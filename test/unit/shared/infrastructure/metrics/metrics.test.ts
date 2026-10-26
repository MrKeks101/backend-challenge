import { describe, expect, test } from "bun:test";
import { OutboxBacklogReporter } from "../../../../../src/messaging/infrastructure/observability/outbox-backlog.reporter";
import { AppMetrics } from "../../../../../src/shared/infrastructure/metrics/metrics";
import { OptimisticLockError } from "../../../../../src/shared/infrastructure/persistence/errors";
import { MikroOrmUnitOfWork } from "../../../../../src/shared/infrastructure/persistence/mikro-orm-unit-of-work";
import { MutableClock } from "../../../../support/in-memory-world";
import { metricValue } from "../../../../support/metrics";
import { at, T0 } from "../../../../support/wagering";

/** `MikroORM` mínimo: `em.fork().transactional(cb)` executa o callback; o SQL não interessa aqui. */
function fakeOrm() {
  const em = { execute: async () => [] };
  return {
    em: {
      fork: () => ({ transactional: async (cb: (em: unknown) => Promise<unknown>) => cb(em) }),
    },
  };
}

const pgError = (code: string) => Object.assign(new Error("pg"), { code });

describe("lock_conflicts_total (Unit of Work)", () => {
  function setup() {
    const metrics = new AppMetrics();
    const uow = new MikroOrmUnitOfWork(fakeOrm() as never, {
      lockConflict: (reason) => metrics.lockConflicts.inc({ reason }),
    });
    return { metrics, uow };
  }

  test.each([
    ["40P01", "deadlock_detected"],
    ["40001", "serialization_failure"],
  ])("conta cada transação desfeita por %s, inclusive as repetidas", async (code, reason) => {
    const { metrics, uow } = setup();
    let attempts = 0;

    const result = await uow.run(
      async () => {
        if (++attempts < 3) throw pgError(code);
        return "ok";
      },
      { retryOnConflict: 3 },
    );

    expect(result).toBe("ok");
    expect(await metricValue(metrics, "lock_conflicts_total", { reason })).toBe(2);
  });

  test("conflito que esgota as repetições conta todas as tentativas e propaga o erro", async () => {
    const { metrics, uow } = setup();

    await expect(
      uow.run(
        async () => {
          throw pgError("40P01");
        },
        { retryOnConflict: 1 },
      ),
    ).rejects.toMatchObject({ code: "40P01" });

    expect(
      await metricValue(metrics, "lock_conflicts_total", { reason: "deadlock_detected" }),
    ).toBe(2);
  });

  test("lock_timeout (55P03) e lock otimista também contam, sem repetir", async () => {
    const { metrics, uow } = setup();

    await expect(
      uow.run(async () => {
        throw pgError("55P03");
      }),
    ).rejects.toMatchObject({ code: "55P03" });
    await expect(
      uow.run(async () => {
        throw new OptimisticLockError("wallet");
      }),
    ).rejects.toBeInstanceOf(OptimisticLockError);

    expect(
      await metricValue(metrics, "lock_conflicts_total", { reason: "lock_not_available" }),
    ).toBe(1);
    expect(await metricValue(metrics, "lock_conflicts_total", { reason: "optimistic_lock" })).toBe(
      1,
    );
  });

  test("erros que não são de concorrência não contam", async () => {
    const { metrics, uow } = setup();

    await expect(
      uow.run(async () => {
        throw pgError("23505");
      }),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      uow.run(async () => {
        throw new TypeError("bug");
      }),
    ).rejects.toBeInstanceOf(TypeError);

    expect(await metricValue(metrics, "lock_conflicts_total")).toBe(0);
  });

  test("sem reporter (testes de integração, scripts) o comportamento é o mesmo", async () => {
    const uow = new MikroOrmUnitOfWork(fakeOrm() as never);
    let attempts = 0;

    expect(
      await uow.run(
        async () => {
          if (++attempts < 2) throw pgError("40001");
          return "ok";
        },
        { retryOnConflict: 1 },
      ),
    ).toBe("ok");
  });
});

describe("outbox_lag_seconds / outbox_pending_total", () => {
  function setup(backlog: () => Promise<{ pending: number; oldestOccurredAt: Date | null }>) {
    const clock = new MutableClock(T0);
    const metrics = new AppMetrics();
    const reporter = new OutboxBacklogReporter({ backlog } as never, clock, metrics);
    reporter.onModuleInit();
    return { clock, metrics };
  }

  test("com o publisher parado o lag cresce a cada scrape", async () => {
    const oldest = at(0);
    const { clock, metrics } = setup(async () => ({ pending: 4, oldestOccurredAt: oldest }));

    clock.set(at(10));
    await metrics.render();
    expect(await metricValue(metrics, "outbox_lag_seconds")).toBe(10);
    expect(await metricValue(metrics, "outbox_pending_total")).toBe(4);

    clock.set(at(70));
    await metrics.render();
    expect(await metricValue(metrics, "outbox_lag_seconds")).toBe(70);
  });

  test("outbox vazia: lag 0 e nenhuma pendente", async () => {
    const { metrics } = setup(async () => ({ pending: 0, oldestOccurredAt: null }));

    await metrics.render();

    expect(await metricValue(metrics, "outbox_lag_seconds")).toBe(0);
    expect(await metricValue(metrics, "outbox_pending_total")).toBe(0);
  });

  test("relógio atrás da mensagem (clock skew) nunca dá lag negativo", async () => {
    const { clock, metrics } = setup(async () => ({ pending: 1, oldestOccurredAt: at(100) }));
    clock.set(at(50));

    await metrics.render();

    expect(await metricValue(metrics, "outbox_lag_seconds")).toBe(0);
  });

  test("banco fora: o scrape ainda responde com as demais métricas", async () => {
    const { metrics } = setup(async () => {
      throw new Error("db down");
    });
    metrics.duplicates.inc({ source: "inbox" });

    const body = await metrics.render();

    expect(body).toContain('wager_duplicates_total{source="inbox"} 1');
  });

  test("sem reporter registrado o render funciona", async () => {
    expect(await new AppMetrics().render()).toContain("# TYPE outbox_lag_seconds gauge");
  });
});

describe("AppMetrics", () => {
  test("registros são independentes (um por instância)", async () => {
    const a = new AppMetrics();
    const b = new AppMetrics();

    a.dlqMessages.inc({ reason: "X" });

    expect(await metricValue(a, "dlq_messages_total")).toBe(1);
    expect(await metricValue(b, "dlq_messages_total")).toBe(0);
  });

  test("métricas do processo só quando pedidas", async () => {
    expect(await new AppMetrics().render()).not.toContain("process_cpu_user_seconds_total");
    expect(await new AppMetrics({ processMetrics: true }).render()).toContain(
      "process_cpu_user_seconds_total",
    );
  });
});

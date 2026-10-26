import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EventPublisher } from "../../../src/messaging/application/ports/event-publisher";
import type { OutboxMessage } from "../../../src/messaging/domain";
import { createTestDatabase, expectInvariants, type TestDatabase } from "../../support/database";
import {
  buildOutboxMessage,
  createPublisherRig,
  DEAD_SQS_ENDPOINT,
  drainQueue,
  enqueueEvent,
  outboxRow,
  type PublisherRig,
  queueDepth,
  unpublishedCount,
} from "../../support/messaging";
import { openWalletInDb } from "../../support/persisted-flow";
import { at } from "../../support/wagering";

/**
 * Outbox publisher contra PostgreSQL e SQS (MiniStack) REAIS. Cada teste tem banco próprio e filas
 * próprias (prefixo único). O tempo (lease e backoff) é controlado por um relógio falso, então
 * nada aqui depende de dormir.
 */
let db: TestDatabase;
let rig: PublisherRig;

beforeEach(async () => {
  db = await createTestDatabase({ poolMax: 30 });
  rig = createPublisherRig(db);
});

afterEach(async () => {
  await expectInvariants(db);
  rig.sqs.destroy();
  await db.close();
});

const newWallet = () => openWalletInDb(db, "0.00");

/** Decora um publisher real registrando cada chamada (e opcionalmente falhando/atrasando). */
function spy(
  inner: EventPublisher,
  behavior: (message: OutboxMessage, call: number) => Promise<void> | void = () => {},
) {
  const published: string[] = [];
  const publisher: EventPublisher = {
    async publish(message) {
      published.push(message.id);
      await behavior(message, published.length);
      await inner.publish(message);
    },
  };
  return { publisher, published };
}

describe("publicação só depois do commit", () => {
  test("evento de transação ainda aberta não é visto nem publicado", async () => {
    const wallet = await newWallet();
    const message = buildOutboxMessage(db, wallet);
    const publisher = rig.build();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let added!: () => void;
    const ready = new Promise<void>((resolve) => {
      added = resolve;
    });
    const open = db.uow.run(async () => {
      await db.outbox.add(message);
      added();
      await gate;
    });
    await ready;

    const during = await publisher.runOnce();
    expect(during).toEqual({ claimed: 0, published: 0, failed: 0, skipped: 0 });
    expect(await queueDepth(rig.sqs, (await rig.urls()).events)).toBe(0);

    release();
    await open;

    const after = await publisher.runOnce();
    expect(after).toEqual({ claimed: 1, published: 1, failed: 0, skipped: 0 });
    const received = await drainQueue(rig.sqs, (await rig.urls()).events);
    expect(received.map((r) => r.eventId)).toEqual([message.id]);
  });

  test("rollback não deixa linha nem publica nada", async () => {
    const wallet = await newWallet();
    const message = buildOutboxMessage(db, wallet);

    await expect(
      db.uow.run(async () => {
        await db.outbox.add(message);
        throw new Error("falha depois de gravar o evento");
      }),
    ).rejects.toThrow("falha depois");

    expect(await db.outbox.findById(message.id)).toBeNull();
    expect(await rig.build().runOnce()).toEqual({
      claimed: 0,
      published: 0,
      failed: 0,
      skipped: 0,
    });
    expect(await drainQueue(rig.sqs, (await rig.urls()).events)).toEqual([]);
  });
});

describe("conteúdo publicado", () => {
  test("corpo = envelope da outbox; grupo = wallet; atributos = tipo e eventId", async () => {
    const wallet = await newWallet();
    const message = await enqueueEvent(db, wallet);

    await rig.build().runOnce();

    const [received, ...rest] = await drainQueue(rig.sqs, (await rig.urls()).events);
    expect(rest).toEqual([]);
    expect(received?.body).toEqual(JSON.parse(JSON.stringify(message.payload)));
    expect(received?.groupId).toBe(wallet.id);
    expect(received?.eventType).toBe("WagerTransactionProcessed");
    expect(received?.eventId).toBe(message.id);
  });

  test("marca a linha como publicada e limpa o erro", async () => {
    const wallet = await newWallet();
    const message = await enqueueEvent(db, wallet);

    await rig.build().runOnce();

    const row = await outboxRow(db, message.id);
    expect(row.publishedAt).toBeInstanceOf(Date);
    expect(row.lastError).toBeUndefined();
    expect(await rig.build().runOnce()).toMatchObject({ claimed: 0 });
  });

  test("um publisher só: a ordem de occurredAt por wallet é preservada na fila", async () => {
    const wallet = await newWallet();
    // Gravadas fora de ordem de propósito; a ordem de publicação vem de occurredAt.
    const ids: string[] = [];
    for (const seconds of [3, 1, 4, 0, 2]) {
      ids[seconds] = (await enqueueEvent(db, wallet, at(seconds))).id;
    }

    await rig.build().runOnce();

    const received = await drainQueue(rig.sqs, (await rig.urls()).events);
    expect(received.map((r) => r.eventId)).toEqual(ids);
  });

  test("respeita o tamanho do lote", async () => {
    const wallet = await newWallet();
    for (let i = 0; i < 5; i++) await enqueueEvent(db, wallet, at(i));
    const publisher = rig.build({ batchSize: 2 });

    expect(await publisher.runOnce()).toMatchObject({ claimed: 2, published: 2 });
    expect(await unpublishedCount(db)).toBe(3);
    expect(await publisher.runOnce()).toMatchObject({ claimed: 2, published: 2 });
    expect(await publisher.runOnce()).toMatchObject({ claimed: 1, published: 1 });
    expect(await publisher.runOnce()).toMatchObject({ claimed: 0 });
  });
});

describe("vários publishers sobre a mesma outbox", () => {
  test("dois publishers concorrentes: nenhum evento perdido e nenhum publicado duas vezes", async () => {
    const wallets = await Promise.all(Array.from({ length: 12 }, () => newWallet()));
    const expected = new Set<string>();
    for (const [w, wallet] of wallets.entries()) {
      for (let i = 0; i < 5; i++) {
        expected.add((await enqueueEvent(db, wallet, at(w * 10 + i))).id);
      }
    }
    expect(expected.size).toBe(60);

    // Cada publisher é lento o bastante para os ciclos dos dois se intercalarem de verdade.
    const slow = () => new Promise<void>((resolve) => setTimeout(resolve, 3));
    const a = spy(rig.sqsPublisher, slow);
    const b = spy(rig.sqsPublisher, slow);
    const runUntilEmpty = async (publisher: ReturnType<PublisherRig["build"]>) => {
      let cycles = 0;
      for (;;) {
        const result = await publisher.runOnce();
        if (result.claimed === 0) return cycles;
        cycles++;
      }
    };
    const [cyclesA, cyclesB] = await Promise.all([
      runUntilEmpty(rig.build({ publisher: a.publisher, batchSize: 7 })),
      runUntilEmpty(rig.build({ publisher: b.publisher, batchSize: 7 })),
    ]);

    // Os dois trabalharam (não foi um só que fez tudo).
    expect(cyclesA).toBeGreaterThan(0);
    expect(cyclesB).toBeGreaterThan(0);
    // Reivindicações disjuntas: cada evento foi enviado ao broker exatamente uma vez no total.
    const attempts = [...a.published, ...b.published];
    expect(attempts).toHaveLength(60);
    expect(new Set(attempts)).toEqual(expected);
    expect(a.published.filter((id) => b.published.includes(id))).toEqual([]);

    expect(await unpublishedCount(db)).toBe(0);
    const received = await drainQueue(rig.sqs, (await rig.urls()).events);
    expect(received).toHaveLength(60);
    expect(new Set(received.map((r) => r.eventId))).toEqual(expected);
  });

  test("N publishers em paralelo sobre a mesma linha: só um a reivindica", async () => {
    const wallet = await newWallet();
    const message = await enqueueEvent(db, wallet);
    const spies = Array.from({ length: 10 }, () => spy(rig.sqsPublisher));

    const results = await Promise.all(
      spies.map((s) => rig.build({ publisher: s.publisher }).runOnce()),
    );

    expect(results.reduce((sum, r) => sum + r.claimed, 0)).toBe(1);
    expect(spies.flatMap((s) => s.published)).toEqual([message.id]);
  });
});

describe("processo morto depois do commit e antes de publicar", () => {
  test("o lease segura a mensagem; vencido, outra instância publica", async () => {
    const wallet = await newWallet();
    const message = await enqueueEvent(db, wallet);

    // A instância A reivindica (lease de 30 s) e morre sem publicar nem marcar.
    const claimedByA = await db.uow.run(() => db.outbox.claimDue(rig.clock.now(), 20, 30_000));
    expect(claimedByA.map((m) => m.id)).toEqual([message.id]);

    const b = rig.build();
    expect(await b.runOnce()).toMatchObject({ claimed: 0 }); // lease ainda vale
    rig.clock.advance(29_999);
    expect(await b.runOnce()).toMatchObject({ claimed: 0 }); // 1 ms antes de vencer
    rig.clock.advance(1);
    expect(await b.runOnce()).toMatchObject({ claimed: 1, published: 1 }); // vencimento inclusivo

    const received = await drainQueue(rig.sqs, (await rig.urls()).events);
    expect(received.map((r) => r.eventId)).toEqual([message.id]);
    expect((await outboxRow(db, message.id)).publishedAt).toBeInstanceOf(Date);
  });

  test("morreu DEPOIS de enviar e ANTES de marcar: a duplicata é idêntica e deduplicável por eventId", async () => {
    const wallet = await newWallet();
    const message = await enqueueEvent(db, wallet);

    const [claimedByA] = await db.uow.run(() => db.outbox.claimDue(rig.clock.now(), 20, 30_000));
    await rig.sqsPublisher.publish(claimedByA as OutboxMessage); // enviou; morreu antes do UPDATE

    rig.clock.advance(30_000);
    expect(await rig.build().runOnce()).toMatchObject({ claimed: 1, published: 1 });

    const received = await drainQueue(rig.sqs, (await rig.urls()).events);
    expect(received.length).toBeGreaterThanOrEqual(1);
    // Se o broker não descartou a segunda cópia, ela é igual à primeira; um consumidor que
    // deduplica por eventId enxerga exatamente um evento.
    for (const copy of received) {
      expect(copy.eventId).toBe(message.id);
      expect(copy.body).toEqual(received[0]?.body as Record<string, unknown>);
    }
    expect(new Set(received.map((r) => r.eventId)).size).toBe(1);
  });

  test("lease vence DURANTE o envio: o outro publisher marca primeiro e o atrasado não quebra", async () => {
    const wallet = await newWallet();
    const message = await enqueueEvent(db, wallet);
    const other = rig.build();

    const slowA = spy(rig.sqsPublisher, async () => {
      // Enquanto A ainda está enviando, o lease vence e B publica e marca a mesma mensagem.
      rig.clock.advance(30_001);
      expect(await other.runOnce()).toMatchObject({ claimed: 1, published: 1 });
    });
    const result = await rig.build({ publisher: slowA.publisher }).runOnce();

    expect(result).toEqual({ claimed: 1, published: 1, failed: 0, skipped: 0 });
    expect((await outboxRow(db, message.id)).publishedAt).toBeInstanceOf(Date);
    const received = await drainQueue(rig.sqs, (await rig.urls()).events);
    expect(new Set(received.map((r) => r.eventId))).toEqual(new Set([message.id]));
  });
});

describe("falha do SQS", () => {
  test("SQS fora do ar: agenda retry com backoff, registra o motivo e recupera depois", async () => {
    const wallet = await newWallet();
    const message = await enqueueEvent(db, wallet);
    const down = createPublisherRig(db, { endpoint: DEAD_SQS_ENDPOINT, clock: rig.clock });

    const first = await down.build().runOnce();
    expect(first).toEqual({ claimed: 1, published: 0, failed: 1, skipped: 0 });
    let row = await outboxRow(db, message.id);
    expect(row.publishedAt).toBeUndefined();
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(rig.clock.now().getTime());
    expect(row.lastError).toBeString();

    // Dentro do backoff nada é tentado de novo.
    expect(await rig.build().runOnce()).toMatchObject({ claimed: 0 });

    // Falha de novo: o backoff cresce.
    const firstDelay = row.nextAttemptAt.getTime() - rig.clock.now().getTime();
    rig.clock.advance(firstDelay);
    await down.build().runOnce();
    row = await outboxRow(db, message.id);
    expect(row.attempts).toBe(2);
    expect(row.nextAttemptAt.getTime() - rig.clock.now().getTime()).toBeGreaterThan(firstDelay);

    // O SQS volta: o evento sai, a linha fica limpa e as tentativas ficam registradas.
    rig.clock.advance(3_600_000);
    expect(await rig.build().runOnce()).toMatchObject({ claimed: 1, published: 1 });
    row = await outboxRow(db, message.id);
    expect(row.publishedAt).toBeInstanceOf(Date);
    expect(row.lastError).toBeUndefined();
    expect(row.attempts).toBe(2);
    const received = await drainQueue(rig.sqs, (await rig.urls()).events);
    expect(received.map((r) => r.eventId)).toEqual([message.id]);
  });

  test("last_error guarda só o tipo do erro, nunca a mensagem", async () => {
    const wallet = await newWallet();
    const message = await enqueueEvent(db, wallet);
    const failing = spy(rig.sqsPublisher, () => {
      throw new TypeError("conteudo-sensivel-do-payload");
    });

    await rig.build({ publisher: failing.publisher }).runOnce();

    const row = await outboxRow(db, message.id);
    expect(row.lastError).toBe("TypeError");
    expect(row.lastError).not.toContain("sensivel");
  });

  test("erro com código: o código entra no motivo", async () => {
    const wallet = await newWallet();
    const message = await enqueueEvent(db, wallet);
    const failing = spy(rig.sqsPublisher, () => {
      throw Object.assign(new Error("x"), { code: "ECONNREFUSED" });
    });

    await rig.build({ publisher: failing.publisher }).runOnce();

    expect((await outboxRow(db, message.id)).lastError).toBe("Error(ECONNREFUSED)");
  });

  test("falha de um evento segura os seguintes da MESMA wallet (ordem) e não as outras", async () => {
    const [w1, w2] = [await newWallet(), await newWallet()];
    const m1 = await enqueueEvent(db, w1, at(0));
    const m2 = await enqueueEvent(db, w1, at(1));
    const m3 = await enqueueEvent(db, w2, at(2));
    const flaky = spy(rig.sqsPublisher, (message) => {
      if (message.id === m1.id) throw new Error("falha só no m1");
    });

    const result = await rig.build({ publisher: flaky.publisher }).runOnce();

    expect(result).toEqual({ claimed: 3, published: 1, failed: 1, skipped: 1 });
    expect(flaky.published).toEqual([m1.id, m3.id]); // m2 nem foi tentado
    expect((await outboxRow(db, m2.id)).attempts).toBe(0); // pular não conta como tentativa
    expect((await outboxRow(db, m3.id)).publishedAt).toBeInstanceOf(Date);
    expect((await outboxRow(db, m1.id)).attempts).toBe(1);

    // Com o backoff vencido, a wallet w1 sai na ordem certa.
    rig.clock.advance(3_600_000);
    expect(await rig.build().runOnce()).toMatchObject({ published: 2, failed: 0, skipped: 0 });
    const received = await drainQueue(rig.sqs, (await rig.urls()).events);
    expect(received.filter((r) => r.groupId === w1.id).map((r) => r.eventId)).toEqual([
      m1.id,
      m2.id,
    ]);
    expect(await unpublishedCount(db)).toBe(0);
  });
});

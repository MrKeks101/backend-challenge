import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { QueueRegistry, SQS_CLIENT } from "../messaging/infrastructure/sqs/sqs.module";
import { MIKRO_ORM } from "../shared/infrastructure/persistence/mikro-orm-unit-of-work";

export const READINESS_PROBES = Symbol("ReadinessProbes");

export interface ReadinessProbe {
  name: string;
  /** Resolve se a dependência está alcançável; rejeita (ou não responde) se não. */
  check(signal: AbortSignal): Promise<void>;
}

export interface ReadinessReport {
  ready: boolean;
  checks: Record<string, "up" | "down">;
}

export const READINESS_TIMEOUT_MS = 2_000;

/** Roda todas as probes em paralelo, cada uma com prazo curto: uma dependência travada não trava a sonda. */
export class ReadinessService {
  constructor(
    private readonly probes: ReadinessProbe[],
    private readonly timeoutMs: number = READINESS_TIMEOUT_MS,
  ) {}

  async check(): Promise<ReadinessReport> {
    const entries = await Promise.all(
      this.probes.map(async (probe) => [probe.name, await this.run(probe)] as const),
    );
    const checks = Object.fromEntries(entries);
    return { ready: entries.every(([, state]) => state === "up"), checks };
  }

  private async run(probe: ReadinessProbe): Promise<"up" | "down"> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const deadline = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
    });
    try {
      await Promise.race([probe.check(signal), deadline]);
      return "up";
    } catch {
      return "down";
    }
  }
}

/** PostgreSQL responde a um `SELECT 1`. */
export class DatabaseProbe implements ReadinessProbe {
  readonly name = "database";

  constructor(private readonly orm: MikroORM) {}

  async check(): Promise<void> {
    await this.orm.em.fork().execute("SELECT 1");
  }
}

/** O SQS responde e a fila de eventos existe (cria as filas, se faltarem, na primeira vez). */
export class SqsProbe implements ReadinessProbe {
  readonly name = "sqs";

  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: QueueRegistry,
  ) {}

  async check(signal: AbortSignal): Promise<void> {
    const { events } = await this.queues.ensure();
    await this.sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: events, AttributeNames: ["QueueArn"] }),
      { abortSignal: signal },
    );
  }
}

export const readinessProbesFactory = {
  provide: READINESS_PROBES,
  inject: [MIKRO_ORM, SQS_CLIENT, QueueRegistry],
  useFactory: (orm: MikroORM, sqs: SQSClient, queues: QueueRegistry): ReadinessProbe[] => [
    new DatabaseProbe(orm),
    new SqsProbe(sqs, queues),
  ],
};

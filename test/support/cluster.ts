import { fileURLToPath } from "node:url";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { Subprocess } from "bun";
import type { QueueUrls } from "../../src/messaging/infrastructure/sqs/ensure-queues";
import type { TestDatabase } from "./database";
import type { ApiResponse } from "./http-app";
import { TEST_SQS_ENDPOINT } from "./infra";
import { queueDepth, registryFor, sqsClient, uniquePrefix } from "./messaging";
import { WageringApi } from "./wagering-api";

const ENTRY = fileURLToPath(new URL("./node-entry.ts", import.meta.url));

/** Env padrão dos nós: tudo rápido (poll curto, retry imediato) para o teste não depender de relógio. */
const FAST_ENV: Record<string, string> = {
  LOG_LEVEL: "info",
  CONSUMER_WAIT_SECONDS: "1",
  CONSUMER_RETRY_BASE_SECONDS: "0",
  CONSUMER_POLLERS: "2",
  SHUTDOWN_GRACE_MS: "10000",
  OUTBOX_POLL_INTERVAL_MS: "100",
  OUTBOX_LEASE_MS: "3000",
  REPROCESSOR_POLL_INTERVAL_MS: "200",
  REPROCESSOR_LEASE_MS: "3000",
  PENDING_REFERENCE_BACKOFF_BASE_MS: "300",
  PENDING_REFERENCE_BACKOFF_CAP_MS: "1000",
};

export interface NodeOptions {
  /** Papéis do nó. `api` é sempre incluído: é por ele que o teste espera o nó ficar pronto e lê `/metrics`. */
  roles: string[];
  env?: Record<string, string>;
  crash?: { point: string; after?: number };
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port;
  await probe.stop(true);
  if (port === undefined) throw new Error("sem porta livre");
  return port;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Um processo `bun` rodando o app de verdade. */
export class Node {
  readonly logs: string[] = [];
  private stopped = false;

  private constructor(
    readonly name: string,
    readonly port: number,
    private readonly proc: Subprocess<"pipe", "pipe", "pipe">,
  ) {
    void this.collect(proc.stdout);
    void this.collect(proc.stderr);
  }

  static async start(
    name: string,
    base: Record<string, string>,
    options: NodeOptions,
  ): Promise<Node> {
    const port = await freePort();
    const roles = options.roles.includes("api") ? options.roles : ["api", ...options.roles];
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...FAST_ENV,
      ...base,
      ...options.env,
      PORT: String(port),
      APP_ROLES: roles.join(","),
    };
    delete env.CRASH_POINT;
    delete env.CRASH_AFTER;
    if (options.crash) {
      env.CRASH_POINT = options.crash.point;
      env.CRASH_AFTER = String(options.crash.after ?? 1);
    }
    const proc = Bun.spawn([process.execPath, ENTRY], {
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const node = new Node(name, port, proc);
    // Um nó com ponto de crash pode morrer antes de ficar pronto (p.ex. publisher com a outbox
    // cheia): quem pede o crash espera a morte, não a prontidão.
    await node.untilReady(60_000, options.crash !== undefined);
    return node;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Resolve com o código de saída quando o processo termina (por qualquer motivo). */
  get exited(): Promise<number | null> {
    return this.proc.exited.then(() => this.proc.exitCode);
  }

  get alive(): boolean {
    return this.proc.exitCode === null && this.proc.signalCode === null;
  }

  get signalCode(): string | null {
    const signal = this.proc.signalCode;
    return signal === null ? null : String(signal);
  }

  /** SIGKILL: nenhum hook de shutdown roda, nenhuma conexão é fechada com cortesia. */
  async kill(): Promise<void> {
    if (!this.alive) return;
    this.proc.kill(9);
    await this.proc.exited;
  }

  /** Shutdown gracioso (o caminho do SIGTERM): espera o processo sair; mata se passar do prazo. */
  async stop(timeoutMs = 30_000): Promise<void> {
    if (!this.alive || this.stopped) return;
    this.stopped = true;
    this.proc.stdin.write("SIGTERM\n");
    this.proc.stdin.flush();
    const outcome = await Promise.race([this.proc.exited.then(() => "exited"), sleep(timeoutMs)]);
    if (outcome !== "exited") {
      await this.kill();
      throw new Error(`${this.name} não terminou o shutdown em ${timeoutMs} ms\n${this.tail()}`);
    }
  }

  async request(
    method: string,
    path: string,
    options: { body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
  ): Promise<ApiResponse> {
    const hasBody = options.body !== undefined || options.rawBody !== undefined;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...options.headers },
      ...(hasBody ? { body: options.rawBody ?? JSON.stringify(options.body) } : {}),
    });
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      body: text.length === 0 ? null : JSON.parse(text),
    };
  }

  async metricsText(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/metrics`);
    return res.text();
  }

  /** Soma das séries de `name` cujos rótulos contêm `labels` (0 se não existe). */
  async metric(name: string, labels: Record<string, string> = {}): Promise<number> {
    return sumSeries(await this.metricsText(), name, labels);
  }

  tail(lines = 40): string {
    return `--- logs de ${this.name} ---\n${this.logs.slice(-lines).join("\n")}`;
  }

  private async untilReady(timeoutMs = 60_000, mayDie = false): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.alive) {
        if (mayDie) return;
        throw new Error(`${this.name} morreu ao subir\n${this.tail()}`);
      }
      try {
        const res = await fetch(`${this.baseUrl}/health/ready`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (res.status === 200) return;
      } catch {
        // ainda subindo
      }
      await sleep(100);
    }
    await this.kill();
    throw new Error(`${this.name} não ficou pronto em ${timeoutMs} ms\n${this.tail()}`);
  }

  private async collect(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim().length > 0) this.logs.push(line);
    }
  }
}

/** Soma as séries Prometheus de `name` (histogramas: use o sufixo `_count`/`_sum`). */
export function sumSeries(text: string, name: string, labels: Record<string, string> = {}): number {
  let total = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || !line.startsWith(name)) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(\S+)$/.exec(line);
    if (!match || match[1] !== name) continue;
    const found = Object.fromEntries(
      [...(match[3] ?? "").matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    if (Object.entries(labels).every(([key, value]) => found[key] === value)) {
      total += Number(match[4]); // allow-number: valor de métrica Prometheus
    }
  }
  return total;
}

export interface Cluster {
  prefix: string;
  sqs: SQSClient;
  urls: QueueUrls;
  nodes: Node[];
  /** Sobe um nó. */
  start(name: string, options: NodeOptions): Promise<Node>;
  /** Cliente de alto nível (helpers de wallet/corpo) apontando para um nó. */
  api(node: Node): WageringApi;
  /** Mensagens na fila de entrada (visíveis + em voo). */
  inputDepth(): Promise<number>;
  /** Mensagens em voo (recebidas e ainda sem ack). */
  inFlight(): Promise<number>;
  close(): Promise<void>;
}

/** Filas próprias + fábrica de nós sobre o banco de teste. Cada teste cria o seu cluster. */
export async function createCluster(db: TestDatabase): Promise<Cluster> {
  const prefix = uniquePrefix();
  const sqs = sqsClient();
  const urls = await registryFor(sqs, prefix).ensure();
  const base: Record<string, string> = {
    DATABASE_URL: db.url,
    SQS_ENDPOINT: TEST_SQS_ENDPOINT,
    SQS_QUEUE_PREFIX: prefix,
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
  };
  const nodes: Node[] = [];
  return {
    prefix,
    sqs,
    urls,
    nodes,
    async start(name, options) {
      const node = await Node.start(name, base, options);
      nodes.push(node);
      return node;
    },
    api: (node) => new WageringApi(node, db),
    inputDepth: () => queueDepth(sqs, urls.transactions),
    async inFlight() {
      const { GetQueueAttributesCommand } = await import("@aws-sdk/client-sqs");
      const res = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: urls.transactions,
          AttributeNames: ["ApproximateNumberOfMessagesNotVisible"],
        }),
      );
      return Number(res.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0); // allow-number: contagem do SQS
    },
    async close() {
      await Promise.all(nodes.map((node) => node.kill()));
      sqs.destroy();
    },
  };
}

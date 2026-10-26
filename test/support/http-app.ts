import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { APP_METRICS, type AppMetrics } from "../../src/shared/infrastructure/metrics/metrics";
import type { TestDatabase } from "./database";
import { TEST_SQS_ENDPOINT } from "./infra";

export interface TestApi {
  baseUrl: string;
  metrics: AppMetrics;
  app: INestApplication;
  /** `fetch` com JSON; devolve status, headers e o corpo já interpretado (ou `null` se vazio). */
  request(
    method: string,
    path: string,
    options?: { body?: unknown; rawBody?: string; headers?: Record<string, string> },
  ): Promise<ApiResponse>;
  close(): Promise<void>;
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  body: any;
}

/**
 * Sobe a API REAL (AppModule completo) numa porta efêmera, apontada para o banco de teste. O ENV
 * é lido do `process.env` na criação do módulo, por isso é definido logo antes.
 */
const OVERRIDABLE_ENV = [
  "SQS_QUEUE_PREFIX",
  "OUTBOX_POLL_INTERVAL_MS",
  "OUTBOX_BATCH_SIZE",
  "OUTBOX_LEASE_MS",
];

export interface StartApiOptions {
  /** `APP_ROLES` do processo (padrão `api`: os testes de HTTP não sobem workers). */
  roles?: string;
  /** Variáveis de ambiente extras/sobrescritas (p.ex. `SQS_QUEUE_PREFIX`, `SQS_ENDPOINT`). */
  env?: Record<string, string>;
}

export async function startApi(db: TestDatabase, options: StartApiOptions = {}): Promise<TestApi> {
  process.env.DATABASE_URL = db.url;
  process.env.AWS_ACCESS_KEY_ID ??= "test";
  process.env.AWS_SECRET_ACCESS_KEY ??= "test";
  // process.env é compartilhado entre os arquivos de teste: zera o que um teste anterior possa ter
  // sobrescrito antes de aplicar as variáveis deste.
  for (const key of OVERRIDABLE_ENV) delete process.env[key];
  process.env.SQS_ENDPOINT = TEST_SQS_ENDPOINT;
  process.env.APP_ROLES = options.roles ?? "api";
  for (const [key, value] of Object.entries(options.env ?? {})) process.env[key] = value;
  const { AppModule } = await import("../../src/app.module");
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  await app.listen(0, "127.0.0.1");
  const baseUrl = await app.getUrl();

  return {
    baseUrl,
    app,
    metrics: app.get<AppMetrics>(APP_METRICS),
    async request(method, path, options = {}) {
      const hasBody = options.body !== undefined || options.rawBody !== undefined;
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(hasBody ? { "content-type": "application/json" } : {}),
          ...options.headers,
        },
        ...(hasBody ? { body: options.rawBody ?? JSON.stringify(options.body) } : {}),
      });
      const text = await res.text();
      return {
        status: res.status,
        headers: res.headers,
        body: text.length === 0 ? null : JSON.parse(text),
      };
    },
    close: () => app.close(),
  };
}

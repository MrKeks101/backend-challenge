import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { APP_METRICS, type AppMetrics } from "../../src/shared/infrastructure/metrics/metrics";
import type { TestDatabase } from "./database";

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
export async function startApi(db: TestDatabase): Promise<TestApi> {
  process.env.DATABASE_URL = db.url;
  process.env.AWS_ACCESS_KEY_ID ??= "test";
  process.env.AWS_SECRET_ACCESS_KEY ??= "test";
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

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AuthModule } from "../../src/auth/auth.module";
import { HealthModule } from "../../src/health/health.module";
import { MetricsModule } from "../../src/shared/infrastructure/metrics/metrics.module";

// Só health + auth + métricas: o liveness não pode depender de banco nem de fila (o AppModule completo exige ambos).
@Module({ imports: [MetricsModule, AuthModule, HealthModule] })
class HealthOnlyModule {}

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  app = await NestFactory.create(HealthOnlyModule, { logger: false });
  await app.listen(0);
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
});

describe("GET /health/live", () => {
  test("responde 200 sem autenticação e sem depender de infra externa", async () => {
    const res = await fetch(`${baseUrl}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("GET /metrics", () => {
  test("responde 200 em formato Prometheus, sem autenticação", async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("# TYPE wager_transactions_total counter");
  });

  test("expõe todas as métricas mínimas do RNF-OBS-02 (e a de reconciliação)", async () => {
    const body = await (await fetch(`${baseUrl}/metrics`)).text();
    for (const name of [
      "wager_transactions_total",
      "wager_duplicates_total",
      "wager_retries_total",
      "dlq_messages_total",
      "lock_conflicts_total",
      "wallet_lock_wait_seconds",
      "outbox_lag_seconds",
      "outbox_pending_total",
      "wager_processing_duration_seconds",
      "reconciliation_divergences_total",
    ]) {
      expect(body).toContain(`# TYPE ${name} `);
    }
  });

  test("inclui as métricas do processo (CPU, memória)", async () => {
    const body = await (await fetch(`${baseUrl}/metrics`)).text();
    expect(body).toContain("process_cpu_user_seconds_total");
  });
});

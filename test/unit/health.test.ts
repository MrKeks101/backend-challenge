import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AuthModule } from "../../src/auth/auth.module";
import { HealthModule } from "../../src/health/health.module";

// Só health + auth: o liveness não pode depender de banco nem de fila (o AppModule completo exige ambos).
@Module({ imports: [AuthModule, HealthModule] })
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

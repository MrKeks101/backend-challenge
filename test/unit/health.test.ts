import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

// O ENV é validado ao subir o módulo; valores padrão só para este teste não depender de um .env.
process.env.DATABASE_URL ??= "postgres://wagering:wagering@localhost:5432/wagering";
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  const { AppModule } = await import("../../src/app.module");
  app = await NestFactory.create(AppModule, { logger: false });
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

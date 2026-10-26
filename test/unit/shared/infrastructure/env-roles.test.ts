import { describe, expect, test } from "bun:test";
import { APP_ROLES, loadEnv } from "../../../../src/shared/infrastructure/config/env";

const base = {
  DATABASE_URL: "postgres://u:p@localhost/db",
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
};

describe("APP_ROLES", () => {
  test("padrão: todos os papéis (uma instância faz tudo)", () => {
    expect([...loadEnv(base).APP_ROLES].sort()).toEqual([...APP_ROLES].sort());
  });

  test("aceita um subconjunto, ignorando espaços e vírgulas sobrando", () => {
    const { APP_ROLES: roles } = loadEnv({ ...base, APP_ROLES: " api , publisher ,," });
    expect([...roles].sort()).toEqual(["api", "publisher"]);
  });

  test("papel repetido vira um só", () => {
    expect(loadEnv({ ...base, APP_ROLES: "api,api" }).APP_ROLES.size).toBe(1);
  });

  test.each([
    ["papel desconhecido", "api,worker"],
    ["lista vazia", ""],
    ["só separadores", " , "],
    ["maiúsculas", "API"],
  ])("rejeita %s", (_label, value) => {
    expect(() => loadEnv({ ...base, APP_ROLES: value })).toThrow(/APP_ROLES/);
  });

  test("a mensagem de erro lista os papéis válidos e o desconhecido", () => {
    expect(() => loadEnv({ ...base, APP_ROLES: "api,worker" })).toThrow(/worker/);
    expect(() => loadEnv({ ...base, APP_ROLES: "api,worker" })).toThrow(/publisher/);
  });
});

describe("configuração do publisher", () => {
  test("padrões", () => {
    const env = loadEnv(base);
    expect(env.SQS_QUEUE_PREFIX).toBe("");
    expect(env.OUTBOX_POLL_INTERVAL_MS).toBe(500);
    expect(env.OUTBOX_BATCH_SIZE).toBe(20);
    expect(env.OUTBOX_LEASE_MS).toBe(30_000);
  });

  test("valores informados são lidos como número", () => {
    const env = loadEnv({
      ...base,
      OUTBOX_POLL_INTERVAL_MS: "50",
      OUTBOX_BATCH_SIZE: "5",
      OUTBOX_LEASE_MS: "1000",
      SQS_QUEUE_PREFIX: "ci_1-",
    });
    expect(env).toMatchObject({
      OUTBOX_POLL_INTERVAL_MS: 50,
      OUTBOX_BATCH_SIZE: 5,
      OUTBOX_LEASE_MS: 1000,
      SQS_QUEUE_PREFIX: "ci_1-",
    });
  });

  test.each([
    ["OUTBOX_POLL_INTERVAL_MS", "0"],
    ["OUTBOX_BATCH_SIZE", "0"],
    ["OUTBOX_BATCH_SIZE", "1.5"],
    ["OUTBOX_LEASE_MS", "-1"],
    ["OUTBOX_LEASE_MS", "abc"],
    ["SQS_QUEUE_PREFIX", "com espaço"],
    ["SQS_QUEUE_PREFIX", "a/b"],
  ])("rejeita %s=%s", (key, value) => {
    expect(() => loadEnv({ ...base, [key]: value })).toThrow(key);
  });
});

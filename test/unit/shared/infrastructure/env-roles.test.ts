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

describe("configuração do consumidor", () => {
  test("padrões", () => {
    const env = loadEnv(base);
    expect(env).toMatchObject({
      CONSUMER_POLLERS: 4,
      CONSUMER_BATCH_SIZE: 10,
      CONSUMER_WAIT_SECONDS: 20,
      CONSUMER_RETRY_BASE_SECONDS: 2,
      SHUTDOWN_GRACE_MS: 25_000,
    });
  });

  test("limites aceitos nas bordas", () => {
    const env = loadEnv({
      ...base,
      CONSUMER_BATCH_SIZE: "1",
      CONSUMER_WAIT_SECONDS: "0",
      CONSUMER_RETRY_BASE_SECONDS: "0",
    });
    expect(env).toMatchObject({
      CONSUMER_BATCH_SIZE: 1,
      CONSUMER_WAIT_SECONDS: 0,
      CONSUMER_RETRY_BASE_SECONDS: 0,
    });
  });

  test.each([
    ["CONSUMER_POLLERS", "0"],
    ["CONSUMER_BATCH_SIZE", "0"],
    ["CONSUMER_BATCH_SIZE", "11"], // o SQS entrega no máximo 10 por receive
    ["CONSUMER_WAIT_SECONDS", "21"], // long poll máximo do SQS: 20 s
    ["CONSUMER_WAIT_SECONDS", "-1"],
    ["CONSUMER_RETRY_BASE_SECONDS", "-1"],
    ["CONSUMER_RETRY_BASE_SECONDS", "3601"],
    ["SHUTDOWN_GRACE_MS", "0"],
  ])("rejeita %s=%s", (key, value) => {
    expect(() => loadEnv({ ...base, [key]: value })).toThrow(key);
  });
});

describe("configuração do reprocessador", () => {
  test("padrões: 10 tentativas, backoff 2 s até 5 min, TTL de 1 h", () => {
    expect(loadEnv(base)).toMatchObject({
      REPROCESSOR_POLL_INTERVAL_MS: 1_000,
      REPROCESSOR_BATCH_SIZE: 20,
      REPROCESSOR_LEASE_MS: 60_000,
      PENDING_REFERENCE_MAX_ATTEMPTS: 10,
      PENDING_REFERENCE_TTL_MS: 3_600_000,
      PENDING_REFERENCE_BACKOFF_BASE_MS: 2_000,
      PENDING_REFERENCE_BACKOFF_CAP_MS: 300_000,
    });
  });

  test("valores informados são lidos como número", () => {
    const env = loadEnv({
      ...base,
      PENDING_REFERENCE_MAX_ATTEMPTS: "3",
      REPROCESSOR_BATCH_SIZE: "7",
    });
    expect(env.PENDING_REFERENCE_MAX_ATTEMPTS).toBe(3);
    expect(env.REPROCESSOR_BATCH_SIZE).toBe(7);
  });

  test.each([
    "REPROCESSOR_POLL_INTERVAL_MS",
    "REPROCESSOR_BATCH_SIZE",
    "REPROCESSOR_LEASE_MS",
    "PENDING_REFERENCE_MAX_ATTEMPTS",
    "PENDING_REFERENCE_TTL_MS",
    "PENDING_REFERENCE_BACKOFF_BASE_MS",
    "PENDING_REFERENCE_BACKOFF_CAP_MS",
  ])("rejeita %s=0", (key) => {
    expect(() => loadEnv({ ...base, [key]: "0" })).toThrow(key);
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

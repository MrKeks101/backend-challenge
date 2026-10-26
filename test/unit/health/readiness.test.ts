import { describe, expect, test } from "bun:test";
import { type ReadinessProbe, ReadinessService } from "../../../src/health/readiness.service";

const probe = (name: string, check: ReadinessProbe["check"]): ReadinessProbe => ({ name, check });
const up = (name: string) => probe(name, async () => {});
const failing = (name: string) =>
  probe(name, async () => {
    throw new Error("ECONNREFUSED 10.0.0.1:5432");
  });
const hanging = (name: string) => probe(name, () => new Promise<void>(() => {}));

describe("ReadinessService", () => {
  test("tudo no ar: pronto", async () => {
    const report = await new ReadinessService([up("database"), up("sqs")]).check();

    expect(report).toEqual({ ready: true, checks: { database: "up", sqs: "up" } });
  });

  test("uma dependência fora derruba o conjunto e é nomeada", async () => {
    const report = await new ReadinessService([up("database"), failing("sqs")]).check();

    expect(report).toEqual({ ready: false, checks: { database: "up", sqs: "down" } });
  });

  test("todas fora", async () => {
    const report = await new ReadinessService([failing("database"), failing("sqs")]).check();

    expect(report.ready).toBe(false);
    expect(report.checks).toEqual({ database: "down", sqs: "down" });
  });

  test("dependência que não responde estoura o prazo e conta como fora", async () => {
    const started = Date.now();
    const report = await new ReadinessService([up("database"), hanging("sqs")], 50).check();

    expect(report).toEqual({ ready: false, checks: { database: "up", sqs: "down" } });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("as probes rodam em paralelo (o prazo vale por probe, não somado)", async () => {
    const started = Date.now();
    await new ReadinessService([hanging("a"), hanging("b"), hanging("c")], 100).check();

    expect(Date.now() - started).toBeLessThan(250);
  });

  test("probe recebe um AbortSignal que dispara no prazo", async () => {
    let aborted = false;
    const watcher = probe(
      "sqs",
      (signal) =>
        new Promise<void>(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    );

    await new ReadinessService([watcher], 30).check();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(aborted).toBe(true);
  });

  test("sem probes: pronto (nada a verificar)", async () => {
    expect(await new ReadinessService([]).check()).toEqual({ ready: true, checks: {} });
  });
});

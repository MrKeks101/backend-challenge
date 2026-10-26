import { describe, expect, test } from "bun:test";
import { type CycleStats, PollingLoop } from "../../../../src/shared/infrastructure/polling-loop";

const idle: CycleStats = { claimed: 0, failed: 0 };
const full = (n: number): CycleStats => ({ ...idle, claimed: n });
const gapsOf = (times: number[]): number[] => times.slice(1).map((t, i) => t - (times[i] ?? 0));
const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condição não atingida");
    await tick(2);
  }
}

describe("PollingLoop", () => {
  test("repete o ciclo enquanto o lote vem cheio, sem pausar", async () => {
    let calls = 0;
    const loop = new PollingLoop(
      async () => (++calls < 5 ? full(10) : idle),
      10,
      { pollIntervalMs: 60_000 }, // se pausasse entre ciclos cheios, o teste estouraria o prazo
    );

    loop.start();
    await waitFor(() => calls >= 5);
    await loop.stop();

    expect(calls).toBe(5);
  });

  test("lote incompleto: dorme o intervalo antes do próximo ciclo", async () => {
    const times: number[] = [];
    const loop = new PollingLoop(
      async () => {
        times.push(Date.now());
        return full(3); // < batchSize
      },
      10,
      { pollIntervalMs: 40 },
    );

    loop.start();
    await waitFor(() => times.length >= 3);
    await loop.stop();

    for (const gap of gapsOf(times)) expect(gap).toBeGreaterThanOrEqual(35);
  });

  test("um erro no ciclo não derruba o laço: tenta de novo", async () => {
    let calls = 0;
    const loop = new PollingLoop(
      async () => {
        calls++;
        if (calls <= 2) throw new Error("postgres caiu");
        return idle;
      },
      10,
      { pollIntervalMs: 5, maxErrorPauseMs: 20 },
    );

    loop.start();
    await waitFor(() => calls >= 4);
    await loop.stop();

    expect(calls).toBeGreaterThanOrEqual(4);
  });

  test("pausa depois de erros cresce, mas respeita o teto", async () => {
    const times: number[] = [];
    const loop = new PollingLoop(
      async () => {
        times.push(Date.now());
        throw new Error("sempre falha");
      },
      10,
      { pollIntervalMs: 20, maxErrorPauseMs: 60 },
    );

    loop.start();
    await waitFor(() => times.length >= 5);
    await loop.stop();

    const gaps = gapsOf(times);
    expect(Math.max(...gaps.slice(2))).toBeGreaterThan(Math.min(...gaps.slice(0, 1)) + 10); // cresce
    for (const gap of gaps) expect(gap).toBeLessThan(60 + 40); // teto (+ folga do timer)
  });

  test("stop() acorda a pausa na hora, sem esperar o intervalo", async () => {
    let calls = 0;
    const loop = new PollingLoop(
      async () => {
        calls++;
        return idle;
      },
      10,
      { pollIntervalMs: 60_000 },
    );

    loop.start();
    await waitFor(() => calls === 1);
    const started = Date.now();
    await loop.stop();

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).toBe(1);
  });

  test("stop() espera o ciclo em andamento terminar", async () => {
    let finished = false;
    let inCycle = false;
    const loop = new PollingLoop(
      async () => {
        inCycle = true;
        await tick(80);
        finished = true;
        return idle;
      },
      10,
      { pollIntervalMs: 60_000 },
    );

    loop.start();
    await waitFor(() => inCycle);
    await loop.stop();

    expect(finished).toBe(true);
  });

  test("start() duas vezes não cria dois laços; stop() sem start é inofensivo", async () => {
    let concurrent = 0;
    let peak = 0;
    const loop = new PollingLoop(
      async () => {
        peak = Math.max(peak, ++concurrent);
        await tick(10);
        concurrent--;
        return idle;
      },
      10,
      { pollIntervalMs: 5 },
    );

    await new PollingLoop(async () => idle, 10, { pollIntervalMs: 5 }).stop();
    loop.start();
    loop.start();
    await tick(80);
    await loop.stop();

    expect(peak).toBe(1);
  });

  test("depois de stop() nenhum ciclo novo começa", async () => {
    let calls = 0;
    const loop = new PollingLoop(
      async () => {
        calls++;
        return idle;
      },
      10,
      { pollIntervalMs: 5 },
    );

    loop.start();
    await waitFor(() => calls >= 2);
    await loop.stop();
    const frozen = calls;
    await tick(60);

    expect(calls).toBe(frozen);
  });
});

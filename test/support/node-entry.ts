/**
 * Ponto de entrada de um "nó" de teste: o MESMO `src/main.ts` de produção, num processo `bun`
 * próprio, com duas adições que só existem aqui:
 *
 * 1. `CRASH_POINT` / `CRASH_AFTER`: o processo se mata com SIGKILL (sem shutdown, sem finally) na
 *    N-ésima passagem por um ponto controlado. Os pontos são instalados por monkey-patch dos
 *    protótipos, então o código de produção não tem nenhum gancho de teste.
 * 2. Uma linha `SIGTERM` no stdin dispara o mesmo caminho do `SIGTERM` real. O Windows não tem
 *    sinais de verdade (`kill("SIGTERM")` mataria o processo na hora), e o teste precisa exercitar
 *    o shutdown gracioso do Nest.
 */
import "reflect-metadata";
import { MikroOrmInboxRepository } from "../../src/messaging/infrastructure/persistence/messaging.repositories";
import { SqsEventPublisher } from "../../src/messaging/infrastructure/sqs/sqs-event-publisher";
import { WagerMessageHandler } from "../../src/wagering/interfaces/sqs/wager-message.handler";

export const CRASH_POINTS = [
  "consumer_before_commit",
  "consumer_after_commit",
  "publisher_before_send",
  "publisher_after_send",
] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

const point = process.env.CRASH_POINT;
const crashAfter = Number(process.env.CRASH_AFTER ?? "1");
let hits = 0;

function die(): never {
  process.kill(process.pid, "SIGKILL");
  return process.exit(137); // só se o SIGKILL próprio não for suportado pela plataforma
}

const reached = (): boolean => ++hits >= crashAfter;

if (point !== undefined && !(CRASH_POINTS as readonly string[]).includes(point)) {
  throw new Error(`CRASH_POINT desconhecido: ${point}`);
}

if (point === "consumer_before_commit") {
  // Último passo da transação do consumidor (efeito + inbox já feitos), imediatamente antes do COMMIT.
  const original = MikroOrmInboxRepository.prototype.markProcessed;
  MikroOrmInboxRepository.prototype.markProcessed = async function (...args) {
    if (reached()) die();
    return original.apply(this, args);
  };
}

if (point === "consumer_after_commit") {
  // `handle` só devolve ACK depois do commit; o `DeleteMessage` (ack) vem depois do retorno.
  const original = WagerMessageHandler.prototype.handle;
  WagerMessageHandler.prototype.handle = async function (...args) {
    const disposition = await original.apply(this, args);
    if (disposition.action === "ACK" && reached()) die();
    return disposition;
  };
}

if (point === "publisher_before_send") {
  const original = SqsEventPublisher.prototype.publish;
  SqsEventPublisher.prototype.publish = async function (...args) {
    if (reached()) die();
    return original.apply(this, args);
  };
}

if (point === "publisher_after_send") {
  // O evento já está no SQS, mas a outbox ainda não foi marcada como publicada.
  const original = SqsEventPublisher.prototype.publish;
  SqsEventPublisher.prototype.publish = async function (...args) {
    await original.apply(this, args);
    if (reached()) die();
  };
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  if (chunk.includes("SIGTERM")) process.emit("SIGTERM", "SIGTERM");
});

await import("../../src/main");

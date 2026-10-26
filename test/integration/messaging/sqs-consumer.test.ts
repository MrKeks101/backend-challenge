import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type ConsumerHarness,
  drainDlq,
  startConsumerHarness,
  until,
  wagerMessage,
} from "../../support/consumer";
import { dropFirstAck } from "../../support/consumer-faults";
import { createTestDatabase, expectInvariants, type TestDatabase } from "../../support/database";
import { money } from "../../support/wagering-api";

/**
 * Consumidor SQS ponta a ponta: API real + consumidor ligado por APP_ROLES, PostgreSQL e SQS
 * (MiniStack) reais. Cada teste tem banco e filas próprios.
 */
let db: TestDatabase;
let h: ConsumerHarness;

beforeEach(async () => {
  db = await createTestDatabase({ poolMax: 40 });
  h = await startConsumerHarness(db);
});
afterEach(async () => {
  await h.close();
  await expectInvariants(db);
  await db.close();
});

const inboxRows = async (): Promise<{ message_id: string; processed: boolean }[]> =>
  db.sql("SELECT message_id, processed_at IS NOT NULL AS processed FROM inbox_messages");

const txByExternalId = async (externalId: string) => {
  const rows = await db.sql<Record<string, any>[]>(
    "SELECT * FROM wager_transactions WHERE external_transaction_id = ?",
    [externalId],
  );
  return rows[0];
};

/** Espera a fila de entrada esvaziar (processada e apagada) e a mensagem ter efeito no banco. */
const settled = () => until(() => h.inputIsEmpty(), 20_000, "fila de entrada vazia");

describe("mensagem válida", () => {
  test("BET via SQS: debita, grava inbox, emite eventos e apaga a mensagem", async () => {
    const wallet = await h.w.createWallet("100.00");
    const message = wagerMessage(h.w, wallet, {
      money: money("30.00"),
      externalTransactionId: "b1",
    });

    await h.send(message);
    await settled();

    expect(await h.w.balanceOf(wallet.id)).toBe("70.00");
    const tx = await txByExternalId(message.data.externalTransactionId as string);
    expect(tx?.status).toBe("PROCESSED");
    expect(await inboxRows()).toEqual([{ message_id: message.messageId, processed: true }]);
    // Processed pertence à transação; WalletBalanceChanged, à wallet (abertura + este débito).
    expect(await h.w.eventTypes(tx?.id)).toEqual(["WagerTransactionProcessed"]);
    expect(await h.w.eventTypes(wallet.id)).toEqual([
      "WalletBalanceChanged",
      "WalletBalanceChanged",
    ]);
    expect(await drainDlq(h.sqs, h.urls.transactionsDlq)).toEqual([]);
  });

  test("rejeição de negócio (saldo insuficiente) é resultado: persiste REJECTED e dá ack", async () => {
    const wallet = await h.w.createWallet("10.00");
    const message = wagerMessage(h.w, wallet, {
      money: money("80.00"),
      externalTransactionId: "b1",
    });

    await h.send(message);
    await settled();

    const tx = await txByExternalId(message.data.externalTransactionId as string);
    expect(tx?.status).toBe("REJECTED");
    expect(tx?.failure_code).toBe("INSUFFICIENT_FUNDS");
    expect(await h.w.balanceOf(wallet.id)).toBe("10.00");
    expect((await inboxRows())[0]?.processed).toBe(true);
    expect(await drainDlq(h.sqs, h.urls.transactionsDlq)).toEqual([]);
  });

  test("referência fora de ordem vira PENDING_REFERENCE (ack) e não vai à DLQ", async () => {
    const wallet = await h.w.createWallet("100.00");
    const message = wagerMessage(h.w, wallet, {
      kind: "REFUND",
      money: money("25.00"),
      externalTransactionId: "r1",
      referenceExternalTransactionId: "ainda-nao-chegou",
    });

    await h.send(message);
    await settled();

    const tx = await txByExternalId(message.data.externalTransactionId as string);
    expect(tx?.status).toBe("PENDING_REFERENCE");
    expect(await drainDlq(h.sqs, h.urls.transactionsDlq)).toEqual([]);
  });

  test("a mesma transação por HTTP e por SQS gera resultado idêntico", async () => {
    const viaHttp = await h.w.createWallet("100.00");
    const viaSqs = await h.w.createWallet("100.00");

    const http = await h.w.send(viaHttp, { money: money("35.00"), externalTransactionId: "same" });
    const message = wagerMessage(h.w, viaSqs, {
      money: money("35.00"),
      externalTransactionId: "same",
    });
    await h.send(message);
    await until(async () => (await h.w.ledgerCount(viaSqs.id)) === 2, 20_000, "efeito do SQS");

    expect(http.res.status).toBe(200);
    expect(await h.w.balanceOf(viaSqs.id)).toBe(await h.w.balanceOf(viaHttp.id));
    const ledger = (id: string) =>
      db.sql(
        "SELECT direction, amount, balance_before, balance_after FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY seq",
        [id],
      );
    expect(await ledger(viaSqs.id)).toEqual(await ledger(viaHttp.id));

    const statusOf = async (wallet: typeof viaHttp, scoped: string) =>
      (
        await db.sql<{ status: string; kind: string; amount: string }[]>(
          "SELECT status, kind, amount FROM wager_transactions WHERE wallet_id = ? AND external_transaction_id = ?",
          [wallet.id, scoped],
        )
      )[0];
    expect(await statusOf(viaSqs, message.data.externalTransactionId as string)).toEqual(
      await statusOf(viaHttp, http.body.externalTransactionId as string),
    );
    const eventTypes = async (wallet: typeof viaHttp) =>
      db.sql<{ event_type: string }[]>(
        "SELECT event_type FROM outbox_messages WHERE message_group_id = ? ORDER BY event_type",
        [wallet.id],
      );
    expect(await eventTypes(viaSqs)).toEqual(await eventTypes(viaHttp));
  });

  test("mesma key já usada por HTTP, mesmo payload: é replay (ack, sem novo débito)", async () => {
    const wallet = await h.w.createWallet("100.00");
    const http = await h.w.send(wallet, { money: money("20.00"), externalTransactionId: "dup" });
    expect(http.res.status).toBe(200);

    await h.send(
      wagerMessage(h.w, wallet, { money: money("20.00"), externalTransactionId: "dup" }),
    );
    await settled();

    expect(await h.w.balanceOf(wallet.id)).toBe("80.00");
    expect(await h.w.ledgerCount(wallet.id)).toBe(2); // abertura + 1 débito
    expect(await drainDlq(h.sqs, h.urls.transactionsDlq)).toEqual([]);
  });
});

describe("redelivery e deduplicação (inbox)", () => {
  test("a mesma mensagem 20 vezes ao mesmo tempo: um único débito", async () => {
    const wallet = await h.w.createWallet("100.00");
    const message = wagerMessage(h.w, wallet, {
      money: money("10.00"),
      externalTransactionId: "b1",
    });

    // Dedup ids distintos: o FIFO não descarta, então o consumidor recebe as 20 cópias.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => h.send(message, { dedup: `copy-${i}` })),
    );
    await settled();

    expect(await h.w.balanceOf(wallet.id)).toBe("90.00");
    expect(await h.w.ledgerCount(wallet.id)).toBe(2);
    expect(await inboxRows()).toHaveLength(1);
    expect(await drainDlq(h.sqs, h.urls.transactionsDlq)).toEqual([]);
  });

  test("messageId novo com a mesma key e payload (produtor reenviou): replay, um débito", async () => {
    const wallet = await h.w.createWallet("100.00");
    const first = wagerMessage(h.w, wallet, { money: money("10.00"), externalTransactionId: "b1" });
    const again = { ...first, messageId: `${first.messageId}-reenvio` };

    await h.send(first);
    await h.send(again);
    await settled();

    expect(await h.w.balanceOf(wallet.id)).toBe("90.00");
    expect(await inboxRows()).toHaveLength(2);
    expect(await drainDlq(h.sqs, h.urls.transactionsDlq)).toEqual([]);
  });

  test("mesmo messageId com payload diferente vai para a DLQ e não vira débito", async () => {
    const wallet = await h.w.createWallet("100.00");
    const first = wagerMessage(h.w, wallet, { money: money("10.00"), externalTransactionId: "b1" });
    const tampered = {
      ...first,
      data: { ...first.data, money: money("90.00") },
    };

    await h.send(first);
    await until(async () => (await inboxRows()).length === 1 && (await h.inputIsEmpty()));
    await h.send(tampered);
    await settled();

    expect(await h.w.balanceOf(wallet.id)).toBe("90.00");
    const [letter, ...rest] = await drainDlq(h.sqs, h.urls.transactionsDlq);
    expect(rest).toEqual([]);
    expect(letter?.attrs.errorReason).toBe("MESSAGE_PAYLOAD_MISMATCH");
    expect(JSON.parse(letter?.body ?? "{}")).toEqual(tampered);
  });

  test("worker morto depois do commit e antes do ack: a mensagem volta e não duplica o efeito", async () => {
    const wallet = await h.w.createWallet("100.00");
    const message = wagerMessage(h.w, wallet, {
      money: money("40.00"),
      externalTransactionId: "b1",
    });

    // O ack é derrubado só na 1ª vez: o efeito já commitou, mas a mensagem fica na fila.
    const dropped = dropFirstAck(h);
    await h.send(message);
    await until(() => dropped.count() >= 1, 20_000, "primeiro ack derrubado");
    await settled(); // reentregue, vista como duplicata na inbox e agora apagada de verdade

    expect(await h.w.balanceOf(wallet.id)).toBe("60.00");
    expect(await h.w.ledgerCount(wallet.id)).toBe(2);
    expect(await inboxRows()).toHaveLength(1);
    expect(dropped.count()).toBe(1);
    expect(await drainDlq(h.sqs, h.urls.transactionsDlq)).toEqual([]);
  });
});

import type { Money } from "../../src/shared/kernel";
import {
  decideWagerOutcome,
  type FailureCode,
  WagerTransaction,
  WagerTransactionKind,
} from "../../src/wagering/domain";
import { LedgerDirection, Wallet } from "../../src/wallet/domain";
import type { TestDatabase } from "./database";
import { brl } from "./money";
import { at } from "./wagering";

/** Abre e persiste uma wallet (com a transação OPENING e o lançamento de abertura) numa só transação. */
export async function openWalletInDb(
  db: TestDatabase,
  balance: string,
  overrides: { playerId?: string } = {},
): Promise<Wallet> {
  const { wallet, openingEntry } = Wallet.open({
    id: db.ids.next(),
    playerId: overrides.playerId ?? db.ids.next(),
    initialBalance: brl(balance),
    createdAt: at(0),
    ...(brl(balance).isZero()
      ? {}
      : { opening: { entryId: db.ids.next(), transactionId: db.ids.next() } }),
  });
  await db.uow.run(async () => {
    if (!(await db.wallets.insert(wallet))) throw new Error("wallet duplicada");
    if (openingEntry) {
      const opening = WagerTransaction.createOpening({
        id: openingEntry.transactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: openingEntry.money,
        createdAt: at(0),
      });
      if (!(await db.transactions.claim(opening))) throw new Error("opening duplicada");
      opening.markProcessed(undefined, at(0), openingEntry.balanceAfter);
      await db.transactions.update(opening, at(0));
      await db.ledger.append(openingEntry);
    }
  });
  return wallet;
}

export interface Applied {
  status: string;
  failureCode?: FailureCode;
  balance: Money;
}

/**
 * Versão mínima do caso de uso (o de verdade é o M7): reivindica, trava a wallet, decide e persiste.
 * Existe aqui para exercitar a persistência de ponta a ponta com o domínio real.
 */
export async function applyInDb(
  db: TestDatabase,
  tx: WagerTransaction,
  now = at(5),
): Promise<Applied> {
  return db.uow.run(async () => {
    const created = await db.transactions.claim(tx);
    if (!created) throw new Error("transação já existia (replay) — fora do escopo do helper");

    const wallet = await db.wallets.findByIdForUpdate(tx.walletId);
    if (!wallet) throw new Error("wallet inexistente");
    const reference = tx.referenceExternalTransactionId
      ? await db.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId)
      : null;
    const reversed = reference ? await db.transactions.hasProcessedReversal(reference.id) : false;

    const outcome = decideWagerOutcome({
      transaction: tx,
      wallet,
      reference,
      referenceAlreadyReversed: reversed,
    });
    if (outcome.type === "PENDING_REFERENCE") {
      tx.markPendingReference(new Date(now.getTime() + 2_000));
    } else if (outcome.type === "REJECTED") {
      tx.reject(outcome.code, wallet.balance, now);
    } else {
      if (outcome.direction !== null) {
        const expectedVersion = wallet.version;
        const movement = { entryId: db.ids.next(), transactionId: tx.id, money: tx.money, at: now };
        const entry =
          outcome.direction === LedgerDirection.Debit
            ? wallet.debit(movement)
            : wallet.credit(movement);
        await db.wallets.save(wallet, expectedVersion);
        await db.ledger.append(entry);
      }
      tx.markProcessed(outcome.referenceTransactionId, now, wallet.balance);
    }
    await db.transactions.update(tx, now);
    return {
      status: tx.status,
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
      balance: wallet.balance,
    };
  });
}

export const KIND = WagerTransactionKind;

/** Transação nova (PENDING) para a wallet, com ids UUID reais e valores padrão coerentes. */
export function newTx(
  db: TestDatabase,
  wallet: Wallet,
  overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${db.ids.next()}`;
  return WagerTransaction.create({
    id: db.ids.next(),
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: WagerTransactionKind.Bet,
    money: brl("10.00"),
    createdAt: at(1),
    ...overrides,
  });
}

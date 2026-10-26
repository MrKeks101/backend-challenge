import type { OutboxRepository } from "../../src/messaging/application/ports/messaging-repositories";
import type { OutboxMessage } from "../../src/messaging/domain";
import type { UnitOfWork } from "../../src/shared/application/unit-of-work";
import { OptimisticLockError } from "../../src/shared/infrastructure/persistence/errors";
import type { Clock, IdGenerator } from "../../src/shared/kernel";
import { PendingReferenceReprocessor } from "../../src/wagering/application/pending-reference-reprocessor";
import type { PendingReferenceSettings } from "../../src/wagering/application/pending-reference-settings";
import type { WagerTransactionRepository } from "../../src/wagering/application/ports/wager-transaction-repository";
import { ProcessWagerTransactionUseCase } from "../../src/wagering/application/process-wager-transaction.use-case";
import { ReprocessPendingTransactionUseCase } from "../../src/wagering/application/reprocess-pending-transaction.use-case";
import { WagerOutcomeApplier } from "../../src/wagering/application/wager-outcome-applier";
import {
  DEFAULT_PENDING_REFERENCE_CONFIG,
  WagerTransaction,
  type WagerTransactionState,
  WagerTransactionStatus,
} from "../../src/wagering/domain";
import type {
  LedgerRepository,
  WalletRepository,
} from "../../src/wallet/application/ports/wallet-repositories";
import { Wallet, type WalletLedgerEntry } from "../../src/wallet/domain";
import { brl } from "./money";
import { T0 } from "./wagering";

/**
 * Mundo em memória para testar casos de uso SEM banco (testes de unidade): as mesmas portas que o
 * PostgreSQL implementa, com a semântica que importa para a lógica — estado copiado a cada leitura
 * (como um SELECT), `UPDATE … WHERE status IN (PENDING, PENDING_REFERENCE)`, lock otimista da
 * wallet e transações serializadas (equivale a um lock global, mais conservador que o real).
 * A prova com PostgreSQL de verdade fica na suíte de integração/concorrência (M12).
 */
export class MutableClock implements Clock {
  constructor(private current: Date = T0) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(date: Date): void {
    this.current = date;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

class SequentialIds implements IdGenerator {
  private n = 0;
  next(): string {
    return `id-${++this.n}`;
  }
}

function snapshot(tx: WagerTransaction): WagerTransactionState {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money,
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    createdAt: tx.createdAt,
    status: tx.status,
    referenceTransactionId: tx.referenceTransactionId,
    failureCode: tx.failureCode,
    processedAt: tx.processedAt,
    observedBalance: tx.observedBalance,
    attempts: tx.attempts,
    nextAttemptAt: tx.nextAttemptAt,
  };
}

class InMemoryTransactions implements WagerTransactionRepository {
  readonly rows = new Map<string, WagerTransactionState>();
  /** Ids passados a `update`, em ordem: prova que a mudança foi persistida (não só mutada). */
  readonly updates: string[] = [];

  private read(state: WagerTransactionState | undefined): WagerTransaction | null {
    return state ? WagerTransaction.rehydrate({ ...state }) : null;
  }

  async claim(transaction: WagerTransaction): Promise<boolean> {
    for (const row of this.rows.values()) {
      if (
        row.idempotencyKey === transaction.idempotencyKey ||
        (row.providerId === transaction.providerId &&
          row.externalTransactionId === transaction.externalTransactionId)
      ) {
        return false;
      }
    }
    this.rows.set(transaction.id, snapshot(transaction));
    return true;
  }

  async findById(id: string) {
    return this.read(this.rows.get(id));
  }

  async findByIdempotencyKey(key: string) {
    return this.read([...this.rows.values()].find((r) => r.idempotencyKey === key));
  }

  async findByExternalId(providerId: string, externalTransactionId: string) {
    return this.read(
      [...this.rows.values()].find(
        (r) => r.providerId === providerId && r.externalTransactionId === externalTransactionId,
      ),
    );
  }

  async update(transaction: WagerTransaction, _at: Date): Promise<void> {
    const stored = this.rows.get(transaction.id);
    if (
      !stored ||
      (stored.status !== WagerTransactionStatus.Pending &&
        stored.status !== WagerTransactionStatus.PendingReference)
    ) {
      throw new OptimisticLockError(`transaction ${transaction.id} is already terminal or missing`);
    }
    this.updates.push(transaction.id);
    this.rows.set(transaction.id, snapshot(transaction));
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    return [...this.rows.values()].some(
      (r) =>
        r.referenceTransactionId === referenceTransactionId &&
        r.status === WagerTransactionStatus.Processed,
    );
  }

  async claimDue(now: Date, limit: number, leaseMs: number): Promise<WagerTransaction[]> {
    const due = [...this.rows.values()]
      .filter(
        (r) =>
          r.status === WagerTransactionStatus.PendingReference &&
          (r.nextAttemptAt?.getTime() ?? 0) <= now.getTime(),
      )
      .sort(
        (a, b) =>
          (a.nextAttemptAt?.getTime() ?? 0) - (b.nextAttemptAt?.getTime() ?? 0) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, limit);
    for (const row of due) row.nextAttemptAt = new Date(now.getTime() + leaseMs);
    return due.map((row) => WagerTransaction.rehydrate({ ...row }));
  }

  async wakeDependents(providerId: string, externalTransactionId: string, now: Date) {
    let woken = 0;
    for (const row of this.rows.values()) {
      if (
        row.providerId === providerId &&
        row.referenceExternalTransactionId === externalTransactionId &&
        row.status === WagerTransactionStatus.PendingReference &&
        (row.nextAttemptAt?.getTime() ?? 0) > now.getTime()
      ) {
        row.nextAttemptAt = now;
        woken++;
      }
    }
    return woken;
  }
}

class InMemoryWallets implements WalletRepository {
  readonly rows = new Map<string, ReturnType<typeof walletState>>();

  async insert(wallet: Wallet): Promise<boolean> {
    if (this.rows.has(wallet.id)) return false;
    this.rows.set(wallet.id, walletState(wallet));
    return true;
  }
  async findById(id: string) {
    const row = this.rows.get(id);
    return row ? Wallet.rehydrate({ ...row }) : null;
  }
  async findByIdForUpdate(id: string) {
    return this.findById(id);
  }
  async findByPlayerAndCurrency(playerId: string, currency: string) {
    const row = [...this.rows.values()].find(
      (r) => r.playerId === playerId && r.currency === currency,
    );
    return row ? Wallet.rehydrate({ ...row }) : null;
  }
  async save(wallet: Wallet, expectedVersion: number): Promise<void> {
    const stored = this.rows.get(wallet.id);
    if (!stored || stored.version !== expectedVersion) {
      throw new OptimisticLockError(`wallet ${wallet.id} was modified concurrently`);
    }
    this.rows.set(wallet.id, walletState(wallet));
  }
}

const walletState = (wallet: Wallet) => ({
  id: wallet.id,
  playerId: wallet.playerId,
  currency: wallet.currency,
  balance: wallet.balance,
  version: wallet.version,
  createdAt: wallet.createdAt,
  updatedAt: wallet.updatedAt,
});

class InMemoryLedger implements LedgerRepository {
  readonly entries: WalletLedgerEntry[] = [];
  async append(entry: WalletLedgerEntry) {
    this.entries.push(entry);
  }
  async findByTransaction(walletId: string, transactionId: string) {
    return (
      this.entries.find((e) => e.walletId === walletId && e.transactionId === transactionId) ?? null
    );
  }
  async findLast(walletId: string) {
    return [...this.entries].reverse().find((e) => e.walletId === walletId) ?? null;
  }
  async page(): Promise<never> {
    throw new Error("not used");
  }
  async summarize(): Promise<never> {
    throw new Error("not used");
  }
}

class InMemoryOutbox implements OutboxRepository {
  readonly messages: OutboxMessage[] = [];
  async add(message: OutboxMessage) {
    this.messages.push(message);
  }
  async findById(id: string) {
    return this.messages.find((m) => m.id === id) ?? null;
  }
  async claimDue(): Promise<never> {
    throw new Error("not used");
  }
  async markPublished(): Promise<never> {
    throw new Error("not used");
  }
  async saveRetry(): Promise<never> {
    throw new Error("not used");
  }
}

/** Transações do UoW em memória: uma de cada vez (como se a wallet inteira fosse travada). */
class SerialUnitOfWork implements UnitOfWork {
  private tail: Promise<unknown> = Promise.resolve();
  runs = 0;
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.runs++;
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export interface WorldOptions {
  balance?: string;
  /** Sobrescreve a política de espera pela referência (padrão: 10 tentativas, 2 s…5 min, TTL 1 h). */
  policy?: Partial<PendingReferenceSettings["policy"]>;
  batchSize?: number;
  leaseMs?: number;
}

export class InMemoryWorld {
  readonly clock = new MutableClock();
  readonly ids = new SequentialIds();
  readonly uow = new SerialUnitOfWork();
  readonly transactions = new InMemoryTransactions();
  readonly wallets = new InMemoryWallets();
  readonly ledger = new InMemoryLedger();
  readonly outbox = new InMemoryOutbox();
  readonly settings: PendingReferenceSettings;

  constructor(private readonly options: WorldOptions = {}) {
    this.settings = {
      policy: { ...DEFAULT_PENDING_REFERENCE_CONFIG, ...options.policy },
      jitter: () => 1,
    };
    const wallet = Wallet.rehydrate({
      id: "wallet-1",
      playerId: "player-1",
      currency: "BRL",
      balance: brl(options.balance ?? "100.00"),
      version: 1,
      createdAt: T0,
      updatedAt: T0,
    });
    this.wallets.rows.set(wallet.id, walletState(wallet));
  }

  /** Módulos novos sobre o MESMO estado: simula reinício do processo / outra instância. */
  build() {
    const applier = new WagerOutcomeApplier(
      this.transactions,
      this.wallets,
      this.ledger,
      this.outbox,
      this.ids,
      this.settings,
    );
    const process = new ProcessWagerTransactionUseCase(
      this.uow,
      this.transactions,
      this.wallets,
      applier,
      this.clock,
      this.ids,
    );
    const reprocess = new ReprocessPendingTransactionUseCase(
      this.uow,
      this.transactions,
      this.wallets,
      applier,
      this.clock,
      this.settings,
    );
    const reprocessor = new PendingReferenceReprocessor(
      this.uow,
      this.transactions,
      reprocess,
      this.clock,
      { batchSize: this.options.batchSize ?? 20, leaseMs: this.options.leaseMs ?? 60_000 },
    );
    return { applier, process, reprocess, reprocessor };
  }

  balance(): string {
    const row = this.wallets.rows.get("wallet-1");
    return row ? row.balance.toJSON().amount : "?";
  }

  stateOf(externalId: string): WagerTransactionState | undefined {
    return [...this.transactions.rows.values()].find((r) => r.externalTransactionId === externalId);
  }

  eventTypes(): string[] {
    return this.outbox.messages.map((m) => m.eventType);
  }

  /** Σ ledger == saldo (a invariante central, também nos testes de unidade). */
  assertLedgerMatchesBalance(): void {
    const net = this.ledger.entries.reduce((sum, e) => {
      const amount = Number(e.money.toJSON().amount) * 100; // allow-number: teste, centavos pequenos
      return sum + (e.direction === "CREDIT" ? amount : -amount);
    }, 0);
    const balance = Number(this.balance()) * 100; // allow-number: teste, centavos pequenos
    const opening = Number("100.00") * 100; // allow-number: teste
    if (Math.round(balance - opening) !== Math.round(net)) {
      throw new Error(`saldo ${balance} != abertura ${opening} + ledger ${net}`);
    }
  }
}

import type { Money } from "../../../shared/kernel";
import type { Wallet, WalletLedgerEntry } from "../../domain";

export const WALLET_REPOSITORY = Symbol("WalletRepository");
export const LEDGER_REPOSITORY = Symbol("LedgerRepository");

export interface WalletRepository {
  /** `false` quando já existe wallet para `(playerId, currency)`; nada é gravado. */
  insert(wallet: Wallet): Promise<boolean>;
  findById(id: string): Promise<Wallet | null>;
  /** `SELECT … FOR NO KEY UPDATE` (não conflita com o share lock das FKs). Exige transação. */
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  /**
   * Grava saldo/versão/horário com `WHERE version = :expectedVersion`.
   * Lança `OptimisticLockError` se a versão no banco já não for a esperada.
   */
  save(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface LedgerPageItem {
  /** Posição estável no ledger (base do cursor). */
  seq: string;
  entry: WalletLedgerEntry;
}

export interface LedgerPage {
  items: LedgerPageItem[];
  /** `seq` do último item quando há mais páginas; `null` na última. */
  nextBeforeSeq: string | null;
}

/** Totais do ledger de uma wallet, para a reconciliação. */
export interface LedgerSummary {
  entries: number;
  /** Créditos − débitos (pode ser negativo se o ledger estiver corrompido). */
  net: Money;
}

export interface LedgerRepository {
  /** Append-only: não existe update nem delete. */
  append(entry: WalletLedgerEntry): Promise<void>;
  findByTransaction(walletId: string, transactionId: string): Promise<WalletLedgerEntry | null>;
  findLast(walletId: string): Promise<WalletLedgerEntry | null>;
  /** Do mais novo para o mais antigo; `beforeSeq` exclusivo. */
  page(walletId: string, options: { limit: number; beforeSeq?: string }): Promise<LedgerPage>;
  /** Soma o ledger inteiro da wallet no banco (uma consulta). `currency` é a moeda da wallet. */
  summarize(walletId: string, currency: string): Promise<LedgerSummary>;
}

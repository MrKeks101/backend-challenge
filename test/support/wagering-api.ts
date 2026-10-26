import { expect } from "bun:test";
import { v7 } from "uuid";
import type { TestDatabase } from "./database";
import type { ApiResponse, TestApi } from "./http-app";

export const money = (amount: string, currency = "BRL") => ({ amount, currency });

export interface ApiWallet {
  id: string;
  playerId: string;
}

export type SubmitBody = Record<string, unknown>;

/** Helpers de alto nível sobre a API real, para os testes de processamento de transações. */
export class WageringApi {
  constructor(
    readonly api: Pick<TestApi, "request">,
    readonly db: TestDatabase,
  ) {}

  async createWallet(balance = "100.00", currency = "BRL"): Promise<ApiWallet> {
    const res = await this.api.request("POST", "/wallets", {
      body: { playerId: v7(), initialBalance: money(balance, currency) },
    });
    expect(res.status).toBe(201);
    return { id: res.body.id, playerId: res.body.playerId };
  }

  /**
   * `(providerId, externalTransactionId)` é único no banco inteiro, então os nomes curtos dos
   * testes ("b1") são escopados pela wallet: dois testes nunca colidem por acidente.
   */
  scoped(wallet: ApiWallet, name: string): string {
    return `${name}@${wallet.id}`;
  }

  /** Corpo válido para a wallet; `overrides` sobrescreve (ou remove, com `undefined`) campos. */
  body(wallet: ApiWallet, overrides: SubmitBody = {}): SubmitBody {
    const scope = (value: unknown) =>
      typeof value === "string" ? this.scoped(wallet, value) : value;
    const merged: SubmitBody = {
      providerId: "provider-a",
      externalTransactionId: `ext-${v7()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: "BET",
      money: money("25.00"),
      ...overrides,
    };
    if ("externalTransactionId" in overrides) {
      merged.externalTransactionId = scope(overrides.externalTransactionId);
    }
    if ("referenceExternalTransactionId" in overrides) {
      merged.referenceExternalTransactionId = scope(overrides.referenceExternalTransactionId);
    }
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
    return merged;
  }

  /** A key padrão recomendada: `{providerId}:{externalTransactionId}`. */
  defaultKey(body: SubmitBody): string {
    return `${body.providerId}:${body.externalTransactionId}`;
  }

  submit(body: SubmitBody, key: string | null = this.defaultKey(body)): Promise<ApiResponse> {
    return this.api.request("POST", "/wagering/transactions", {
      body,
      headers: key === null ? {} : { "idempotency-key": key },
    });
  }

  /** Atalho: cria o corpo, envia e devolve também o corpo enviado. */
  async send(wallet: ApiWallet, overrides: SubmitBody = {}) {
    const body = this.body(wallet, overrides);
    const res = await this.submit(body);
    return { body, res };
  }

  async balanceOf(walletId: string): Promise<string> {
    const rows = await this.db.sql<{ balance: string }[]>(
      "SELECT balance FROM wallets WHERE id = ?",
      [walletId],
    );
    return rows[0]?.balance ?? "?";
  }

  async count(table: string, where = "true", params: unknown[] = []): Promise<number> {
    const rows = await this.db.sql<{ n: string }[]>(
      `SELECT count(*)::text AS n FROM ${table} WHERE ${where}`,
      params,
    );
    return Number(rows[0]?.n);
  }

  ledgerCount(walletId: string): Promise<number> {
    return this.count("wallet_ledger_entries", "wallet_id = ?", [walletId]);
  }

  async eventTypes(aggregateId: string): Promise<string[]> {
    const rows = await this.db.sql<{ event_type: string }[]>(
      "SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY event_type",
      [aggregateId],
    );
    return rows.map((r) => r.event_type);
  }

  async row(transactionId: string): Promise<Record<string, any>> {
    const rows = await this.db.sql<Record<string, any>[]>(
      "SELECT * FROM wager_transactions WHERE id = ?",
      [transactionId],
    );
    return rows[0] ?? {};
  }
}

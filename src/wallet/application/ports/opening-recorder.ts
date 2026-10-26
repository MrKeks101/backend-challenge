import type { Wallet, WalletLedgerEntry } from "../../domain";

export const OPENING_RECORDER = Symbol("OpeningRecorder");

export interface RecordOpeningInput {
  wallet: Wallet;
  /** Lançamento `CREDIT` de abertura; seu `transactionId` identifica a transação OPENING. */
  entry: WalletLedgerEntry;
  correlationId: string;
  at: Date;
}

/**
 * Porta para o contexto de Wagering registrar a transação `OPENING` (já `PROCESSED`) e os eventos
 * de integração da abertura. Roda DENTRO da transação do chamador: a wallet já foi inserida e o
 * lançamento ainda não (a FK do ledger exige que a transação exista antes).
 */
export interface OpeningRecorder {
  recordOpening(input: RecordOpeningInput): Promise<void>;
}

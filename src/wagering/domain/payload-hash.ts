import { hashCanonical, type Money } from "../../shared/kernel";
import type { WagerTransactionKind } from "./wager-transaction-kind";

/**
 * Campos de NEGÓCIO que identificam o pedido. Fora do hash (de propósito): a `Idempotency-Key`,
 * `messageId`, `occurredAt`, `correlationId` e qualquer metadado de transporte (AR-39).
 */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * SHA-256 (hex) do JSON canônico do payload de negócio. Um campo ausente entra como `null`
 * explícito, nunca omitido, para que "ausente" tenha uma única representação.
 */
export function computePayloadHash(payload: WagerPayload): string {
  return hashCanonical({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: payload.money,
    referenceExternalTransactionId: payload.referenceExternalTransactionId ?? null,
  });
}

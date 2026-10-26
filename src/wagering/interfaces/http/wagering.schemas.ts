import { z } from "zod";
import { moneyInput, uuid } from "../../../shared/interfaces/http/schemas";
import { WagerTransactionKind as Kind } from "../../domain";

const providerText = z.string().min(1).max(200);

/** `OPENING` é interno: não é aceito pela API (fica fora do enum, então vira 400). */
const SUBMITTABLE_KINDS = [Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback] as const;

export const submitTransactionBody = z
  .object({
    providerId: providerText,
    externalTransactionId: providerText,
    playerId: uuid,
    walletId: uuid,
    roundId: providerText,
    gameId: providerText,
    kind: z.enum(SUBMITTABLE_KINDS),
    money: moneyInput,
    referenceExternalTransactionId: providerText.optional(),
  })
  .strict();

/** ASCII imprimível, 1–200 caracteres e não só espaços (RF-API-08, AR-38). */
export const idempotencyKeyHeader = z
  .string()
  .regex(/^[\x20-\x7E]{1,200}$/, "must be 1 to 200 printable ASCII characters")
  .refine((value) => value.trim().length > 0, "must not be blank");

export const transactionIdParam = z.object({ transactionId: uuid });

export const providerTransactionParams = z.object({
  providerId: providerText,
  externalTransactionId: providerText,
});

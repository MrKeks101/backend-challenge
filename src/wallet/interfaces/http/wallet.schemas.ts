import { z } from "zod";
import { moneyInput, uuid } from "../../../shared/interfaces/http/schemas";

export const createWalletBody = z
  .object({
    playerId: uuid,
    initialBalance: moneyInput,
  })
  .strict();

export const walletIdParam = z.object({ walletId: uuid });

export const ledgerQuery = z.object({
  cursor: z.string().min(1).max(256).optional(),
  limit: z
    .string()
    .regex(/^[0-9]{1,3}$/, "must be an integer between 1 and 200")
    .transform((value) => Number.parseInt(value, 10)) // allow-number: tamanho de página, não é dinheiro
    .refine((value) => value >= 1 && value <= 200, "must be an integer between 1 and 200")
    .default(50),
});

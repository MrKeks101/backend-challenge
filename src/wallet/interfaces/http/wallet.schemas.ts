import { z } from "zod";
import { isUuid } from "../../../shared/kernel";

const uuid = z.string().refine(isUuid, "must be a UUID");

const money = z
  .object({
    amount: z.string().max(40),
    currency: z.string().max(3),
  })
  .strict();

export const createWalletBody = z
  .object({
    playerId: uuid,
    initialBalance: money,
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

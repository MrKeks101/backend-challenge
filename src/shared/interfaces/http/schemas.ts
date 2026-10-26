import { z } from "zod";
import { isUuid } from "../../kernel";

export const uuid = z.string().refine(isUuid, "must be a UUID");

/** `{ amount, currency }` de entrada. O formato exato (2 casas, moeda ISO) é validado por `Money.from`. */
export const moneyInput = z
  .object({
    amount: z.string().max(40),
    currency: z.string().max(3),
  })
  .strict();

import { z } from "zod";
import { idempotencyKeyHeader, submitTransactionBody } from "../http/wagering.schemas";

export const WAGER_REQUESTED_TYPE = "WagerTransactionRequested";

/**
 * Mensagem `WagerTransactionRequested` (README, RF-SQS-02). O `data` é o mesmo corpo da API HTTP
 * mais a `idempotencyKey` (que no HTTP vem em header), para a fila e a API serem equivalentes.
 */
export const wagerRequestedMessage = z
  .object({
    messageId: z.string().min(1).max(200),
    type: z.literal(WAGER_REQUESTED_TYPE),
    occurredAt: z.iso.datetime(),
    data: submitTransactionBody.extend({ idempotencyKey: idempotencyKeyHeader }),
  })
  .strict();

export type WagerRequestedMessage = z.infer<typeof wagerRequestedMessage>;

export type ParsedMessage =
  | { ok: true; message: WagerRequestedMessage }
  | { ok: false; detail: string };

/** JSON + schema. O `detail` lista só caminhos e códigos do erro: nunca ecoa valores recebidos. */
export function parseWagerMessage(body: string): ParsedMessage {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, detail: "body is not valid JSON" };
  }
  const parsed = wagerRequestedMessage.safeParse(json);
  if (parsed.success) return { ok: true, message: parsed.data };
  const detail = parsed.error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
    .join("; ");
  return { ok: false, detail };
}

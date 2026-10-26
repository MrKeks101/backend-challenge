import { InvalidCursorError } from "./errors";

interface CursorPayload {
  /** Versão do formato, para poder evoluí-lo sem quebrar cursores em circulação. */
  v: 1;
  /** Wallet dona do cursor: um cursor de outra wallet é recusado. */
  w: string;
  /** `seq` do último item entregue; a próxima página começa antes dele. */
  s: string;
}

const SEQ = /^[0-9]{1,18}$/;

/**
 * Cursor opaco: base64url de um JSON pequeno. Estável porque `seq` é a identidade do ledger, que
 * só cresce e é atribuída sob o lock da wallet (a ordem de `seq` é a ordem de commit por wallet).
 * Não é assinado: adulterá-lo só muda a posição de leitura de dados que o chamador já pode ler.
 */
export function encodeLedgerCursor(walletId: string, seq: string): string {
  const payload: CursorPayload = { v: 1, w: walletId, s: seq };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeLedgerCursor(cursor: string, walletId: string): string {
  let payload: Partial<CursorPayload>;
  try {
    payload = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<CursorPayload>;
  } catch {
    throw new InvalidCursorError();
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    payload.v !== 1 ||
    payload.w !== walletId ||
    typeof payload.s !== "string" ||
    !SEQ.test(payload.s)
  ) {
    throw new InvalidCursorError();
  }
  return payload.s;
}

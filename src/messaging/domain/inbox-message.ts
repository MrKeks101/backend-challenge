import { InvalidArgumentError, requireDate, requireText } from "../../shared/kernel";
import { InvalidMessageStateError } from "./errors";

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  /** SHA-256 hex (64 caracteres) do conteúdo de negócio da mensagem. */
  payloadHash: string;
  receivedAt: Date;
}

/** Estado persistido. `rehydrate` o aceita como está, sem revalidar. */
export interface InboxMessageState extends ReceiveInboxProps {
  processedAt: Date | undefined;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Registro de mensagem consumida, base da deduplicação persistente por `(consumerName, messageId)`.
 * Nasce junto da transação financeira e é marcada como processada na MESMA transação SQL.
 */
export class InboxMessage {
  private readonly _receivedAt: Date;
  private _processedAt: Date | undefined;

  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    receivedAt: Date,
    processedAt: Date | undefined,
  ) {
    this._receivedAt = new Date(receivedAt.getTime());
    this._processedAt = processedAt ? new Date(processedAt.getTime()) : undefined;
  }

  static receive(props: ReceiveInboxProps): InboxMessage {
    const payloadHash = requireText(props.payloadHash, "payloadHash");
    if (!SHA256_HEX.test(payloadHash)) {
      throw new InvalidArgumentError("payloadHash must be a lowercase SHA-256 hex digest");
    }
    return new InboxMessage(
      requireText(props.messageId, "messageId"),
      requireText(props.consumerName, "consumerName"),
      payloadHash,
      requireDate(props.receivedAt, "receivedAt"),
      undefined,
    );
  }

  /** Reconstrução a partir da persistência. NÃO revalida. */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get receivedAt(): Date {
    return new Date(this._receivedAt.getTime());
  }

  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt.getTime()) : undefined;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidMessageStateError("inbox message was already processed");
    }
    this._processedAt = requireDate(at, "at");
  }

  /** A mesma `messageId` chegando com conteúdo diferente é anomalia, não duplicata. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }
}

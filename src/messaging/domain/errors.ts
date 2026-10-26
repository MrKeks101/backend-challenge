import { DomainError } from "../../shared/kernel";

/** Mensagem de inbox/outbox já em estado terminal (processada/publicada) sendo alterada de novo. */
export class InvalidMessageStateError extends DomainError {
  readonly code = "INVALID_MESSAGE_STATE";
}

/** O mesmo `messageId` chegou com conteúdo diferente: anomalia do produtor, não duplicata. */
export class MessagePayloadMismatchError extends DomainError {
  readonly code = "MESSAGE_PAYLOAD_MISMATCH";

  constructor() {
    super("message id was already received with a different payload");
  }
}

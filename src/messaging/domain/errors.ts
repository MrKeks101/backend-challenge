import { DomainError } from "../../shared/kernel";

/** Mensagem de inbox/outbox já em estado terminal (processada/publicada) sendo alterada de novo. */
export class InvalidMessageStateError extends DomainError {
  readonly code = "INVALID_MESSAGE_STATE";
}

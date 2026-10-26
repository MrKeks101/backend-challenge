export const MESSAGE_HANDLER = Symbol("MessageHandler");

/** O que o consumidor deve fazer com a mensagem depois de o handler terminar. */
export type Disposition =
  /** Efeito já commitado (ou terminal): apagar da fila. */
  | { action: "ACK"; outcome: string }
  /** Falha transitória: NÃO apagar; tornar visível de novo depois de um backoff. */
  | { action: "RETRY"; reason: string }
  /** Falha permanente: enviar à DLQ com os atributos de erro e apagar da fila de entrada. */
  | { action: "DEAD_LETTER"; reason: string; detail?: string };

export interface IncomingMessage {
  /** Corpo bruto, como veio do SQS. */
  body: string;
  /** `ApproximateReceiveCount`: quantas vezes o SQS já entregou esta mensagem (>= 1). */
  receiveCount: number;
}

export interface MessageHandler {
  /**
   * Nunca lança por falha de processamento: devolve a `Disposition`. O `ack` só é decidido depois
   * do COMMIT, então um `ACK` aqui significa que o efeito já está no banco.
   */
  handle(message: IncomingMessage): Promise<Disposition>;
}

import { AsyncLocalStorage } from "node:async_hooks";

/** Campos que acompanham TODO log emitido enquanto uma requisição/mensagem está sendo processada. */
export interface LogContext {
  correlationId?: string | undefined;
  messageId?: string | undefined;
  transactionId?: string | undefined;
  walletId?: string | undefined;
  providerId?: string | undefined;
}

const storage = new AsyncLocalStorage<LogContext>();

const defined = (context: LogContext): LogContext =>
  Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined));

/**
 * Contexto de log por requisição HTTP ou mensagem SQS (RNF-OBS-01). Vive num `AsyncLocalStorage`:
 * quem loga não recebe o `correlationId` por parâmetro. O contexto é aberto na borda (interceptor
 * HTTP, handler SQS) e enriquecido à medida que os ids ficam conhecidos.
 */
export const RequestContext = {
  run<T>(context: LogContext, fn: () => T): T {
    return storage.run(defined(context), fn);
  },

  /** Contexto corrente (vazio fora de uma requisição/mensagem, como nos workers de fundo). */
  current(): Readonly<LogContext> {
    return storage.getStore() ?? {};
  },

  /** Acrescenta ids ao contexto corrente; sem contexto aberto, não faz nada. */
  enrich(extra: LogContext): void {
    const store = storage.getStore();
    if (store) Object.assign(store, defined(extra));
  },
};

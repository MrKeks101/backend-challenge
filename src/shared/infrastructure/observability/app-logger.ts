import type { LoggerService } from "@nestjs/common";
import pino, { type DestinationStream, type Logger as PinoLogger } from "pino";
import { RequestContext } from "../../application/request-context";
import { sanitizeForLog } from "./log-sanitizer";

export interface CreateLoggerOptions {
  level: string;
  /** Padrão: stdout. Os testes passam um destino em memória. */
  destination?: DestinationStream;
}

export function createPinoLogger({ level, destination }: CreateLoggerOptions): PinoLogger {
  return pino(
    {
      level,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    destination,
  );
}

type Level = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

/**
 * Faz o `Logger` do Nest (usado em toda a aplicação) escrever JSON via pino, sempre com os ids do
 * `RequestContext` (`correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`) e com
 * os campos financeiros removidos (`sanitizeForLog`, AR-55). O objeto passado ao `Logger` vira os
 * campos do JSON; o texto, o `msg`. Stacks não são escritos: podem carregar dados da requisição.
 */
export class AppLogger implements LoggerService {
  constructor(private readonly pinoLogger: PinoLogger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write("info", message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.write("error", message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.write("warn", message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.write("debug", message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.write("trace", message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.write("fatal", message, params);
  }

  private write(level: Level, message: unknown, params: unknown[]): void {
    // O Nest anexa o nome do contexto (`new Logger("X")`) como último argumento.
    const last = params.at(-1);
    const context = typeof last === "string" ? last : undefined;

    const safe = sanitizeForLog(message);
    const isFields = typeof safe === "object" && safe !== null && !Array.isArray(safe);
    const fields = isFields ? (safe as Record<string, unknown>) : {};
    const text = isFields ? undefined : String(safe);

    this.pinoLogger[level](
      { ...(context ? { context } : {}), ...RequestContext.current(), ...fields },
      text,
    );
  }
}

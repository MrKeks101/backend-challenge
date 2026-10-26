import {
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestMiddleware,
} from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { v7 } from "uuid";

export const CORRELATION_HEADER = "x-correlation-id";
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

type WithCorrelation = Request & { correlationId?: string };

/**
 * Aceita o `x-correlation-id` do cliente só se for seguro para log (sem espaços nem quebras de
 * linha); senão gera um. O id volta no header da resposta e no corpo dos erros. Também registra uma
 * linha de acesso por requisição: método, caminho, status e duração, nunca o corpo.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  private readonly logger = new Logger("Http");

  use(req: WithCorrelation, res: Response, next: NextFunction): void {
    const incoming = req.header(CORRELATION_HEADER);
    const id = incoming !== undefined && SAFE_ID.test(incoming) ? incoming : v7();
    req.correlationId = id;
    res.setHeader(CORRELATION_HEADER, id);

    const started = performance.now();
    res.on("finish", () => {
      this.logger.log({
        event: "http_request",
        correlationId: id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - started),
      });
    });
    next();
  }
}

export const correlationIdOf = (req: Request): string =>
  (req as WithCorrelation).correlationId ?? "unknown";

export const CorrelationId = createParamDecorator((_data: unknown, ctx: ExecutionContext) =>
  correlationIdOf(ctx.switchToHttp().getRequest<Request>()),
);

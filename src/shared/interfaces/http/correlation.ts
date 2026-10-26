import {
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  type NestMiddleware,
} from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { v7 } from "uuid";

export const CORRELATION_HEADER = "x-correlation-id";
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

type WithCorrelation = Request & { correlationId?: string };

/**
 * Aceita o `x-correlation-id` do cliente só se for seguro para log (sem espaços nem quebras de
 * linha); senão gera um. O id volta no header da resposta e no corpo dos erros.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: WithCorrelation, res: Response, next: NextFunction): void {
    const incoming = req.header(CORRELATION_HEADER);
    const id = incoming !== undefined && SAFE_ID.test(incoming) ? incoming : v7();
    req.correlationId = id;
    res.setHeader(CORRELATION_HEADER, id);
    next();
  }
}

export const correlationIdOf = (req: Request): string =>
  (req as WithCorrelation).correlationId ?? "unknown";

export const CorrelationId = createParamDecorator((_data: unknown, ctx: ExecutionContext) =>
  correlationIdOf(ctx.switchToHttp().getRequest<Request>()),
);

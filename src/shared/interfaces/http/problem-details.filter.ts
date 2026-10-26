import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from "@nestjs/common";
import type { Request, Response } from "express";
import { correlationIdOf } from "./correlation";
import { toProblem } from "./problem-mapper";

/** Responde TODO erro em `application/problem+json` (RFC 9457) com `code` estável e `correlationId`. */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger("Http");

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const problem = toProblem(exception);
    const correlationId = correlationIdOf(req);

    if (problem.loggable) {
      // Nunca a mensagem da exceção: erros de banco podem trazer a linha inteira (inclui saldo).
      this.logger.error({ correlationId, status: problem.status, ...problem.loggable });
    }

    for (const [name, value] of Object.entries(problem.headers)) res.setHeader(name, value);
    res
      .status(problem.status)
      .type("application/problem+json")
      .send({
        type: "about:blank",
        title: problem.title,
        status: problem.status,
        code: problem.code,
        detail: problem.detail,
        instance: req.path,
        correlationId,
        ...(problem.errors ? { errors: problem.errors } : {}),
      });
  }
}

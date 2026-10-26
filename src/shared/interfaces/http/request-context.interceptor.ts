import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import type { Request } from "express";
import { Observable } from "rxjs";
import { RequestContext } from "../../application/request-context";
import { correlationIdOf } from "./correlation";

/**
 * Abre o `RequestContext` em volta do handler, depois do parsing do corpo: o `AsyncLocalStorage`
 * não sobrevive de forma confiável aos callbacks de stream dos middlewares do Express, mas o que
 * roda a partir daqui (controller → use case → repositórios) herda o contexto.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const correlationId = correlationIdOf(context.switchToHttp().getRequest<Request>());
    return new Observable((subscriber) =>
      RequestContext.run({ correlationId }, () => next.handle().subscribe(subscriber)),
    );
  }
}

import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC } from "./public.decorator";

/**
 * Guard global no-op: autenticação não implementada por decisão documentada (ARCHITECTURE §15.3).
 * Existe para que a fiação (guard global + `@Public()`) já esteja no lugar quando houver um IdP.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return true; // no-op: um IdP validaria o JWT aqui
  }
}

import "reflect-metadata";
import { describe, expect, test } from "bun:test";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "../../../src/auth/auth.guard";
import { NoopProviderIdentity } from "../../../src/auth/provider-identity.port";
import { Public } from "../../../src/auth/public.decorator";
import { HealthController } from "../../../src/health/health.controller";

class Sample {
  @Public()
  open(): void {}

  closed(): void {}
}

const contextFor = (handler: () => void): ExecutionContext =>
  ({ getHandler: () => handler, getClass: () => Sample }) as unknown as ExecutionContext;

describe("ponto de extensão de autenticação (RF-AUTH-01)", () => {
  const guard = new AuthGuard(new Reflector());

  test("o guard no-op deixa passar, em endpoints públicos ou não", () => {
    expect(guard.canActivate(contextFor(Sample.prototype.open))).toBe(true);
    expect(guard.canActivate(contextFor(Sample.prototype.closed))).toBe(true);
  });

  test("o health é marcado @Public (continuará aberto quando houver autenticação real)", () => {
    expect(new Reflector().get<boolean>("isPublic", HealthController)).toBe(true);
  });

  test("ProviderIdentityPort no-op aceita qualquer provedor", () => {
    expect(() => new NoopProviderIdentity().assertMayActFor("provider-a")).not.toThrow();
  });
});

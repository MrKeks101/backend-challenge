export const PROVIDER_IDENTITY = Symbol("ProviderIdentityPort");

/**
 * Ponto de extensão de autenticação (RF-AUTH-01, ARCHITECTURE §15.3). Com um IdP, a implementação
 * compararia a claim `provider_id` do token com o `providerId` do body e lançaria se divergirem.
 */
export interface ProviderIdentityPort {
  assertMayActFor(providerId: string): void;
}

/** Implementação atual: autenticação não implementada; qualquer provedor pode agir. */
export class NoopProviderIdentity implements ProviderIdentityPort {
  assertMayActFor(_providerId: string): void {}
}

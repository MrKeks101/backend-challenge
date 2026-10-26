import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthGuard } from "./auth.guard";
import { NoopProviderIdentity, PROVIDER_IDENTITY } from "./provider-identity.port";

@Global()
@Module({
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: PROVIDER_IDENTITY, useClass: NoopProviderIdentity },
  ],
  exports: [PROVIDER_IDENTITY],
})
export class AuthModule {}

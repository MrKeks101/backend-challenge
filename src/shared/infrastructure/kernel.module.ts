import { Global, Module } from "@nestjs/common";
import { CLOCK, ID_GENERATOR } from "../application/tokens";
import { SystemClock, Uuid7Generator } from "../kernel";

/** Relógio e gerador de ids injetáveis: o domínio e os use cases nunca chamam `new Date()` nem `v7()`. */
@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: Uuid7Generator },
  ],
  exports: [CLOCK, ID_GENERATOR],
})
export class KernelModule {}

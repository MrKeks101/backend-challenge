import "reflect-metadata";
import { describe, expect, test } from "bun:test";
import { Inject, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

// Spike M1: Bun não emite `design:paramtypes`. Toda injeção usa token explícito.
const CLOCK = Symbol("CLOCK");

interface Clock {
  now(): Date;
}

@Injectable()
class FixedClock implements Clock {
  now(): Date {
    return new Date("2026-01-01T00:00:00.000Z");
  }
}

@Injectable()
class UsesClock {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  iso(): string {
    return this.clock.now().toISOString();
  }
}

@Module({
  providers: [{ provide: CLOCK, useClass: FixedClock }, UsesClock],
})
class SpikeModule {}

describe("NestJS DI sob Bun (sem emitDecoratorMetadata)", () => {
  test("resolve dependência por token explícito via @Inject", async () => {
    const app = await NestFactory.createApplicationContext(SpikeModule, { logger: false });
    try {
      expect(app.get(UsesClock).iso()).toBe("2026-01-01T00:00:00.000Z");
    } finally {
      await app.close();
    }
  });

  test("confirma que o Bun NÃO emite design:paramtypes (por isso o @Inject explícito)", () => {
    expect(Reflect.getMetadata("design:paramtypes", UsesClock)).toBeUndefined();
  });
});

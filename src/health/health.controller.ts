import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  /** Liveness: o processo responde. Público e sem dependências externas. */
  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }
}

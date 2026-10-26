import { Controller, Get } from "@nestjs/common";
import { Public } from "../auth/public.decorator";

@Public()
@Controller("health")
export class HealthController {
  /** Liveness: o processo responde. Público e sem dependências externas. */
  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }
}

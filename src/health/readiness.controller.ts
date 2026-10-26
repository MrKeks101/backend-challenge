import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import { Public } from "../auth/public.decorator";
import { ReadinessService } from "./readiness.service";

@Public()
@Controller("health")
export class ReadinessController {
  constructor(@Inject(ReadinessService) private readonly readiness: ReadinessService) {}

  /** Readiness: PostgreSQL e SQS alcançáveis. 200 se tudo responde, 503 se qualquer um não. */
  @Get("ready")
  async ready(@Res({ passthrough: true }) res: Response) {
    const report = await this.readiness.check();
    res.status(report.ready ? 200 : 503);
    return { status: report.ready ? "ok" : "unavailable", checks: report.checks };
  }
}

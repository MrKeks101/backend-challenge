import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { PROVIDER_IDENTITY, type ProviderIdentityPort } from "../../../auth/provider-identity.port";
import { CorrelationId } from "../../../shared/interfaces/http/correlation";
import { parseOrThrow } from "../../../shared/interfaces/http/parse";
import { ApiProblem } from "../../../shared/interfaces/http/problem";
import { ProcessWagerTransactionUseCase } from "../../application/process-wager-transaction.use-case";
import { GetTransactionQuery } from "../../application/wager-queries";
import { presentSubmission, presentTransaction } from "./wagering.presenter";
import {
  idempotencyKeyHeader,
  providerTransactionParams,
  submitTransactionBody,
  transactionIdParam,
} from "./wagering.schemas";

@Controller()
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase)
    private readonly process: ProcessWagerTransactionUseCase,
    @Inject(GetTransactionQuery) private readonly queries: GetTransactionQuery,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  @Post("wagering/transactions")
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") rawKey: string | undefined,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    // O header é a fonte da verdade da idempotência: sem ele nada é processado (AR-38).
    if (rawKey === undefined || rawKey.length === 0) {
      throw new ApiProblem(
        400,
        "MISSING_IDEMPOTENCY_KEY",
        "the Idempotency-Key header is required",
      );
    }
    const idempotencyKey = parseOrThrow(idempotencyKeyHeader, rawKey);
    const command = parseOrThrow(submitTransactionBody, body);
    this.identity.assertMayActFor(command.providerId);

    const result = await this.process.execute({ ...command, idempotencyKey }, { correlationId });
    const response = presentSubmission(result);
    res.status(response.status);
    for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value);
    return response.body;
  }

  @Get("wagering/transactions/:transactionId")
  async getById(@Param() params: unknown) {
    const { transactionId } = parseOrThrow(transactionIdParam, params);
    return presentTransaction(await this.queries.byId(transactionId));
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByExternalId(@Param() params: unknown) {
    const { providerId, externalTransactionId } = parseOrThrow(providerTransactionParams, params);
    this.identity.assertMayActFor(providerId);
    return presentTransaction(await this.queries.byExternalId(providerId, externalTransactionId));
  }
}

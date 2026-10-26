import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { CorrelationId } from "../../../shared/interfaces/http/correlation";
import { parseOrThrow } from "../../../shared/interfaces/http/parse";
import { CreateWalletUseCase } from "../../application/create-wallet.use-case";
import { ReconcileWalletUseCase } from "../../application/reconcile-wallet.use-case";
import { GetWalletQuery, ListLedgerQuery } from "../../application/wallet-queries";
import {
  presentLedgerPage,
  presentReconciliation,
  presentWallet,
  presentWalletDetails,
} from "./wallet.presenter";
import { createWalletBody, ledgerQuery, walletIdParam } from "./wallet.schemas";

@Controller("wallets")
export class WalletController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
    @Inject(GetWalletQuery) private readonly getWallet: GetWalletQuery,
    @Inject(ListLedgerQuery) private readonly listLedger: ListLedgerQuery,
    @Inject(ReconcileWalletUseCase) private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = parseOrThrow(createWalletBody, body);
    const wallet = await this.createWallet.execute({ ...input, correlationId });
    res.setHeader("Location", `/wallets/${wallet.id}`);
    return presentWallet(wallet);
  }

  @Get(":walletId")
  async get(@Param() params: unknown) {
    const { walletId } = parseOrThrow(walletIdParam, params);
    return presentWalletDetails(await this.getWallet.execute(walletId));
  }

  @Get(":walletId/ledger")
  async ledger(@Param() params: unknown, @Query() query: unknown) {
    const { walletId } = parseOrThrow(walletIdParam, params);
    const { cursor, limit } = parseOrThrow(ledgerQuery, query);
    return presentLedgerPage(await this.listLedger.execute(walletId, { cursor, limit }));
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  async reconciliation(@Param() params: unknown, @CorrelationId() correlationId: string) {
    const { walletId } = parseOrThrow(walletIdParam, params);
    return presentReconciliation(await this.reconcile.execute(walletId, correlationId));
  }
}

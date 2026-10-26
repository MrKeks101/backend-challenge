import { describe, expect, test } from "bun:test";
import type {
  UnitOfWork,
  UnitOfWorkOptions,
} from "../../../../src/shared/application/unit-of-work";
import { Uuid7Generator } from "../../../../src/shared/kernel";
import {
  type ProcessWagerTransactionCommand,
  ProcessWagerTransactionUseCase,
} from "../../../../src/wagering/application/process-wager-transaction.use-case";
import type { WagerOutcomeApplier } from "../../../../src/wagering/application/wager-outcome-applier";
import {
  InvalidWagerTransactionError,
  WagerTransactionKind,
} from "../../../../src/wagering/domain";
import { WalletNotFoundError } from "../../../../src/wallet/application/errors";
import { at } from "../../../support/wagering";

const command: ProcessWagerTransactionCommand = {
  idempotencyKey: "k",
  providerId: "provider-a",
  externalTransactionId: "ext-1",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-1",
  gameId: "game",
  kind: WagerTransactionKind.Bet,
  money: { amount: "10.00", currency: "BRL" },
};

class StopHere extends Error {}

/** Unit of Work de mentira que só registra as opções e interrompe a execução. */
function recordingUow() {
  const calls: (UnitOfWorkOptions | undefined)[] = [];
  const uow: UnitOfWork = {
    run: async (_fn, options) => {
      calls.push(options);
      throw new StopHere();
    },
  };
  return { uow, calls };
}

function build(options: { walletExists: boolean }) {
  const { uow, calls } = recordingUow();
  const wallets = { findById: async () => (options.walletExists ? {} : null) };
  const useCase = new ProcessWagerTransactionUseCase(
    uow,
    {} as never,
    wallets as never,
    {} as WagerOutcomeApplier,
    { now: () => at(1) },
    new Uuid7Generator(),
  );
  return { useCase, calls };
}

describe("ProcessWagerTransactionUseCase.execute (orquestração, sem banco)", () => {
  test("pede ao Unit of Work repetição de deadlock/serialização (RF-CON-03)", async () => {
    const { useCase, calls } = build({ walletExists: true });
    await expect(useCase.execute(command, { correlationId: "c" })).rejects.toBeInstanceOf(StopHere);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.retryOnConflict).toBeGreaterThanOrEqual(1);
    expect(calls[0]?.retryOnConflict).toBeLessThanOrEqual(5); // limitado: nunca um laço aberto
  });

  test("wallet inexistente é recusada ANTES de abrir a transação", async () => {
    const { useCase, calls } = build({ walletExists: false });
    await expect(useCase.execute(command, { correlationId: "c" })).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
    expect(calls).toHaveLength(0);
  });

  test("comando inválido é recusado ANTES de qualquer acesso ao banco", async () => {
    const { useCase, calls } = build({ walletExists: true });
    for (const bad of [
      { ...command, kind: WagerTransactionKind.Refund }, // reversão sem referência
      { ...command, kind: WagerTransactionKind.Opening }, // interno
      { ...command, referenceExternalTransactionId: "x" }, // BET não referencia
    ]) {
      await expect(useCase.execute(bad, { correlationId: "c" })).rejects.toBeInstanceOf(
        InvalidWagerTransactionError,
      );
    }
    expect(calls).toHaveLength(0);
  });
});

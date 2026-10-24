# Milestones

Plano de implementação em etapas **sequenciais**. Cada milestone é **um commit** e só começa quando o anterior está fechado.

## Regras de trabalho

1. Um milestone = um commit, na ordem abaixo. Não se mistura escopo de milestones diferentes.
2. Um milestone só fecha com todos os critérios de aceite cumpridos e **todos os testes passando** (`bun test` e `tsc --noEmit` limpos).
3. Decisão nova ou alterada durante o desenvolvimento é registrada no `ARCHITECTURE.md` (incluindo o registro de alterações) **no mesmo commit** do milestone que a motivou.
4. Cada requisito do `requirements.md` deve ter pelo menos um teste que o cubra; a coluna **Cobre** indica onde ele nasce.
5. Mensagem de commit: `<tipo>: <resumo>` (`docs`, `chore`, `feat`, `test`). O texto sugerido de cada milestone é só uma sugestão.
6. Status: `[ ]` pendente · `[~]` em andamento · `[x]` fechado.

## Visão geral

| # | Milestone | Status |
|---|---|---|
| M0 | Docs iniciais | [x] |
| M1 | Scaffold e spike da stack | [x] |
| M2 | Shared kernel: `Money` e utilitários | [x] |
| M3 | Domínio da Wallet e do Ledger | [ ] |
| M4 | Domínio de Wagering, Inbox/Outbox e eventos | [ ] |
| M5 | Persistência: migrations, schema e repositórios | [ ] |
| M6 | Wallets: casos de uso e API HTTP | [ ] |
| M7 | Processamento de transações via HTTP (idempotência e concorrência) | [ ] |
| M8 | Outbox publisher e SQS de saída | [ ] |
| M9 | Consumidor SQS (inbox, retry, DLQ, shutdown) | [ ] |
| M10 | Reprocessador de `PENDING_REFERENCE` | [ ] |
| M11 | Observabilidade | [ ] |
| M12 | Suíte de concorrência multi-instância e recuperação | [ ] |
| M13 | Docker Compose completo e README | [ ] |
| M14 | Fechamento da documentação (e teste de carga, opcional) | [ ] |

---

## M0 — Docs iniciais

**Objetivo:** registrar o entendimento do desafio e as decisões antes de qualquer código.

**Entregas**
- `requirements.md` (requisitos funcionais, não funcionais e antirrequisitos)
- `ARCHITECTURE.md` (decisões D1–D14, schema de referência, taxonomia, mapeamento HTTP)
- `milestones.md` (este arquivo)

**Aceite:** os três arquivos revisados e commitados na `main`.
**Commit:** `docs iniciais`

---

## M1 — Scaffold e spike da stack

**Objetivo:** projeto rodando em Bun com a stack confirmada, antes de construir em cima dela.

**Entregas**
- `package.json`, `bunfig.toml`, `tsconfig.json` (`strict` total, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), `.gitignore`, `.editorconfig`, `.env.example`.
- Lint/format (Biome ou ESLint) com regra que **proíbe `parseFloat`, `Number()` e `parseInt` sobre valores monetários** (AR-01).
- `docker-compose.yml` com `postgres:17-alpine` e `ministack`; `docker-compose.test.yml`.
- Bootstrap NestJS em Bun com `GET /health/live` (público) e configuração tipada por env.
- **Spike (descartável ou mantido como teste de fumaça):** DI do Nest com `@Inject(TOKEN)` explícito (sem `emitDecoratorMetadata`); MikroORM + `pg` conectando, abrindo transação e executando `SELECT … FOR UPDATE`; Migrator rodando `up`/`down`; SDK SQS contra o MiniStack.
- Scripts: `dev`, `build`, `test`, `typecheck`, `lint`, `migration:up`, `migration:down`.

**Aceite**
- `docker compose up -d postgres ministack` sobe e fica saudável.
- `bun run dev` responde `200` em `/health/live`.
- O spike prova os quatro pontos acima; qualquer falha é registrada em `ARCHITECTURE.md` com a mitigação.
- `bun run typecheck`, `bun run lint` e `bun test` passam.

**Cobre:** RNF-STK-01..07, AR-10 (sem Prisma).
**Commit:** `chore: scaffold do projeto e spike da stack`

---

## M2 — Shared kernel: `Money` e utilitários

**Objetivo:** a base monetária e os utilitários puros, 100% testados.

**Entregas**
- `Money` (bigint em centavos): `from`, `zero`, `add`, `subtract`, `negate`, `isZero`, `isPositive`, `isNegative`, `isLessThan`, `equals`, `toJSON`, `toString`, `assertSameCurrency`; imutável; teto de `numeric(19,2)`.
- Parse estrito `^(0|[1-9]\d*)\.\d{2}$`; erros de domínio (`InvalidMoneyError`, `CurrencyMismatchError`).
- `Clock`, `IdGenerator` (UUIDv7), hierarquia de erros de domínio (`DomainError`, `InvalidTransactionStateError`, …).
- JSON canônico (chaves ordenadas recursivamente) e `sha256` hex.

**Testes (unidade):** escala, entradas inválidas (`NaN`, `Infinity`, `1e3`, vazio, > 2 casas, negativo, `"25"`, `"25.5"`), nenhum arredondamento, conflito de moeda, imutabilidade, overflow do teto, canonicalização estável e independente da ordem das chaves.

**Cobre:** RF-MON-01..08, AR-01, AR-14, AR-22.
**Commit:** `feat: Money e utilitários do shared kernel`

---

## M3 — Domínio da Wallet e do Ledger

**Objetivo:** aggregates de saldo e lançamento, sem nenhuma dependência de framework.

**Entregas**
- `Wallet` (`open`, `rehydrate`, `debit`, `credit`; `version` só sobe quando o saldo muda; saldo nunca negativo; checagem de moeda).
- `WalletLedgerEntry` (`create` valida a aritmética, `rehydrate`, `isBalanced`; sem campos mutáveis).
- `LedgerDirection`; erros (`InsufficientFundsError`, …).

**Testes (unidade):** invariantes da wallet, `version`, débito acima do saldo, conflito de moeda, ledger desbalanceado rejeitado na factory, imutabilidade estrutural (sem setters), `rehydrate` não revalida transições.

**Cobre:** RF-WAL-01..07, RF-LED-01..04, AR-18, AR-21, AR-34.
**Commit:** `feat: domínio da Wallet e do Ledger`

---

## M4 — Domínio de Wagering, Inbox/Outbox e eventos

**Objetivo:** máquina de estados, regras de negócio puras e envelope de eventos.

**Entregas**
- `WagerTransaction` (kinds, status, transições válidas, `matchesPayload`, `ledgerDirectionFor`, `payloadHash` via JSON canônico) e `InvalidTransactionStateError` em estados terminais.
- `FailureCode` (taxonomia do `ARCHITECTURE.md` §9.3).
- `WagerPolicy` (serviço de domínio puro): devolve `Processed | Rejected(code) | PendingReference` conforme as regras §9.2 (inclui `REFERENCE_ALREADY_REVERSED`).
- `IntegrationEvent<T>` abstrata e subclasses: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`, `WagerTransactionFailed`.
- `InboxMessage` e `OutboxMessage` (`enqueue`, `isDue`, `markPublished`, `scheduleRetry` com backoff).

**Testes (unidade):** cada regra de BET/WIN/LOSS/REFUND/ROLLBACK, `ROLLBACK` invertendo a direção da referência, saldo insuficiente × reversão que estouraria o saldo (códigos distintos), reversão única, valor igual ao da referência, mesma key com payload divergente, `OPENING` rejeitado, todas as transições proibidas, `data` dos eventos só com `MoneyProps`, backoff do outbox.

**Cobre:** RF-TRX-*, RF-BIZ-*, RF-FC-*, RF-OUT-05..07, AR-11, AR-12, AR-19, AR-23..28, AR-31, AR-32.
**Commit:** `feat: domínio de Wagering, eventos de integração, Inbox e Outbox`

---

## M5 — Persistência: migrations, schema e repositórios

**Objetivo:** o banco como guardião das invariantes.

**Entregas**
- MikroORM configurado; `EntitySchema` + mappers (`toDomain` via `rehydrate`); `UnitOfWork` (`em.transactional`, `lock_timeout`).
- Migrations **reversíveis** (`up`/`down`), **SQL escrito à mão** (D15): tabelas, índices, `CHECK`s, unique de idempotência e de reversão única, trigger de ledger append-only, constraint trigger `wallet.balance = último balance_after`.
- Repositórios: wallet (com `FOR UPDATE`), ledger, transações, inbox, outbox.
- `ErrorClassifier` (SQLSTATE → transitório/permanente/negócio).
- Helper de testes: banco novo por suíte + *invariant checker* (`wallet.balance == Σ ledger`, encadeamento de `balance_before/after`).

**Testes (integração, PostgreSQL real):** `up → down → up`; `UPDATE`/`DELETE`/`TRUNCATE` no ledger falham; `balance < 0` falha; saldo alterado sem ledger falha no commit; ledger sem alterar saldo falha; unique de `(player_id, currency)`, de key e de `(provider, external_id)`; reversão dupla bloqueada pelo índice parcial; `numeric` volta como string (nunca `number`); **colunas e tipos de cada `EntitySchema` coincidem com o schema real** (`information_schema`), falhando se divergirem.

**Cobre:** RNF-DB-01..03, RNF-STK-07, AR-05, AR-09, AR-59.
**Commit:** `feat: persistência, migrations e constraints do schema`

---

## M6 — Wallets: casos de uso e API HTTP

**Objetivo:** primeira superfície HTTP completa e idempotente por conflito.

**Entregas**
- `POST /wallets` (cria wallet + `OPENING` + `CREDIT` + eventos na mesma transação; `409 WALLET_ALREADY_EXISTS`).
- `GET /wallets/:walletId`.
- `GET /wallets/:walletId/ledger?cursor&limit` (cursor opaco por `seq`).
- `POST /wallets/:walletId/reconciliation` (snapshot `REPEATABLE READ`, não corrige, sinaliza divergência).
- Filtro de exceções `application/problem+json`, validação de borda (zod), `AuthGuard` no-op + `ProviderIdentityPort`.

**Testes:** integração dos endpoints; criação concorrente da mesma wallet (uma vence, as demais `409`); paginação estável sem pular nem repetir; reconciliação consistente e divergência provocada manualmente (sinalizada, não corrigida).

**Cobre:** RF-API-01..06, RF-API-12, RF-API-13, RF-AUTH-01, AR-15, AR-41, AR-42.
**Commit:** `feat: API de wallets, ledger e reconciliação`

---

## M7 — Processamento de transações via HTTP

**Objetivo:** o coração financeiro: idempotência, concorrência e regras de negócio ponta a ponta (sem mensageria ainda).

**Entregas**
- `ProcessWagerTransactionUseCase` (fluxo §7: claim de idempotência → lock da wallet → decisão → aplicação → outbox na mesma transação).
- `POST /wagering/transactions` (`Idempotency-Key` obrigatório) e os dois `GET` de consulta.
- Mapeamento HTTP final: 200/202/422/400/404/409/503/500.
- Replay devolvendo `observed_balance` original; `409` para payload divergente e para key divergente.
- Retry interno limitado só para `40001`/`40P01`.

**Testes (integração + concorrência real):** os cenários de BET/WIN/LOSS/REFUND/ROLLBACK ponta a ponta; **mesma aposta 50× em paralelo → um débito**; **cenário obrigatório 100,00 / 2 × 80,00 → uma `PROCESSED`, uma `REJECTED`, saldo 20,00, um débito**; wallets distintas em paralelo; replay após o saldo mudar devolve o saldo original; invariante final em todos os testes.

**Cobre:** RF-API-07..11, RF-CON-01..04, RF-BIZ-01..09, AR-02, AR-06, AR-07, AR-12, AR-29, AR-37, AR-38, AR-43; FE-02, FE-03, FE-04.
**Commit:** `feat: processamento idempotente e concorrente de transações via HTTP`

---

## M8 — Outbox publisher e SQS de saída

**Objetivo:** eventos publicados somente após o commit, com vários publishers.

**Entregas**
- Cliente SQS (`@aws-sdk/client-sqs`), `ensureQueues()` idempotente (`wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wager-events.fifo`).
- `OutboxPublisher`: claim com lease + `SKIP LOCKED`, publicação FIFO (`GroupId = walletId`, `DedupId = eventId`), `markPublished`/`scheduleRetry` com backoff.
- Papéis por env (`APP_ROLES`), `GET /health/ready` (PostgreSQL + SQS).

**Testes (integração, PG e MiniStack reais):** evento só existe na fila depois do commit; rollback não publica nada; **dois publishers sobre a mesma outbox** sem perda e sem republicação indefinida; **processo morto depois do commit e antes de publicar → outra instância publica**; duplicata de publicação é inofensiva (mesmo `eventId`); falha do SQS agenda retry e recupera.

**Cobre:** RF-OUT-01..07, RF-API-14, AR-04, AR-51..53; FE-06.
**Commit:** `feat: outbox publisher e publicação de eventos no SQS`

---

## M9 — Consumidor SQS

**Objetivo:** a segunda porta de entrada, usando o mesmo use case.

**Entregas**
- `SqsConsumer`: long poll, concorrência por grupo (mesmo grupo em série dentro do lote), validação da mensagem.
- Inbox `(consumerName, messageId)` na mesma transação; `ack` só após o commit.
- Classificação: negócio (ack), transitório (`ChangeMessageVisibility` com backoff), permanente (DLQ explícita com atributos de erro + `FAILED`/`WagerTransactionFailed` best-effort).
- Shutdown gracioso em `SIGTERM`.

**Testes (integração):** redelivery não duplica efeitos; **worker morto depois do commit e antes do ack**; mensagem inválida vai para a DLQ; erro transitório faz retry e, ao esgotar, vai para a DLQ; mesmo `messageId` com payload diferente vai para a DLQ; `SIGTERM` com mensagens em andamento; a mesma transação por HTTP e por SQS gera resultado idêntico.

**Cobre:** RF-SQS-01..09, AR-44..50.
**Commit:** `feat: consumidor SQS com inbox, retry, DLQ e shutdown gracioso`

---

## M10 — Reprocessador de `PENDING_REFERENCE`

**Objetivo:** tratar referências fora de ordem.

**Entregas**
- Worker agendado: claim com lease + `SKIP LOCKED`, `ReprocessPendingTransactionUseCase` (trava a wallet **antes** da transação), backoff exponencial com jitter, 10 tentativas / TTL 1 h.
- *Wake-up* oportunista dos dependentes quando a referência é processada.
- Esgotado o limite: `REJECTED REFERENCE_NOT_FOUND` + evento.

**Testes:** `REFUND`/`ROLLBACK` antes da `BET` → `PENDING_REFERENCE` → resolve quando a referência chega; cadeia de pendências; esgotamento do limite; dois reprocessadores concorrentes não aplicam duas vezes; reprocessamento após reinício.

**Cobre:** RF-REF-01..03, AR-30.
**Commit:** `feat: reprocessamento de transações com referência pendente`

---

## M11 — Observabilidade

**Objetivo:** diagnosticar o sistema em execução.

**Entregas**
- `pino` JSON com `correlationId` (AsyncLocalStorage), `messageId`, `transactionId`, `walletId`, `providerId`; *redaction* de campos financeiros.
- `prom-client` em `GET /metrics`: transações por status, duplicatas, retries, DLQ, conflitos de lock, espera de lock, outbox lag, latência, divergências de reconciliação.

**Testes:** logs não contêm `amount`/`balance`/payload; `correlationId` propagado de HTTP e SQS até o evento; métricas incrementam nos cenários de duplicata, retry, DLQ e lock; `outbox_lag_seconds` cresce com o publisher parado.

**Cobre:** RNF-OBS-01..03, AR-55, AR-56.
**Commit:** `feat: logs estruturados e métricas`

---

## M12 — Suíte de concorrência multi-instância e recuperação

**Objetivo:** provar as garantias sob condições reais, com processos separados.

**Entregas**
- Harness que sobe **≥ 3 processos `bun`** contra o mesmo PostgreSQL e MiniStack; `SIGKILL` em pontos controlados.
- Os 8 cenários obrigatórios do README (§13), cada um terminando com o *invariant checker*.

**Testes:** (1) mesma aposta 50× em paralelo; (2) disputa de saldo; (3) wallets distintas em paralelo; (4) ≥ 3 instâncias; (5) morte entre commit e ack; (6) dois publishers; (7) reversão antes da referência; (8) reinício do serviço com consistência final.

**Cobre:** RNF-TST-03..05, RNF-COR-01, RNF-COR-04; FE-05, FE-08.
**Commit:** `test: suíte de concorrência multi-instância e recuperação`

---

## M13 — Docker Compose completo e README

**Objetivo:** qualquer pessoa sobe tudo com um comando.

**Entregas**
- `Dockerfile` (Bun), `docker-compose.yml` completo: `postgres`, `ministack`, `migrate` (one-shot), `app` (escalável com `--scale app=3`), `worker`.
- `README.md` com setup, comandos, variáveis de ambiente e como rodar cada suíte. O enunciado original do desafio é preservado em `CHALLENGE.md` (movido do README atual).

**Aceite:** a partir de um clone limpo, `docker compose up --build` sobe o sistema e `bun run test:integration` passa.

**Cobre:** RNF-DOC-01, RNF-STK-06.
**Commit:** `chore: compose completo e README de uso`

---

## M14 — Fechamento da documentação (e teste de carga, opcional)

**Objetivo:** documentação final fiel ao código.

**Entregas**
- `ARCHITECTURE.md` revisado contra o código real: limitações, trade-offs e parâmetros finais.
- `requirements.md` conferido: cada RF/RNF/AR com teste correspondente (tabela de rastreabilidade).
- *Opcional (diferencial):* `bun run test:load` com ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos de lock e outbox lag.

**Cobre:** RNF-DOC-02, RNF-OPT-01.
**Commit:** `docs: fechamento da arquitetura e rastreabilidade`

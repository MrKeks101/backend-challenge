# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de múltiplos provedores, por **HTTP** e por **SQS**, com entrega at-least-once. Permanece correto sob mensagens duplicadas, fora de ordem, concorrência real, várias instâncias e quedas temporárias de PostgreSQL/SQS.

O enunciado original está em [`CHALLENGE.md`](CHALLENGE.md). As decisões, trade-offs e limitações estão em [`ARCHITECTURE.md`](ARCHITECTURE.md); os requisitos e sua rastreabilidade para testes, em [`requirements.md`](requirements.md); o plano de entregas, em [`milestones.md`](milestones.md).

## Stack

Bun 1.4 · TypeScript estrito · NestJS · MikroORM 7 · PostgreSQL 17 · AWS SQS (MiniStack) · zod · pino · prom-client · Biome.

## Pré-requisitos

- [Docker](https://docs.docker.com/get-docker/) com Compose v2 (tudo que o sistema precisa roda em containers).
- [Bun](https://bun.sh) ≥ 1.4 (só para rodar testes e scripts no host; não é necessário para subir o sistema).

## Subir o sistema

```bash
docker compose up --build
```

Sobem, nesta ordem: `postgres` e `ministack` (SQS) → `migrate` (aplica as migrations e sai) → `app` e `worker`. As filas são criadas pela própria aplicação na inicialização. Nenhum `.env` é necessário.

| Serviço | Papéis (`APP_ROLES`) | O que faz |
|---|---|---|
| `app` | `api,consumer` | API HTTP na porta 3000 e consumidor de `wager-transactions.fifo` |
| `worker` | `publisher,reprocessor` | Publica a outbox em `wager-events.fifo` e reprocessa `PENDING_REFERENCE` (sem HTTP) |
| `migrate` | — | Roda `scripts/migrate.ts up` e termina |

Várias instâncias (o sistema é correto com N ≥ 3):

```bash
docker compose up --build --scale app=3 --scale worker=2
# as réplicas de app ficam em localhost:3000, 3001, 3002 ...
```

Verificação ponta a ponta contra o sistema no ar (cria wallets, apostas, replays, reversões, entrada por SQS, confere eventos e métricas):

```bash
bun install
bun run smoke
```

Derrubar (apaga também os dados): `docker compose down -v`.

## Endpoints

| Método e rota | Descrição |
|---|---|
| `POST /wallets` | Cria wallet (`playerId`, `initialBalance`); saldo inicial gera `OPENING` + lançamento |
| `GET /wallets/:walletId` | Consulta a wallet |
| `GET /wallets/:walletId/ledger?cursor=&limit=50` | Extrato paginado por cursor opaco |
| `POST /wallets/:walletId/reconciliation` | Compara saldo armazenado × soma do ledger |
| `POST /wagering/transactions` | Processa uma transação; header `Idempotency-Key` obrigatório |
| `GET /wagering/transactions/:transactionId` | Estado de uma transação |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Estado pelo id do provedor |
| `GET /health/live` · `GET /health/ready` | Liveness · readiness (PostgreSQL e SQS) |
| `GET /metrics` | Métricas Prometheus |

Exemplo:

```bash
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0198f0c0-0000-7000-8000-000000000001","initialBalance":{"amount":"100.00","currency":"BRL"}}'

curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: prov-1:bet-1' \
  -d '{"providerId":"prov-1","externalTransactionId":"bet-1","playerId":"0198f0c0-0000-7000-8000-000000000001","walletId":"<id da wallet>","roundId":"r1","gameId":"g1","kind":"BET","money":{"amount":"30.00","currency":"BRL"}}'
```

Status HTTP: `200` processada · `202` aceita, aguardando a referência (`PENDING_REFERENCE`) · `400` payload inválido · `404` não encontrado · `409` conflito de idempotência · `422` rejeitada por regra de negócio (com `failureCode` e `providerAction`) · `503` infraestrutura indisponível (tentar de novo). Detalhes em [`ARCHITECTURE.md` §13](ARCHITECTURE.md#13-d11--api-http-modo-de-processamento-e-status).

## Desenvolvimento local (app no host)

```bash
bun install
cp .env.example .env          # opcional; os padrões já servem
bun run infra:up              # só postgres + ministack
bun run migration:up
APP_ROLES=api,consumer,publisher,reprocessor bun run dev
```

Comandos:

| Comando | O que faz |
|---|---|
| `bun run dev` / `bun run start` | Sobe a aplicação (com / sem watch) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` / `bun run lint:fix` | Biome |
| `bun run migration:up` / `migration:down` | Aplica / reverte migrations (reversíveis) |
| `bun run infra:up` / `infra:down` | Sobe / derruba postgres e ministack |
| `bun run smoke` | Verificação ponta a ponta contra o sistema no ar |

## Testes

| Suíte | Comando | Infra |
|---|---|---|
| Unidade (domínio, casos de uso, guardas estáticas) | `bun test` | nenhuma |
| Integração e concorrência (PostgreSQL e SQS **reais**; inclui processos Bun separados, crash e recuperação) | `bun run test:integration` | sobe `docker-compose.test.yml` sozinho e remove no fim |

`test:integration` usa portas próprias (PostgreSQL 55432, MiniStack 45566), não conflita com o compose principal e leva alguns minutos (≈ 6 min). Todos os cenários terminam conferindo `wallet.balance == saldo reconstruído pelo ledger`.

## Variáveis de ambiente

Validadas por zod na inicialização (`src/shared/infrastructure/config/env.ts`). Obrigatórias: `DATABASE_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.

| Variável | Padrão | Descrição |
|---|---|---|
| `NODE_ENV` | `development` | `development` · `test` · `production` |
| `PORT` | `3000` | Porta HTTP (só com o papel `api`) |
| `LOG_LEVEL` | `info` | `fatal` … `trace` · `silent` |
| `APP_ROLES` | todos | Lista separada por vírgula: `api`, `consumer`, `publisher`, `reprocessor` |
| `DATABASE_URL` | — | `postgres://usuario:senha@host:5432/banco` |
| `AWS_REGION` | `us-east-1` | Região do SQS |
| `SQS_ENDPOINT` | — | Endpoint do emulador (ex.: `http://localhost:4566`) |
| `SQS_QUEUE_PREFIX` | vazio | Prefixo dos nomes das filas (isola ambientes) |
| `CONSUMER_POLLERS` | `4` | Laços de long poll do consumidor |
| `CONSUMER_BATCH_SIZE` | `10` | Mensagens por `ReceiveMessage` (1–10) |
| `CONSUMER_WAIT_SECONDS` | `20` | Duração do long poll (0–20) |
| `CONSUMER_RETRY_BASE_SECONDS` | `2` | Base do backoff de visibilidade em retry |
| `SHUTDOWN_GRACE_MS` | `25000` | Espera pelas mensagens em andamento no `SIGTERM` |
| `OUTBOX_POLL_INTERVAL_MS` | `500` | Pausa do publisher com a outbox vazia |
| `OUTBOX_BATCH_SIZE` | `20` | Mensagens reivindicadas por rodada |
| `OUTBOX_LEASE_MS` | `30000` | Tempo que uma mensagem fica “emprestada” a um publisher |
| `REPROCESSOR_POLL_INTERVAL_MS` | `1000` | Pausa do reprocessador sem trabalho |
| `REPROCESSOR_BATCH_SIZE` | `20` | Transações reivindicadas por rodada |
| `REPROCESSOR_LEASE_MS` | `60000` | Lease da reivindicação |
| `PENDING_REFERENCE_MAX_ATTEMPTS` | `10` | Tentativas antes de rejeitar por referência inexistente |
| `PENDING_REFERENCE_TTL_MS` | `3600000` | Idade máxima de uma transação aguardando referência |
| `PENDING_REFERENCE_BACKOFF_BASE_MS` | `2000` | Backoff exponencial: base |
| `PENDING_REFERENCE_BACKOFF_CAP_MS` | `300000` | Backoff exponencial: teto |

## Mensageria

- **Entrada:** `wager-transactions.fifo` (DLQ: `wager-transactions-dlq.fifo`), mensagem `WagerTransactionRequested`, `MessageGroupId = walletId`. Usa o mesmo caso de uso do HTTP; deduplica pela inbox `(consumerName, messageId)`; `ack` só após o commit.
- **Saída:** `wager-events.fifo`, alimentada pela outbox transacional (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`). A publicação é at-least-once; consumidores devem deduplicar por `eventId`.

## Decisões que merecem leitura

- Dinheiro é `bigint` em centavos no domínio e `numeric(19,2)` no banco; nunca `number`.
- A wallet é a unidade de concorrência (`SELECT … FOR NO KEY UPDATE`); unicidade, não-negatividade e imutabilidade do ledger estão **no schema**.
- Idempotência persistente (`UNIQUE` + hash canônico do payload), sem cache em memória.
- Autenticação **não foi implementada** (opcional no enunciado); há `AuthGuard` no-op e `ProviderIdentityPort` como pontos de extensão ([§15.3](ARCHITECTURE.md#153-autenticação--não-implementar-ponto-de-extensão)).
- O teste de carga opcional (`test:load`) não foi feito; ver [limitações](ARCHITECTURE.md#16-interpretações-adotadas-limitações-e-questões-em-aberto).

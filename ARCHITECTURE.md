# ARCHITECTURE — Distributed Wagering Processor

> **Documento vivo.** Registra as decisões técnicas, as alternativas consideradas e os trade-offs. Cada decisão tem um status:
> **✅ Decidido** · **🟡 Decidido, a validar** (depende de spike ou teste) · **❓ Em aberto**.
> Toda mudança relevante entra no [Registro de alterações](#17-registro-de-alterações) no fim do arquivo.
> IDs `RF/RNF/AR/FE` referem-se ao `requirements.md`.

## Sumário

1. [Visão geral](#1-visão-geral)
2. [Decisões em resumo](#2-decisões-em-resumo)
3. [D1 — Representação de dinheiro](#3-d1--representação-de-dinheiro)
4. [D2 — ORM, mapeamento e fronteira com o domínio](#4-d2--orm-mapeamento-e-fronteira-com-o-domínio)
5. [D3 — Estratégia de concorrência](#5-d3--estratégia-de-concorrência)
6. [D4 — Idempotência](#6-d4--idempotência)
7. [D5 — Fluxo transacional do use case único](#7-d5--fluxo-transacional-do-use-case-único)
8. [D6 — Schema do banco](#8-d6--schema-do-banco)
9. [D7 — Máquina de estados, regras de reversão e `failureCode`](#9-d7--máquina-de-estados-regras-de-reversão-e-failurecode)
10. [D8 — Referências fora de ordem (reprocessador)](#10-d8--referências-fora-de-ordem-reprocessador)
11. [D9 — Consumo SQS](#11-d9--consumo-sqs)
12. [D10 — Transactional Outbox](#12-d10--transactional-outbox)
13. [D11 — API HTTP: modo de processamento e status](#13-d11--api-http-modo-de-processamento-e-status)
14. [D12 — Estrutura de módulos e camadas](#14-d12--estrutura-de-módulos-e-camadas)
15. [D13 — Observabilidade, testes, autenticação, deploy](#15-d13--observabilidade-testes-autenticação-deploy)
16. [Interpretações adotadas, limitações e questões em aberto](#16-interpretações-adotadas-limitações-e-questões-em-aberto)
17. [Registro de alterações](#17-registro-de-alterações)

---

## 1. Visão geral

```
                 ┌────────────┐   POST /wagering/transactions     ┌───────────────────────────────┐
 Provedores ───▶ │  HTTP API  │ ────────────────────────────────▶ │                               │
                 └────────────┘                                    │  ProcessWagerTransaction      │
                 ┌────────────┐   WagerTransactionRequested       │  (use case ÚNICO)             │
 Provedores ───▶ │ SQS (FIFO) │ ──▶ Consumer ──(inbox)──────────▶ │                               │
                 └────────────┘                                    └──────────────┬────────────────┘
                                                                                  │ 1 transação SQL
                                    ┌─────────────────────────────────────────────▼───────────────┐
                                    │ PostgreSQL: wallets · wager_transactions · ledger · inbox ·  │
                                    │             outbox                                           │
                                    └───────▲───────────────────────────────▲─────────────────────┘
                                            │ SKIP LOCKED                   │ SKIP LOCKED
                                  ┌─────────┴────────┐            ┌─────────┴─────────┐
                                  │ Outbox Publisher │──▶ SQS     │ Pending-Reference │
                                  │ (N instâncias)   │  events    │ Reprocessor (N)   │
                                  └──────────────────┘            └───────────────────┘
```

Uma única imagem/código-base. Os papéis (`api`, `consumer`, `publisher`, `reprocessor`) são ligados por variável de ambiente (`APP_ROLES`), de modo que qualquer combinação pode rodar em qualquer número de instâncias. **Nenhum estado correto vive em memória de processo**; tudo que garante correção está no PostgreSQL.

Princípios que guiam todas as decisões:

1. **O banco é a fonte final das invariantes** (constraints, índices, triggers). O código de aplicação é a primeira linha de defesa, nunca a única (AR-03, AR-09).
2. **A wallet é a unidade de concorrência**: tudo que altera saldo passa por um lock de linha daquela wallet (AR-06).
3. **Uma transação SQL por operação financeira** contendo idempotência, saldo, ledger, inbox e outbox (RF-OUT-01).
4. **At-least-once em todo lugar, efeito exatamente-uma-vez** por idempotência persistente (AR-46, AR-53).

---

## 2. Decisões em resumo

| # | Tema | Decisão | Status |
|---|---|---|---|
| D1 | Dinheiro | `Money` com **`bigint` em centavos** (escala 2) no domínio; `numeric(19,2)` + `char(3)` no banco; string no JSON | ✅ |
| D2 | ORM | **MikroORM** com `EntitySchema` (sem decorators), modelos de persistência **separados** do domínio e mappers via `rehydrate` | ✅ (compat. Bun validada no M1) |
| D3 | Concorrência | **Lock pessimista** `SELECT … FOR NO KEY UPDATE` na wallet (ver §5.2) + guarda `version` no `UPDATE` + `CHECK (balance >= 0)` | ✅ |
| D4 | Idempotência | `INSERT … ON CONFLICT DO NOTHING` em `wager_transactions` com `UNIQUE(idempotency_key)` e `UNIQUE(provider_id, external_transaction_id)`, comparando `payload_hash` | ✅ |
| D5 | Fluxo | Ordem fixa de aquisição: **(1) inbox → (2) claim de idempotência → (3) lock da wallet**; READ COMMITTED | ✅ |
| D6 | Schema | Constraints, partial unique de reversão, ledger append-only por trigger, **constraint trigger diferido** `wallet.balance = último balance_after` (sem trigger de `version`) | ✅ |
| D7 | Estados | Máquina de estados explícita; **cada referência é revertida no máximo uma vez**, de qualquer tipo (interpretação estrita) | ✅ |
| D8 | Referência ausente | Worker com **lease + `SKIP LOCKED`**, backoff exponencial, 10 tentativas (~18 min), *wake-up* oportunista | ✅ |
| D9 | SQS | `@aws-sdk/client-sqs` direto, FIFO, `MessageGroupId = walletId`, DLQ **explícita** para erro permanente, redrive nativo como rede de segurança | ✅ |
| D10 | Outbox | Lease via `next_attempt_at` + `SKIP LOCKED`; publica em `wager-events.fifo`; dedupe do consumidor por `eventId` | ✅ |
| D11 | API | **Processamento síncrono**; 200/202/400/404/409/422/503; erros em `application/problem+json` | ✅ |
| D12 | Camadas | Módulos por contexto (`wallet`, `wagering`, `messaging`) em camadas domain/application/infrastructure/interfaces; DI sempre por **token explícito** | ✅ |
| D13 | Observabilidade/Testes/Auth | pino JSON + AsyncLocalStorage; `prom-client`; testes de integração com `docker-compose.test.yml`; **auth não implementada** (decisão do autor), só `AuthGuard` global no-op + `ProviderIdentityPort` (adapter no-op) como pontos de extensão | ✅ |
| D14 | Emulador SQS | **MiniStack** (sem conta/token); validado com 10 verificações de FIFO, visibilidade, redrive e DLQ | ✅ |
| D15 | Migrations | **SQL escrito à mão** (`up`/`down` explícitos, sem snapshot nem geração pelo ORM) + teste de divergência `EntitySchema` × banco | ✅ |

---

## 3. D1 — Representação de dinheiro

**Problema.** Representar `Money` exato, imutável, com escala fixa 2, sem `number` (AR-01), reidratável do banco.

| Opção | Prós | Contras |
|---|---|---|
| **A. `bigint` em centavos** (escolhida) | Exato; zero dependências; comparação/soma triviais e rápidas; overflow impossível dentro do limite de `numeric(19,2)`; imutável por natureza | Parse/format de string manual (pequeno e 100% testável); não generaliza para escalas ≠ 2 |
| B. `decimal.js` | Genérico; o esqueleto do README cita `Decimal` | Dependência extra; precisão/rounding configuráveis aumentam superfície de bug; objetos mais pesados |
| C. string + SQL faz a conta | Evita lib | Lógica monetária fora do domínio; inviabiliza testes unitários puros |

**Decisão.** `Money` guarda `minor: bigint` (centavos) e `currency: string` (ISO-4217, 3 letras maiúsculas). O README permite adaptar o campo `value: Decimal` desde que as garantias se mantenham.

**Regras de parse** (`Money.from`):

- Regex estrita `^(0|[1-9]\d*)\.\d{2}$`: **exatamente 2 casas**, sem sinal, sem expoente, sem espaços, sem zeros à esquerda. `"25"`, `"25.5"`, `"25.000"`, `"1e3"`, `"NaN"`, `""`, `"-1.00"` → erro de domínio `InvalidMoneyError`.
- **Nunca há arredondamento**: o que excede 2 casas é rejeitado (RF-MON-05, AR-22). O teste de "arredondamento" verifica justamente que nada é arredondado.
- Teto: `≤ 9_999_999_999_999_999.99` (limite de `numeric(19,2)`).
- Valores negativos só existem como resultado interno de `negate()`/`subtract()`; `Money.from` (contrato de entrada) nunca os aceita. `Wallet` nunca persiste saldo negativo.
- Serialização: `toJSON() → { amount: "25.00", currency: "BRL" }`; `toString() → "25.00 BRL"`.
- **Implementação (M2):** `Money` guarda `minor: bigint` e é congelado (`Object.freeze`), então a imutabilidade é estrutural e testada. Intervalo `±9_999_999_999_999_999.99` (`MoneyOverflowError` fora dele, inclusive em `add`/`subtract`). `amount` que não seja `string` em runtime (p.ex. `number`) é rejeitado mesmo que o tipo TS seja burlado. Moeda validada só pelo formato ISO-4217 (3 letras maiúsculas), sem lista oficial.
- **`equals` entre moedas diferentes devolve `false`** (igualdade de valor, não lança); já `add`, `subtract` e `isLessThan` lançam `CurrencyMismatchError`.
- **Mensagens de erro não repetem o valor recebido** (AR-55); só descrevem o motivo.
- Todo erro de domínio estende `DomainError` e carrega um `code` estável (`INVALID_MONEY`, `MONEY_OVERFLOW`, `CURRENCY_MISMATCH`, `INVALID_TRANSACTION_STATE`).
- Conflito de moeda em qualquer operação binária → `CurrencyMismatchError`.

**Valor zero.** `BET`, `WIN`, `REFUND`, `ROLLBACK` exigem `amount > 0`. `LOSS` aceita `0.00` (não move saldo). Ledger exige `amount > 0`. Ver [§16](#16-interpretações-adotadas-limitações-e-questões-em-aberto).

---

## 4. D2 — ORM, mapeamento e fronteira com o domínio

**Problema.** Escolher MikroORM ou TypeORM, mapear `Money`, definir a estratégia transacional e manter o domínio livre de ORM/Nest (AR-33).

### 4.1 ORM: MikroORM (✅)

| Critério | MikroORM | TypeORM |
|---|---|---|
| Transações explícitas | `em.transactional()` com `AsyncLocalStorage` (`RequestContext`/`TransactionContext`) | `DataSource.transaction()` / `QueryRunner` (propagação manual) |
| Lock pessimista | `LockMode.PESSIMISTIC_WRITE` + `FOR UPDATE SKIP LOCKED` nativo | `setLock('pessimistic_write')`, `SKIP LOCKED` via `setOnLocked` |
| Mapeamento sem decorators | `EntitySchema` de primeira classe | `EntitySchema` existe, menos ergonômico |
| Migrations reversíveis | `Migrator` com `up()`/`down()` | idem |
| Unit of Work / Identity Map | Sim (preferencial segundo o README) | Não |
| SQL cru quando necessário | `em.execute` / `QueryBuilder` | idem |

**Decisão:** MikroORM (preferencial no README). Usamos o EntityManager principalmente como **gerenciador de transação e executor de SQL parametrizado**; consultas de caminho quente (claim de idempotência, lock da wallet, claim do outbox) são SQL explícito. O Identity Map não é usado como cache de correção.

### 4.2 Fronteira domínio × persistência (✅)

| Opção | Prós | Contras |
|---|---|---|
| A. Mapear as classes de domínio diretamente (`EntitySchema` apontando para elas) | Sem mappers | Construtores `private` e `rehydrate` conflitam com a hidratação do ORM; acopla o formato do domínio ao banco; `Money` exigiria `Type` customizado dentro do domínio |
| **B. Modelos de persistência separados + mappers** (escolhida) | Domínio 100% puro; `rehydrate` é o único caminho de reconstrução (RNF-MOD-02); `Money` ↔ colunas resolvido no mapper | Código de mapeamento extra (pequeno) |

Estrutura: `infrastructure/persistence/schemas/*.schema.ts` (`EntitySchema`, só dados em `string`/`Date`/`number` de versão) e `infrastructure/persistence/mappers/*.mapper.ts` (`toDomain` chama `X.rehydrate(...)`, `toRecord` extrai primitivos).

### 4.3 Mapeamento de `Money`

- Colunas `amount numeric(19,2)` + `currency char(3)` (valor e moeda separados, conforme permitido).
- No schema do ORM a propriedade é `type: 'string'` com `columnType: 'numeric(19,2)'`; o driver `pg` devolve `numeric` como **string** (nunca `number`), e o mapper converte via `Money.from`.
- Nenhum `parseFloat`/`Number()` em qualquer ponto do caminho (lint rule `no-restricted-globals`/`no-restricted-syntax` + revisão).

### 4.4 Estratégia transacional

Uma porta `UnitOfWork.run(fn, opts)` na camada de aplicação, implementada com `em.transactional()`. Repositórios obtêm o `EntityManager` do contexto assíncrono ambiente, então o use case não propaga `tx` por parâmetro. Isolamento **READ COMMITTED** (justificativa em [§5](#5-d3--estratégia-de-concorrência)). `SET LOCAL lock_timeout`/`statement_timeout` por transação.

### 4.5 Riscos da stack — validados no spike do M1 (✅)

Versões resolvidas: **Bun 1.4.4, NestJS 12.2, MikroORM 7.2 (`@mikro-orm/postgresql`, `migrations`), TypeScript 7.0, Biome 2.6, zod 4**. Os testes que provam cada item estão em `test/unit` e `test/integration` e rodam em `bun run test:integration`.

- **Bun × NestJS**: o Bun **não emite `design:paramtypes`** (confirmado por teste). Toda injeção usa `@Inject(TOKEN)` explícito, com tokens `Symbol` para portas. O Nest 12 sobe normalmente no Bun com `platform-express`.
- **Bun × MikroORM/`pg`**: conexão, transação, rollback, `FOR UPDATE` e `FOR UPDATE SKIP LOCKED` funcionam. Com `READ COMMITTED`, a 2ª transação bloqueada em `FOR UPDATE` enxerga o commit da 1ª (saldo `100.00 → 20.00`). `numeric(19,2)` volta como **string**, nunca `number`.
- **Migrator (MikroORM 7)**: é uma *extensão* registrada via `extensions: [Migrator]`. As migrations entram por `migrations.migrationsList` (lista explícita `{ name, class }`), sem varredura de diretório. `up` → `down` → `up` funciona.
- **⚠️ SQL cru dentro de transação: usar `em.execute(...)`, nunca `em.getConnection().execute(...)`.** O segundo pega outra conexão do pool e **ignora a transação**: o `FOR UPDATE` não segurava lock e o rollback não desfazia nada (o spike falhou exatamente assim antes da correção). Regra para todos os repositórios (M5): receber o `EntityManager` do contexto transacional e usar `em.execute`.
- **TypeScript 7**: a opção `baseUrl` foi removida; o alias `@/*` usa apenas `paths` com `./`. `experimentalDecorators` continua suportado; `emitDecoratorMetadata` fica desligado.
- **Biome 2.6** também formata Markdown; foi restrito ao código (`files.includes`) para não reescrever os documentos. `unsafeParameterDecoratorsEnabled` é necessário para `@Inject` em parâmetros de construtor.
- **Guardas estáticas** (`test/unit/architecture.test.ts`): `src/` não pode usar `parseFloat`/`parseInt`/`Number()`/`toFixed` (AR-01; exceção explícita com `// allow-number: <motivo>`), e `src/shared/kernel` e `src/*/domain` não podem importar Nest, MikroORM, AWS SDK, `pg`, express ou zod (AR-33).

---

## 5. D3 — Estratégia de concorrência

**Problema.** Duas `BET` de 80 sobre saldo 100 simultâneas ⇒ uma passa, outra é rejeitada, saldo 20, um débito (RF-CON-04), com ≥ 3 instâncias e wallets quentes.

| Opção | Como funciona | Prós | Contras |
|---|---|---|---|
| **A. Pessimista: `SELECT … FOR UPDATE` na wallet** (escolhida) | Serializa por wallet; a decisão de domínio roda com o saldo travado | Sem retry sob contenção; ordem FIFO natural de lock; regras de reversão (ler referência + ledger) rodam num estado estável; wallets distintas não se bloqueiam | Wallet muito quente serializa (vazão por wallet = 1/tempo da transação); exige transações curtas |
| B. Otimista (`version` + retry limitado) | `UPDATE … WHERE version = :v`; em conflito, refaz | Sem lock durante a decisão | Sob hot wallet, tempestade de retries e desperdício; cada retry refaz I/O; difícil provar "retry não duplica"; falha após N tentativas vira erro artificial |
| C. Update atômico condicionado (`UPDATE … SET balance = balance - x WHERE balance >= x RETURNING`) | Decisão dentro do SQL | Sem lock explícito e muito rápido para BET puro | Regra de negócio vaza para SQL; `balance_before/after` e o ledger dependem do `RETURNING`; reversões (que dependem de leituras da referência/ledger) continuam precisando de serialização; difícil manter `Wallet` como aggregate encapsulado |
| D. Advisory lock por wallet | `pg_advisory_xact_lock(hash(walletId))` | Serializa sem tocar a linha | Colisão de hash; invisível em `pg_locks` por linha; sem vantagem sobre `FOR UPDATE` |

**Decisão:** **A, com defesa em profundidade**:

1. `SELECT … FROM wallets WHERE id = :id FOR NO KEY UPDATE` (lock por linha ⇒ **por wallet**, nunca global).
2. `Wallet.debit/credit` aplica a regra no aggregate e devolve o `WalletLedgerEntry`.
3. `UPDATE wallets SET balance = :b, version = :v+1, updated_at = :t WHERE id = :id AND version = :v` — se afetar 0 linhas (impossível sob lock correto), lança erro de invariante ⇒ transação aborta. É o *belt and suspenders* do optimistic locking.
4. `CHECK (balance >= 0)` + constraint trigger de consistência ([§8](#8-d6--schema-do-banco)) como última barreira.

**Isolamento READ COMMITTED.** Cada statement enxerga o último commit; após obter o `FOR UPDATE`, as leituras seguintes (referência, ledger) enxergam o estado já commitado pelo dono anterior do lock. REPEATABLE READ/SERIALIZABLE trariam falhas de serialização sem benefício, pois a serialização já é explícita.

**Prevenção de deadlock — ordem global de aquisição.** Toda transação adquire recursos nesta ordem, sempre:

1. linha de inbox (apenas SQS);
2. *claim* da linha em `wager_transactions` (insert que reserva as unique keys);
3. lock da wallet (`FOR NO KEY UPDATE`, ver §5.2);
4. demais linhas (ledger, outbox) — inserts que não conflitam.

O reprocessador e o publisher respeitam a mesma ordem (o reprocessador trava a **wallet antes** de reler/travar a transação pendente; ver §10). Uma transação toca **no máximo uma wallet**, então não há ordenação entre wallets.

**Contenção.** `SET LOCAL lock_timeout = '5s'`. Estouro (`55P03`) ⇒ `TransientError` ⇒ HTTP 503 + `Retry-After` / SQS retry. Retry interno limitado (máx. 3, jitter) apenas para `40001` e `40P01`. Métricas: `wallet_lock_wait_seconds` (histograma) e `lock_conflicts_total{reason}` (RNF-OBS-02).

**Hot wallet.** A vazão por wallet é limitada por *tempo de transação*. Mitigação: transação curta (sem I/O de rede dentro dela; o outbox só grava linhas), índices certos, pool dimensionado. Limitação documentada em [§16](#16-interpretações-adotadas-limitações-e-questões-em-aberto).

### 5.1 Contrato do aggregate `Wallet` e do `WalletLedgerEntry` (M3)

O aggregate **não faz concorrência**: quem o usa já o carregou sob `FOR NO KEY UPDATE`. Ele garante que, dentro de uma instância, saldo e ledger andam juntos.

- **`debit`/`credit` devolvem o `WalletLedgerEntry`** da movimentação e são **atômicos**: tudo que pode falhar (moeda, valor positivo, saldo suficiente, estouro, criação do lançamento) é avaliado *antes* de qualquer mutação. Falhou ⇒ saldo, `version` e `updatedAt` intactos.
- **Os ids e o horário vêm de fora** (`entryId`, `transactionId`, `at`): o domínio não gera identificadores nem lê o relógio, o que o torna determinístico em teste.
- **`Wallet.open` devolve `{ wallet, openingEntry }`** (adaptação da assinatura do README, que devolvia só a wallet): com saldo inicial positivo, o lançamento `CREDIT` de abertura (`balanceBefore = 0`) nasce junto da wallet, então saldo e ledger já nascem consistentes. A wallet abre direto com `balance = initialBalance` e `version = 1` (não passa por `version = 2`). Com saldo zero, `openingEntry` é `null`. Saldo inicial positivo sem os ids de abertura é erro.
- **`version`** começa em 1 e sobe exatamente 1 por movimentação bem-sucedida; falhas não sobem.
- **Todo movimento é estritamente positivo** (`> 0`); o sentido vem de `debit` × `credit`. Saldo nunca fica negativo: `InsufficientFundsError` (`INSUFFICIENT_FUNDS`) em vez de negativar.
- **`WalletLedgerEntry` é imutável de forma estrutural**: campos `readonly`, instância congelada (`Object.freeze`), nenhum método de transição nem setter; só existem `create` (valida a aritmética `balanceBefore ± money = balanceAfter`, valor positivo, saldos não negativos e moedas coerentes) e `rehydrate` (não revalida). `isBalanced()` devolve `false`, sem lançar, para estado reidratado incoerente.
- **Datas (`Date` é mutável)**: entradas e saídas são copiadas; mutar a data devolvida por `createdAt`/`updatedAt` não altera o aggregate.
- **Defesa em profundidade**: a checagem de moeda do movimento é redundante com `Money` e o ledger, de propósito (falha cedo com a moeda da wallet).
- **Prova por mutação**: 21 bugs plantados nesses arquivos; 20 detectados e 1 mutante equivalente (a checagem de moeda acima).

### 5.2 Achado do M5: `FOR NO KEY UPDATE`, não `FOR UPDATE` (✅ revisão do D3)

**O problema, reproduzido por teste.** No fluxo do D4 a transação primeiro faz o *claim* (`INSERT` em `wager_transactions`) e só depois trava a wallet. O `INSERT` tem FK para `wallets`, e o PostgreSQL protege a linha referenciada com um `FOR KEY SHARE`. Com `SELECT … FOR UPDATE` na wallet, duas transações da **mesma** wallet entram em deadlock: cada uma segura o `KEY SHARE` da própria FK e pede `FOR UPDATE`, que conflita com o `KEY SHARE` da outra. O teste de 20 apostas paralelas na mesma wallet falhou com `deadlock detected` (SQLSTATE `40P01`) na primeira execução.

**A correção.** `SELECT … FOR NO KEY UPDATE`: serializa duas transações pela wallet exatamente como antes (conflita com ele mesmo), mas **não conflita com `KEY SHARE`**, então as FKs dos filhos (transação, ledger) nunca bloqueiam nem criam ciclo. O `UPDATE wallets SET balance…` já pede esse nível internamente, então não há "upgrade" de lock. A ordem do D4 (inbox → claim → wallet) fica **mantida**, sem precisar inverter para "wallet primeiro".

**Guarda.** `test/unit/architecture.test.ts` falha o build se qualquer SQL em `src/` usar `FOR UPDATE` sem `SKIP LOCKED`. Os `claimDue` também usam `FOR NO KEY UPDATE SKIP LOCKED` (transações) pelo mesmo motivo (o ledger tem FK para elas).

---

## 6. D4 — Idempotência

**Problema.** Mesma operação N vezes (50 em paralelo) ⇒ um efeito; mesma key + payload diferente ⇒ conflito; persistente e correta multi-instância (AR-02).

| Opção | Prós | Contras |
|---|---|---|
| A. `SELECT` antes, `INSERT` depois | Intuitivo | Race clássica (TOCTOU) entre o select e o insert |
| B. Tabela separada `idempotency_keys` | Guarda resposta serializada | Duas fontes de verdade; precisa de atomicidade extra; a resposta já é derivável da própria transação |
| **C. A própria `wager_transactions` é o registro de idempotência** (escolhida) | Unique index do PostgreSQL serializa os concorrentes (quem perde **espera** o commit do vencedor); sem tabela extra; resposta derivada da linha | Exige disciplina na ordem de locks (§5) |

**Decisão.**

```sql
INSERT INTO wager_transactions (...status='PENDING', payload_hash, idempotency_key ...)
ON CONFLICT DO NOTHING
RETURNING id;
```

- **Retornou linha** ⇒ esta execução é a dona; segue o fluxo.
- **Não retornou** (conflito em qualquer unique) ⇒ `SELECT` da linha existente por `idempotency_key` **ou** `(provider_id, external_transaction_id)`:
  - mesma key e mesmo `payload_hash` ⇒ **replay**: devolve o resultado original (`idempotentReplay: true`);
  - mesma key e `payload_hash` diferente ⇒ **`IDEMPOTENCY_KEY_CONFLICT`** (HTTP 409);
  - `(provider, externalId)` já existe com **outra** key ⇒ também 409 (`EXTERNAL_TRANSACTION_ID_CONFLICT`): o mesmo evento do provedor sob outra identidade é ambíguo demais para tratar como replay.
- Em READ COMMITTED, quando o concorrente ainda não commitou, o `INSERT … ON CONFLICT` **bloqueia até o commit/rollback** dele; ao retomar, o `SELECT` já enxerga a linha. Se o dono deu rollback (erro transitório), o insert do concorrente simplesmente vence.

**Resultado original com o saldo daquele momento (RF-BIZ-07).** `wager_transactions.observed_balance` grava o saldo observado na decisão (saldo após o lançamento para `PROCESSED`; saldo no momento da rejeição para `REJECTED`; `LOSS` grava o saldo corrente). A resposta de replay usa **essa coluna**, nunca o saldo atual (AR-29). Para `PENDING_REFERENCE`, `balance` é `null`.

### 6.1 `payloadHash` (RF-API-09)

- **Algoritmo:** SHA-256, hex minúsculo, sobre o **JSON canônico** (UTF-8, sem espaços, chaves ordenadas lexicograficamente em todos os níveis) do objeto:

```json
{
  "currency": "BRL", "amount": "25.00",   // money normalizado (já validado, escala 2)
  "externalTransactionId": "...", "gameId": "...", "kind": "BET",
  "playerId": "...", "providerId": "...",
  "referenceExternalTransactionId": null,   // null quando ausente (nunca omitido)
  "roundId": "...", "walletId": "..."
}
```

  (as chaves acima aparecem agrupadas só para leitura; na prática `money` é objeto aninhado `{amount,currency}` ordenado.)
- **Fora do hash:** header `Idempotency-Key`, `messageId`, `occurredAt`, `correlationId`, qualquer metadado de transporte (AR-39).
- **JSON canônico (`canonicalize`, M2):** sem espaços; chaves ordenadas por unidade de código UTF-16 em todos os níveis; arrays mantêm a ordem; strings como em `JSON.stringify`; objetos com `toJSON()` (`Money`, `Date`) são convertidos por ele. **Rejeita** (`TypeError` com o caminho do valor) `undefined`, `NaN`, `Infinity`, `bigint`, função, símbolo e instâncias de classe sem `toJSON`: um campo ausente precisa ser escrito como `null` explícito pelo chamador, para que "ausente" e "nulo" nunca colidam no hash por acidente.
- Como `Money` já é normalizado, `"25.00"` tem uma única forma textual.
- A implementação vive no domínio (`WagerTransaction.create` calcula e `matchesPayload` compara) usando uma função pura de canonicalização; `crypto` do Bun/Node apenas para o SHA-256.

### 6.2 Origem da key

- HTTP: header `Idempotency-Key` **obrigatório** (400 se ausente/vazio/> 200 chars). É a fonte da verdade; default sugerido `"{providerId}:{externalTransactionId}"`, mas não é imposto.
- SQS: `data.idempotencyKey` (mesma semântica).
- Camadas de dedup, em ordem: inbox (mesmo `messageId`) → idempotency key → `(provider, externalId)`. Mensagens diferentes com a mesma transação caem na 2ª camada.

---

## 7. D5 — Fluxo transacional do use case único

`ProcessWagerTransactionUseCase.execute(command, source)` é chamado **igualmente** pelo controller HTTP e pelo consumer SQS (AR-50). O `command` já é validado e normalizado (`Money`, hash).

### 7.1 Antes da transação

1. Validar o comando (schema + `Money` + `kind ≠ OPENING` + exigência de `referenceExternalTransactionId` por `kind`). Falha ⇒ `ValidationError` (HTTP 400; SQS: permanente ⇒ DLQ). **Nada é persistido.**
2. Leitura simples (sem lock) da wallet por `walletId` para garantir existência. Inexistente ⇒ `WalletNotFoundError` (HTTP 404; SQS: permanente ⇒ DLQ). Não há linha de transação possível sem FK; a wallet nunca é excluída, então a checagem é segura.

### 7.2 Dentro de **uma** transação SQL (READ COMMITTED)

```
BEGIN
  SET LOCAL lock_timeout = '5s'

  [0] (SQS) INSERT inbox(consumer_name, message_id, payload_hash, received_at) ON CONFLICT DO NOTHING
        └ sem linha → mensagem já commitada antes → ROLLBACK/no-op → ack            (dedup #1)

  [1] INSERT wager_transactions (PENDING, payload_hash, idempotency_key, …) ON CONFLICT DO NOTHING RETURNING
        └ sem linha → SELECT existente → replay | 409                                  (dedup #2/#3)
        └ replay: COMMIT (se houve inbox) e devolve resultado original

  [2] SELECT … FROM wallets WHERE id = :walletId FOR NO KEY UPDATE                          (serializa a wallet)

  [3] Se houver referência: SELECT da transação de referência por (provider_id, reference_external_transaction_id)

  [4] DECISÃO (domínio puro — WagerPolicy):
        Rejected(code) | PendingReference | Processed(effect: none | debit | credit)

  [5] Aplicação do resultado
        Processed c/ efeito: wallet.debit/credit → WalletLedgerEntry
             UPDATE wallets … WHERE id AND version = :v
             INSERT wallet_ledger_entries
             UPDATE wager_transactions SET status='PROCESSED', reference_transaction_id, observed_balance, processed_at
             UPDATE wager_transactions SET next_attempt_at = now()       -- wake-up de dependentes pendentes
                    WHERE provider_id = :p AND reference_external_transaction_id = :ext AND status='PENDING_REFERENCE'
        Processed LOSS: UPDATE tx → PROCESSED (sem ledger, sem mudança de saldo)
        Rejected: UPDATE tx → REJECTED + failure_code + observed_balance (sem ledger)
        PendingReference: UPDATE tx → PENDING_REFERENCE, attempts=0, next_attempt_at = now()+backoff₀

  [6] INSERT outbox_messages (eventos do resultado — ver §12.3)
  [7] (SQS) UPDATE inbox SET processed_at = now()
COMMIT
→ somente depois: ack da mensagem SQS / resposta HTTP / "nudge" opcional ao publisher
```

**Por que esta ordem** (e não "lock da wallet primeiro"): se um duplicado travasse a wallet *antes* de reivindicar a key, ele ficaria esperando o commit do original no unique index **segurando a wallet**, enquanto o original esperaria a wallet ⇒ deadlock. Reivindicar a key antes de qualquer lock de wallet elimina o ciclo.

**Garantias de atomicidade.** Inbox, claim de idempotência, saldo, ledger, status e outbox compartilham a mesma transação; um crash em qualquer ponto antes do COMMIT desfaz tudo, e depois do COMMIT o redelivery é neutralizado por [0]/[1] (cenário "morre depois do commit, antes do ack").

**Rejeição de negócio é commitada.** `REJECTED` é um resultado persistido (auditável, replay devolve o mesmo), não uma exceção que dá rollback. Só erros de infraestrutura/invariante causam rollback.

**Decisão pura.** `WagerPolicy` (serviço de domínio) recebe `(transaction, wallet, reference?)` e devolve um `Outcome`; é testável sem banco (RNF-TST-01). O use case só orquestra I/O.

**Pós-commit.** Nada de publicar eventos aqui (AR-04). O publisher lê a outbox. Um *nudge* opcional em memória (EventEmitter) apenas acelera o próximo poll; perder o nudge é inofensivo.

---

## 8. D6 — Schema do banco

Todas as garantias de unicidade, imutabilidade e não-negatividade moram aqui (AR-09, RNF-DB-01).

### 8.1 DDL de referência

```sql
-- IDs são UUIDv7 gerados pela aplicação (ordenáveis no tempo, bons para índices).

CREATE TABLE wallets (
  id          uuid PRIMARY KEY,
  player_id   uuid        NOT NULL,
  currency    char(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance     numeric(19,2) NOT NULL CHECK (balance >= 0),
  version     integer     NOT NULL CHECK (version >= 1),
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  UNIQUE (player_id, currency)
);

CREATE TABLE wager_transactions (
  id                                uuid PRIMARY KEY,
  provider_id                       text        NOT NULL,
  external_transaction_id           text        NOT NULL,
  idempotency_key                   text        NOT NULL,
  payload_hash                      char(64)    NOT NULL,
  wallet_id                         uuid        NOT NULL REFERENCES wallets(id),
  player_id                         uuid        NOT NULL,
  round_id                          text        NOT NULL,
  game_id                           text        NOT NULL,
  kind                              text        NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  amount                            numeric(19,2) NOT NULL CHECK (amount >= 0),
  currency                          char(3)     NOT NULL,
  reference_external_transaction_id text,
  reference_transaction_id          uuid        REFERENCES wager_transactions(id),
  status                            text        NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  failure_code                      text,
  observed_balance                  numeric(19,2),
  attempts                          integer     NOT NULL DEFAULT 0,
  next_attempt_at                   timestamptz,
  created_at                        timestamptz NOT NULL,
  processed_at                      timestamptz,
  updated_at                        timestamptz NOT NULL,

  UNIQUE (idempotency_key),
  UNIQUE (provider_id, external_transaction_id),

  CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
  CHECK (kind IN ('LOSS','OPENING') OR amount > 0),
  CHECK (status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL),
  CHECK (status <> 'PROCESSED' OR processed_at IS NOT NULL),
  CHECK (status <> 'PENDING_REFERENCE' OR next_attempt_at IS NOT NULL)
);

-- Cada transação é revertida NO MÁXIMO UMA VEZ (qualquer REFUND/ROLLBACK processado). Ver D7.
CREATE UNIQUE INDEX uq_wager_single_reversal
  ON wager_transactions (reference_transaction_id)
  WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');

CREATE INDEX ix_wager_pending_due ON wager_transactions (next_attempt_at)
  WHERE status = 'PENDING_REFERENCE';
CREATE INDEX ix_wager_dependents ON wager_transactions (provider_id, reference_external_transaction_id)
  WHERE status = 'PENDING_REFERENCE';
CREATE INDEX ix_wager_wallet ON wager_transactions (wallet_id, created_at);

CREATE TABLE wallet_ledger_entries (
  seq            bigint GENERATED ALWAYS AS IDENTITY,       -- ordem estável; base do cursor
  id             uuid PRIMARY KEY,
  wallet_id      uuid NOT NULL REFERENCES wallets(id),
  transaction_id uuid NOT NULL REFERENCES wager_transactions(id),
  direction      text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount         numeric(19,2) NOT NULL CHECK (amount > 0),
  currency       char(3) NOT NULL,
  balance_before numeric(19,2) NOT NULL CHECK (balance_before >= 0),
  balance_after  numeric(19,2) NOT NULL CHECK (balance_after  >= 0),
  created_at     timestamptz NOT NULL,
  UNIQUE (wallet_id, transaction_id),                        -- ≤ 1 lançamento por transação/wallet
  UNIQUE (seq),
  CHECK ( (direction = 'CREDIT' AND balance_after = balance_before + amount)
       OR (direction = 'DEBIT'  AND balance_after = balance_before - amount) )
);
CREATE INDEX ix_ledger_wallet_seq ON wallet_ledger_entries (wallet_id, seq DESC);

CREATE TABLE inbox_messages (
  consumer_name text        NOT NULL,
  message_id    text        NOT NULL,
  payload_hash  char(64)    NOT NULL,
  received_at   timestamptz NOT NULL,
  processed_at  timestamptz,
  PRIMARY KEY (consumer_name, message_id)
);

CREATE TABLE outbox_messages (
  id               uuid PRIMARY KEY,                -- = eventId
  aggregate_id     text        NOT NULL,
  message_group_id text        NOT NULL,            -- walletId (FIFO group)
  event_type       text        NOT NULL,
  payload          jsonb       NOT NULL,
  occurred_at      timestamptz NOT NULL,
  attempts         integer     NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL,            -- vencimento E lease
  published_at     timestamptz,
  last_error       text
);
CREATE INDEX ix_outbox_due ON outbox_messages (next_attempt_at) WHERE published_at IS NULL;
```

### 8.2 Triggers (imutabilidade e consistência saldo↔ledger)

```sql
-- Ledger append-only: nenhum UPDATE/DELETE/TRUNCATE.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation'; END $$;
CREATE TRIGGER trg_ledger_immutable  BEFORE UPDATE OR DELETE ON wallet_ledger_entries FOR EACH ROW       EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_ledger_no_truncate BEFORE TRUNCATE         ON wallet_ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Saldo materializado == balance_after do último lançamento (ou 0 se não houver). Diferido para o COMMIT.
CREATE FUNCTION assert_wallet_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w uuid; bal numeric; last_after numeric;
BEGIN
  w := CASE TG_TABLE_NAME WHEN 'wallets' THEN NEW.id ELSE NEW.wallet_id END;
  SELECT balance INTO bal FROM wallets WHERE id = w;
  SELECT balance_after INTO last_after FROM wallet_ledger_entries WHERE wallet_id = w ORDER BY seq DESC LIMIT 1;
  IF bal IS DISTINCT FROM COALESCE(last_after, 0) THEN
    RAISE EXCEPTION 'wallet % balance % diverges from ledger %', w, bal, COALESCE(last_after, 0)
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_wallet_ledger_ck AFTER INSERT OR UPDATE ON wallets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_wallet_matches_ledger();
CREATE CONSTRAINT TRIGGER trg_ledger_wallet_ck AFTER INSERT ON wallet_ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_wallet_matches_ledger();
```

**Não adotado:** trigger que força a regra de `version` (só sobe quando o saldo muda). O ganho é marginal: a regra já é garantida pelo domínio (`Wallet`) e pelo `UPDATE … WHERE version = :v`.

Efeito: **"toda alteração de saldo tem lançamento e vice-versa" (RF-WAL-04) é imposto pelo banco no COMMIT**, e o ledger não pode ser sobrescrito nem apagado (AR-05). Um bug na aplicação que tentasse tocar o saldo sem ledger falha no commit.

**Custo.** Uma busca indexada extra por linha de wallet/ledger alterada por transação. 🟡 Medir no teste de carga; se virar gargalo, o trigger vira checagem em ambiente de teste e a reconciliação cobre a produção.

**Consequências para os testes.** `TRUNCATE` do ledger é bloqueado: os testes de integração usam um banco novo por suíte (migration up/down) e dados com IDs únicos, nunca limpeza por truncate.

### 8.3 Migrations (RNF-STK-07, AR-59)

**D15 — SQL escrito à mão (✅ decidido pelo autor).**

| Opção | Prós | Contras |
|---|---|---|
| **SQL à mão** (escolhida) | Controle total; o schema é parte do que é avaliado e boa parte dele não é gerável por ORM (trigger de ledger append-only, constraint trigger diferido saldo = ledger, índices parciais, CHECKs compostos); diff de revisão legível; `down` sempre fiel | Mais verboso; o ORM não detecta sozinho divergência entre `EntitySchema` e banco |
| Gerada pelo ORM a partir dos `EntitySchema` | Menos digitação nas tabelas | Triggers, constraint triggers e parte dos índices parciais/CHECKs ficam de fora e exigiriam SQL manual de qualquer forma; o schema passa a depender do gerador |
| Híbrido | Menos digitação | Schema espalhado entre arquivos gerados e manuais; o SQL gerado pode mudar entre versões do MikroORM (7.x é recente) |

Implementação: MikroORM `Migrator` com `migrations.migrationsList` explícita, **sem snapshot** (`snapshot: false`), um arquivo por mudança em `migrations/`, `up()` e `down()` com SQL explícito (os `down` removem triggers/funções/índices antes das tabelas). CI roda `up → down → up`.

**Mitigação do contra:** um teste de integração (M5) compara as colunas e os tipos que cada `EntitySchema` espera com o schema real do PostgreSQL após as migrations (`information_schema`), falhando se divergirem.

### 8.4 Reconciliação e leitura do ledger

- `POST /wallets/:id/reconciliation` roda numa transação `REPEATABLE READ READ ONLY` (um snapshot único, sem lock): `storedBalance` = `wallets.balance`; `calculatedBalance` = `Σ(CREDIT) − Σ(DEBIT)`; `checkedEntries` = contagem; verifica também o encadeamento (`balance_before` de cada entrada = `balance_after` da anterior). Divergência ⇒ `consistent:false`, log `ERROR`, métrica `reconciliation_divergences_total`; **nunca corrige** (AR-42). Retorna 200 com o corpo descrevendo o resultado.
- Paginação do ledger: cursor opaco = base64url de `{seq}` (+ versão do formato); `WHERE wallet_id = :w AND seq < :cursor ORDER BY seq DESC LIMIT :n`. Como as inserções de uma wallet são serializadas pelo lock, `seq` cresce em ordem de commit dentro da wallet ⇒ cursor estável, sem pular nem repetir. `limit` padrão 50, máximo 200.

### 8.5 Contrato da camada de persistência (M5)

- **Fonte única do schema no código: `TableDef`** (`shared/infrastructure/persistence/table-def.ts`). Cada tabela é declarada uma vez (`tables.ts` do contexto) e dela saem: a lista de colunas dos `SELECT` (`selectList`), o `INSERT` parametrizado (`insertStatement`), o `EntitySchema` do MikroORM (`toEntitySchema`) e o teste de divergência. O DDL continua sendo SQL à mão (D15); o teste compara colunas, tipos, `NULL`, `char(n)`, `numeric(p,s)` e identity de **cada** `TableDef` com `information_schema` e falha se divergirem.
- **Repositórios usam SQL explícito via `em.execute`** do `EntityManager` da transação em curso (§4.5). Todo valor vai como parâmetro (`?`); só nomes de tabela/coluna vêm de constantes. Uma guarda estática proíbe `getConnection()`.
- **`timestamptz` volta como texto do driver** (`2026-10-24 05:09:10.663757+00`), não como `Date`: `fetchRecords` coage as colunas `timestamptz` pelo `TableDef` (precisão de ms; o app só grava ms). `numeric` e `bigint` ficam `string`; `jsonb` volta como objeto. Achado do primeiro teste de integração real.
- **`UnitOfWork`** (`run`): `READ COMMITTED`, `SET LOCAL lock_timeout` (padrão 5 s) e `statement_timeout` (15 s) por transação, e chamada aninhada **entra** na transação em curso. Guarda o `EntityManager` num `AsyncLocalStorage` próprio. `requireTransaction` impede `FOR UPDATE`/`SKIP LOCKED` fora de transação.
- **Escritas condicionais** (`WHERE version = ?`, `WHERE status IN ('PENDING','PENDING_REFERENCE')`, `WHERE published_at IS NULL`, `WHERE processed_at IS NULL`) com `RETURNING`: zero linhas ⇒ `OptimisticLockError` (transitório). O banco, e não só o domínio, recusa reescrever uma transação terminal.
- **Idempotência**: `claim`, `Inbox.tryReceive` e `Wallet.insert` usam `INSERT … ON CONFLICT DO NOTHING RETURNING` (`true` = esta chamada criou; `false` = já existia). O `claim` não nomeia o alvo do conflito, pois deve cobrir a key **e** `(provider, externalId)`; quem recebe `false` consulta qual das duas colidiu.
- **Workers** (`claimDue`): `UPDATE … WHERE id IN (SELECT … FOR … SKIP LOCKED) RETURNING`, empurrando `next_attempt_at` para `now + lease`. O relógio é injetado (`now`), não `now()` do banco, para o teste ser determinístico. Vencimento inclusivo (`<=`). Uma reivindicação desfeita por rollback não consome o lease. O `claimDue` do outbox ordena por `(occurred_at, id)`; **garantir a ordem por grupo FIFO ao publicar é responsabilidade do publisher (M9)**, pois uma mensagem adiada por retry pode ser ultrapassada por outra do mesmo grupo.
- **`ErrorClassifier`** (`classifyError`): `DomainError` ⇒ `BUSINESS`; `OptimisticLockError`, SQLSTATE `40001/40P01/55P03/57014/57P0x/53xxx`, classe `08` e erros de rede ⇒ `TRANSIENT`; o resto (integridade `23xxx`, dado inválido `22xxx`, SQL inválido `42xxx`, desconhecido) ⇒ `PERMANENT`. Procura o código nas causas encadeadas e **nunca copia a mensagem original** (pode ter dados do jogador).
- **Invariant checker** (`test/support/database.ts`): saldo ≥ 0; saldo = `balance_after` do último lançamento = Σ(créditos − débitos); encadeamento `balance_before = balance_after` anterior; lançamento só de transação `PROCESSED`; toda `PROCESSED` que move saldo tem lançamento e `LOSS` não tem; reversão única. Tem suíte própria, que corrompe o banco desligando os triggers para provar que ele acusa.
- **Banco por suíte**: `createTestDatabase()` cria um banco novo e aplica as migrations (o ledger nem aceita `TRUNCATE`). `constraints.test.ts` insere linhas sintéticas direto em SQL para provar cada constraint e, por isso, não roda o checker global.
- **Prova por mutação**: 55 bugs plantados (SQL dos repositórios, locks, migrations, Unit of Work, classificador, coerção de datas, mapeadores); 53 morreram de primeira e 2 sobreviveram por testes fracos (um CHECK que falhava antes do CHECK testado, e um filtro de status nunca exercitado). Os testes foram corrigidos e os 55 estão mortos.

---

## 9. D7 — Máquina de estados, regras de reversão e `failureCode`

### 9.1 Transições válidas de `WagerTransaction`

| De \ Para | `PENDING` | `PENDING_REFERENCE` | `PROCESSED` | `REJECTED` | `FAILED` |
|---|:-:|:-:|:-:|:-:|:-:|
| *(create)* | ✔ nasce | | | | |
| `PENDING` | – | ✔ | ✔ | ✔ | ✔ |
| `PENDING_REFERENCE` | – | ✔ (nova tentativa) | ✔ | ✔ | ✔ |
| `PROCESSED` / `REJECTED` / `FAILED` | **terminais** — qualquer transição lança `InvalidTransactionStateError` (AR-19) |

No fluxo síncrono, `PENDING` existe só dentro da transação SQL (nunca é observado por outro leitor); permanece no modelo por fidelidade ao domínio e para eventual modo assíncrono.

### 9.2 Regras de reversão (RF-BIZ-02..09)

Pré-condições avaliadas por `WagerPolicy` (sob lock da wallet), em ordem:

1. `wallet.playerId = tx.playerId` e `wallet.currency = tx.currency` ⇒ senão `REJECTED PLAYER_WALLET_MISMATCH` / `CURRENCY_MISMATCH`.
2. `BET`: `balance ≥ amount` ⇒ senão `REJECTED INSUFFICIENT_FUNDS`.
3. Se a transação traz referência (`REFUND`/`ROLLBACK` obrigatória; `WIN`/`LOSS` opcional):
   - não existe ⇒ `PENDING_REFERENCE`;
   - existe mas está `PENDING_REFERENCE` ⇒ `PENDING_REFERENCE` (encadeado);
   - existe mas é `REJECTED`/`FAILED` ⇒ `REJECTED REFERENCE_NOT_PROCESSED`;
   - provider/player/wallet/moeda/rodada diferentes ⇒ `REJECTED REFERENCE_MISMATCH`;
   - tipo não permitido (`REFUND→BET`; `ROLLBACK→BET|WIN|REFUND`; `WIN→BET`) ⇒ `REJECTED REFERENCE_KIND_NOT_ALLOWED`;
   - para `REFUND`/`ROLLBACK`: valor ≠ referência ⇒ `REJECTED REFERENCE_AMOUNT_MISMATCH`; já revertida ⇒ `REJECTED ALREADY_REVERSED`;
   - para `WIN`/`LOSS` com referência: referência já revertida (existe `REFUND`/`ROLLBACK` `PROCESSED` apontando para ela) ⇒ `REJECTED REFERENCE_ALREADY_REVERSED`. Evita pagar prêmio de aposta cujo débito foi devolvido. A checagem usa o mesmo índice parcial `uq_wager_single_reversal`.
4. Efeito: `REFUND` ⇒ crédito; `ROLLBACK` ⇒ direção **inversa** do lançamento da referência (`ledgerDirectionFor(reference)`); se o débito resultante exceder o saldo ⇒ `REJECTED REVERSAL_WOULD_OVERDRAW` (código **distinto** de `INSUFFICIENT_FUNDS`, AR-28).

O índice `uq_wager_single_reversal` é a barreira definitiva de `ALREADY_REVERSED`; uma violação inesperada dele é tratada como `ALREADY_REVERSED` (rejeição), pois só ocorreria numa corrida impossível sob o lock.

**Interpretação estrita da regra 4** ("não pode ser revertida duas vezes pelo mesmo tipo"): adotamos **no máximo uma reversão por transação, de qualquer tipo**. Caso contrário uma `BET` poderia receber `REFUND` *e* `ROLLBACK`, creditando duas vezes e violando a invariante global "sem crédito duplicado". ✅ Confirmado pelo autor.

### 9.3 Taxonomia de `failureCode`

Estável, em `UPPER_SNAKE_CASE`, nunca reaproveitado/renomeado (mudança = nova versão). A coluna **Ação** orienta o provedor:

| Código | Estado | Significado | Ação sugerida ao provedor |
|---|---|---|---|
| `INSUFFICIENT_FUNDS` | REJECTED | `BET` > saldo | Nova transação (nova key) após recarga, ou desistir |
| `REVERSAL_WOULD_OVERDRAW` | REJECTED | reversão levaria o saldo a < 0 | Tratar fora de banda (ajuste manual); não reenviar |
| `CURRENCY_MISMATCH` | REJECTED | moeda ≠ moeda da wallet | Corrigir payload |
| `PLAYER_WALLET_MISMATCH` | REJECTED | `playerId` ≠ dono da wallet | Corrigir payload |
| `REFERENCE_NOT_FOUND` | REJECTED | referência não chegou dentro do limite do reprocessador | Reenviar a referência e depois nova tentativa (nova key), ou desistir |
| `REFERENCE_NOT_PROCESSED` | REJECTED | referência existe mas `REJECTED`/`FAILED` | Desistir |
| `REFERENCE_MISMATCH` | REJECTED | provider/player/wallet/moeda/rodada divergem | Corrigir payload |
| `REFERENCE_KIND_NOT_ALLOWED` | REJECTED | tipo da referência inválido para o `kind` | Corrigir payload |
| `REFERENCE_AMOUNT_MISMATCH` | REJECTED | valor ≠ valor da referência (sem reversão parcial) | Corrigir payload |
| `ALREADY_REVERSED` | REJECTED | `REFUND`/`ROLLBACK` sobre referência já revertida | Desistir (já resolvido) |
| `REFERENCE_ALREADY_REVERSED` | REJECTED | `WIN`/`LOSS` cuja `BET` referenciada já foi revertida | Desistir; o prêmio não é devido |
| `PROCESSING_RETRIES_EXHAUSTED` | FAILED | esgotou tentativas transitórias no consumidor | Reenviar (mesma key é segura) |
| `INTERNAL_PERMANENT_ERROR` | FAILED | erro permanente inesperado | Contatar o suporte; reenviar não resolve |

Erros **não persistidos** (a transação nem chega a existir): `INVALID_PAYLOAD`, `MISSING_IDEMPOTENCY_KEY`, `WALLET_NOT_FOUND`, `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_TRANSACTION_ID_CONFLICT`, `WALLET_ALREADY_EXISTS`, `SERVICE_UNAVAILABLE`.

`FAILED` é gravado numa transação própria e idempotente (best-effort) pelo consumidor antes de enviar à DLQ, apenas quando o payload é válido e a wallet existe.

### 9.4 Contrato do domínio de Wagering, eventos e mensageria (M4)

- **`WagerTransaction`**: nasce `PENDING`; `markProcessed`, `markPendingReference`, `reject` e `fail` seguem a tabela de transições (§9.1) e lançam `InvalidTransactionStateError` a partir de estados terminais. `reject` só aceita códigos de rejeição e `fail` só códigos técnicos (`REJECTION_CODES`/`FAILURE_CODES` particionam a taxonomia). `OPENING` só nasce por `createOpening` (provedor `internal`, `externalTransactionId = walletId`); `create` o recusa.
- **`payloadHash`** (SHA-256 do JSON canônico) é calculado no `create` e **não** é recalculado no `rehydrate`. Metadados (key, ids, datas) ficam fora do hash.
- **`decideWagerOutcome`** (política pura, sem I/O) recebe transação, wallet sob lock, referência já resolvida e o fato `referenceAlreadyReversed`; devolve `PROCESSED{direction|null}`, `REJECTED{code}` ou `PENDING_REFERENCE`. **Ordem das verificações**: jogador × wallet → moeda → fatos estáticos da referência (provedor, jogador, wallet, moeda, rodada) → tipo permitido → status da referência (em espera / não processada) → valor igual → já estornada → saldo. Fatos estáticos vêm **antes** do status porque uma referência errada não "melhora" esperando.
- **Rejeição por saldo**: `BET` sem saldo ⇒ `INSUFFICIENT_FUNDS`; reversão que debitaria além do saldo ⇒ `REVERSAL_WOULD_OVERDRAW`.
- **Tipos aceitos como referência**: `REFUND` → `BET`; `ROLLBACK` → `BET`/`WIN`/`REFUND`; `WIN`/`LOSS` (referência opcional) → `BET`.
- **`providerActionFor(code)`** mapeia cada `failureCode` à ação esperada do provedor (reenviar, corrigir payload, desistir, resolução manual), para a documentação de contrato (M11).
- **Eventos** (`IntegrationEvent<T>`): `eventType` e `version` fixados na subclasse; `data` é JSON puro (validado por `assertPlainJson`, dinheiro como `MoneyProps`, datas ISO), copiado e congelado. Cada evento é construído por `from(...)` e exige que a transação já esteja no estado que ele descreve; `WalletBalanceChanged.from` confere que o lançamento pertence à wallet e que `balanceAfter` é o saldo dela.
- **`pending-reference-policy`**: padrão de 10 tentativas, backoff 2 s·2ⁿ com teto de 5 min, TTL 1 h (limite de TTL inclusivo). O jitter é injetado, o que mantém a função determinística.
- **`InboxMessage`**: `markProcessed` uma única vez. **`OutboxMessage`**: o `eventId` é o id; nasce vencida no instante do evento; `nextAttemptAt` serve de vencimento e de lease; `scheduleRetry` usa backoff de 1 s até 5 min; publicada não volta à fila.
- **Prova por mutação**: 32 bugs plantados no domínio novo; os 32 foram detectados.

---

## 10. D8 — Referências fora de ordem (reprocessador)

**Problema.** `REFUND`/`ROLLBACK` (ou `WIN` com referência) chega antes da referência (RF-REF-*).

| Opção | Prós | Contras |
|---|---|---|
| A. Rejeitar de imediato | Simples | Perde operações válidas apenas por ordem de chegada |
| B. Reenfileirar no SQS com atraso | Sem worker de banco | Não é observável/auditável; limite de atraso (15 min); mistura estado no broker |
| **C. Persistir `PENDING_REFERENCE` + worker agendado** (escolhida) | Auditável, consultável pela API, sobrevive a restart, funciona multi-instância | Precisa de worker e de *claim* seguro |

**Mecânica.**

1. **Claim com lease** (curta, sem segurar lock):

```sql
UPDATE wager_transactions SET next_attempt_at = now() + interval '60 seconds'     -- lease
WHERE id IN (SELECT id FROM wager_transactions
             WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= now()
             ORDER BY next_attempt_at LIMIT :batch FOR UPDATE SKIP LOCKED)
RETURNING id, wallet_id;
```

2. Para cada id, executa `ReprocessPendingTransactionUseCase(id)` numa transação nova: **trava a wallet primeiro**, depois relê a transação `FOR UPDATE` e confere que ainda é `PENDING_REFERENCE` (senão no-op, pois outra instância/wake-up já resolveu). Reaplica `WagerPolicy`:
   - referência apareceu ⇒ `PROCESSED`/`REJECTED` + eventos normais;
   - ainda ausente ⇒ `attempts+1` e `next_attempt_at = now() + backoff(attempts)`;
   - `attempts ≥ MAX` (ou idade > TTL) ⇒ `REJECTED REFERENCE_NOT_FOUND` + `WagerTransactionRejected`.
3. **Backoff:** `delay = min(cap, base · 2^attempts) · jitter(0.8–1.2)` com `base = 2s`, `cap = 5min`. **Limite: 10 tentativas (≈ 18 min) e TTL absoluto de 1 h** (o que ocorrer primeiro), configuráveis por env. *Justificativa:* a defasagem esperada entre mensagens de um mesmo provedor é de segundos; ~18 min cobre incidentes curtos do provedor sem manter pendências indefinidas, e o TTL é o freio de segurança caso o worker fique parado.
4. **Wake-up oportunista:** ao processar qualquer transação, o passo [5] do fluxo faz `next_attempt_at = now()` para dependentes pendentes daquela referência, de modo que a resolução costuma acontecer no próximo ciclo do worker (≈ 1–2 s), sem depender do backoff.
5. Lease expirada (worker morreu) ⇒ a linha volta a ficar elegível sozinha.

Evento `WagerTransactionPendingReference` é emitido **uma vez** (na primeira vez que a transação vira pendente), não a cada tentativa.

---

## 11. D9 — Consumo SQS

**Cliente.** `@aws-sdk/client-sqs` direto (sem wrapper NestJS de SQS): precisamos de controle fino de `ack`, visibilidade e DLQ, que é exatamente o que o desafio avalia.

**Filas.** `wager-transactions.fifo` (entrada), `wager-transactions-dlq.fifo` (DLQ), `wager-events.fifo` (saída do outbox, §12). Provisionadas por um `ensureQueues()` idempotente na subida (`CreateQueue` com os mesmos atributos é idempotente). Redrive nativo `maxReceiveCount = 5` na fila de entrada. Emulador: **MiniStack** (ver D14, §15.5).

**Batch FIFO.** Um único `ReceiveMessage` FIFO pode devolver várias mensagens **do mesmo grupo**, em ordem. O consumidor deve processar em paralelo apenas mensagens de grupos (`walletId`) diferentes e **em série** as do mesmo grupo dentro do lote; enquanto uma mensagem de um grupo está em voo, o SQS não entrega novas desse grupo.

**FIFO.** Produtor usa `MessageGroupId = walletId`. Isso reduz a concorrência por wallet e preserva ordem *quando possível*, mas **não é a garantia** (AR-03): o banco continua sendo a barreira. Efeito colateral aceito: *head-of-line blocking* por wallet quando uma mensagem fica falhando — mitigado por limite de tentativas.

**Loop do consumidor.**

```
long poll (WaitTimeSeconds=20, MaxNumberOfMessages=10) → pool de N handlers (concorrência configurável)
para cada mensagem:
   parse + validação ─ inválida ───────────────▶ PERMANENTE
   use case (mesma função do HTTP)
      ├─ sucesso / replay / REJECTED persistido ─▶ deleteMessage (ACK, só depois do COMMIT)
      ├─ TransientError ─────────────────────────▶ NÃO deleta; ChangeMessageVisibility(backoff por ApproximateReceiveCount)
      └─ PermanentError ─────────────────────────▶ (grava FAILED, best-effort) → SendMessage na DLQ com atributos de erro → deleteMessage
```

**Classificação de erros** (RF-SQS-06, AR-47):

| Classe | Exemplos | Tratamento |
|---|---|---|
| **Negócio** | saldo insuficiente, referência inválida, replay | Resultado persistido (`REJECTED`) ⇒ **ack** |
| **Transitório** | conexão PG recusada/caída, `55P03`, `40001`, `40P01`, timeout, erro de SQS | **Retry** com backoff exponencial via visibilidade; após `maxReceiveCount` o redrive nativo envia à DLQ; ao atingir o limite o consumidor grava `FAILED(PROCESSING_RETRIES_EXHAUSTED)` best-effort |
| **Permanente** | JSON/schema inválido, `kind = OPENING`, wallet inexistente, `messageId` repetido com `payloadHash` diferente, violação de invariante inesperada | **DLQ** imediata + ack do original |

A classificação mora em um `ErrorClassifier` único (mapeia códigos SQLSTATE/`ECONN*`/classes de erro de domínio) reutilizado pelo HTTP (503 vs 500 vs 4xx).

**Inbox.** `INSERT … ON CONFLICT DO NOTHING` na transação (§7). Mensagem repetida: se a linha existe, já foi commitada por inteiro ⇒ ack. Repetida com `payload_hash` diferente ⇒ permanente (DLQ). A inbox é a dedup rápida; a correção final independe dela (a idempotency key cobre mensagens distintas com o mesmo conteúdo).

**Shutdown (SIGTERM, RF-SQS-08).** Nest `enableShutdownHooks()`: (1) parar de fazer poll (abort do long poll); (2) aguardar handlers em andamento até `SHUTDOWN_GRACE_MS` (padrão 25 s); (3) as mensagens ainda não concluídas recebem `ChangeMessageVisibility(0)` para redelivery imediato; (4) fechar pool do PG por último. O `terminationGracePeriod`/`stop_grace_period` do compose é maior que esse valor.

---

## 12. D10 — Transactional Outbox

### 12.1 Escrita

Na mesma transação do §7, `OutboxMessage.enqueue(event)` insere a linha (`id = eventId`, `payload = event.toJSON()` com `MoneyProps` em string, `message_group_id = walletId`, `next_attempt_at = now()`). Nada é enviado antes do COMMIT (AR-04, AR-51).

### 12.2 Publicação com múltiplos publishers

| Opção | Prós | Contras |
|---|---|---|
| A. Manter a tx aberta com `FOR UPDATE SKIP LOCKED` durante o envio ao SQS | Sem coluna de lease | Transação longa presa em I/O de rede; consome conexões; pior sob falha do SQS |
| **B. Lease via `next_attempt_at` + `SKIP LOCKED` no claim** (escolhida) | Claim é curto; crash devolve a linha sozinho; sem coluna extra | Pode haver republicação (aceita; at-least-once) |
| C. `LISTEN/NOTIFY` | Baixa latência | Não é durável; polling segue necessário |

Ciclo (cada publisher, a cada ~500 ms ou após *nudge*):

1. **Claim:** `UPDATE outbox_messages SET next_attempt_at = now() + interval '30 seconds' WHERE id IN (SELECT id … WHERE published_at IS NULL AND next_attempt_at <= now() ORDER BY occurred_at LIMIT :batch FOR UPDATE SKIP LOCKED) RETURNING *`.
2. **Publicar** no `wager-events.fifo`: `MessageGroupId = message_group_id`, `MessageDeduplicationId = eventId`, corpo = envelope JSON, atributos `eventType`/`correlationId`.
3. Sucesso ⇒ `markPublished` (`UPDATE … SET published_at = now()`). Falha ⇒ `scheduleRetry(now)` (`attempts+1`, backoff exponencial com teto, `last_error`).

**Cenário de crash (RF-OUT-04).** Commit OK → processo morre → lease de 30 s expira → outro publisher faz o claim → publica. Se o morto já tinha publicado e não marcou, haverá **duplicata**: o consumidor deduplica por `eventId` (documentado no contrato do evento); a dedup nativa do FIFO (janela de 5 min) é só uma otimização.

**Ordenação.** Com publishers concorrentes a ordem global/por wallet *não é garantida*. Eventos carregam `walletVersion` (em `WalletBalanceChanged`) e `occurredAt` para o consumidor reordenar/descartar obsoletos.

**Lag.** Gauge `outbox_lag_seconds` = `now() − min(occurred_at)` das não publicadas, e `outbox_pending_total`; calculados no scrape.

### 12.3 Eventos emitidos

| Resultado | Eventos |
|---|---|
| `PROCESSED` com efeito no saldo | `WagerTransactionProcessed` + `WalletBalanceChanged` |
| `PROCESSED` `LOSS` | `WagerTransactionProcessed` (sem `WalletBalanceChanged`) |
| `REJECTED` (inclui `REFERENCE_NOT_FOUND` do reprocessador) | `WagerTransactionRejected` |
| 1ª vez em `PENDING_REFERENCE` | `WagerTransactionPendingReference` |
| `OPENING` (criação de wallet com saldo > 0) | `WagerTransactionProcessed` + `WalletBalanceChanged` |
| `FAILED` | `WagerTransactionFailed` (evento extra, além dos 4 mínimos; carrega `transactionId` e `failureCode`) |

Envelope: classe abstrata `IntegrationEvent<T>` com subclasses concretas (`eventType` e `version` no tipo). `correlationId` vem do contexto (header `x-correlation-id` ou gerado); `causationId` = `transactionId`/`messageId` de origem.

---

## 13. D11 — API HTTP: modo de processamento e status

### 13.1 Síncrono × assíncrono (✅ síncrono)

| Opção | Prós | Contras |
|---|---|---|
| **A. Síncrono**: processa no request e devolve o resultado final (escolhida) | Casa com o contrato do README (resposta com `status` e `balance`); sem estado intermediário observável; uma única transação | Latência atrelada ao lock da wallet |
| B. Assíncrono: grava e enfileira, responde 202 | Absorve picos | Resposta do README não teria `balance`/`PROCESSED`; exige polling; mais partes móveis |

### 13.2 Mapeamento de status (consistente em todos os endpoints)

| Situação | HTTP | `code` / corpo |
|---|---|---|
| Processada (1ª vez ou replay) | **200** | `{ transactionId, status:"PROCESSED", balance, idempotentReplay }` |
| Aceita, aguardando referência | **202** | `status:"PENDING_REFERENCE"`, `balance:null` (+ `Location` para a consulta) |
| Rejeitada por regra de negócio (1ª vez ou replay) | **422** | `{ transactionId, status:"REJECTED", failureCode, balance, idempotentReplay }` |
| Payload inválido / header ausente | **400** | problem+json `INVALID_PAYLOAD` / `MISSING_IDEMPOTENCY_KEY` (com `errors[]`) |
| Recurso inexistente (wallet/transação) | **404** | `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` |
| Conflito de idempotência / duplicidade | **409** | `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_TRANSACTION_ID_CONFLICT`, `WALLET_ALREADY_EXISTS` |
| Falha transitória de infraestrutura | **503** + `Retry-After` | `SERVICE_UNAVAILABLE` — **seguro reenviar com a mesma key** |
| Erro inesperado | **500** | `INTERNAL_ERROR` — não reenviar às cegas; consultar a transação pelo `externalTransactionId` |
| Criação de wallet | **201** (+ `Location`) | `{ id, playerId, balance, version }` |
| `GET` de recurso existente | **200** | o estado do recurso (uma transação `REJECTED` consultada é 200: é estado, não resultado de comando) |
| Reconciliação | **200** | corpo com `consistent` true/false (divergência é dado, não erro) |

Erros em `application/problem+json` (RFC 9457) com campos extras `code` (estável), `correlationId` e `errors[]`. Regra de decisão para o provedor: **4xx ⇒ não reenviar igual** (400 corrigir; 409 revisar key; 422 resultado final); **202 ⇒ aguardar/consultar**; **503 ⇒ reenviar igual**.

### 13.3 DTOs e validação

Validação na borda (schema) + `Money.from` + checagem de enum, rejeitando campos desconhecidos. Campo opcional `referenceExternalTransactionId` no body HTTP e em `data` da mensagem SQS. `kind = OPENING` ⇒ 400. O header é a fonte da key; se o body trouxer `idempotencyKey` divergente (SQS), prevalece o campo da mensagem como "header" equivalente.

### 13.4 Contrato da API de wallets (M6)

| Endpoint | Sucesso | Erros |
|---|---|---|
| `POST /wallets` | **201** + `Location: /wallets/{id}`, corpo `{ id, playerId, balance, version }` | 400 `INVALID_PAYLOAD` · 409 `WALLET_ALREADY_EXISTS` · 413 · 503 |
| `GET /wallets/:walletId` | 200, o corpo do POST + `createdAt`/`updatedAt` | 400 (id não UUID) · 404 `WALLET_NOT_FOUND` |
| `GET /wallets/:walletId/ledger?cursor&limit` | 200 `{ items[], nextCursor }` | 400 `INVALID_PAYLOAD` (`limit`) · 400 `INVALID_CURSOR` · 404 |
| `POST /wallets/:walletId/reconciliation` | **200**, com `consistent` true/false | 400 · 404 |

- **Criação (RF-API-01/02, AR-15).** Uma só transação SQL: `INSERT wallets … ON CONFLICT DO NOTHING` → transação `OPENING` (`PROCESSED`) → lançamento `CREDIT` → 2 linhas na outbox (`WagerTransactionProcessed` + `WalletBalanceChanged`, `message_group_id = walletId`). A ordem é imposta pela FK do ledger (a transação precisa existir antes do lançamento). Sob criação concorrente, o banco decide: uma vence, as demais recebem 409 sem gravar nada. Saldo inicial zero cria só a wallet. A **moeda** é a do saldo inicial (uma wallet por `(playerId, moeda)`).
- **Fronteira entre contextos.** O `wallet` não conhece a transação `OPENING`: define a porta `OpeningRecorder` (`wallet/application/ports`), implementada pelo `wagering` (`WageringOpeningRecorder`), que cria a transação e enfileira os eventos.
- **Paginação (RF-API-04, AR-41).** Ordem do mais novo ao mais antigo por `seq` (identity do ledger). O cursor é **opaco** (base64url de `{v,w,s}`) e **estável**: aponta para o último `seq` entregue, então lançamentos novos nunca deslocam páginas já lidas. Como `seq` é atribuído sob o lock da wallet, a ordem de `seq` coincide com a de commit **por wallet**. O cursor carrega a wallet e é recusado em outra (`INVALID_CURSOR`); não é assinado (adulterá-lo só muda a posição de leitura de dados já acessíveis). `limit`: 1–200, padrão 50; fora disso é 400 (não há clamp silencioso).
- **Reconciliação (RF-API-12/13, AR-42).** Executa em **`REPEATABLE READ`** (snapshot único) sem lock: lê a wallet e soma o ledger no banco numa única consulta. Assim saldo e ledger vêm do mesmo instante mesmo com apostas em andamento, e a reconciliação não bloqueia o processamento (testado de forma determinística, forçando um commit entre as duas leituras). `difference = storedBalance − calculatedBalance` (pode ser negativa). Divergência é **dado**, não erro: 200 com `consistent: false`; é logada (só ids e contagem, sem valores) e contada em `reconciliation_divergences_total`. **Nunca é corrigida.**
- **Erros.** Todo erro sai como `application/problem+json` (`ProblemDetailsFilter` global) com `code`, `correlationId` e, na validação, `errors[]` (caminho + motivo, sem ecoar o valor enviado). `toProblem` é uma função pura: `DomainError` de entrada malformada → 400; outros `DomainError` → 422 com o próprio `code`; erro transitório de infra → 503 + `Retry-After`; o resto → 500. O log de 5xx traz só nome e classificação, **nunca a mensagem** (erros do PostgreSQL podem conter a linha inteira, inclusive saldo).
- **Validação de borda.** `zod` estrito (campos desconhecidos rejeitados); ids de rota validados como UUID antes de tocar o banco (senão o cast `uuid` do PostgreSQL viraria 500).
- **Correlação.** `x-correlation-id` do cliente é aceito só se for seguro para log (`[A-Za-z0-9._:-]{1,128}`); senão é gerado. Volta no header e no corpo dos erros.
- **Auth (RF-AUTH-01).** `AuthGuard` global no-op + `@Public()` (health) + `ProviderIdentityPort` no-op, em `src/auth`.
- **Unit of Work.** Ganhou a opção `isolation` (`READ COMMITTED` padrão | `REPEATABLE READ`).
- **Métricas.** `AppMetrics` (prom-client) nasce com `reconciliation_divergences_total`; o M11 acrescenta as demais e o endpoint `/metrics`.

---

## 14. D12 — Estrutura de módulos e camadas

```
src/
  main.ts                       # bootstrap; APP_ROLES liga api/consumer/publisher/reprocessor
  shared/
    kernel/                     # Money, erros de domínio, Clock, IdGenerator (UUIDv7), canonical-json
    infrastructure/             # config, logger (pino), metrics (prom-client), UnitOfWork, ErrorClassifier
  wallet/
    domain/                     # Wallet, WalletLedgerEntry, LedgerDirection, erros
    application/                # CreateWalletUseCase, GetWallet, ListLedger, ReconcileWallet; ports (WalletRepository, LedgerRepository)
    infrastructure/persistence/ # schemas, mappers, repositórios MikroORM
    interfaces/http/            # WalletController
  wagering/
    domain/                     # WagerTransaction, WagerPolicy, FailureCode, IntegrationEvents (subclasses)
    application/                # ProcessWagerTransactionUseCase, ReprocessPendingTransactionUseCase, queries; ports
    infrastructure/             # persistence + workers (PendingReferenceWorker)
    interfaces/http/            # WageringController
  messaging/
    domain/                     # InboxMessage, OutboxMessage, IntegrationEvent (base)
    application/                # ports (InboxRepository, OutboxRepository, EventBus/Publisher)
    infrastructure/             # SqsClient, SqsConsumer, OutboxPublisher, persistência
  health/                       # /health/live, /health/ready, /metrics
  auth/                         # AuthGuard no-op + ProviderIdentityPort (ponto de extensão)
migrations/
test/ (unit | integration | concurrency)
```

Regras de dependência: `domain` não importa nada de Nest/MikroORM/AWS; `application` depende só de `domain` e de **portas** (tokens `Symbol`); `infrastructure` implementa as portas; `interfaces` só chama use cases. Dependência entre contextos apenas via portas/IDs (o `wagering` usa a porta `WalletGateway`, implementada sobre o repositório do `wallet`, sem importar internals dele). Aggregates com construtor `private` e factories (`create`/`open`/`from`/`rehydrate`).

Bibliotecas: `@nestjs/*`, `@mikro-orm/{core,postgresql,migrations,nestjs}`, `@aws-sdk/client-sqs`, `zod` (validação de borda, schemas compartilhados HTTP/SQS), `uuid` (v7), `pino`/`nestjs-pino`, `prom-client`. Sem Prisma (AR-10).

---

## 15. D13 — Observabilidade, testes, autenticação, deploy

### 15.1 Logs e métricas (✅)

- **pino** JSON; `correlationId` via `AsyncLocalStorage` (entra por `x-correlation-id`, `messageId` da fila ou gerado). Campos padrão: `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`.
- **Sem payload financeiro** (AR-55): logs carregam ids, `kind`, `status`, `failureCode`, duração; **não** `amount`/`balance`/body. Redaction configurada para `*.money`, `*.amount`, `*.balance`, `authorization`.
- **Métricas** (`/metrics`, formato Prometheus): `wager_transactions_total{status,kind}`, `wager_duplicates_total{source}` (replay/inbox), `wager_retries_total{stage}`, `dlq_messages_total`, `lock_conflicts_total{reason}`, `wallet_lock_wait_seconds`, `outbox_lag_seconds`, `outbox_pending_total`, `wager_processing_duration_seconds{source}`, `reconciliation_divergences_total`.
- **Health:** `/health/live` (processo responde, sem dependências) e `/health/ready` (`SELECT 1` no PG + `GetQueueAttributes` no SQS, com timeout curto); ambos públicos (AR-36).

### 15.2 Estratégia de testes (✅)

- Unidade (`bun test`): `Money`, `Wallet`, `WagerTransaction`, `WagerPolicy`, canonicalização/hash.
- Integração: PostgreSQL e MiniStack **reais** via `docker-compose.test.yml` (decisão: preferido a Testcontainers por ser a mesma ferramenta do ambiente local e facilitar processos `bun` filhos contra a mesma infra), disparado por `bun run test:integration`; banco novo por suíte, migrations `up/down/up`, asserts de constraints e triggers.
- Concorrência (paralelismo real, AR-58): `Promise.all` com pool de conexões independente por "instância" e, para multi-instância, **processos `bun` filhos** (≥ 3) contra o mesmo PG/MiniStack; crash simulado com `SIGKILL` entre commit e ack; reinício do serviço.
- Todo teste termina com o *invariant checker*: `wallet.balance == Σ ledger` e `balance_before/after` encadeados.

### 15.3 Autenticação (✅ não implementar; ponto de extensão)

Decisão do autor: autenticação **não será implementada** (não pontua e não deve competir com correção financeira). O README aceita isso desde que a decisão fique documentada e o ponto de extensão seja explícito no código. Desenho que seria adotado: IdP (Keycloak) com *client credentials* por provedor; JWT validado por um `AuthGuard` global; a claim `provider_id` precisa coincidir com `providerId` do body (via `ProviderIdentityPort.assertMayActFor(providerId)`); mensagens SQS são canal interno confiável, mas `providerId` segue validado pelo domínio. No código: `AuthGuard` no-op global + `@Public()` nos endpoints de health/metrics.

### 15.4 Deploy local

`docker-compose.yml`: `postgres`, `ministack` (`ministackorg/ministack`, porta 4566; as 3 filas são criadas pelo `ensureQueues()` da aplicação), `migrate` (one-shot), `app` (API, escalável via `--scale app=3` atrás de um proxy simples) e `worker` (consumer + publisher + reprocessor). Tudo da mesma imagem; `bun run test:load` opcional (diferencial).

### 15.5 D14 — Emulador de SQS: MiniStack (✅ validado)

| Opção | Prós | Contras |
|---|---|---|
| **MiniStack** (escolhida) | Open source (MIT); sem conta nem token; imagem ~270 MB, sobe em segundos; citado como válido no README; quem avaliar roda `docker compose up` sem configurar nada | Projeto mais novo |
| LocalStack atual | Maduro e fiel à AWS | Desde 23/03/2026 exige conta e `LOCALSTACK_AUTH_TOKEN` (plano gratuito Hobby só para uso não comercial); o avaliador precisaria do próprio token. Verificado: sem token o container encerra com "License activation failed" |
| LocalStack antigo fixado | Sem token | Congelado, sem correções; tag pode sumir |

**Validação (10/10 passaram, `@aws-sdk/client-sqs` 3.1156 contra `ministackorg/ministack:latest`):** criação de fila FIFO e DLQ FIFO; `GetQueueAttributes(QueueArn)`; `RedrivePolicy` com `maxReceiveCount`; dedup por `MessageDeduplicationId`; `ApproximateReceiveCount` incrementando; `ChangeMessageVisibility` com 0 (redelivery imediato) e com 4 s (atraso respeitado); bloqueio de grupo FIFO com mensagem em voo, sem bloquear outros grupos; redrive nativo para a DLQ após `maxReceiveCount`; `SendMessage` explícito na DLQ com `MessageAttributes`; long polling (~1,1 s com mensagem chegando durante a espera); `CreateQueue` idempotente e `GetQueueUrl`.

**Fallback:** se algum comportamento divergir da AWS no futuro, trocar para LocalStack com token é só mudar a imagem e o `SQS_ENDPOINT` no compose; o código usa o SDK padrão.

---

## 16. Interpretações adotadas, limitações e questões em aberto

### Interpretações adotadas (a documentar também no README final)

1. **Reversão única de qualquer tipo** por transação (mais estrita que "mesmo tipo"), para sustentar "sem crédito duplicado". ✅
2. **`amount` com exatamente 2 casas na entrada** (`"25"` é 400). Evita ambiguidade de hash e nunca arredonda. ✅
3. **Valor zero**: só `LOSS` (e nenhum lançamento); demais kinds exigem `> 0`.
4. **Referência opcional em `WIN`/`LOSS`**, quando informada, passa pelas mesmas validações e pode gerar `PENDING_REFERENCE`.
5. **`WIN`/`LOSS` com referência a `BET` já revertida** são rejeitados com `REFERENCE_ALREADY_REVERSED`. ✅
6. **Wallet inexistente** não gera registro de transação: 404 (HTTP) / DLQ (SQS).
7. **`OPENING`**: a wallet nasce com `balance = initialBalance`, `version = 1`, junto de transação `OPENING` (`provider_id='internal'`, `external_transaction_id=walletId`, key `opening:{walletId}`) e lançamento `CREDIT` (`balance_before=0`). Emite `Processed` + `BalanceChanged`.
8. **Replay de transação pendente** devolve 202 com `balance:null`; após resolvida, devolve o resultado original.
9. **Eventos publicados** em uma fila FIFO dedicada `wager-events.fifo`.

### Limitações conhecidas

- Hot wallet: vazão por wallet limitada pelo tempo da transação (lock pessimista).
- Ordem de eventos publicados não é garantida com múltiplos publishers (mitigada por `walletVersion`).
- Dedup do FIFO é de 5 min; a correção não depende dela.
- Head-of-line blocking por `MessageGroupId` enquanto uma mensagem falha.
- Constraint trigger diferido tem custo por escrita (🟡 medir).
- Autenticação não implementada.

### Questões em aberto

- 🟡 Parâmetros finais (lock_timeout, lease, tamanhos de lote, concorrência do consumer) após o teste de carga.

---

## 17. Registro de alterações

| Data | Alteração |
|---|---|
| 2026-10-23 | Versão inicial: decisões D1–D13, schema de referência, taxonomia de `failureCode`, mapeamento HTTP. |
| 2026-10-23 | Decisões revisadas uma a uma com o autor e confirmadas: D1 (bigint, entrada com exatamente 2 casas), D2, D3, D4 (+ key divergente = 409), D6 (sem trigger de `version`), D7 (reversão única de qualquer tipo), D8 (10 tentativas / TTL 1h), D9, D10 (+ fila `wager-events.fifo`), D11 (síncrono, mapeamento HTTP), D12, D13 (pino + prom-client, `docker-compose.test.yml`, sem autenticação). Fechadas as duas pendências: `WIN`/`LOSS` sobre `BET` revertida são rejeitados (`REFERENCE_ALREADY_REVERSED`) e `FAILED` emite `WagerTransactionFailed`. Auth: `AuthGuard` no-op + `ProviderIdentityPort`. |
| 2026-10-24 | D14: emulador de SQS = MiniStack (LocalStack atual exige token). Validado 10/10 em teste com o SDK real. Adicionada nota sobre lotes FIFO com várias mensagens do mesmo grupo (§11). Ambiente: Bun 1.4.4 instalado; Docker Desktop iniciado. |
| 2026-10-24 | M1: spike da stack concluído (§4.5). Versões: NestJS 12, MikroORM 7, TypeScript 7. Achado crítico: dentro de transação usar `em.execute`, nunca `em.getConnection().execute` (este ignora a transação). Migrator via `extensions` + `migrationsList`. Guardas estáticas de AR-01 e AR-33. |
| 2026-10-24 | D15: migrations em SQL escrito à mão, confirmadas pelo autor (antes estavam assumidas no scaffold sem consulta). Adicionado teste de divergência `EntitySchema` × banco ao M5. |
| 2026-10-24 | M2: `Money` (bigint em centavos, congelado), erros de domínio com `code`, `Clock`, `IdGenerator` (UUIDv7), JSON canônico e `sha256`. Decisões de detalhe: `equals` entre moedas diferentes é `false`; canonicalização rejeita `undefined`. |
| 2026-10-24 | M3: domínio da `Wallet` e do `WalletLedgerEntry` (§5.1). Adaptação: `Wallet.open` devolve `{ wallet, openingEntry }`. Kernel ganhou `InvalidArgumentError`, `requireText` e `requireDate`. |
| 2026-10-24 | M4: domínio de Wagering (§9.4), eventos de integração, `InboxMessage`/`OutboxMessage`. Kernel ganhou `backoff`, `plain-json` e `IntegrationEvent`. Detalhes decididos: ordem das verificações da política, `providerActionFor`, TTL inclusivo. |
| 2026-10-24 | M5: persistência (§8.5). `TableDef` como fonte única de schema; migrations SQL à mão (tabelas + triggers); repositórios, `UnitOfWork`, `ErrorClassifier`, invariant checker. **Revisão do D3 (§5.2):** `FOR NO KEY UPDATE` no lugar de `FOR UPDATE`, após deadlock real entre o `KEY SHARE` das FKs e o lock da wallet. Achado: `em.execute` devolve `timestamptz` como texto. |
| 2026-10-26 | M6: API de wallets (§13.4). Porta `OpeningRecorder` entre os contextos; cursor opaco por `seq`; reconciliação em `REPEATABLE READ`; `problem+json` global com `toProblem` puro; `AuthGuard` no-op. `UnitOfWork` ganhou `isolation`. Política de mutation check proporcional ao risco registrada em `milestones.md`. |

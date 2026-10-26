# Requisitos — Distributed Wagering Processor

Derivado do `README.md` do desafio. Referências `§N` apontam para as seções do README.

Legenda de IDs: **RF** (funcional), **RNF** (não funcional), **AR** (antirequisito: o que NÃO se pode fazer; cumprimento obrigatório), **FE** (falha eliminatória), **DEC** (decisão a cargo do candidato, a documentar).

---

## 1. Escopo

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de múltiplos provedores, por HTTP e SQS, com entrega **at-least-once**. Deve permanecer correto sob mensagens duplicadas, fora de ordem, processamento simultâneo, múltiplas instâncias e indisponibilidade temporária de PostgreSQL/SQS.

**Invariantes globais (§3):** sem crédito duplicado, sem débito duplicado, sem perda de evento confirmado, sem saldo negativo.
**Invariante final de todos os testes (§13):** `wallet.balance == saldo reconstruído pelo ledger`.

---

## 2. Requisitos funcionais

### 2.1 Money (§6.1)

- **RF-MON-01** `Money` é imutável; toda operação retorna nova instância.
- **RF-MON-02** Operações: `from`, `zero`, `add`, `subtract`, `negate`, `isZero`, `isPositive`, `isNegative`, `isLessThan`, `equals`, `toJSON`, `toString`.
- **RF-MON-03** `amount` é recebido e serializado como string decimal com escala fixa de 2 casas (ex.: `"25.00"`).
- **RF-MON-04** Operações entre moedas diferentes lançam erro de domínio (`assertSameCurrency`).
- **RF-MON-05** Rejeitar entradas inválidas: `NaN`, `Infinity`, notação científica, string vazia, mais de 2 casas decimais, valores negativos em contratos de entrada.
- **RF-MON-06** Modelo multi-moeda (pode-se operar só com `BRL`, mas conflitos de moeda devem ser testados).
- **RF-MON-07** Persistência com valor e moeda em colunas separadas, representação exata, reidratada como `Money`.
- **RF-MON-08** Contratos usam `{ "amount": "25.00", "currency": "BRL" }`.

### 2.2 Wallet (§6.2)

- **RF-WAL-01** Aggregate root com `open`, `rehydrate`, `debit`, `credit`; `balance`, `version`, `updatedAt` expostos por getters.
- **RF-WAL-02** No máximo uma wallet por `(playerId, currency)`.
- **RF-WAL-03** Saldo nunca negativo.
- **RF-WAL-04** Toda alteração de saldo tem um lançamento de ledger correspondente, e vice-versa.
- **RF-WAL-05** Moeda da operação deve ser igual à da wallet.
- **RF-WAL-06** `version` inicia em `1` e incrementa **somente** quando o saldo muda.
- **RF-WAL-07** Operações concorrentes não causam lost update.

### 2.3 WagerTransaction (§6.3)

- **RF-TRX-01** Kinds: `OPENING` (interno), `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`.
- **RF-TRX-02** Status: `PENDING`, `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED`. Os três últimos são terminais.
- **RF-TRX-03** `create` nasce em `PENDING` e valida exigência de referência por kind.
- **RF-TRX-04** Transições: `markProcessed`, `markPendingReference`, `reject`, `fail`; transição a partir de estado terminal lança `InvalidTransactionStateError` (erro de programação, não caminho de negócio).
- **RF-TRX-05** Consultas de domínio: `isTerminal`, `affectsBalance` (false para `LOSS`), `requiresReference` (true para `REFUND`/`ROLLBACK`), `matchesPayload`, `ledgerDirectionFor`.
- **RF-TRX-06** Mesma idempotency key com payload diferente é **conflito**, não replay.
- **RF-TRX-07** Tabela de transições válidas definida e documentada. (DEC)

### 2.4 Ledger (§6.4)

- **RF-LED-01** `WalletLedgerEntry` com `create`, `rehydrate`, `isBalanced`; sem campos mutáveis nem métodos de transição.
- **RF-LED-02** `create` valida `balanceBefore ± money === balanceAfter`.
- **RF-LED-03** No máximo um lançamento por transação por wallet.
- **RF-LED-04** `LOSS` e qualquer transação `REJECTED` não geram lançamento.

### 2.5 Regras de negócio (§7)

| Op | Efeito | Ledger | Regra |
|---|---|---|---|
| `BET` | débito | 1 `DEBIT` | rejeitar se saldo insuficiente |
| `WIN` | crédito | 1 `CREDIT` | pode referenciar a `BET` da mesma rodada |
| `LOSS` | nenhum | nenhum | registra resultado sem mover saldo |
| `REFUND` | crédito | 1 `CREDIT` | reverte uma `BET` `PROCESSED`, uma única vez |
| `ROLLBACK` | inverso da referência | 1 entrada invertida | reverte transação `PROCESSED`, uma única vez |

- **RF-BIZ-01** `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`.
- **RF-BIZ-02** Referência resolvida por `(providerId, referenceExternalTransactionId)`, devendo pertencer ao mesmo provider, player, wallet, moeda e rodada.
- **RF-BIZ-03** `REFUND` só referencia `BET`. `ROLLBACK` referencia `BET`, `WIN` ou `REFUND`.
- **RF-BIZ-04** Uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação.
- **RF-BIZ-05** Valor de `REFUND`/`ROLLBACK` **igual** ao da referência.
- **RF-BIZ-06** `REJECTED` não altera saldo nem gera ledger.
- **RF-BIZ-07** Repetir operação já processada retorna o **resultado original**, incluindo o saldo observado naquele momento.
- **RF-BIZ-08** Referência ausente → persistir como `PENDING_REFERENCE` e reprocessar depois.
- **RF-BIZ-09** Reversão que geraria saldo negativo é rejeitada explicitamente, com `failureCode` **distinto** do de aposta sem saldo, e permanece auditável.
- **RF-BIZ-10** Interpretações adicionais adotadas devem ser documentadas. (DEC)

### 2.6 Referências fora de ordem (§7.1)

- **RF-REF-01** Worker agendado reprocessa `PENDING_REFERENCE` com backoff exponencial.
- **RF-REF-02** Limite de tentativas ou TTL definido e justificado. (DEC)
- **RF-REF-03** Esgotado o limite: `REJECTED` com `failureCode` que identifique referência inexistente, e evento correspondente publicado.

### 2.7 Códigos de falha (§7.2)

- **RF-FC-01** Toda rejeição carrega `failureCode` estável e legível por máquina.
- **RF-FC-02** O código deve permitir ao provedor decidir: reenviar, corrigir payload ou desistir.
- **RF-FC-03** Taxonomia definida e documentada. (DEC)

### 2.8 Concorrência (§8)

- **RF-CON-01** Unidade de concorrência é a `walletId`.
- **RF-CON-02** Correto quando: duas apostas disputam o mesmo saldo; múltiplos workers recebem operações da mesma wallet; wallets distintas em paralelo; ≥ 3 instâncias simultâneas.
- **RF-CON-03** Estratégia (pessimistic, optimistic com retry limitado, update atômico condicionado ou combinação) escolhida e justificada. (DEC)
- **RF-CON-04** **Cenário obrigatório:** saldo `100.00 BRL`, duas `BET` de `80.00` simultâneas → exatamente uma `PROCESSED`, a outra `REJECTED` por saldo insuficiente, saldo final `20.00`, exatamente um débito no ledger, retries não duplicam débito.

### 2.9 API HTTP (§9)

- **RF-API-01** `POST /wallets` cria wallet; saldo inicial > 0 gera transação `OPENING` + `CREDIT` no ledger **na mesma transação SQL**; resposta com `id`, `playerId`, `balance`, `version: 1`.
- **RF-API-02** Wallet duplicada (`playerId` + `currency`) falha como conflito.
- **RF-API-03** `GET /wallets/:walletId`.
- **RF-API-04** `GET /wallets/:walletId/ledger?cursor=&limit=50` com cursor estável e opaco.
- **RF-API-05** `GET /wagering/transactions/:transactionId`.
- **RF-API-06** `GET /providers/:providerId/wagering/transactions/:externalTransactionId`.
- **RF-API-07** `POST /wagering/transactions` com header `Idempotency-Key`; resposta `{ transactionId, status, balance, idempotentReplay }`.
- **RF-API-08** `Idempotency-Key` obrigatório e fonte da verdade; default recomendado `"{providerId}:{externalTransactionId}"`.
- **RF-API-09** `payloadHash` = hash de JSON canônico (chaves ordenadas) do subconjunto de campos de negócio; header e metadados de transporte fora do hash; algoritmo documentado.
- **RF-API-10** Requisição idêntica → mesma resposta com `idempotentReplay: true`. Mesma key com payload diferente → conflito.
- **RF-API-11** Mapeamento de status HTTP consistente entre **todos** os endpoints, distinguindo com clareza: payload inválido; conflito de idempotência; rejeição por regra de negócio; aceite com processamento pendente; falha transitória de infraestrutura. (DEC)
- **RF-API-12** `POST /wallets/:walletId/reconciliation` retorna `walletId`, `storedBalance`, `calculatedBalance`, `difference`, `consistent`, `checkedEntries`.
- **RF-API-13** Divergência de reconciliação é logada, contabilizada em métrica e sinalizada na resposta.
- **RF-API-14** `GET /health/live` (processo vivo) e `GET /health/ready` (PostgreSQL e SQS alcançáveis).

### 2.10 Consumo SQS (§10)

- **RF-SQS-01** Filas `wager-transactions.fifo` e `wager-transactions-dlq.fifo`.
- **RF-SQS-02** Mensagem `WagerTransactionRequested` com `messageId`, `type`, `occurredAt`, `data` (campos conforme §10).
- **RF-SQS-03** Consumidor reutiliza **o mesmo use case** da entrada HTTP.
- **RF-SQS-04** Deduplicação por **inbox persistente** `(consumerName, messageId)`.
- **RF-SQS-05** `ack` somente após o commit.
- **RF-SQS-06** Distinguir erros: **negócio** (terminal, ack), **transitório** (retry com backoff), **permanente** (DLQ).
- **RF-SQS-07** Limite de tentativas antes da DLQ.
- **RF-SQS-08** Em `SIGTERM`: concluir mensagens em andamento ou devolver a visibilidade.
- **RF-SQS-09** Redelivery não duplica efeitos.

### 2.11 Transactional Outbox (§11)

- **RF-OUT-01** Atomicidade em uma única transação SQL: transação, saldo, ledger, inbox (se origem SQS) e evento de integração.
- **RF-OUT-02** Worker publisher funciona com múltiplos publishers concorrentes, sem perder nem duplicar indefinidamente.
- **RF-OUT-03** Retry com backoff (`attempts`, `nextAttemptAt`, `scheduleRetry`).
- **RF-OUT-04** Cenário de crash: commit OK → processo morre antes de publicar → outra instância assume → evento publicado → publicação duplicada segura para o consumidor.
- **RF-OUT-05** Eventos mínimos: `WagerTransactionProcessed` (inclusive `LOSS`), `WagerTransactionRejected`, `WalletBalanceChanged` (**somente** quando o saldo muda), `WagerTransactionPendingReference`.
- **RF-OUT-06** Envelope `IntegrationEvent<T>` como **classe abstrata** com subclasse concreta por evento; `eventType` e `version` no tipo; campos `eventId`, `aggregateId`, `correlationId`, `causationId?`, `occurredAt`, `data`; `toJSON()` com `occurredAt` ISO-8601.
- **RF-OUT-07** `data` carrega `MoneyProps` (string decimal), nunca instância de `Money`.

### 2.12 Autenticação (§2)

- **RF-AUTH-01** Opcional e sem pontuação. Escolher entre (a) integrar IdP externo (Keycloak, Zitadel ou equivalente) ou (b) não implementar, documentar a decisão e o desenho no `ARCHITECTURE.md` e deixar ponto de extensão explícito no código (ex.: `AuthGuard` no-op ou `ProviderIdentityPort`). (DEC)
- **RF-AUTH-02** Health endpoints abertos. Mensagens da fila são canal interno confiável, mas a identidade do provedor na mensagem segue sujeita às validações de domínio.

---

## 3. Requisitos não funcionais

### 3.1 Stack obrigatória (§4)

- **RNF-STK-01** Bun 1.x como runtime, package manager e test runner.
- **RNF-STK-02** TypeScript em modo estrito.
- **RNF-STK-03** NestJS.
- **RNF-STK-04** PostgreSQL.
- **RNF-STK-05** AWS SQS via LocalStack ou MiniStack.
- **RNF-STK-06** Docker Compose para orquestração local.
- **RNF-STK-07** Migrations versionadas e **reversíveis**.
- **RNF-STK-08** ORM: MikroORM (preferencial) ou TypeORM. Escolha, mapeamento de `Money` e estratégia transacional justificados no `ARCHITECTURE.md`.

### 3.2 Integridade no schema do banco (§5.9)

- **RNF-DB-01** Unicidade, imutabilidade e não-negatividade garantidas **no schema** (constraints, índices, triggers), não só no código.
- **RNF-DB-02** Candidatos mínimos: `UNIQUE(playerId, currency)` em wallets; `CHECK(balance >= 0)`; `UNIQUE(providerId, externalTransactionId)`; `UNIQUE(idempotencyKey)`; `UNIQUE(consumerName, messageId)` na inbox; unicidade de lançamento por `(walletId, transactionId)`; ledger imutável (bloqueio de `UPDATE`/`DELETE`, por ex. via trigger); unicidade de reversão por referência e tipo.
- **RNF-DB-03** Desenho de schema, constraints e índices faz parte da avaliação.

### 3.3 Correção, concorrência e resiliência

- **RNF-COR-01** Correto com múltiplas instâncias (≥ 3).
- **RNF-COR-02** O banco é o responsável final pelas invariantes; ordenação e dedup do broker são só otimização.
- **RNF-COR-03** Idempotência persistente, sobrevivendo a restart.
- **RNF-COR-04** Recuperação após crash em qualquer ponto (antes/depois do commit, antes do ack, antes da publicação).
- **RNF-COR-05** Tolerância a indisponibilidade temporária de PostgreSQL e SQS.
- **RNF-COR-06** Graceful shutdown em `SIGTERM`.

### 3.4 Modelagem (§6.0)

- **RNF-MOD-01** Construtor `private`/`protected` com factories estáticas (`create`, `from`, `rehydrate`).
- **RNF-MOD-02** `rehydrate` não revalida regras de transição.
- **RNF-MOD-03** Estado encapsulado, transições explícitas.
- **RNF-MOD-04** Domínio sem dependência de tipos monetários do ORM nem de decorators do NestJS.
- **RNF-MOD-05** Boundaries claros, portas/adaptadores, simplicidade.

### 3.5 Observabilidade (§12)

- **RNF-OBS-01** Logs estruturados JSON com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`.
- **RNF-OBS-02** Métricas mínimas: transações por status, duplicatas detectadas, retries, mensagens em DLQ, conflitos de lock, outbox lag, latência de processamento.
- **RNF-OBS-03** Health checks separados de liveness e readiness.
- **RNF-OBS-04** OpenTelemetry e dashboard: opcionais.

### 3.6 Testes (§13)

- **RNF-TST-01 Unidade:** `Money` (escala, arredondamento, entradas inválidas); invariantes da `Wallet`; regras de BET/WIN/LOSS/REFUND/ROLLBACK; conflito de moeda; idempotency key com payload divergente.
- **RNF-TST-02 Integração** (PostgreSQL e LocalStack/MiniStack **reais** em containers): migrations e constraints; atomicidade wallet+ledger+inbox+outbox; inbox e redelivery; publishers concorrentes; retry e DLQ; recuperação após reinício.
- **RNF-TST-03 Concorrência** (paralelismo real):
  1. mesma aposta 50× em paralelo → um único débito;
  2. disputa de saldo na mesma wallet (cenário §8);
  3. wallets distintas em paralelo;
  4. ≥ 3 processos/instâncias simultâneos;
  5. worker morto depois do commit e antes do ack;
  6. dois publishers sobre a mesma outbox;
  7. `ROLLBACK`/`REFUND` antes da referência;
  8. reinício do serviço com prova de consistência final.
- **RNF-TST-04** Todos os testes terminam verificando `wallet.balance == saldo reconstruído pelo ledger`.
- **RNF-TST-05** Determinismo (sem flakiness).

### 3.7 Documentação (§14)

- **RNF-DOC-01** `README.md` com setup e comandos.
- **RNF-DOC-02** `ARCHITECTURE.md` com decisões, trade-offs e limitações, cobrindo no mínimo: ORM e mapeamento de `Money`; estratégia de concorrência; estratégia transacional; transições de estado; taxonomia de `failureCode`; mapeamento HTTP; algoritmo de `payloadHash`; limite/TTL de `PENDING_REFERENCE`; decisão sobre autenticação; interpretações adicionais de regra.

### 3.8 Diferencial opcional

- **RNF-OPT-01** Teste de carga via `bun run test:load`, registrando ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos de concorrência e outbox lag. Sem meta de RPS; honestidade da análise pesa mais.
- **RNF-OPT-02** Ledger de partidas dobradas (opcional).

---

## 4. Antirrequisitos (obrigatórios)

Itens que a solução **não pode** fazer. O descumprimento de qualquer um é violação do desafio.

### 4.1 Restrições invioláveis (§5)

- **AR-01** NÃO usar `number`, `float` ou `double` para dinheiro (em domínio, DTOs, persistência, eventos, mensagens ou testes).
- **AR-02** NÃO usar cache em memória como garantia de idempotência.
- **AR-03** NÃO confiar apenas em SQS FIFO para consistência (dedup/ordenação do broker não substituem constraints e controle de concorrência no banco).
- **AR-04** NÃO publicar eventos antes do commit da transação financeira.
- **AR-05** NÃO sobrescrever nem excluir lançamentos do ledger.
- **AR-06** NÃO usar lock global compartilhado por todas as wallets.
- **AR-07** NÃO implementar saldo como `read → calculate → update` sem controle de concorrência.
- **AR-08** NÃO entregar solução que só funcione com uma instância.
- **AR-09** NÃO deixar garantias de unicidade, imutabilidade e não-negatividade apenas no código de aplicação; devem estar no schema.
- **AR-10** NÃO usar Prisma nem outro ORM além de MikroORM/TypeORM.

### 4.2 Antirrequisitos de domínio (derivados de §6 e §7)

- **AR-11** NÃO aceitar `OPENING` pela API nem pela fila (é interno).
- **AR-12** NÃO tratar mesma idempotency key com payload diferente como replay (é conflito).
- **AR-13** NÃO permitir saldo negativo, nem por race, nem por reversão.
- **AR-14** NÃO permitir operação com moeda diferente da wallet; NÃO operar `Money` entre moedas distintas.
- **AR-15** NÃO permitir mais de uma wallet por `(playerId, currency)`.
- **AR-16** NÃO gerar lançamento de ledger para `LOSS` nem para transação `REJECTED`.
- **AR-17** NÃO gerar mais de um lançamento por transação por wallet.
- **AR-18** NÃO incrementar `version` quando o saldo não muda.
- **AR-19** NÃO transicionar transação em estado terminal (`PROCESSED`, `REJECTED`, `FAILED`); deve lançar `InvalidTransactionStateError`.
- **AR-20** NÃO revalidar regras de transição em `rehydrate`.
- **AR-21** NÃO expor campos mutáveis nem métodos de transição em `WalletLedgerEntry`.
- **AR-22** NÃO aceitar entradas monetárias inválidas: `NaN`, `Infinity`, notação científica, string vazia, > 2 casas decimais, negativos em contratos de entrada.
- **AR-23** NÃO aceitar reversão parcial (valor de `REFUND`/`ROLLBACK` deve ser igual ao da referência).
- **AR-24** NÃO reverter a mesma referência duas vezes pelo mesmo tipo de operação.
- **AR-25** NÃO aceitar referência de outro provider, player, wallet, moeda ou rodada.
- **AR-26** NÃO permitir `REFUND` referenciar algo diferente de `BET`; NÃO permitir `ROLLBACK` referenciar algo diferente de `BET`, `WIN` ou `REFUND`.
- **AR-27** NÃO reverter transação que não esteja `PROCESSED`.
- **AR-28** NÃO usar o mesmo `failureCode` para "saldo insuficiente em BET" e "reversão que causaria saldo negativo".
- **AR-29** NÃO recalcular o saldo observado em replay: deve devolver o resultado original, incluindo o saldo daquele momento.
- **AR-30** NÃO descartar silenciosamente `PENDING_REFERENCE`: nem perder a transação, nem reprocessá-la para sempre; deve haver limite/TTL, `REJECTED` com `failureCode` próprio e evento.
- **AR-31** NÃO emitir `WalletBalanceChanged` quando o saldo não muda (ex.: `LOSS`, `REJECTED`).
- **AR-32** NÃO colocar instância de `Money` no `data` dos eventos; apenas `MoneyProps`.
- **AR-33** NÃO acoplar o domínio a tipos monetários do ORM nem a decorators do NestJS.
- **AR-34** NÃO instanciar entidades por `new` externo: construtores `private`/`protected` com factories.
- **AR-35** NÃO escrever autenticação artesanal (tabela de usuários com hash de senha); se houver auth, via IdP externo.
- **AR-36** NÃO exigir autenticação nos endpoints de health.

### 4.3 Antirrequisitos de API

- **AR-37** NÃO colapsar em um mesmo status HTTP: payload inválido, conflito de idempotência, rejeição de negócio, aceite pendente e falha transitória.
- **AR-38** NÃO aceitar `POST /wagering/transactions` sem `Idempotency-Key`.
- **AR-39** NÃO incluir header nem metadados de transporte no cálculo do `payloadHash`.
- **AR-40** NÃO usar JSON não canônico (ordem de chaves instável) para o hash.
- **AR-41** NÃO usar cursor instável nem transparente na paginação do ledger.
- **AR-42** NÃO corrigir silenciosamente divergências na reconciliação; devem ser logadas, contabilizadas em métrica e sinalizadas na resposta.
- **AR-43** NÃO usar mapeamento de status HTTP inconsistente entre endpoints.

### 4.4 Antirrequisitos de mensageria e outbox

- **AR-44** NÃO fazer `ack` antes do commit.
- **AR-45** NÃO deixar de deduplicar via inbox persistente `(consumerName, messageId)`.
- **AR-46** NÃO duplicar efeitos em redelivery.
- **AR-47** NÃO tratar erro de negócio como retry/DLQ (é terminal, com ack); NÃO enviar erro transitório direto à DLQ; NÃO reter erro permanente em retry infinito.
- **AR-48** NÃO retentar sem limite antes da DLQ.
- **AR-49** NÃO encerrar em `SIGTERM` abandonando mensagens em andamento sem devolver visibilidade.
- **AR-50** NÃO implementar caminho de processamento separado para a fila: deve ser o mesmo use case do HTTP.
- **AR-51** NÃO gravar a outbox fora da transação financeira (nem dual-write).
- **AR-52** NÃO deixar publishers concorrentes perderem eventos nem republicarem indefinidamente.
- **AR-53** NÃO assumir que a publicação é exactly-once: o consumidor deve tolerar duplicata.
- **AR-54** NÃO modelar `OutboxMessage` ou `InboxMessage` com estado fora do banco (memória).

### 4.5 Antirrequisitos de observabilidade e testes

- **AR-55** NÃO logar dados sensíveis nem payloads financeiros completos.
- **AR-56** NÃO usar logs não estruturados (não JSON) nem sem `correlationId`.
- **AR-57** NÃO substituir PostgreSQL e SQS por mocks nos testes de integração e concorrência.
- **AR-58** NÃO simular concorrência com chamadas sequenciais; deve haver paralelismo real.
- **AR-59** NÃO entregar migrations irreversíveis.
- **AR-60** NÃO escrever testes não determinísticos (flaky).

---

## 5. Falhas eliminatórias (§14)

Qualquer uma zera a credibilidade da solução. Cada uma tem correspondência nos antirrequisitos.

| ID | Falha | Antirrequisitos relacionados |
|---|---|---|
| FE-01 | `number` para dinheiro | AR-01 |
| FE-02 | Saldo negativo causado por race | AR-07, AR-13 |
| FE-03 | Débito ou crédito duplicado | AR-02, AR-12, AR-46 |
| FE-04 | Idempotência apenas em memória | AR-02, AR-54 |
| FE-05 | Correta somente com uma instância | AR-06, AR-08 |
| FE-06 | Evento publicado antes do commit | AR-04, AR-51 |
| FE-07 | Ausência de ledger auditável | AR-05, AR-21 |
| FE-08 | Testes que substituem completamente PostgreSQL e SQS por mocks | AR-57, AR-58 |

---

## 6. Critérios de avaliação (§14)

| Área | Pts |
|---|---|
| Correção financeira | 20 |
| Concorrência | 20 |
| Idempotência | 15 |
| Mensageria e falhas | 15 |
| Modelagem e arquitetura | 10 |
| Testes | 10 |
| Observabilidade | 5 |
| Documentação | 5 |
| **Total** | **100** |

Autenticação não pontua; não deve competir por tempo com as áreas acima.

---

## 7. Decisões em aberto (a discutir na fase de arquitetura)

1. ORM: MikroORM vs TypeORM; mapeamento de `Money` (colunas `numeric(…,2)` + `char(3)`?); biblioteca de `Decimal`.
2. Estratégia de concorrência na wallet: `SELECT … FOR UPDATE`, optimistic com `version` + retry, ou update atômico condicionado (`UPDATE … WHERE balance >= x`).
3. Fluxo transacional do use case único (HTTP e SQS): ordem de operações dentro da transação, tratamento de violação de unique na inbox e na idempotency key.
4. Processamento síncrono vs. assíncrono no `POST /wagering/transactions` (quando devolve `PENDING` vs. resultado final).
5. Schema: constraints, índices, trigger de imutabilidade do ledger, unicidade de reversão por referência.
6. Reprocessamento de `PENDING_REFERENCE`: seleção segura entre instâncias (`FOR UPDATE SKIP LOCKED`), backoff, limite/TTL, gatilho oportunista quando a referência chega.
7. Outbox publisher: `SKIP LOCKED`, backoff, destino de publicação dos eventos (fila/tópico), idempotência para o consumidor.
8. Taxonomia de `failureCode` e mapeamento para status HTTP.
9. Política de classificação de erros no consumidor SQS (negócio / transitório / permanente) e limite de tentativas; uso do FIFO (`MessageGroupId` = `walletId`?).
10. Estrutura de módulos / camadas (DDD, portas e adaptadores) e testabilidade.
11. Métricas: biblioteca (ex.: Prometheus) e exposição.
12. Autenticação: implementar IdP ou só ponto de extensão.
13. Estratégia de testes de multi-instância (processos Bun reais contra o mesmo Postgres/LocalStack).

Todas as 13 foram decididas e estão registradas no `ARCHITECTURE.md` (D1–D15); nenhuma permanece em aberto.

---

## 8. Rastreabilidade (requisito → teste)

Verificada no M14 contra o código. Caminhos relativos a `test/`; **U** = unidade (`bun test`), **I** = integração e **C** = concorrência (`bun run test:integration`, PostgreSQL e SQS reais). Itens sem teste automatizado dizem como são verificados.

### Requisitos funcionais

| Requisitos | Onde são provados |
|---|---|
| RF-MON-01..08 | U `unit/shared/kernel/money.test.ts`; ida e volta no banco: I `integration/persistence/constraints.test.ts` (`numeric` volta como string) |
| RF-WAL-01..06 | U `unit/wallet/domain/wallet.test.ts`; I `integration/persistence/constraints.test.ts` (wallets, CHECK, UNIQUE) |
| RF-WAL-07 | I `integration/persistence/unit-of-work.test.ts` (concorrência real sobre a wallet); C `concurrency/wagering-concurrency.test.ts` |
| RF-TRX-01..07 | U `unit/wagering/domain/wager-transaction.test.ts`, `failure-code.test.ts`; schema: I `constraints.test.ts` (`wager_transactions`) |
| RF-LED-01..04 | U `unit/wallet/domain/wallet-ledger-entry.test.ts`; I `constraints.test.ts` (ledger append-only, UNIQUE por transação) |
| RF-BIZ-01..10 | U `unit/wagering/domain/wager-policy.test.ts`; I `integration/api/wagering-flows.test.ts` |
| RF-REF-01..03 | U `unit/wagering/application/reprocess-pending.test.ts`, `domain/pending-reference-policy.test.ts`; I `persistence/claim-locking.test.ts`; C `concurrency/multi-instance.test.ts` (referência que nunca chega → `REFERENCE_NOT_FOUND` com evento) |
| RF-FC-01..03 | U `unit/wagering/domain/failure-code.test.ts`; I `api/wagering-flows.test.ts` (`failureCode` e `providerAction` nas respostas) |
| RF-CON-01..04 | C `concurrency/wagering-concurrency.test.ts` (cenário obrigatório 100,00 / 2×80,00, repetido 25×), `multi-instance.test.ts` (3 processos) |
| RF-API-01..06, 12..13 | I `integration/api/wallets.test.ts`; métrica de divergência: U `unit/health.test.ts`, `shared/infrastructure/metrics/metrics.test.ts` |
| RF-API-07..11 | I `integration/api/wagering-idempotency.test.ts`, `wagering-flows.test.ts`; U `unit/shared/kernel/canonical-json.test.ts`, `shared/interfaces/problem-mapper.test.ts` |
| RF-API-14 | U `unit/health.test.ts`, `unit/health/readiness.test.ts`; I `integration/messaging/publisher-roles.test.ts` (`/health/ready`) |
| RF-SQS-01..09 | I `integration/messaging/sqs-queues.test.ts`, `sqs-consumer.test.ts`, `sqs-consumer-failures.test.ts`, `sqs-consumer-lifecycle.test.ts`; U `unit/messaging/sqs-consumer.test.ts`, `unit/wagering/interfaces/wager-message.*.test.ts`, `shared/infrastructure/error-classifier.test.ts` |
| RF-OUT-01..03 | I `integration/messaging/outbox-publisher.test.ts`, `persistence/unit-of-work.test.ts`; U `unit/messaging/domain/inbox-outbox.test.ts` |
| RF-OUT-04 | I `outbox-publisher.test.ts` (processo morto depois do commit); C `multi-instance.test.ts` |
| RF-OUT-05..07 | U `unit/wagering/domain/events.test.ts` |
| RF-AUTH-01..02 | U `unit/auth/auth.test.ts` (guard no-op, health `@Public`, `ProviderIdentityPort`); decisão em ARCHITECTURE §15.3 |

### Requisitos não funcionais

| Requisitos | Onde são provados |
|---|---|
| RNF-STK-01..05, 08 | `package.json`, `bun test`; I `integration/stack-mikro-orm.test.ts`, `stack-sqs.test.ts`; ARCHITECTURE D2, D14 |
| RNF-STK-06 | `docker-compose.yml` + `bun run smoke` (verificado no M13 com `--scale app=3`) |
| RNF-STK-07 | I `integration/persistence/migrations.test.ts` (up → down → up; divergência `EntitySchema` × banco) |
| RNF-DB-01..03 | I `persistence/constraints.test.ts`, `invariant-checker.test.ts`, `repositories.test.ts` |
| RNF-COR-01..02 | C `multi-instance.test.ts`, `wagering-concurrency.test.ts` |
| RNF-COR-03..04 | C `multi-instance.test.ts` (SIGKILL antes do COMMIT, depois do COMMIT e antes do ack, 2 de 3 processos); I `outbox-publisher.test.ts` |
| RNF-COR-05 | I `outbox-publisher.test.ts` (falha do SQS), `sqs-consumer-failures.test.ts` (transitório), `wagering-concurrency.test.ts` (`lock_timeout` → 503) |
| RNF-COR-06 | I `sqs-consumer-lifecycle.test.ts`; C `multi-instance.test.ts` (shutdown gracioso); `docker compose stop` sai com código 0 |
| RNF-MOD-01..05 | U `unit/architecture.test.ts` (domínio sem framework/ORM/AWS, aplicação sem infraestrutura), `nest-di.test.ts`, testes de domínio |
| RNF-OBS-01 | U `unit/shared/infrastructure/observability/logging.test.ts`, `shared/interfaces/http/request-context.test.ts`; C `multi-instance.test.ts` (logs JSON) |
| RNF-OBS-02 | U `unit/shared/infrastructure/metrics/metrics.test.ts`, `unit/wagering/application/observability.test.ts`; C `multi-instance.test.ts` (métricas coerentes) |
| RNF-OBS-03 | U `unit/health.test.ts`, `unit/health/readiness.test.ts` |
| RNF-TST-01..05 | Esta tabela; invariante final: `persistence/invariant-checker.test.ts` usado ao fim dos cenários C; determinismo: suíte repetida sem falhas (M12) |
| RNF-DOC-01..02 | `README.md`, `ARCHITECTURE.md` (revisado no M14) |
| RNF-OPT-01 | **Não feito** (opcional); registrado em ARCHITECTURE §16 |
| RNF-OPT-02 | Não feito (opcional) |

Os 8 cenários de concorrência de RNF-TST-03: (1) `wagering-concurrency` e `multi-instance` (50×); (2) `wagering-concurrency` (RF-CON-04); (3) ambos (wallets distintas); (4) `multi-instance` (3 processos); (5) `multi-instance` (SIGKILL depois do commit e antes do ack); (6) `multi-instance` e `outbox-publisher` (publishers concorrentes); (7) `multi-instance` (REFUND/ROLLBACK antes da referência); (8) `multi-instance` (reinício com processo substituto).

### Antirrequisitos

| AR | Garantia |
|---|---|
| AR-01 | U `unit/architecture.test.ts` (sem `parseFloat/parseInt/Number()/toFixed` em `src/`); `Money` em `bigint` |
| AR-02, AR-54 | Idempotência, inbox e outbox só no banco: I `repositories.test.ts`, C 50× em paralelo |
| AR-03, AR-09, AR-13 | Constraints e triggers do schema: I `constraints.test.ts` |
| AR-04, AR-51 | I `outbox-publisher.test.ts` (publicação só depois do commit; outbox na mesma transação) |
| AR-05, AR-21 | I `constraints.test.ts` (UPDATE/DELETE/TRUNCATE falham); U `wallet-ledger-entry.test.ts` |
| AR-06 | C `wagering-concurrency.test.ts` (wallet travada não bloqueia as outras); U `architecture.test.ts` (`FOR UPDATE` só com `SKIP LOCKED` ou `FOR NO KEY UPDATE` de wallet) |
| AR-07, AR-08 | C `wagering-concurrency.test.ts`, `multi-instance.test.ts` |
| AR-10 | `package.json` (sem Prisma/TypeORM) |
| AR-11..12, AR-14..20, AR-22..27 | U `wager-transaction.test.ts`, `wager-policy.test.ts`, `wallet.test.ts`, `money.test.ts`; I `constraints.test.ts`, `wagering-flows.test.ts` |
| AR-28..32 | U `failure-code.test.ts`, `events.test.ts`, `reprocess-pending.test.ts`; C `multi-instance.test.ts` |
| AR-33..34 | U `architecture.test.ts`, testes de domínio (construtores privados) |
| AR-35..36 | U `auth.test.ts`; sem tabela de usuários no schema |
| AR-37..43 | I `wagering-idempotency.test.ts` (mapeamento consistente), `wallets.test.ts`; U `canonical-json.test.ts`, `ledger-cursor.test.ts` |
| AR-44..50 | I `sqs-consumer*.test.ts`; U `unit/messaging/sqs-consumer.test.ts`, `error-classifier.test.ts` (mesmo use case, ack após commit, classificação) |
| AR-52..53 | I `outbox-publisher.test.ts`, `claim-locking.test.ts`; C `multi-instance.test.ts` |
| AR-55..56 | U `observability/logging.test.ts` (redaction, `correlationId`) |
| AR-57..58, AR-60 | Todas as suítes I e C usam PostgreSQL/SQS reais e paralelismo real; repetidas sem falhas |
| AR-59 | I `migrations.test.ts` |

### Falhas eliminatórias

FE-01 → AR-01 · FE-02 → `wagering-concurrency` (30 apostas contra 100,00) · FE-03 → 50× em paralelo e redelivery · FE-04 → restart no `multi-instance` · FE-05 → 3 processos · FE-06 → `outbox-publisher` · FE-07 → ledger append-only + reconciliação · FE-08 → suítes I e C sem mocks de PostgreSQL/SQS.

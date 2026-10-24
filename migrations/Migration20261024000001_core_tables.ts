import { Migration } from "@mikro-orm/migrations";

/**
 * Tabelas, índices e CHECKs (ARCHITECTURE §8.1). SQL à mão (D15). IDs são UUIDv7 gerados pela
 * aplicação. Dinheiro é `numeric(19,2)`; nunca `float`.
 */
export class Migration20261024000001_core_tables extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid PRIMARY KEY,
        player_id   uuid          NOT NULL,
        currency    char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance     numeric(19,2) NOT NULL CHECK (balance >= 0),
        version     integer       NOT NULL CHECK (version >= 1),
        created_at  timestamptz   NOT NULL,
        updated_at  timestamptz   NOT NULL,
        CONSTRAINT uq_wallet_player_currency UNIQUE (player_id, currency)
      )`);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid PRIMARY KEY,
        provider_id                       text          NOT NULL,
        external_transaction_id           text          NOT NULL,
        idempotency_key                   text          NOT NULL,
        payload_hash                      char(64)      NOT NULL,
        wallet_id                         uuid          NOT NULL REFERENCES wallets(id),
        player_id                         uuid          NOT NULL,
        round_id                          text          NOT NULL,
        game_id                           text          NOT NULL,
        kind                              text          NOT NULL
          CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount                            numeric(19,2) NOT NULL CHECK (amount >= 0),
        currency                          char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id text,
        reference_transaction_id          uuid          REFERENCES wager_transactions(id),
        status                            text          NOT NULL
          CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code                      text,
        observed_balance                  numeric(19,2) CHECK (observed_balance >= 0),
        attempts                          integer       NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at                   timestamptz,
        created_at                        timestamptz   NOT NULL,
        processed_at                      timestamptz,
        updated_at                        timestamptz   NOT NULL,

        CONSTRAINT uq_wager_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT uq_wager_provider_external UNIQUE (provider_id, external_transaction_id),

        CONSTRAINT ck_wager_reference_required
          CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT ck_wager_amount_positive
          CHECK (kind IN ('LOSS','OPENING') OR amount > 0),
        CONSTRAINT ck_wager_failure_code
          CHECK (status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL),
        CONSTRAINT ck_wager_processed_at
          CHECK (status <> 'PROCESSED' OR processed_at IS NOT NULL),
        CONSTRAINT ck_wager_pending_schedule
          CHECK (status <> 'PENDING_REFERENCE' OR next_attempt_at IS NOT NULL)
      )`);

    // Cada transação é revertida NO MÁXIMO UMA VEZ, por qualquer REFUND/ROLLBACK processado (D7).
    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_single_reversal
        ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`);
    this.addSql(`
      CREATE INDEX ix_wager_pending_due ON wager_transactions (next_attempt_at)
        WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`
      CREATE INDEX ix_wager_dependents
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`CREATE INDEX ix_wager_wallet ON wager_transactions (wallet_id, created_at)`);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        seq            bigint GENERATED ALWAYS AS IDENTITY,
        id             uuid PRIMARY KEY,
        wallet_id      uuid          NOT NULL REFERENCES wallets(id),
        transaction_id uuid          NOT NULL REFERENCES wager_transactions(id),
        direction      text          NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount         numeric(19,2) NOT NULL CHECK (amount > 0),
        currency       char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance_before numeric(19,2) NOT NULL CHECK (balance_before >= 0),
        balance_after  numeric(19,2) NOT NULL CHECK (balance_after >= 0),
        created_at     timestamptz   NOT NULL,
        CONSTRAINT uq_ledger_wallet_transaction UNIQUE (wallet_id, transaction_id),
        CONSTRAINT uq_ledger_seq UNIQUE (seq),
        CONSTRAINT ck_ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount))
      )`);
    this.addSql(`CREATE INDEX ix_ledger_wallet_seq ON wallet_ledger_entries (wallet_id, seq DESC)`);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text      NOT NULL,
        message_id    text      NOT NULL,
        payload_hash  char(64)  NOT NULL,
        received_at   timestamptz NOT NULL,
        processed_at  timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      )`);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid PRIMARY KEY,
        aggregate_id     text        NOT NULL,
        message_group_id text        NOT NULL,
        event_type       text        NOT NULL,
        payload          jsonb       NOT NULL,
        occurred_at      timestamptz NOT NULL,
        attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at  timestamptz NOT NULL,
        published_at     timestamptz,
        last_error       text
      )`);
    this.addSql(`
      CREATE INDEX ix_outbox_due ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions`);
    this.addSql(`DROP TABLE IF EXISTS wallets`);
  }
}

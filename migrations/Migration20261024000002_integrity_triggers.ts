import { Migration } from "@mikro-orm/migrations";

/**
 * Guardas de integridade no banco (ARCHITECTURE §8.2): ledger append-only e saldo da wallet igual
 * ao `balance_after` do último lançamento, conferido no COMMIT. SQL à mão (D15).
 */
export class Migration20261024000002_integrity_triggers extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
          USING ERRCODE = 'integrity_constraint_violation';
      END
      $fn$`);
    this.addSql(`
      CREATE TRIGGER trg_ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`);
    this.addSql(`
      CREATE TRIGGER trg_ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`);

    this.addSql(`
      CREATE FUNCTION assert_wallet_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $fn$
      DECLARE
        w uuid;
        bal numeric;
        last_after numeric;
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN w := NEW.id; ELSE w := NEW.wallet_id; END IF;
        SELECT balance INTO bal FROM wallets WHERE id = w;
        SELECT balance_after INTO last_after FROM wallet_ledger_entries
          WHERE wallet_id = w ORDER BY seq DESC LIMIT 1;
        IF bal IS DISTINCT FROM COALESCE(last_after, 0) THEN
          RAISE EXCEPTION 'wallet % balance % diverges from ledger %', w, bal, COALESCE(last_after, 0)
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NULL;
      END
      $fn$`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_wallet_ledger_ck AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_wallet_matches_ledger()`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_ledger_wallet_ck AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_wallet_matches_ledger()`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TRIGGER IF EXISTS trg_ledger_wallet_ck ON wallet_ledger_entries`);
    this.addSql(`DROP TRIGGER IF EXISTS trg_wallet_ledger_ck ON wallets`);
    this.addSql(`DROP FUNCTION IF EXISTS assert_wallet_matches_ledger()`);
    this.addSql(`DROP TRIGGER IF EXISTS trg_ledger_no_truncate ON wallet_ledger_entries`);
    this.addSql(`DROP TRIGGER IF EXISTS trg_ledger_immutable ON wallet_ledger_entries`);
    this.addSql(`DROP FUNCTION IF EXISTS forbid_mutation()`);
  }
}

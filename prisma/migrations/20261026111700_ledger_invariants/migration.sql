-- Invariants Prisma's schema language cannot express. The application already
-- enforces every one of these; the database enforces them again so that a bug
-- fails loudly instead of silently creating or destroying money.

-- ---------------------------------------------------------------- users / kyc
ALTER TABLE "users"
    ADD CONSTRAINT "users_email_normalised" CHECK ("email" = lower(btrim("email")));

ALTER TABLE "kyc_records"
    ADD CONSTRAINT "kyc_records_verified_at_matches_status"
        CHECK (("status" = 'VERIFIED') = ("verified_at" IS NOT NULL));

-- -------------------------------------------------------------------- wallets
ALTER TABLE "wallets"
    ADD CONSTRAINT "wallets_account_number_format" CHECK ("account_number" ~ '^[0-9]{10}$'),
    ADD CONSTRAINT "wallets_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
    -- A USER wallet has an owner and no system code; a SYSTEM wallet the reverse.
    ADD CONSTRAINT "wallets_owner_matches_kind" CHECK (
        ("kind" = 'USER'   AND "user_id" IS NOT NULL AND "system_code" IS NULL) OR
        ("kind" = 'SYSTEM' AND "user_id" IS NULL     AND "system_code" IS NOT NULL)
    ),
    -- Customers can never be overdrawn. System accounts may go negative
    -- (SETTLEMENT is negative by exactly the money that came in from outside).
    ADD CONSTRAINT "wallets_user_balance_non_negative" CHECK ("kind" = 'SYSTEM' OR "balance" >= 0);

-- ------------------------------------------------------- journals and entries
ALTER TABLE "transactions"
    ADD CONSTRAINT "transactions_amount_positive" CHECK ("amount" > 0),
    ADD CONSTRAINT "transactions_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "ledger_entries"
    ADD CONSTRAINT "ledger_entries_amount_positive" CHECK ("amount" > 0),
    ADD CONSTRAINT "ledger_entries_balance_math" CHECK (
        ("direction" = 'CREDIT' AND "balance_after" = "balance_before" + "amount") OR
        ("direction" = 'DEBIT'  AND "balance_after" = "balance_before" - "amount")
    );

-- The ledger is append-only: corrections are new, reversing journals. History
-- is never rewritten. (TRUNCATE does not fire row triggers; the dev seed and
-- the e2e tests rely on that to reset state.)
CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries is append-only (attempted %)', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "ledger_entries_append_only"
    BEFORE UPDATE OR DELETE ON "ledger_entries"
    FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

-- Double-entry invariant, checked at COMMIT: the entries of one journal must
-- net to zero. Deferring the check lets a posting insert its legs one by one.
CREATE FUNCTION assert_journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    net bigint;
BEGIN
    SELECT COALESCE(SUM(CASE WHEN "direction" = 'CREDIT' THEN "amount" ELSE -"amount" END), 0)
      INTO net
      FROM "ledger_entries"
     WHERE "transaction_id" = NEW."transaction_id";

    IF net <> 0 THEN
        RAISE EXCEPTION 'unbalanced journal %: net %', NEW."transaction_id", net
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ledger_entries_balanced"
    AFTER INSERT ON "ledger_entries"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

-- ------------------------------------------------------------------- payments
ALTER TABLE "deposits"
    ADD CONSTRAINT "deposits_amount_positive" CHECK ("amount" > 0),
    ADD CONSTRAINT "deposits_succeeded_has_transaction"
        CHECK (("status" = 'SUCCEEDED') = ("transaction_id" IS NOT NULL));

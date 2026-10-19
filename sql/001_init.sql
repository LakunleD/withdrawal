-- Initial schema for the Withdrawal Authorization Service.
-- gen_random_uuid() is built into PostgreSQL 13+.

CREATE TABLE users (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT        NOT NULL,
    password_hash TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT users_email_key UNIQUE (email)
);

CREATE TABLE accounts (
    id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID          NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    balance_usd NUMERIC(19,2) NOT NULL DEFAULT 0,
    status      TEXT          NOT NULL DEFAULT 'active',
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT accounts_user_id_key UNIQUE (user_id),
    CONSTRAINT accounts_balance_nonnegative CHECK (balance_usd >= 0),
    CONSTRAINT accounts_status_check CHECK (status IN ('active', 'suspended'))
);

CREATE TABLE withdrawals (
    id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id          UUID          NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
    amount_usd          NUMERIC(19,2) NOT NULL,
    target_currency     CHAR(3)       NOT NULL,
    converted_amount    NUMERIC       NOT NULL,
    exchange_rate       NUMERIC       NOT NULL,
    status              TEXT          NOT NULL DEFAULT 'authorised',
    authorisation_code  TEXT          NOT NULL,
    idempotency_key     TEXT          NOT NULL,
    request_fingerprint TEXT          NOT NULL,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT withdrawals_amount_positive CHECK (amount_usd > 0),
    CONSTRAINT withdrawals_converted_amount_positive CHECK (converted_amount > 0),
    CONSTRAINT withdrawals_exchange_rate_positive CHECK (exchange_rate > 0),
    CONSTRAINT withdrawals_target_currency_format CHECK (target_currency ~ '^[A-Z]{3}$'),
    CONSTRAINT withdrawals_status_check CHECK (status IN ('authorised')),
    CONSTRAINT withdrawals_authorisation_code_key UNIQUE (authorisation_code),
    CONSTRAINT withdrawals_account_idempotency_key UNIQUE (account_id, idempotency_key)
);

-- Supports newest-first keyset pagination of an account's withdrawal history.
CREATE INDEX withdrawals_account_created_idx
    ON withdrawals (account_id, created_at DESC, id DESC);

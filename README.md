# Withdrawal Authorization Service

A TypeScript / Express / PostgreSQL service that authenticates a user, converts a USD withdrawal into a requested currency using [Frankfurter](https://frankfurter.dev), checks funds, issues an authorisation code and records the withdrawal. Every step that touches money runs in one transaction.

Everything runs in Docker. You don't need Node.js or PostgreSQL installed locally.

---

## Quick start

```bash
cp .env.example .env          # optional: change secrets (compose has dev-only fallbacks)
docker compose up --build -d  # starts PostgreSQL + API on http://localhost:3000
curl http://localhost:3000/health
```

The API waits for PostgreSQL's health check before it starts. It applies the SQL migrations in `sql/` when it boots. Data is kept in the `pgdata` Docker volume.

Stop the stack with `docker compose down`. Add `-v` to also delete the database volume.

### Development mode (hot reload)

[docker-compose.dev.yml](docker-compose.dev.yml) runs the API with `tsx watch` instead of the compiled build. It mounts `./src` and `./sql` into the container, so saving a file restarts the server within about a second, with no rebuild.

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build -d
docker compose logs -f api   # watch the restarts
```

To make this the default on your machine, add the following line to `.env`. Plain `docker compose up` will then include the override:

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.dev.yml
```

After changing `package.json`, rebuild the container with `up --build`, because dependencies are baked into the image. tsx skips type checking. To check types without restarting, run `docker compose --profile test run --build --rm test npm run typecheck`, or just run the test suite, which compiles with `tsc`.

## Running the tests

```bash
docker compose --profile test run --build --rm test
```

This builds the `test` image stage and starts a **separate, throwaway PostgreSQL** (`db-test`, on tmpfs) before running the Node.js test runner against it. The tests never reach Frankfurter, because the exchange rate provider is mocked. To remove the test database container afterwards, run `docker compose --profile test down`.

| Suite | Covers |
| --- | --- |
| `tests/unit/token.service` | JWT issue/verify, expiry, signature, issuer, audience, `alg=none` |
| `tests/unit/frankfurter.provider` | Response validation, timeouts, retries, 4xx/5xx, stale and future rates |
| `tests/unit/money`, `withdrawal-validation` | Decimal conversion and rounding, fingerprints, amount/currency/key/cursor validation |
| `tests/unit/authorisation-code` | Format, alphabet, CSPRNG use (`Math.random` is stubbed to throw), uniqueness |
| `tests/integration/auth` | Registration (atomic user + account), duplicate email, login, JWT claims |
| `tests/integration/accounts` | 401 cases, ownership (403) on every endpoint, 404s, health |
| `tests/integration/own-account` | Token-scoped `/v1/accounts` routes: own-account resolution, isolation between users, shared idempotency with the ID routes |
| `tests/integration/withdrawals` | Success, rounding, USD path, insufficient funds, validation, provider failure (503), rollback, code-collision retries, get-by-id, history pagination |
| `tests/integration/idempotency` | Replay, normalised replay, 409 conflict, per-account scoping, DB constraint |
| `tests/integration/concurrency` | Parallel withdrawals never overspend; parallel same-key requests produce exactly one withdrawal |

## Environment variables

All variables are listed in [.env.example](.env.example). `docker-compose.yml` reads them from `.env` and falls back to **development-only** defaults so the stack starts without any setup. Never use those defaults outside local development.

The database credentials are not variables. They are fixed in `docker-compose.yml` (user `withdrawal`, password `withdrawal_dev_password`, database `withdrawal`). This password is a local development credential, not a secret: the database is published on `127.0.0.1` only.

To connect a database client such as DBeaver, use host `localhost`, port `4539` (or `DB_PORT`), database `withdrawal`, user `withdrawal` and password `withdrawal_dev_password`. The URL form is `postgresql://withdrawal:withdrawal_dev_password@localhost:4539/withdrawal`. It's fixed because PostgreSQL only reads `POSTGRES_PASSWORD` when it initialises an empty volume, so a configurable password easily stops matching an existing volume. A real deployment would use managed credentials.

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_PORT` | `3000` | Host port the API is published on |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent` |
| `DB_PORT` | `4539` | Host port PostgreSQL is published on (`127.0.0.1` only) |
| `DB_POOL_MAX` | `10` | pg pool size |
| `JWT_SECRET` | dev-only value | HS256 signing secret, **at least 32 characters** (`openssl rand -base64 48`) |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `withdrawal-service` / `withdrawal-api` | Validated on every request |
| `JWT_EXPIRES_IN_SECONDS` | `900` | Access token lifetime (15 min) |
| `BCRYPT_ROUNDS` | `12` | Password hashing cost |
| `FRANKFURTER_BASE_URL` | `https://api.frankfurter.dev/v1` | Exchange rate provider |
| `EXCHANGE_RATE_TIMEOUT_MS` | `3000` | Timeout per provider request |
| `EXCHANGE_RATE_RETRIES` | `1` | Extra attempts, made only after transient failures (network, timeout, 5xx, 429) |
| `EXCHANGE_RATE_MAX_AGE_DAYS` | `4` | Rates older than this are rejected as stale |

---

## Using the API

The examples use `curl` and `jq`.

### 1. Register

```bash
curl -s -X POST http://localhost:3000/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"correct-horse-battery"}'
```

This creates the user and their account (balance `0.00`) in one transaction. The email is stored lowercased. Passwords must be 8–72 bytes long.

### 2. Log in and get an access token

```bash
LOGIN=$(curl -s -X POST http://localhost:3000/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"correct-horse-battery"}')
TOKEN=$(echo "$LOGIN" | jq -r .access_token)
ACCOUNT_ID=$(echo "$LOGIN" | jq -r .account_id)
```

Response: `{ "access_token": "...", "token_type": "Bearer", "expires_in": 900, "account_id": "..." }`

### 3. Fund the account (development only)

There is deliberately no deposit API. To credit an account in development, run SQL directly:

```bash
docker compose exec db psql -U withdrawal -d withdrawal -c \
  "UPDATE accounts SET balance_usd = 1000.00
    WHERE user_id = (SELECT id FROM users WHERE email = 'alice@example.com');"
```

### Two ways to address the account

Each user has exactly one account, so every account endpoint is available in two forms:

| Resolved from the token | Explicit account ID (ownership-checked, 403 if not yours) |
| --- | --- |
| `GET /v1/accounts` | `GET /v1/accounts/:accountId` |
| `POST /v1/accounts/withdrawals` | `POST /v1/accounts/:accountId/withdrawals` |
| `GET /v1/accounts/withdrawals` | `GET /v1/accounts/:accountId/withdrawals` |
| `GET /v1/accounts/withdrawals/:withdrawalId` | `GET /v1/accounts/:accountId/withdrawals/:withdrawalId` |

Both forms run the same code and share idempotency keys. The token-scoped form is simpler for clients because no account ID has to be passed around. The examples below use it.

### 4. Check the balance

```bash
curl -s http://localhost:3000/v1/accounts -H "Authorization: Bearer $TOKEN"
```

### 5. Create a withdrawal

```bash
curl -s -i -X POST http://localhost:3000/v1/accounts/withdrawals \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"amount":"125.50","target_currency":"EUR"}'
```

```http
HTTP/1.1 201 Created
Location: /v1/accounts/withdrawals/57f2d0df-cbef-4c5f-b182-b973627655b0
Idempotent-Replayed: false

{
  "id": "57f2d0df-cbef-4c5f-b182-b973627655b0",
  "account_id": "6931a183-abed-4a6e-ad9c-507627ff34a1",
  "status": "authorised",
  "authorisation_code": "GY2G-F8GN",
  "amount_usd": "125.50",
  "target_currency": "EUR",
  "converted_amount": "111.53",
  "exchange_rate": "0.88865",
  "created_at": "2026-10-19T07:46:11.810Z"
}
```

- `amount` is a USD **string** with at most 2 decimal places. JSON numbers are rejected so that no value ever passes through a float.
- `target_currency` must be one of the ISO 4217 codes Frankfurter publishes: AUD, BRL, CAD, CHF, CNY, CZK, DKK, EUR, GBP, HKD, HUF, IDR, ILS, INR, ISK, JPY, KRW, MXN, MYR, NOK, NZD, PHP, PLN, RON, SEK, SGD, THB, TRY, USD, ZAR. Lowercase codes are accepted.
- If you resend the same `Idempotency-Key` with the same parameters, you get the original response back with `Idempotent-Replayed: true`. If you resend it with different parameters, you get `409`.

### 6. Withdrawal history

```bash
curl -s "http://localhost:3000/v1/accounts/withdrawals?limit=20" -H "Authorization: Bearer $TOKEN"
# => { "data": [ ...newest first... ], "next_cursor": "eyJ0Ijoi..." | null }

curl -s "http://localhost:3000/v1/accounts/withdrawals?limit=20&cursor=<next_cursor>" -H "Authorization: Bearer $TOKEN"
curl -s "http://localhost:3000/v1/accounts/withdrawals/<withdrawalId>" -H "Authorization: Bearer $TOKEN"
```

`limit` defaults to 20 and can be at most 100. The cursor is opaque.

### Postman collection

[postman/withdrawal.postman_collection.json](postman/withdrawal.postman_collection.json) (collection name: `withdrawal`) has requests for every endpoint, with test assertions on each. Login saves the access token and account ID into collection variables, and creating a withdrawal saves its ID and Idempotency-Key, so the requests can run in order.

1. Import the file into Postman. Optionally change the `email`, `password` or `baseUrl` collection variables.
2. Run **Auth → Register** and **Login**, then fund the account with the SQL command in step 3 above.
3. Run the rest of the collection, or step through it request by request.

To run it from the command line, use Newman in Docker:

```bash
docker run --rm -v "$PWD/postman":/etc/newman postman/newman:6-alpine \
  run withdrawal.postman_collection.json \
  --env-var baseUrl=http://host.docker.internal:3000 --env-var email=alice@example.com
```

### Errors

Every error has the same shape:

```json
{ "error": { "code": "INSUFFICIENT_FUNDS", "message": "The account has insufficient funds." } }
```

| Status | Codes |
| --- | --- |
| 400 | `VALIDATION_ERROR`, `INVALID_JSON`, `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_IDEMPOTENCY_KEY`, `INVALID_CURSOR`, `AMOUNT_TOO_SMALL` |
| 401 | `UNAUTHENTICATED`, `INVALID_TOKEN`, `TOKEN_EXPIRED`, `INVALID_CREDENTIALS` |
| 403 | `ACCOUNT_ACCESS_DENIED`, `ACCOUNT_NOT_ACTIVE` |
| 404 | `ACCOUNT_NOT_FOUND`, `WITHDRAWAL_NOT_FOUND`, `NOT_FOUND` |
| 409 | `IDEMPOTENCY_KEY_CONFLICT`, `EMAIL_ALREADY_REGISTERED` |
| 413 / 415 | `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` |
| 422 | `INSUFFICIENT_FUNDS` |
| 503 | `EXCHANGE_RATE_UNAVAILABLE` |
| 500 | `INTERNAL_ERROR` (details are logged on the server, never returned to the client) |

---

## Architecture

The service is a modular monolith with no ORM. Every query is parameterised SQL through `pg`.

```
src/
  app.ts, server.ts              composition root, startup, graceful shutdown
  config/                        env parsing and validation
  db/                            pool, withTransaction(), migration runner
  middleware/                    authenticate (JWT), JSON error handler
  modules/
    auth/                        register/login, TokenService, users repository
    accounts/                    ownership middleware, accounts repository
    withdrawals/                 service (workflow), repository, validation,
                                 idempotency fingerprint, auth codes, pagination
  services/exchange-rate/        ExchangeRateProvider interface, Frankfurter impl, currency table
sql/001_init.sql                 schema: users, accounts, withdrawals
```

Routes only parse input and shape responses. The business rules live in the services, and SQL lives in the repositories. Dependencies are passed into `createApp()` (pool, config, rate provider, code generator), which lets the tests swap in a mock provider or a code generator that forces collisions.

### Withdrawal workflow

```
authenticate JWT ─► validate body + Idempotency-Key ─► verify account ownership
  ─► existing withdrawal for (account, key)? ── yes ─► same fingerprint? 201 replay : 409
  ─► fetch rate (USD → 1, no call)  ◄── outside any transaction / lock
  ─► convert with decimal.js, round to currency minor units
  ─► BEGIN
       SELECT ... FROM accounts WHERE id = $1 FOR UPDATE
       recheck ownership, idempotency key, status, balance        (under the lock)
       UPDATE accounts SET balance_usd = balance_usd - $amt WHERE ... AND balance_usd >= $amt
       INSERT withdrawal ... ON CONFLICT (authorisation_code) DO NOTHING   (≤5 code attempts)
     COMMIT ─► 201
```

### Key decisions

- **Concurrency.** Withdrawals on one account are serialised by `SELECT … FOR UPDATE` on the account row. The funds check, the debit and the insert all happen under that lock in one transaction. Two further layers back this up: the `UPDATE` itself requires `balance_usd >= amount`, and a `CHECK (balance_usd >= 0)` constraint makes overspending impossible even if application code is wrong. Requests for different accounts never block each other.
- **Idempotency.** The key is checked before the external call (a cheap retry path that skips Frankfurter) and again under the row lock. Under the lock, concurrent same-key requests queue behind the first one and then see its committed row. The `UNIQUE (account_id, idempotency_key)` constraint is the final guard: if it ever fires, the service loads the winning row and replays it. The fingerprint is a SHA-256 of the account ID, the amount normalised to 2 decimal places, and the uppercased currency, so `"10"` and `"10.00"` count as the same request. Failed attempts (422, 503, …) store nothing, so the client can retry with the same key.
- **Replays return the stored result.** The rate is not fetched again, the account is not debited again, and an account that has since been drained or suspended does not change the answer.
- **No lock held during network I/O.** Frankfurter is called before `BEGIN`. The cost is that the rate can be a few hundred milliseconds old at commit time. That is acceptable for daily ECB reference rates.
- **Money.** All money is handled with decimal.js, configured at 40 significant digits because the default 20 can lose precision on `NUMERIC(19,2) × rate`. pg returns `NUMERIC` columns as strings, and responses keep them as strings. Converted amounts are rounded **half-up** to the currency's ISO minor units (JPY, KRW and ISK have 0 decimal places, the rest 2). The exact rate used is stored with each withdrawal, and history is never recalculated.
- **Exchange rate provider.** The provider sits behind an `ExchangeRateProvider` interface. The Frankfurter implementation adds:
  - a per-request timeout covering both headers and body
  - one retry, only after transient failures
  - strict response validation: base must be USD, the rate a finite number above 0, and the date well-formed and not in the future
  - rejection of rates older than `EXCHANGE_RATE_MAX_AGE_DAYS`, so stale rates are never used silently

  Any failure becomes a 503 and nothing is debited.
- **Authorisation codes.** Codes look like `XXXX-XXXX` and are drawn from a 31-character alphabet without `0 O 1 I L`, using `crypto.randomInt`, which is an unbiased CSPRNG. That gives about 8.5 × 10¹¹ possible codes. Uniqueness is enforced by the database, and a collision gets a fresh code, up to 5 attempts. If all attempts collide, an error is thrown inside the transaction, so the debit rolls back. Codes are separate from withdrawal IDs and are references, not credentials.
- **Authentication.** Access tokens are HS256 JWTs with `sub` = user ID, valid for 15 minutes. Verification pins the algorithm and checks the signature, `exp`, `iss` and `aud`. Tokens are not stored. Login runs a bcrypt comparison even when the email is unknown, so response timing doesn't reveal which emails exist. Passwords over 72 bytes are rejected rather than silently truncated by bcrypt.
- **Ownership.** On `/v1/accounts/...` routes, the account is looked up by the token's user ID, so the client never supplies an account ID. On `/v1/accounts/:accountId/...` routes, a middleware loads the account and returns 403 unless it belongs to the token's user. In both cases the withdrawal service checks ownership again under the lock.
- **Pagination.** History uses keyset pagination on `(created_at DESC, id DESC)`, backed by the composite index. The cursor carries PostgreSQL's own text form of the timestamp because a JS `Date` would truncate microseconds and could skip or repeat rows.

## Assumptions and trade-offs

- IDs are UUIDs, as in the schema, so the `wd_…` / `acc_…` IDs in the brief's example are not used.
- Every response contains an `account_id` field that identifies the account resource. For convenience, the login response also includes the account ID.
- A replay returns `201` with the original body and adds an `Idempotent-Replayed` header so clients can tell the two cases apart.
- Malformed account or withdrawal IDs return `404`, the same as IDs that don't exist.
- A suspended account returns `403 ACCOUNT_NOT_ACTIVE`. Suspension can only be set in SQL; there is no admin API for it.
- Duplicate registration returns `409 EMAIL_ALREADY_REGISTERED`. This reveals that an email is registered, which is a common trade-off for usability.
- Half-up rounding was chosen for converted amounts. A real payout system would follow the rounding rule its settlement partner uses.
- If an amount converts to zero in the target currency, the request is rejected with `400 AMOUNT_TOO_SMALL`.
- The supported currency list is hard-coded to match ECB/Frankfurter coverage. Frankfurter is still the source of truth, and an unexpected 404 from it becomes a 503.
- The database password is fixed in `docker-compose.yml`, and the JWT secret has a dev-only fallback, so `docker compose up` works without a `.env` file. A real deployment must set `JWT_SECRET` and use managed database credentials.

## Known limitations

- There are no refresh tokens, logout or token revocation. A token stays valid until it expires (15 minutes).
- There are no deposit, reversal or settlement flows. `authorised` is the only withdrawal status, and there is no general ledger. The `withdrawals` table serves as the transaction history.
- There is no rate limiting or brute-force protection on login.
- Exchange rates are not cached. Every non-USD, non-replay withdrawal calls Frankfurter, and there is no circuit breaker.
- The provider's rate date is validated but not stored with the withdrawal.
- Idempotency keys never expire.
- There is one hot row per account. All withdrawals for an account are serialised, which is correct, but caps throughput for a single account.
- The migration runner is a minimal forward-only implementation and does not support rollback.

## AI tools used

This project was built with **Claude Code** (Anthropic, Claude Opus 5.5), which wrote the implementation, tests, Docker setup and this README from the specification in `CLAUDE.md`. All builds and test runs happened inside Docker.

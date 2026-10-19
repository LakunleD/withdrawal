
# CLAUDE.md

## Project Overview

Build a Withdrawal Authorization Service for the Staff Back-End Engineer technical assessment.

The service must:
1. Authenticate incoming requests.
2. Convert USD withdrawal amounts into a requested currency using an external exchange rate provider.
3. Verify that the account has sufficient funds.
4. Generate a unique authorization code.
5. Authorize the withdrawal and persist the transaction.
6. Return the authorization details or an appropriate error.

The implementation should demonstrate sound engineering decisions, financial correctness, concurrency handling, external service resilience, and testability.

Prioritize correctness and simplicity over unnecessary features.

## Technology Stack

- Language: TypeScript
- Runtime: Node.js
- Framework: Express.js
- Database: PostgreSQL
- Database driver: pg
- Authentication: JWT
- Password hashing: bcrypt
- Currency conversion: Frankfurter API
- Monetary calculations: decimal.js
- Containerization: Docker and Docker Compose
- Testing: Node.js test runner

Do not use Prisma, TypeORM, Sequelize, or any ORM.

Use parameterized SQL queries.

## Architecture

Use a modular monolith.

Organize the application into:
- Authentication module
- Account module
- Withdrawal module
- Exchange rate provider
- Database access layer
- Error handling
- Request validation

Keep HTTP controllers separate from business logic where practical.

Do not introduce microservices, Redis, message queues, or unnecessary infrastructure.

## Docker Requirements

Everything must run inside Docker.

Docker Compose must manage:
- Node.js API container
- PostgreSQL container
- Test execution

The application must not require locally installed Node.js or PostgreSQL.

Use a persistent Docker volume for PostgreSQL.

Configure PostgreSQL health checks and ensure the API waits for the database to become healthy.

Use environment variables for configuration.

Never commit secrets to source control.

The entire application should start using:

docker compose up --build -d

Tests should run using:

docker compose --profile test run --build --rm test

## Database Design

Use three main tables.

### users

Fields:
- id: UUID primary key
- email: unique, not null
- password_hash: not null
- created_at: timestamp

### accounts

Fields:
- id: UUID primary key
- user_id: UUID foreign key, unique, not null
- balance_usd: NUMERIC(19,2), not null
- status: active or suspended
- created_at: timestamp

Each user has exactly one account.

Each account belongs to exactly one user.

Create the account automatically when the user registers.

Registration and account creation must happen within one database transaction.

New accounts start with a zero USD balance.

Enforce nonnegative account balances using a database constraint.

### withdrawals

Fields:
- id: UUID primary key
- account_id: UUID foreign key
- amount_usd: NUMERIC(19,2)
- target_currency: CHAR(3)
- converted_amount: NUMERIC
- exchange_rate: NUMERIC
- status: authorised
- authorisation_code: unique, not null
- idempotency_key: not null
- request_fingerprint: not null
- created_at: timestamp

Enforce:
- Positive withdrawal amounts
- Unique authorization codes
- Unique (account_id, idempotency_key)
- Valid foreign key relationships

The withdrawals table serves as transaction history.

Do not introduce a separate transactions table or general ledger.

## Authentication

Implement user registration and login.

### POST /v1/auth/register

Accept:
- email
- password

Validate inputs.

Hash passwords securely using bcrypt.

Create the user and account atomically.

### POST /v1/auth/login

Verify user credentials.

Return a signed JWT access token.

Use a short expiration, such as 15 minutes.

Include the user ID in the JWT subject claim.

Validate:
- Signature
- Expiration
- Issuer
- Audience

Do not store access tokens in PostgreSQL.

Refresh tokens are out of scope for the initial implementation.

### Authorization

Every account-specific endpoint must:
1. Authenticate the JWT.
2. Identify the authenticated user.
3. Verify the requested account belongs to that user.

Never trust the account ID supplied in the URL without checking ownership.

## API Endpoints

### Authentication

POST /v1/auth/register

POST /v1/auth/login

### Accounts

GET /v1/accounts/:accountId

Returns account details and the current USD balance.

### Withdrawals

POST /v1/accounts/:accountId/withdrawals

Authorizes a new withdrawal.

GET /v1/accounts/:accountId/withdrawals

Returns paginated withdrawal history.

GET /v1/accounts/:accountId/withdrawals/:withdrawalId

Returns details of a specific withdrawal.

### Health

GET /health

Returns the application health status.

## Withdrawal Request

POST /v1/accounts/:accountId/withdrawals

Required headers:

Authorization: Bearer <JWT>
Idempotency-Key: <unique-request-key>
Content-Type: application/json

Request body:

{
  "amount": "125.50",
  "target_currency": "EUR"
}

Rules:
- amount is denominated in USD.
- amount must be a positive decimal string.
- Support no more than two decimal places.
- target_currency must be a supported ISO 4217 currency code.
- Idempotency-Key is mandatory.

Reject missing idempotency keys with HTTP 400.

## Withdrawal Processing Workflow

1. Authenticate the request.
2. Validate the request body and idempotency key.
3. Verify the user owns the account.
4. Check for an existing withdrawal with the same idempotency key.
5. If found, compare the request fingerprint.
6. Return the original authorization for an identical request.
7. Return HTTP 409 if the same key is used with different request parameters.
8. Fetch the exchange rate from Frankfurter.
9. Calculate the converted amount using decimal arithmetic.
10. Begin a PostgreSQL transaction.
11. Lock the account row using SELECT ... FOR UPDATE.
12. Recheck account ownership, status, and idempotency under the lock.
13. Verify the account has sufficient USD funds.
14. Generate a secure authorization code.
15. Deduct the USD amount from the account balance.
16. Insert the withdrawal record.
17. Commit the database transaction.
18. Return HTTP 201 Created.

The account balance update, withdrawal record, and idempotency key must be persisted atomically.

Never call Frankfurter while holding a database row lock.

Never return a successful authorization before the transaction commits.

## Mandatory Idempotency

Every withdrawal request must include an Idempotency-Key header.

Requirements:

- Reject missing or invalid idempotency keys.
- Store the idempotency key with the withdrawal.
- Store a fingerprint of the normalized request parameters.
- Enforce uniqueness on (account_id, idempotency_key).
- Identical retries must return the original authorization without deducting funds again.
- Reusing the key with different parameters must return HTTP 409 Conflict.
- Concurrent requests using the same key must not create duplicate withdrawals.

Implement idempotency checks both before and inside the database transaction.

The database unique constraint is the final protection against duplicate processing.

Use a stable request fingerprint derived from:
- Account ID
- Normalized USD amount
- Target currency

Return the original stored response for successful retries.

## Exchange Rate Provider

Use Frankfurter for currency conversion.

Create a dedicated ExchangeRateProvider abstraction.

Requirements:
- Fetch USD-to-target exchange rates.
- Validate external API responses.
- Apply an HTTP timeout.
- Handle provider failures.
- Do not authorize withdrawals using invalid exchange rates.
- Do not use stale rates silently.
- For USD-to-USD withdrawals, use exchange rate 1 without calling Frankfurter.

Fetch exchange rates before starting the database transaction.

Store the exchange rate used for each withdrawal.

Never recalculate historical withdrawals using current exchange rates.

## Authorization Code Generation

Generate a unique, human-readable authorization code for every successful withdrawal.

Example:

A7Q2-91XK

Requirements:
- Use cryptographically secure randomness.
- Do not use Math.random().
- Use an alphanumeric format.
- Avoid visually ambiguous characters.
- Enforce uniqueness in PostgreSQL.
- Handle rare code collisions with bounded retries.

Authorization codes and withdrawal IDs must be separate.

Authorization codes are references, not authentication credentials.

## Financial Correctness

Use decimal.js for monetary calculations.

Never use JavaScript floating-point arithmetic for balances.

All balances are stored in USD.

A successful authorization immediately deducts the USD amount.

Use PostgreSQL transactions and row-level locking to prevent concurrent withdrawals from overspending accounts.

The balance check, debit, and withdrawal insert must occur atomically.

If any operation fails, roll back the transaction.

Use the appropriate rounding rules for the target currency.

## Withdrawal Response

Return HTTP 201 Created.

Example:

{
  "id": "wd_8f3k2",
  "account_id": "acc_123",
  "status": "authorised",
  "authorisation_code": "A7Q2-91XK",
  "amount_usd": "125.50",
  "target_currency": "EUR",
  "converted_amount": "115.46",
  "exchange_rate": "0.92",
  "created_at": "2026-10-13T14:03:00Z"
}

## Withdrawal History

Implement:

GET /v1/accounts/:accountId/withdrawals

Support:
- Cursor-based pagination
- Configurable page size with a maximum limit
- Newest-first ordering
- Account ownership validation

Use a composite index on:

(account_id, created_at DESC, id DESC)

For individual withdrawals:

GET /v1/accounts/:accountId/withdrawals/:withdrawalId

Verify the withdrawal belongs to the specified account.

Return the original stored exchange rate and converted amount.

## Error Handling

Use consistent JSON error responses.

Example:

{
  "error": {
    "code": "INSUFFICIENT_FUNDS",
    "message": "The account has insufficient funds."
  }
}

HTTP status codes:

- 400: Invalid input or missing idempotency key
- 401: Missing or invalid JWT
- 403: Account access denied
- 404: Account or withdrawal not found
- 409: Idempotency conflict
- 422: Insufficient funds
- 503: Exchange rate provider unavailable
- 500: Unexpected internal error

Never expose stack traces, passwords, or JWT secrets in API responses.

## Testing

Implement unit and integration tests.

Prioritize:

1. User registration and login.
2. JWT validation and expiration.
3. Account ownership authorization.
4. Invalid withdrawal amounts and currencies.
5. Successful withdrawal authorization.
6. Insufficient funds.
7. Concurrent withdrawals against the same account.
8. Idempotent request retries.
9. Idempotency conflicts.
10. Concurrent requests with identical idempotency keys.
11. Exchange rate API failures and timeouts.
12. Authorization code generation and uniqueness.
13. Database transaction rollback.
14. Withdrawal history and pagination.

Mock the external exchange rate provider during tests.

Use a separate PostgreSQL test database.

Tests must run inside Docker.

Do not claim tests passed unless they have actually been executed.

## Project Structure

Use a structure similar to:

src/
  app.ts
  server.ts
  config/
  db/
  modules/
    auth/
    accounts/
    withdrawals/
  services/
    exchange-rate/
  middleware/
  utils/

sql/
  001_init.sql

tests/

Dockerfile
docker-compose.yml
.env.example
package.json
tsconfig.json
README.md
CLAUDE.md

Keep modules focused and avoid unnecessary abstractions.

## Development Priorities

Implement in this order:

1. Docker and PostgreSQL configuration.
2. Database schema.
3. Registration and login.
4. JWT authentication middleware.
5. Account ownership validation.
6. Exchange rate provider.
7. Withdrawal authorization.
8. Mandatory idempotency.
9. Withdrawal retrieval endpoints.
10. Unit and integration tests.
11. README and architecture documentation.

The assessment recommends approximately two hours.

Prioritize the required withdrawal workflow, financial correctness, and meaningful tests if time becomes limited.

## Documentation

The README must explain:
- How to start the application with Docker Compose.
- How to run tests with Docker.
- Environment variables.
- How to register and log in.
- How to obtain an access token.
- How to create a withdrawal.
- How to retrieve withdrawal history.
- How to fund a development account using a documented seed or SQL command.
- Architecture and design decisions.
- Assumptions and trade-offs.
- Known limitations.
- AI tools used during development.

## Instructions for Claude

- Follow the architecture and technology decisions in this file.
- Do not introduce an ORM.
- Do not introduce a separate transactions table.
- Do not implement refresh tokens unless requested.
- Do not implement a deposit API unless requested.
- Keep one user mapped to exactly one account.
- Treat idempotency as mandatory for withdrawals.
- Use PostgreSQL transactions for financial operations.
- Use secure authorization-code generation.
- Keep the application fully Dockerized.
- Prefer readable code and clear engineering decisions.
- Run builds and tests inside Docker.
- Document assumptions and important trade-offs.
- Do not claim successful execution without verification.
- Disclose actual AI usage in the assessment submission.

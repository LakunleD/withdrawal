import type Decimal from 'decimal.js';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../db/pool';
import { minorUnits } from '../../services/exchange-rate/currencies';
import type { ExchangeRateProvider } from '../../services/exchange-rate/exchange-rate.provider';
import { AppError, isUniqueViolation } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { Money, convertAmount } from '../../utils/money';
import { debitAccount, lockAccountForUpdate } from '../accounts/accounts.repository';
import { computeRequestFingerprint } from './fingerprint';
import { encodeCursor, type Cursor } from './pagination';
import {
  findByIdempotencyKey,
  findWithdrawal,
  insertWithdrawal,
  listWithdrawals,
  type WithdrawalRow,
} from './withdrawals.repository';

export interface AuthoriseWithdrawalCommand {
  userId: string;
  accountId: string;
  amount: Decimal;
  targetCurrency: string;
  idempotencyKey: string;
}

export interface AuthoriseWithdrawalResult {
  withdrawal: WithdrawalRow;
  /** True when an earlier identical request's stored result is being returned. */
  replayed: boolean;
}

export interface WithdrawalServiceDeps {
  pool: Pool;
  exchangeRateProvider: ExchangeRateProvider;
  generateAuthorisationCode: () => string;
  maxCodeAttempts?: number;
}

const IDEMPOTENCY_CONSTRAINT = 'withdrawals_account_idempotency_key';

export class WithdrawalService {
  private readonly maxCodeAttempts: number;

  constructor(private readonly deps: WithdrawalServiceDeps) {
    this.maxCodeAttempts = deps.maxCodeAttempts ?? 5;
  }

  /**
   * Authorises a withdrawal. Ownership has already been checked by the route
   * middleware; it is checked again under the row lock.
   */
  async authorise(cmd: AuthoriseWithdrawalCommand): Promise<AuthoriseWithdrawalResult> {
    const fingerprint = computeRequestFingerprint(cmd.accountId, cmd.amount, cmd.targetCurrency);

    // Fast path for retries: avoids an external call and a lock for a request we've already processed.
    const existing = await findByIdempotencyKey(this.deps.pool, cmd.accountId, cmd.idempotencyKey);
    if (existing) return replay(existing, fingerprint);

    // The rate is fetched before the transaction: never hold a row lock across a network call.
    const rate = await this.getRate(cmd.targetCurrency);
    const converted = convertAmount(cmd.amount, rate, minorUnits(cmd.targetCurrency));
    if (converted.lte(0)) {
      throw new AppError(400, 'AMOUNT_TOO_SMALL', 'The amount is too small to convert into the target currency.');
    }

    try {
      return await withTransaction(this.deps.pool, async (client) => {
        const account = await lockAccountForUpdate(client, cmd.accountId);
        if (!account) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found.');
        if (account.user_id !== cmd.userId) {
          throw new AppError(403, 'ACCOUNT_ACCESS_DENIED', 'You do not have access to this account.');
        }

        // Concurrent requests with the same key serialise on the lock above; the loser sees the winner's row here.
        const duplicate = await findByIdempotencyKey(client, cmd.accountId, cmd.idempotencyKey);
        if (duplicate) return replay(duplicate, fingerprint);

        if (account.status !== 'active') {
          throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'The account is not active.');
        }
        if (new Money(account.balance_usd).lt(cmd.amount)) {
          throw insufficientFunds();
        }

        const amountUsd = cmd.amount.toFixed(2);
        if (!(await debitAccount(client, cmd.accountId, amountUsd))) throw insufficientFunds();

        const withdrawal = await this.insertWithUniqueCode(client, {
          accountId: cmd.accountId,
          amountUsd,
          targetCurrency: cmd.targetCurrency,
          convertedAmount: converted.toFixed(minorUnits(cmd.targetCurrency)),
          exchangeRate: rate.toFixed(),
          idempotencyKey: cmd.idempotencyKey,
          requestFingerprint: fingerprint,
        });

        logger.info('withdrawal_authorised', {
          withdrawal_id: withdrawal.id,
          account_id: withdrawal.account_id,
          amount_usd: withdrawal.amount_usd,
          target_currency: withdrawal.target_currency,
        });
        return { withdrawal, replayed: false };
      });
    } catch (err) {
      // Final safety net: the unique constraint rejected a duplicate the checks above didn't see.
      if (isUniqueViolation(err, IDEMPOTENCY_CONSTRAINT)) {
        const winner = await findByIdempotencyKey(this.deps.pool, cmd.accountId, cmd.idempotencyKey);
        if (winner) return replay(winner, fingerprint);
      }
      throw err;
    }
  }

  async get(accountId: string, withdrawalId: string): Promise<WithdrawalRow> {
    const withdrawal = await findWithdrawal(this.deps.pool, accountId, withdrawalId);
    if (!withdrawal) throw new AppError(404, 'WITHDRAWAL_NOT_FOUND', 'Withdrawal not found.');
    return withdrawal;
  }

  async list(accountId: string, limit: number, after?: Cursor): Promise<{ items: WithdrawalRow[]; nextCursor: string | null }> {
    // Fetch one extra row to know whether another page exists.
    const rows = await listWithdrawals(this.deps.pool, accountId, limit + 1, after);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.created_at_text, id: last.id }) : null;
    return { items, nextCursor };
  }

  private async getRate(targetCurrency: string): Promise<Decimal> {
    if (targetCurrency === 'USD') return new Money(1);
    const quote = await this.deps.exchangeRateProvider.getUsdRate(targetCurrency);
    if (quote.target !== targetCurrency || !quote.rate.isFinite() || quote.rate.lte(0)) {
      throw new AppError(503, 'EXCHANGE_RATE_UNAVAILABLE', 'The exchange rate provider returned an invalid rate.');
    }
    return quote.rate;
  }

  private async insertWithUniqueCode(
    client: PoolClient,
    withdrawal: Omit<Parameters<typeof insertWithdrawal>[1], 'authorisationCode'>,
  ): Promise<WithdrawalRow> {
    for (let attempt = 1; attempt <= this.maxCodeAttempts; attempt++) {
      const row = await insertWithdrawal(client, {
        ...withdrawal,
        authorisationCode: this.deps.generateAuthorisationCode(),
      });
      if (row) return row;
      logger.warn('authorisation_code_collision', { attempt });
    }
    // Thrown inside the transaction, so the debit is rolled back.
    throw new Error(`Could not generate a unique authorisation code after ${this.maxCodeAttempts} attempts`);
  }
}

function replay(existing: WithdrawalRow, fingerprint: string): AuthoriseWithdrawalResult {
  if (existing.request_fingerprint !== fingerprint) {
    throw new AppError(
      409,
      'IDEMPOTENCY_KEY_CONFLICT',
      'This Idempotency-Key was already used with different request parameters.',
    );
  }
  return { withdrawal: existing, replayed: true };
}

function insufficientFunds(): AppError {
  return new AppError(422, 'INSUFFICIENT_FUNDS', 'The account has insufficient funds.');
}

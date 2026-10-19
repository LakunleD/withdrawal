import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import { AppError } from '../../utils/errors';
import { isUuid } from '../../utils/validation';
import { findAccountById, findAccountByUserId } from './accounts.repository';

/**
 * Resolves the authenticated user's own account from the JWT subject (each user has
 * exactly one). Must run after `authenticate`. No account ID is taken from the client.
 */
export function createResolveOwnAccount(pool: Pool) {
  return async function resolveOwnAccount(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const account = await findAccountByUserId(pool, req.auth!.userId);
    if (!account) {
      throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found.');
    }
    req.account = account;
    next();
  };
}

/**
 * Loads `:accountId` and verifies it belongs to the authenticated user. Must run
 * after `authenticate`. The account ID from the URL is never trusted on its own.
 */
export function createRequireAccountAccess(pool: Pool) {
  return async function requireAccountAccess(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const accountId = req.params.accountId;
    if (!isUuid(accountId)) {
      throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found.');
    }

    const account = await findAccountById(pool, accountId);
    if (!account) {
      throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found.');
    }
    if (account.user_id !== req.auth?.userId) {
      throw new AppError(403, 'ACCOUNT_ACCESS_DENIED', 'You do not have access to this account.');
    }

    req.account = account;
    next();
  };
}

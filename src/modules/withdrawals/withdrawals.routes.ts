import { Router } from 'express';
import { AppError } from '../../utils/errors';
import { isUuid } from '../../utils/validation';
import { decodeCursor, parsePageSize } from './pagination';
import { toWithdrawalResponse } from './withdrawals.repository';
import type { WithdrawalService } from './withdrawals.service';
import { parseCreateWithdrawalRequest } from './withdrawals.validation';

/**
 * Mounted at /v1/accounts/withdrawals and /v1/accounts/:accountId/withdrawals.
 * `req.account` is already resolved and ownership-checked by the mount.
 */
export function createWithdrawalsRouter(withdrawals: WithdrawalService): Router {
  const router = Router({ mergeParams: true });

  router.post('/', async (req, res) => {
    if (!req.is('application/json')) {
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
    }
    const input = parseCreateWithdrawalRequest(req.body, req.get('idempotency-key'));
    const account = req.account!;

    const { withdrawal, replayed } = await withdrawals.authorise({
      userId: req.auth!.userId,
      accountId: account.id,
      ...input,
    });

    res
      .status(201)
      // baseUrl is whichever mount served the request, so Location matches the caller's URL style.
      .location(`${req.baseUrl}/${withdrawal.id}`)
      .set('Idempotent-Replayed', String(replayed))
      .json(toWithdrawalResponse(withdrawal));
  });

  router.get('/', async (req, res) => {
    const limit = parsePageSize(req.query.limit);
    const cursor = decodeCursor(req.query.cursor);
    const page = await withdrawals.list(req.account!.id, limit, cursor);
    res.json({ data: page.items.map(toWithdrawalResponse), next_cursor: page.nextCursor });
  });

  router.get('/:withdrawalId', async (req, res) => {
    const { withdrawalId } = req.params;
    if (!isUuid(withdrawalId)) throw new AppError(404, 'WITHDRAWAL_NOT_FOUND', 'Withdrawal not found.');
    const withdrawal = await withdrawals.get(req.account!.id, withdrawalId);
    res.json(toWithdrawalResponse(withdrawal));
  });

  return router;
}

import { Router, type RequestHandler } from 'express';
import { toAccountResponse } from './accounts.repository';

/** Account and withdrawal routes for whichever account `req.account` holds. */
function createAccountRouter(withdrawalsRouter: Router): Router {
  const router = Router({ mergeParams: true });

  router.get('/', (req, res) => {
    res.json(toAccountResponse(req.account!));
  });

  router.use('/withdrawals', withdrawalsRouter);

  return router;
}

/**
 * Routes under /v1/accounts, which must already be authenticated:
 * - /v1/accounts[/withdrawals...]             the caller's own account, resolved from the JWT
 * - /v1/accounts/:accountId[/withdrawals...]  an explicit account, ownership-checked
 */
export function createAccountsRouter(opts: {
  withdrawalsRouter: Router;
  resolveOwnAccount: RequestHandler;
  requireAccountAccess: RequestHandler;
}): Router {
  const accountRouter = createAccountRouter(opts.withdrawalsRouter);
  const router = Router();

  // Registered before '/:accountId' so "withdrawals" is never treated as an account ID.
  router.get('/', opts.resolveOwnAccount, accountRouter);
  router.use('/withdrawals', opts.resolveOwnAccount, opts.withdrawalsRouter);
  router.use('/:accountId', opts.requireAccountAccess, accountRouter);

  return router;
}

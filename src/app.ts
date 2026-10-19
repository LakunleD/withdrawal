import express, { type Express } from 'express';
import type { Pool } from 'pg';
import type { AppConfig } from './config';
import { createAuthenticate } from './middleware/authenticate';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { createRequireAccountAccess, createResolveOwnAccount } from './modules/accounts/account-access.middleware';
import { createAccountsRouter } from './modules/accounts/accounts.routes';
import { createAuthRouter } from './modules/auth/auth.routes';
import { AuthService } from './modules/auth/auth.service';
import { TokenService } from './modules/auth/token.service';
import { generateAuthorisationCode } from './modules/withdrawals/authorisation-code';
import { createWithdrawalsRouter } from './modules/withdrawals/withdrawals.routes';
import { WithdrawalService } from './modules/withdrawals/withdrawals.service';
import type { ExchangeRateProvider } from './services/exchange-rate/exchange-rate.provider';

export interface AppDependencies {
  pool: Pool;
  config: AppConfig;
  exchangeRateProvider: ExchangeRateProvider;
  /** Overridable for tests (e.g. forcing code collisions). */
  generateAuthorisationCode?: () => string;
}

export function createApp(deps: AppDependencies): Express {
  const { pool, config } = deps;

  const tokens = new TokenService(config.auth);
  const authService = new AuthService(pool, tokens, config.auth.bcryptRounds);
  const withdrawalService = new WithdrawalService({
    pool,
    exchangeRateProvider: deps.exchangeRateProvider,
    generateAuthorisationCode: deps.generateAuthorisationCode ?? generateAuthorisationCode,
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(express.json({ limit: '10kb' }));

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', database: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable', database: 'unreachable' });
    }
  });

  app.use('/v1/auth', createAuthRouter(authService));

  app.use(
    '/v1/accounts',
    createAuthenticate(tokens),
    createAccountsRouter({
      withdrawalsRouter: createWithdrawalsRouter(withdrawalService),
      resolveOwnAccount: createResolveOwnAccount(pool),
      requireAccountAccess: createRequireAccountAccess(pool),
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

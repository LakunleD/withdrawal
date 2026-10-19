import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { ExchangeRateUnavailableError } from '../services/exchange-rate/exchange-rate.provider';

function send(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export function notFoundHandler(_req: Request, res: Response): void {
  send(res, 404, 'NOT_FOUND', 'Route not found.');
}

/** Converts every error into the standard JSON shape. Internals never reach the client. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    if (err instanceof ExchangeRateUnavailableError) {
      logger.warn('exchange_rate_unavailable', { reason: err.reason, path: req.path });
    }
    send(res, err.status, err.code, err.message);
    return;
  }

  // Errors raised by express.json() body parsing.
  const bodyErr = err as { type?: string; status?: number };
  if (bodyErr?.type === 'entity.parse.failed') {
    send(res, 400, 'INVALID_JSON', 'Request body is not valid JSON.');
    return;
  }
  if (bodyErr?.type === 'entity.too.large') {
    send(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
    return;
  }

  logger.error('unhandled_error', {
    method: req.method,
    path: req.path,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  send(res, 500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
}

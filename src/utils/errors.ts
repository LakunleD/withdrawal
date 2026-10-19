/**
 * An error that is safe to show to API clients. `message` is client-facing;
 * anything sensitive must stay out of it.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

export function validationError(message: string): AppError {
  return new AppError(400, 'VALIDATION_ERROR', message);
}

/** True when `err` is a PostgreSQL unique_violation, optionally on a specific constraint. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const pgErr = err as { code?: unknown; constraint?: unknown };
  return pgErr.code === '23505' && (constraint === undefined || pgErr.constraint === constraint);
}

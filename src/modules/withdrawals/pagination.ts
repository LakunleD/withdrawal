import { AppError } from '../../utils/errors';
import { isUuid } from '../../utils/validation';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * Position of the last row on a page. `createdAt` is PostgreSQL's own text
 * rendering of the timestamp, which keeps microsecond precision that a JS Date
 * would lose (and with it, correct ordering of rows created in the same millisecond).
 */
export interface Cursor {
  createdAt: string;
  id: string;
}

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

function invalidCursor(): AppError {
  return new AppError(400, 'INVALID_CURSOR', 'The pagination cursor is invalid.');
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.createdAt, id: cursor.id })).toString('base64url');
}

export function decodeCursor(raw: unknown): Cursor | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw === '' || raw.length > 200) throw invalidCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const { t, id } = (parsed ?? {}) as { t?: unknown; id?: unknown };
  if (typeof t !== 'string' || !TIMESTAMP_PATTERN.test(t) || !isUuid(id)) throw invalidCursor();
  return { createdAt: t, id };
}

export function parsePageSize(raw: unknown): number {
  if (raw === undefined) return DEFAULT_PAGE_SIZE;
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) {
    throw new AppError(400, 'VALIDATION_ERROR', `limit must be an integer between 1 and ${MAX_PAGE_SIZE}.`);
  }
  const size = Number(raw);
  if (size < 1 || size > MAX_PAGE_SIZE) {
    throw new AppError(400, 'VALIDATION_ERROR', `limit must be an integer between 1 and ${MAX_PAGE_SIZE}.`);
  }
  return size;
}

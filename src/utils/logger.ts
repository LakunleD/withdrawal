type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level | 'silent', number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function threshold(): number {
  const configured = (process.env.LOG_LEVEL ?? 'info') as Level | 'silent';
  return LEVELS[configured] ?? LEVELS.info;
}

function write(level: Level, event: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold()) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

/** Minimal structured JSON logger. Never pass secrets, passwords or tokens to it. */
export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => write('debug', event, fields),
  info: (event: string, fields?: Record<string, unknown>) => write('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => write('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => write('error', event, fields),
};

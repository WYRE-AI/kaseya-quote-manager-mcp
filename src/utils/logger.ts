const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LEVELS;

function getConfiguredLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return (env in LEVELS) ? env as LogLevel : 'info';
}

function log(level: LogLevel, message: string, context?: unknown): void {
  if (LEVELS[level] < LEVELS[getConfiguredLevel()]) return;
  const timestamp = new Date().toISOString();
  const prefix = `${timestamp} [${level.toUpperCase()}]`;
  if (context !== undefined) {
    let contextStr: string;
    try { contextStr = JSON.stringify(context); }
    catch { contextStr = String(context); }
    console.error(`${prefix} ${message} ${contextStr}`);
  } else {
    console.error(`${prefix} ${message}`);
  }
}

/** What is safe to log about a caught error: its type and a short message, never the object (it can carry request data). */
export function safeError(error: unknown): { errorType: string; message: string } {
  const err = error as { constructor?: { name?: string }; message?: unknown } | null | undefined;
  return {
    errorType: err?.constructor?.name ?? typeof error,
    message: (typeof err?.message === 'string' ? err.message : '').slice(0, 200),
  };
}

export const logger = {
  debug: (msg: string, ctx?: unknown) => log('debug', msg, ctx),
  info:  (msg: string, ctx?: unknown) => log('info',  msg, ctx),
  warn:  (msg: string, ctx?: unknown) => log('warn',  msg, ctx),
  error: (msg: string, ctx?: unknown) => log('error', msg, ctx),
};

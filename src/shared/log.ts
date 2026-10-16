/**
 * Structured logging with mandatory redaction.
 *
 * Workers Logs ingests whatever is printed, and the observability pipeline is
 * not a secret store. Every field passes through `scrub` before it is emitted.
 */

import { redactSecrets } from './errors.js';

const SENSITIVE_KEY = /token|secret|password|authorization|apikey|api_key|credential|cookie/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSecrets(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : scrub(item, depth + 1);
    }
    return out;
  }
  return '[unloggable]';
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, event, ...(scrub(fields) as Record<string, unknown>) });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => log('debug', event, fields),
  info: (event: string, fields?: Record<string, unknown>) => log('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => log('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => log('error', event, fields)
};

/** Error summary safe to log: name and message only, never a stack or a URL. */
export function errorSummary(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: redactSecrets(error.message) };
  }
  return { name: 'UnknownError', message: redactSecrets(String(error)) };
}

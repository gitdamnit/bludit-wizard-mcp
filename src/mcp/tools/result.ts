/** Uniform tool result shapes. */

import { toErrorPayload } from '../../shared/errors.js';

export interface TextToolResult {
  /** Index signature required by the MCP SDK's CallToolResult shape. */
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** Pretty-printed JSON keeps tool output stable and diffable for clients and tests. */
export function ok(data: unknown): TextToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function fail(error: unknown): TextToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(toErrorPayload(error), null, 2) }], isError: true };
}

/** Wrap a tool body so thrown errors become structured, non-leaking failures. */
export function toResult(run: () => Promise<unknown>): Promise<TextToolResult> {
  return run().then(ok, fail);
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

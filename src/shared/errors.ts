/**
 * Error taxonomy.
 *
 * Tool failures are mapped to a small, stable set of codes so an MCP client
 * gets an actionable message without any credential, URL-with-token, upstream
 * body, or stack ever reaching the wire.
 */

export type ToolErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'ambiguous_site'
  | 'site_unreachable'
  | 'site_auth_failed'
  | 'capability_unavailable'
  | 'conflict'
  | 'revision_mismatch'
  | 'proposal_expired'
  | 'forbidden'
  | 'rate_limited'
  | 'upstream_error'
  | 'internal_error';

const RETRYABLE: ReadonlySet<ToolErrorCode> = new Set<ToolErrorCode>([
  'site_unreachable',
  'rate_limited',
  'upstream_error'
]);

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  /** Safe, caller-facing text. Never contains secrets. */
  override readonly message: string;
  /** Structured, non-secret context for the client to act on. */
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(code: ToolErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.message = message;
    this.details = details;
    this.retryable = RETRYABLE.has(code);
  }
}

export function isToolError(value: unknown): value is ToolError {
  return value instanceof ToolError;
}

/** Payload shape returned to an MCP client when a tool fails. */
export interface ToolErrorPayload {
  ok: false;
  error: {
    code: ToolErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

export function toErrorPayload(error: unknown): ToolErrorPayload {
  if (isToolError(error)) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(Object.keys(error.details).length > 0 ? { details: error.details } : {})
      }
    };
  }
  return {
    ok: false,
    error: {
      code: 'internal_error',
      message: 'An unexpected internal error occurred. The operation was not confirmed.',
      retryable: false
    }
  };
}

/** Identifiers scrubbed from any message that might be echoed upward. */
export function redactSecrets(value: string): string {
  return value
    .replace(/(token|authentication|authorization|api_?key|password|secret)=([^&\s]+)/gi, '$1=[redacted]')
    .replace(/(bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 [redacted]')
    .replace(/\b[A-Fa-f0-9]{64}\b/g, '[redacted-hex64]');
}

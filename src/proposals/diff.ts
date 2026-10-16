/**
 * Deterministic change previews.
 *
 * This is a pure function over two strings or two field maps. No model, no
 * network, no inference: what it reports is exactly what the server will send
 * to Bludit. That is the point — `preview_page_changes` must not be able to
 * disagree with `apply_approved_edit`.
 */

export interface FieldChange {
  field: string;
  changed: boolean;
  before: string;
  after: string;
  /** True when only leading/trailing whitespace differs. */
  whitespaceOnly: boolean;
}

const METADATA_FIELDS = ['title', 'description', 'type', 'slug', 'category', 'tags', 'parent', 'date'] as const;

function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

/** Field-level comparison for the page metadata Bludit stores in its JSON DB. */
export function diffFields(
  before: Partial<Record<string, unknown>>,
  after: Partial<Record<string, unknown>>
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of METADATA_FIELDS) {
    if (!(field in after)) continue;
    const beforeText = asText(before[field]);
    const afterText = asText(after[field]);
    changes.push({
      field,
      changed: beforeText !== afterText,
      before: beforeText.slice(0, 400),
      after: afterText.slice(0, 400),
      whitespaceOnly: beforeText !== afterText && beforeText.trim() === afterText.trim()
    });
  }
  return changes;
}

export interface LineDiffSummary {
  added: number;
  removed: number;
  /** Unified-diff body, truncated to `maxLines`. */
  patch: string;
  truncated: boolean;
  identical: boolean;
}

const LCS_LINE_LIMIT = 1500;

/**
 * Line-oriented diff. Uses an LCS over the changed region after trimming the
 * common prefix and suffix, which keeps cost proportional to the edit rather
 * than to the document. Very large rewrites fall back to a block replacement.
 */
export function diffText(before: string, after: string, maxLines = 400): LineDiffSummary {
  if (before === after) {
    return { added: 0, removed: 0, patch: '', truncated: false, identical: true };
  }

  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const beforeMid = beforeLines.slice(prefix, beforeLines.length - suffix);
  const afterMid = afterLines.slice(prefix, afterLines.length - suffix);

  let operations: Array<{ type: ' ' | '-' | '+'; text: string }>;

  if (beforeMid.length > LCS_LINE_LIMIT || afterMid.length > LCS_LINE_LIMIT) {
    // Fall back to a whole-block replacement rather than blowing the CPU budget.
    operations = [
      ...beforeMid.map((text) => ({ type: '-' as const, text })),
      ...afterMid.map((text) => ({ type: '+' as const, text }))
    ];
  } else {
    operations = lcsDiff(beforeMid, afterMid);
  }

  const added = operations.filter((op) => op.type === '+').length;
  const removed = operations.filter((op) => op.type === '-').length;

  const header = `@@ -${prefix + 1},${beforeMid.length} +${prefix + 1},${afterMid.length} @@`;
  const context = 3;
  const head = beforeLines.slice(Math.max(0, prefix - context), prefix).map((text) => ({ type: ' ' as const, text }));
  const tail = afterLines
    .slice(afterLines.length - suffix, afterLines.length - suffix + context)
    .map((text) => ({ type: ' ' as const, text }));

  const all = [...head, ...operations, ...tail];
  const truncated = all.length > maxLines;
  const shown = truncated ? all.slice(0, maxLines) : all;
  const body = shown.map((op) => `${op.type}${op.text}`).join('\n');

  return {
    added,
    removed,
    patch: `${header}\n${body}${truncated ? '\n… (patch truncated)' : ''}`,
    truncated,
    identical: false
  };
}

/** Classic LCS dynamic-programming diff, bounded by the caller. */
function lcsDiff(before: string[], after: string[]): Array<{ type: ' ' | '-' | '+'; text: string }> {
  const n = before.length;
  const m = after.length;
  const table: Uint32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i += 1) table[i] = new Uint32Array(m + 1);

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const row = table[i] as Uint32Array;
      const next = table[i + 1] as Uint32Array;
      row[j] = before[i] === after[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
    }
  }

  const out: Array<{ type: ' ' | '-' | '+'; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ type: ' ', text: before[i] as string });
      i += 1;
      j += 1;
    } else if ((table[i + 1] as Uint32Array)[j]! >= (table[i] as Uint32Array)[j + 1]!) {
      out.push({ type: '-', text: before[i] as string });
      i += 1;
    } else {
      out.push({ type: '+', text: after[j] as string });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ type: '-', text: before[i] as string });
    i += 1;
  }
  while (j < m) {
    out.push({ type: '+', text: after[j] as string });
    j += 1;
  }
  return out;
}

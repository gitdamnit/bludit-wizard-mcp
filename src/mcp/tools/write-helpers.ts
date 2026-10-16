/**
 * Write-input validation, kept separate from tool registration.
 *
 * These are the rules that decide whether a write request is well-formed before
 * it is ever sent to Bludit. They live here so they can be tested without
 * standing up an MCP server.
 *
 * Note on sanitisation: Bludit sanitises DB-bound values itself in
 * `Pages::add()` / `Pages::edit()`. Sanitising again here would double-encode
 * (`Cats & Dogs` becoming `Cats &amp;amp; Dogs`), so this module only validates.
 */

import { isPageType, type BluditWriteFields } from '../../bludit/types.js';
import { ToolError } from '../../shared/errors.js';

export interface WriteFieldsInput {
  title?: string;
  content?: string;
  description?: string;
  type?: string;
  slug?: string;
  category?: string;
  tags?: string;
  parent?: string;
  date?: string;
  coverImage?: string;
  template?: string;
  position?: number;
}

/** Collect only the fields the caller actually supplied. */
export function pickWriteFields(args: WriteFieldsInput): BluditWriteFields {
  const fields: BluditWriteFields = {};
  if (args.title !== undefined) fields.title = args.title;
  if (args.content !== undefined) fields.content = args.content;
  if (args.description !== undefined) fields.description = args.description;
  if (args.type !== undefined) {
    if (!isPageType(args.type)) {
      throw new ToolError('invalid_input', `Unsupported page type: ${args.type}`, {
        allowed: ['published', 'draft', 'static', 'sticky', 'scheduled']
      });
    }
    fields.type = args.type;
  }
  if (args.slug !== undefined) fields.slug = args.slug;
  if (args.category !== undefined) fields.category = args.category;
  if (args.tags !== undefined) fields.tags = args.tags;
  if (args.parent !== undefined) fields.parent = args.parent;
  if (args.date !== undefined) fields.date = args.date;
  if (args.coverImage !== undefined) fields.coverImage = args.coverImage;
  if (args.template !== undefined) fields.template = args.template;
  if (args.position !== undefined) fields.position = args.position;
  return fields;
}

/**
 * Enforce the create/edit invariants.
 *
 * `Bludit` ignores an empty `content` on edit (`Pages::edit()` only replaces the
 * body when the value is non-empty), so rather than silently doing nothing this
 * refuses the request and says why.
 */
export function assertWritable(fields: BluditWriteFields, mode: 'create' | 'edit'): void {
  if (mode === 'create') {
    if (!fields.title || fields.title.trim() === '') {
      throw new ToolError('invalid_input', 'A non-empty `title` is required to create a page.');
    }
    if (fields.content === undefined || fields.content === '') {
      throw new ToolError('invalid_input', 'A non-empty `content` is required to create a page.');
    }
    return;
  }

  if (Object.keys(fields).length === 0) {
    throw new ToolError('invalid_input', 'No fields to change were supplied.');
  }
  if (fields.title !== undefined && fields.title.trim() === '') {
    throw new ToolError('invalid_input', '`title` cannot be set to empty.');
  }
  if (fields.content !== undefined && fields.content === '') {
    throw new ToolError(
      'invalid_input',
      'Bludit ignores an empty `content` value on edit, so clearing a page body is not supported through this API.'
    );
  }
}

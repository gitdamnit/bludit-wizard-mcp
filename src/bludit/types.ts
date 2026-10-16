/**
 * Types describing the Bludit HTTP API as implemented by `bl-plugins/api`
 * (Bludit 3.22.x, both Community and Pro).
 *
 * Response envelope, unchanged since the plugin was introduced:
 *   { "status": "0" | "1", "message": "<text>", "data"?: <payload>, "meta"?: {...} }
 * `status: "0"` means success, `status: "1"` means an application-level failure.
 * Newer builds also set a meaningful HTTP status code for the same outcome.
 */

export interface BluditEnvelope<T> {
  status?: string;
  message?: string;
  data?: T;
  meta?: BluditPageMeta;
}

export interface BluditPageMeta {
  total?: number;
  pageNumber?: number;
  pageSize?: number;
  hasMore?: boolean;
}

/** A page as returned by `Page::json(true)`. */
export interface BluditPage {
  key: string;
  title?: string;
  /** Markdown parsed to HTML by the site's parser. */
  content?: string;
  /** The raw Markdown on disk. */
  contentRaw?: string;
  description?: string;
  /** published | static | draft | sticky | scheduled | autosave */
  type?: string;
  slug?: string;
  date?: string;
  dateRaw?: string;
  dateUTC?: string;
  /**
   * Comma-joined on the wire, an array in Bludit's own database.
   *
   * `Page::json()` calls `tags(false)`, which returns `implode(',', $tags)`.
   * Verified against live Bludit Community and Pro 3.22.0; see
   * `docs/BLUDIT_COMPATIBILITY_MATRIX.md`. Use `pageTags()` rather than reading
   * this directly.
   */
  tags?: string | string[];
  username?: string;
  /**
   * The category **name**, or `false`.
   *
   * `Page::category()` resolves the page's stored category key against the site's
   * category list and returns `false` when there is no match — which includes the
   * case where a page was stored with a category that the site has never defined.
   * Verified against live Bludit Community and Pro 3.22.0. Use `pageCategory()`.
   */
  category?: string | false;
  uuid?: string;
  permalink?: string;
  coverImage?: string | false;
  coverImageFilename?: string | false;
}

/** Subset of `Site::get()` exposed by `GET /api/settings`. */
export interface BluditSettings {
  title?: string;
  description?: string;
  language?: string;
  locale?: string;
  timezone?: string;
  url?: string;
  [key: string]: unknown;
}

export interface BluditTaxonomyTerm {
  key?: string;
  name?: string;
  description?: string;
  pages?: BluditPage[];
  [key: string]: unknown;
}

/** Fields accepted by `POST /api/pages` and `PUT /api/pages/<key>`. */
export interface BluditWriteFields {
  title?: string;
  content?: string;
  description?: string;
  type?: 'published' | 'draft' | 'static' | 'sticky' | 'scheduled';
  slug?: string;
  parent?: string;
  category?: string;
  tags?: string;
  date?: string;
  coverImage?: string;
  template?: string;
  position?: number;
}

export const PAGE_TYPES = ['published', 'draft', 'static', 'sticky', 'scheduled'] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export function isPageType(value: unknown): value is PageType {
  return typeof value === 'string' && (PAGE_TYPES as readonly string[]).includes(value);
}

/** The Wizard extension's `GET /api/wizard/site` payload. */
export interface WizardSiteInfo {
  ok?: boolean;
  site?: { title?: string; description?: string; url?: string; totalPages?: number };
  error?: string;
}

/** The Wizard extension's `GET /api/wizard/pages` payload. */
export interface WizardPageList {
  ok?: boolean;
  count?: number;
  pages?: Array<{
    key: string;
    title?: string;
    description?: string;
    type?: string;
    slug?: string;
    permalink?: string;
  }>;
  error?: string;
}

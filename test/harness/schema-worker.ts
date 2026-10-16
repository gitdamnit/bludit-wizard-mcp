/**
 * Test-only database access.
 *
 * Two capabilities, both scoped to the test harness:
 *   POST /apply  — create the schema (the harness does not run D1 migrations)
 *   POST /query  — run a statement and return any rows
 *
 * `/query` exists so tests can assert on *stored* state — most importantly that
 * credentials and tokens are ciphertext in D1 rather than plaintext — and so a
 * test can arrange a state that would otherwise need the passage of time, such as
 * a token that has expired.
 *
 * It permits `SELECT`, `UPDATE` and `DELETE` on the application tables. Anything
 * that could change the schema, attach a database or reach outside it is refused.
 * This Worker exists only under `test/`, binds a local in-memory database, and is
 * never referenced by a deployable config.
 */

import init from '../../migrations/0001_init.sql';
import rateLimits from '../../migrations/0002_rate_limits.sql';
import personalAccessTokens from '../../migrations/0003_personal_access_tokens.sql';

/** Applied in filename order, the same order `wrangler d1 migrations apply` uses. */
const SCHEMA = `${init}\n${rateLimits}\n${personalAccessTokens}`;

export function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
}

export default {
  async fetch(request: Request, env: { DB: D1Database }): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    if (pathname === '/apply') {
      const statements = splitStatements(SCHEMA);
      for (const statement of statements) {
        await env.DB.prepare(statement).run();
      }
      return Response.json({ ok: true, statements: statements.length });
    }

    if (pathname === '/query') {
      const body = (await request.json()) as { sql?: string; params?: unknown[] };
      const sql = (body.sql ?? '').trim();
      // No schema changes, no ATTACH, no multiple statements.
      if (!/^(select|update|delete)\s/i.test(sql) || sql.includes(';')) {
        return Response.json(
          { ok: false, error: 'only a single SELECT, UPDATE or DELETE is permitted' },
          { status: 400 }
        );
      }
      const statement = env.DB.prepare(sql);
      const bound = body.params && body.params.length > 0 ? statement.bind(...body.params) : statement;
      const result = await bound.all();
      return Response.json({ ok: true, results: result.results ?? [] });
    }

    return new Response('Not found', { status: 404 });
  }
};

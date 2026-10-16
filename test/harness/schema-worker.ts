/**
 * Test-only database access.
 *
 * Two capabilities, both scoped to the test harness:
 *   POST /apply  — create the schema (the harness does not run D1 migrations)
 *   POST /query  — run a read-only SELECT and return the rows
 *
 * `/query` exists so tests can assert on *stored* state — most importantly that
 * credentials are ciphertext in D1 rather than plaintext. It refuses anything
 * that is not a SELECT, and it is never referenced by a deployable config.
 */

import schema from '../../migrations/0001_init.sql';

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
      const statements = splitStatements(schema);
      for (const statement of statements) {
        await env.DB.prepare(statement).run();
      }
      return Response.json({ ok: true, statements: statements.length });
    }

    if (pathname === '/query') {
      const body = (await request.json()) as { sql?: string; params?: unknown[] };
      const sql = (body.sql ?? '').trim();
      if (!/^select\s/i.test(sql)) {
        return Response.json({ ok: false, error: 'only SELECT is permitted' }, { status: 400 });
      }
      const statement = env.DB.prepare(sql);
      const bound = body.params && body.params.length > 0 ? statement.bind(...body.params) : statement;
      const result = await bound.all();
      return Response.json({ ok: true, results: result.results ?? [] });
    }

    return new Response('Not found', { status: 404 });
  }
};

import type { Context, Hono } from 'hono';
import type { AuthEnv } from '../shared/env.js';
import type { SessionContext } from './sessions.js';

export interface AuthVariables {
  session: SessionContext;
}

export type AuthApp = Hono<{ Bindings: AuthEnv; Variables: AuthVariables }>;

/** Fully typed Hono context, so `c.env` and `c.get('session')` are not `any`. */
export type AuthContext = Context<{ Bindings: AuthEnv; Variables: AuthVariables }>;

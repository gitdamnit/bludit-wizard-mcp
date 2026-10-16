-- Personal access tokens.
--
-- Why these exist: three of the twelve target clients cannot complete an OAuth
-- authorization flow at all. GitHub Copilot's cloud agent and code review
-- "do not currently support remote MCP servers that leverage OAuth", Mistral's
-- Vibe Code CLI "does not yet support MCP servers that require OAuth
-- authentication", and Empryo documents static headers only. Without a
-- header-based credential those clients cannot connect to any conforming remote
-- MCP server, ours included.
--
-- What a token is: a user-created, user-labelled, scoped, expiring, revocable
-- bearer credential, owned by one account. It is never a second authentication
-- system — it grants nothing an OAuth grant could not, and it is checked by the
-- same scope and tenancy code.
--
-- Storage: only a SHA-256 digest of the token. The token itself is shown once at
-- creation and never stored. An unkeyed digest is sufficient here, unlike for a
-- password, because the token is 192 bits of randomness and cannot be guessed;
-- see docs/SECURITY.md.

CREATE TABLE IF NOT EXISTS personal_access_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  scopes_json  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  revoked_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_pat_user ON personal_access_tokens (user_id);

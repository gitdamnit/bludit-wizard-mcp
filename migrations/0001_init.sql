-- Bludit Wizard MCP — D1 schema
--
-- Design notes
--  * `users` are accounts on THIS service. They are deliberately distinct from
--    Bludit site users, from OAuth clients, and from OAuth grants. The OAuth
--    provider stores clients/grants/tokens in KV, not here.
--  * `sites` hold encrypted credentials only. Plaintext credentials never
--    reach D1, and are never logged or returned by any tool.
--  * `pairing_challenges` implement the site-connection flow: a challenge the
--    signed-in user generates, which the target site must prove it received.
--  * `proposals` are the immutable, short-lived, account+site-bound records
--    that back propose/preview/apply. `base_revision` is the guard against
--    stale approvals.
--  * `audit_log` records tool activity with no secrets.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  ua_hash    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS sites (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label              TEXT NOT NULL,
  base_url           TEXT NOT NULL,
  edition            TEXT NOT NULL DEFAULT 'unknown',
  bludit_version     TEXT NOT NULL DEFAULT '',
  api_token_enc      TEXT NOT NULL,
  auth_token_enc     TEXT NOT NULL DEFAULT '',
  wizard_api_key_enc TEXT NOT NULL DEFAULT '',
  wizard_api_base    TEXT NOT NULL DEFAULT '',
  capabilities_json  TEXT NOT NULL DEFAULT '{}',
  status             TEXT NOT NULL DEFAULT 'connected',
  last_error         TEXT NOT NULL DEFAULT '',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  last_checked_at    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, base_url),
  CHECK (status IN ('connected', 'error', 'disabled'))
);
CREATE INDEX IF NOT EXISTS idx_sites_user ON sites(user_id);

CREATE TABLE IF NOT EXISTS pairing_challenges (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge_hash TEXT NOT NULL,
  label          TEXT NOT NULL DEFAULT '',
  base_url       TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  consumed_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pairing_user ON pairing_challenges(user_id);
CREATE INDEX IF NOT EXISTS idx_pairing_expires ON pairing_challenges(expires_at);

CREATE TABLE IF NOT EXISTS proposals (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id              TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  page_key             TEXT NOT NULL,
  base_revision        TEXT NOT NULL DEFAULT '',
  operation            TEXT NOT NULL,
  payload_json         TEXT NOT NULL,
  payload_hash         TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'proposed',
  created_at           INTEGER NOT NULL,
  expires_at           INTEGER NOT NULL,
  applied_at           INTEGER,
  applied_by_client_id TEXT NOT NULL DEFAULT '',
  CHECK (operation IN ('create', 'edit')),
  CHECK (status IN ('proposed', 'applied', 'expired', 'rejected'))
);
CREATE INDEX IF NOT EXISTS idx_proposals_user_site ON proposals(user_id, site_id, status);
CREATE INDEX IF NOT EXISTS idx_proposals_expires ON proposals(expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL DEFAULT '',
  site_id    TEXT NOT NULL DEFAULT '',
  client_id  TEXT NOT NULL DEFAULT '',
  tool       TEXT NOT NULL,
  outcome    TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  CHECK (outcome IN ('ok', 'denied', 'error'))
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_site ON audit_log(site_id, created_at);

-- Rate limiting.
--
-- Fixed-window counters, keyed by an opaque bucket string. The bucket is an
-- HMAC of whatever identifies the caller (an IP, an account, a client), so no
-- IP address or email address is ever stored here — a database leak reveals
-- counts, not who was counting.
--
-- One row per (bucket, window). Reads and writes are a single UPSERT, which
-- matters because D1 bills and rate-limits per row. Rows are pruned by the
-- scheduled handler; see `purgeExpiredRateLimits`.

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       TEXT    NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

-- Supports the prune of expired windows.
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start);

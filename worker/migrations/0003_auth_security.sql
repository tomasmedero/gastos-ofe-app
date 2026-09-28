CREATE TABLE IF NOT EXISTS auth_failures (
  fingerprint TEXT PRIMARY KEY,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  window_started_at INTEGER NOT NULL,
  blocked_until INTEGER,
  last_failed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_failures_last_failed_idx
ON auth_failures (last_failed_at);

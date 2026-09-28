CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  person TEXT NOT NULL CHECK (person IN ('Ofelia', 'Andrea')),
  description TEXT NOT NULL,
  cents INTEGER NOT NULL CHECK (cents > 0),
  due_date TEXT,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
  created_at TEXT NOT NULL,
  paid_at TEXT
);

CREATE INDEX IF NOT EXISTS expenses_reminders_idx
ON expenses (status, due_date) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS reminders (
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  due_date TEXT NOT NULL,
  days_before INTEGER NOT NULL CHECK (days_before IN (0, 1, 2)),
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent')),
  lease_until INTEGER,
  sent_at TEXT,
  PRIMARY KEY (expense_id, due_date, days_before)
);
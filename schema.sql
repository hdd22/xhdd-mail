PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
  quota INTEGER NOT NULL DEFAULT 5 CHECK(quota >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
  last_login_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_users_role_status ON users(role, status);

CREATE TABLE IF NOT EXISTS inboxes (
  id TEXT PRIMARY KEY,
  local_part TEXT NOT NULL COLLATE NOCASE UNIQUE,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  owner_username TEXT REFERENCES users(username),
  is_favorite INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_inboxes_expiry ON inboxes(expires_at);
CREATE INDEX IF NOT EXISTS idx_inboxes_owner ON inboxes(owner_username);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  dedupe_key TEXT UNIQUE,
  sender_address TEXT NOT NULL,
  sender_name TEXT,
  subject TEXT NOT NULL DEFAULT '(无主题)',
  text_body TEXT NOT NULL DEFAULT '',
  raw_size INTEGER NOT NULL DEFAULT 0,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  forward_status TEXT NOT NULL DEFAULT 'pending',
  forward_error TEXT,
  r2_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_expiry ON messages(expires_at);
CREATE INDEX IF NOT EXISTS idx_messages_inbox_received ON messages(inbox_id, received_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT NOT NULL,
  attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts(ip, attempted_at);

CREATE TABLE IF NOT EXISTS forward_settings (
  username TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
  target_email TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0
);

-- AnonShock store: link definitions only.
-- There is deliberately no table for sessions, IP addresses, pseudonyms, or
-- control history. Adding one is a visible schema change, not an accident.

CREATE TABLE holders (
  id           TEXT PRIMARY KEY,
  token_hash   BLOB NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE links (
  id                TEXT PRIMARY KEY,
  holder_id         TEXT NOT NULL REFERENCES holders(id) ON DELETE CASCADE,
  slug              TEXT NOT NULL UNIQUE,
  manage_token_hash BLOB NOT NULL,
  mode              TEXT NOT NULL CHECK (mode IN ('share','token')),

  upstream_base     TEXT NOT NULL,
  sealed_share_id   BLOB,
  sealed_token      BLOB,

  title             TEXT NOT NULL,
  author_text       TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('active','killed','dead_upstream','needs_reauth')),
  expires_at        INTEGER NOT NULL,

  rl_per_guest_per_min  INTEGER NOT NULL,
  rl_per_link_per_min   INTEGER NOT NULL,
  require_bot_check     INTEGER NOT NULL,
  guest_password_hash   BLOB,

  created_at        INTEGER NOT NULL
);
CREATE INDEX links_holder ON links(holder_id);
CREATE INDEX links_expiry ON links(expires_at);

CREATE TABLE link_devices (
  link_id      TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  alias        TEXT NOT NULL,
  sealed_id    BLOB NOT NULL,
  display_name TEXT NOT NULL,
  sort         INTEGER NOT NULL,
  PRIMARY KEY (link_id, alias)
);

CREATE TABLE link_shockers (
  link_id       TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  alias         TEXT NOT NULL,
  sealed_id     BLOB NOT NULL,
  device_alias  TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  max_intensity INTEGER NOT NULL CHECK (max_intensity BETWEEN 0 AND 100),
  max_duration  INTEGER NOT NULL CHECK (max_duration BETWEEN 300 AND 65535),
  allow_shock   INTEGER NOT NULL,
  allow_vibrate INTEGER NOT NULL,
  allow_sound   INTEGER NOT NULL,
  hidden        INTEGER NOT NULL,
  cooldown_ms   INTEGER NOT NULL,
  sort          INTEGER NOT NULL,
  PRIMARY KEY (link_id, alias)
);

CREATE TABLE instance_state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

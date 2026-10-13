CREATE TABLE games (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  steam_app_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  steam_review_score INTEGER,
  steam_review_count INTEGER,
  hltb_id INTEGER,
  hltb_main REAL,
  hltb_main_extra REAL,
  hltb_completionist REAL,
  value_score REAL,
  is_endless INTEGER DEFAULT 0,
  is_on_wishlist INTEGER DEFAULT 0,
  is_early_access INTEGER DEFAULT 0,
  controller_support TEXT,
  release_date TEXT,
  is_owned INTEGER DEFAULT 0,
  playtime_minutes INTEGER,
  is_ignored INTEGER DEFAULT 0,
  has_single_player INTEGER DEFAULT 0,
  has_multiplayer INTEGER DEFAULT 0,
  has_co_op INTEGER DEFAULT 0,
  has_online_co_op INTEGER DEFAULT 0,
  has_local_co_op INTEGER DEFAULT 0,
  has_pvp INTEGER DEFAULT 0,
  has_online_pvp INTEGER DEFAULT 0,
  has_local_pvp INTEGER DEFAULT 0,
  has_crossplatform INTEGER DEFAULT 0,
  is_mmo INTEGER DEFAULT 0,
  tags TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  is_running INTEGER NOT NULL DEFAULT 0,
  lock_expires_at INTEGER,
  ignored_count INTEGER NOT NULL DEFAULT 0,
  wishlist_count INTEGER NOT NULL DEFAULT 0,
  owned_count INTEGER NOT NULL DEFAULT 0,
  games_updated INTEGER NOT NULL DEFAULT 0,
  games_removed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE catalog_refresh_state (
  key TEXT PRIMARY KEY,
  last_app_id INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  completed_at INTEGER,
  min_reviews INTEGER NOT NULL DEFAULT 0,
  apps_seen INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE catalog_refresh_failures (
  steam_app_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  error TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE itad_game_map (
  steam_app_id INTEGER PRIMARY KEY,
  itad_id TEXT,
  checked_at INTEGER NOT NULL
);

CREATE TABLE game_deal_cache (
  steam_app_id INTEGER NOT NULL,
  country TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('retail','bundle')),
  checked_at INTEGER NOT NULL,
  offers_json TEXT NOT NULL CHECK(json_valid(offers_json)),
  PRIMARY KEY(steam_app_id, country, kind)
);

CREATE TABLE deal_refresh_state (
  country TEXT PRIMARY KEY,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  lock_token TEXT,
  lock_expires_at INTEGER,
  games_checked INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX games_steam_app_id_unique ON games(steam_app_id);

CREATE INDEX idx_games_browse_default ON games(value_score DESC)
  WHERE value_score IS NOT NULL AND is_endless = 0 AND is_ignored = 0;

CREATE INDEX idx_games_browse_owned_playtime ON games(playtime_minutes, value_score DESC)
  WHERE value_score IS NOT NULL AND is_endless = 0;

CREATE INDEX idx_games_steam_app_id ON games(steam_app_id);

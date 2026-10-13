CREATE TABLE __drizzle_migrations (
  id SERIAL PRIMARY KEY,
  hash TEXT NOT NULL,
  created_at numeric
);

CREATE INDEX idx_games_status_filters ON games(is_endless, is_early_access, is_ignored, is_mmo, is_owned);

CREATE INDEX idx_games_value_score ON games(value_score DESC);

-- MenuForge D1 Database Schema

CREATE TABLE IF NOT EXISTS recipe_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  robots_allowed INTEGER DEFAULT 1,
  last_status INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recipes (
  id TEXT PRIMARY KEY,
  source_url TEXT UNIQUE NOT NULL,
  source_domain TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  hero_image_url TEXT,
  cuisine TEXT,
  tags TEXT,
  yield TEXT,
  time_prep_min INTEGER,
  time_cook_min INTEGER,
  time_total_min INTEGER,
  calories_per_serving INTEGER,
  ingredients_json TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  equipment_json TEXT,
  nutrition_json TEXT,
  allergens_json TEXT,
  source_blocks_json TEXT,
  alternatives_json TEXT,
  confidence TEXT DEFAULT 'medium',
  emb BLOB,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  email TEXT,
  name TEXT,
  picture_url TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_users_account ON users(account_id);

CREATE TABLE IF NOT EXISTS favorites (
  user_id TEXT,
  recipe_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, recipe_id)
);

CREATE TABLE IF NOT EXISTS ratings (
  user_id TEXT,
  recipe_id TEXT,
  stars INTEGER CHECK (stars BETWEEN 1 AND 5),
  notes TEXT,
  cooked_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, recipe_id)
);

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY,
  cuisine_prefs_json TEXT,
  tag_prefs_json TEXT,
  last_recomputed_at TEXT
);

CREATE TABLE IF NOT EXISTS menus (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  title TEXT,
  week_start TEXT,
  items_json TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS menu_members (
  menu_id TEXT,
  user_id TEXT,
  role TEXT DEFAULT 'editor',
  PRIMARY KEY (menu_id, user_id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  recipe_id TEXT,
  event_type TEXT NOT NULL,
  event_value TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crawl_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT UNIQUE,
  priority INTEGER DEFAULT 0,
  status TEXT DEFAULT 'queued',
  error TEXT,
  scheduled_for TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id TEXT,
  html_r2_key TEXT,
  screenshot_r2_key TEXT,
  pdf_r2_key TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

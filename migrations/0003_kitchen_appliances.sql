-- Migration: Kitchen appliances management and recipe prep phases
-- Adds prep phase storage to recipes and a table for user kitchen appliances

ALTER TABLE recipes ADD COLUMN prep_phases_json TEXT;

CREATE TABLE IF NOT EXISTS kitchen_appliances (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  manual_r2_key TEXT,
  extracted_text TEXT,
  manual_embedding_json TEXT,
  created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_kitchen_appliances_user ON kitchen_appliances(user_id);

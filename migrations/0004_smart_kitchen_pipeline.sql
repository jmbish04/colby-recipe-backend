-- Migration: Smart Kitchen pipeline enhancements
-- Reshapes the kitchen_appliances table for the agentic pipeline requirements

PRAGMA foreign_keys=off;

CREATE TABLE IF NOT EXISTS kitchen_appliances_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  nickname TEXT,
  brand TEXT,
  model TEXT,
  extracted_specs_json TEXT,
  manual_r2_key TEXT,
  ocr_text_r2_key TEXT,
  agent_instructions TEXT,
  processing_status TEXT NOT NULL DEFAULT 'QUEUED',
  created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO kitchen_appliances_new (
  id,
  user_id,
  nickname,
  brand,
  model,
  extracted_specs_json,
  manual_r2_key,
  ocr_text_r2_key,
  agent_instructions,
  processing_status,
  created_at,
  updated_at
)
SELECT
  id,
  user_id,
  NULL AS nickname,
  brand,
  model,
  NULL AS extracted_specs_json,
  manual_r2_key,
  NULL AS ocr_text_r2_key,
  NULL AS agent_instructions,
  'COMPLETED' AS processing_status,
  created_at,
  updated_at
FROM kitchen_appliances;

DROP TABLE kitchen_appliances;
ALTER TABLE kitchen_appliances_new RENAME TO kitchen_appliances;

CREATE INDEX IF NOT EXISTS idx_kitchen_appliances_user ON kitchen_appliances(user_id);
CREATE INDEX IF NOT EXISTS idx_kitchen_appliances_status ON kitchen_appliances(processing_status);

PRAGMA foreign_keys=on;

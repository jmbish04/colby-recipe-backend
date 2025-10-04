-- Migration: Ensure request_logs table exists for observability
-- Context: Production error `D1_ERROR: no such table: request_logs` indicates
--          some environments were initialized without this table. This
--          migration recreates the table definition defensively so new or
--          existing databases regain logging capabilities without destructive
--          resets.

CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  route TEXT NOT NULL,
  method TEXT NOT NULL,
  status INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  msg TEXT,
  meta TEXT
);

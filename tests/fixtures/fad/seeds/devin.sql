-- Devin CLI sessions.db fixture seed (schema mirrors the real store).
-- Built into tests/fixtures/fad/home/.local/share/devin/cli/sessions.db
-- by scripts/regen-fad-fixtures.ts and by the parity test itself.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  working_directory TEXT NOT NULL,
  backend_type TEXT NOT NULL,
  model TEXT NOT NULL,
  agent_mode TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  title TEXT,
  main_chain_id INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE message_nodes (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  node_id INTEGER NOT NULL,
  parent_node_id INTEGER,
  chat_message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  metadata TEXT,
  UNIQUE(session_id, node_id)
);

INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, title, main_chain_id, hidden)
VALUES ('devin-fad-001', '/tmp/fad-alpha', 'cli', 'swe-1-7', 'normal', 1780000000, 1780000100, 'Fixture session', 5, 0);

INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES
  ('devin-fad-001', 1, NULL, '{"role":"system","content":"You are Devin.","metadata":{}}', 1780000000),
  ('devin-fad-001', 2, 1,    '{"role":"user","content":"fix the login bug","metadata":{"is_user_input":true}}', 1780000001),
  ('devin-fad-001', 3, 2,    '{"role":"assistant","content":"Reading auth.ts.","tool_calls":[{"id":"call_1","name":"read","arguments":"{\"path\":\"auth.ts\"}"}],"metadata":{}}', 1780000002),
  -- Internal keepalive: is_user_input null -> agentboard drops, FAD keeps.
  ('devin-fad-001', 4, 3,    '{"role":"user","content":"continue","metadata":{"is_user_input":null}}', 1780000003),
  ('devin-fad-001', 5, 4,    '{"role":"user","content":"now add tests","metadata":{"is_user_input":true}}', 1780000004);

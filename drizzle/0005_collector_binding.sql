-- First-binding state for the local Feishu WebSocket collector.
ALTER TABLE collector_state ADD COLUMN binding_status TEXT NOT NULL DEFAULT 'unbound';
ALTER TABLE collector_state ADD COLUMN bound_chat_id TEXT;
ALTER TABLE collector_state ADD COLUMN bound_chat_name TEXT;
ALTER TABLE collector_state ADD COLUMN pending_chat_id TEXT;
ALTER TABLE collector_state ADD COLUMN pending_chat_name TEXT;
ALTER TABLE collector_state ADD COLUMN pending_message_id TEXT;
ALTER TABLE collector_state ADD COLUMN pending_received_at INTEGER;


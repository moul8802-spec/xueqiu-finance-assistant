CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`action` text NOT NULL,
	`actor` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_logs_created` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`category` text NOT NULL,
	`topic_key` text NOT NULL,
	`source_chat_id` text NOT NULL,
	`source_label` text NOT NULL,
	`source_message_ids` text NOT NULL,
	`review_flags` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`reviewed_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_drafts_status_updated` ON `drafts` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_drafts_merge_window` ON `drafts` (`source_chat_id`,`topic_key`,`created_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`message_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`sender_id` text,
	`sanitized_content` text NOT NULL,
	`content_hash` text NOT NULL,
	`status` text NOT NULL,
	`duplicate_of` text,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_messages_event_id` ON `messages` (`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_messages_message_id` ON `messages` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_hash_received` ON `messages` (`content_hash`,`received_at`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sources_chat_id` ON `sources` (`chat_id`);
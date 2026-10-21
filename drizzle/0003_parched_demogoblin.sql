CREATE TABLE `collector_state` (
	`id` text PRIMARY KEY NOT NULL,
	`last_received_at` integer,
	`last_success_at` integer,
	`last_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_event_id` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `messages` ADD `sender_name` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `source` text DEFAULT 'feishu' NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `original_content` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `source_url` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `event_timestamp` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `processed_at` integer;
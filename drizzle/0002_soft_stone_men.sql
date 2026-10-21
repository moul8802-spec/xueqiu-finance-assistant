CREATE TABLE `device_pairings` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`label` text NOT NULL,
	`platform` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_hint` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`expires_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_device_pairings_token_hash` ON `device_pairings` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_device_pairings_actor` ON `device_pairings` (`actor_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `drafts` ADD `metadata_json` text DEFAULT '{}' NOT NULL;
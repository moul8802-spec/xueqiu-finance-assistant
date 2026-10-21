CREATE TABLE `feishu_connections` (
	`actor_id` text PRIMARY KEY NOT NULL,
	`feishu_open_id` text,
	`feishu_union_id` text,
	`tenant_key` text,
	`name` text,
	`avatar_url` text,
	`access_token_enc` text NOT NULL,
	`refresh_token_enc` text,
	`token_type` text DEFAULT 'Bearer' NOT NULL,
	`scope` text DEFAULT '' NOT NULL,
	`expires_at` integer NOT NULL,
	`refresh_expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `feishu_oauth_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_feishu_oauth_states_actor` ON `feishu_oauth_states` (`actor_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `feishu_selected_chats` (
	`actor_id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`name` text NOT NULL,
	`external` integer DEFAULT false NOT NULL,
	`tenant_key` text,
	`updated_at` integer NOT NULL
);

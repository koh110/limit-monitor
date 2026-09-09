CREATE TABLE `collector_tokens` (
	`source_id` text PRIMARY KEY,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE TABLE `latest_limits` (
	`provider` text NOT NULL,
	`account_alias` text NOT NULL,
	`bucket_id` text NOT NULL,
	`label` text NOT NULL,
	`used_percent` real NOT NULL,
	`remaining_percent` real NOT NULL,
	`window_duration_seconds` integer,
	`resets_at` text,
	`observed_at` text NOT NULL,
	`received_at` text NOT NULL,
	`source_id` text NOT NULL,
	`reached` integer DEFAULT false NOT NULL,
	CONSTRAINT `latest_limits_pk` PRIMARY KEY(`provider`, `account_alias`, `bucket_id`)
);

CREATE TABLE `collector_tokens__new` (
	`source_id` text NOT NULL,
	`account_alias` text NOT NULL,
	`token_hash` text NOT NULL UNIQUE,
	`created_at` text NOT NULL,
	`revoked_at` text,
	CONSTRAINT `collector_tokens_pk` PRIMARY KEY(`source_id`, `account_alias`)
);
--> statement-breakpoint
INSERT INTO `collector_tokens__new` (`source_id`, `account_alias`, `token_hash`, `created_at`, `revoked_at`)
SELECT `source_id`, 'default', `token_hash`, `created_at`, `revoked_at`
FROM `collector_tokens`;
--> statement-breakpoint
DROP TABLE `collector_tokens`;
--> statement-breakpoint
ALTER TABLE `collector_tokens__new` RENAME TO `collector_tokens`;

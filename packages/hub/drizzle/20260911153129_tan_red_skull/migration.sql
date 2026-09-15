CREATE TABLE `refresh_requests` (
	`id` text PRIMARY KEY,
	`provider` text NOT NULL,
	`account_alias` text NOT NULL,
	`source_id` text NOT NULL,
	`requested_at` text NOT NULL,
	`dispatched_at` text,
	`started_at` text,
	`completed_at` text,
	`status` text NOT NULL,
	`error_code` text
);
--> statement-breakpoint
CREATE INDEX `refresh_requests_scope_status_idx` ON `refresh_requests` (`source_id`,`provider`,`account_alias`,`status`);--> statement-breakpoint
CREATE INDEX `refresh_requests_lease_idx` ON `refresh_requests` (`status`,`dispatched_at`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `refresh_requests_active_scope_idx` ON `refresh_requests` (`source_id`,`provider`,`account_alias`) WHERE "refresh_requests"."status" in ('queued', 'dispatched', 'running');
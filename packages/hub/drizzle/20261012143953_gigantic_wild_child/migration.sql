CREATE TABLE `latest_snapshot_markers` (
	`provider` text NOT NULL,
	`account_alias` text NOT NULL,
	`observed_at` text NOT NULL,
	`received_at` text NOT NULL,
	CONSTRAINT `latest_snapshot_markers_pk` PRIMARY KEY(`provider`, `account_alias`)
);

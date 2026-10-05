CREATE TABLE `account_bucket_orders` (
	`provider` text NOT NULL,
	`account_alias` text NOT NULL,
	`bucket_order` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `account_bucket_orders_pk` PRIMARY KEY(`provider`, `account_alias`)
);

CREATE TABLE `deploy_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`requested_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`note` text,
	`action_id` text,
	`snapshot` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `deploy_requests_status_idx` ON `deploy_requests` (`status`);--> statement-breakpoint
CREATE INDEX `deploy_requests_service_idx` ON `deploy_requests` (`service_id`,`requested_at`);--> statement-breakpoint
ALTER TABLE `approvals` ADD `requested_by` text;
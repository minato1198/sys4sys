CREATE TABLE `port_history` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`pid_host_id` text,
	`protocol` text NOT NULL,
	`address` text NOT NULL,
	`port` integer NOT NULL,
	`pid` integer,
	`ppid` integer,
	`process_name` text,
	`process_path` text,
	`command_line` text,
	`started_at` integer,
	`service_id` text,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	`released_by` text
);
--> statement-breakpoint
CREATE INDEX `port_history_scope_port_opened_idx` ON `port_history` (`scope`,`port`,`opened_at`);--> statement-breakpoint
CREATE INDEX `port_history_closed_at_idx` ON `port_history` (`closed_at`);--> statement-breakpoint
ALTER TABLE `ports` ADD `ppid` integer;--> statement-breakpoint
ALTER TABLE `ports` ADD `started_at` integer;
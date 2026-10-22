ALTER TABLE `services` ADD `pid` integer;--> statement-breakpoint
ALTER TABLE `services` ADD `pid_scope` text;--> statement-breakpoint
ALTER TABLE `services` ADD `last_started_at` integer;--> statement-breakpoint
ALTER TABLE `services` ADD `last_exited_at` integer;--> statement-breakpoint
ALTER TABLE `services` ADD `last_exit_code` integer;--> statement-breakpoint
ALTER TABLE `services` ADD `last_error` text;--> statement-breakpoint
CREATE INDEX `log_events_ts_idx` ON `log_events` (`ts`);--> statement-breakpoint
CREATE INDEX `log_sources_host_service_idx` ON `log_sources` (`host_id`,`service_id`);
ALTER TABLE `services` ADD `deploy` text;--> statement-breakpoint
ALTER TABLE `services` ADD `last_deploy_at` integer;--> statement-breakpoint
ALTER TABLE `services` ADD `last_deploy_status` text;--> statement-breakpoint
ALTER TABLE `services` ADD `last_deploy_error` text;
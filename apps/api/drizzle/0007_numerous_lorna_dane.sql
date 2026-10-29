ALTER TABLE `services` ADD `control_mode` text DEFAULT 'spawn' NOT NULL;--> statement-breakpoint
ALTER TABLE `services` ADD `service_name` text;--> statement-breakpoint
CREATE UNIQUE INDEX `services_host_service_name_uq` ON `services` (`host_id`,lower("service_name")) WHERE "services"."service_name" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `actions_one_running_deploy` ON `actions` (`service_id`) WHERE "actions"."type" = 'deploy' and "actions"."status" in ('pending', 'running');
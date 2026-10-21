CREATE TABLE `actions` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text,
	`service_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_by` text,
	`approved_by` text,
	`policy_id` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `actions_service_started_idx` ON `actions` (`service_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `ai_analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`result` text NOT NULL,
	`confidence` real DEFAULT 0 NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_analyses_incident_id_idx` ON `ai_analyses` (`incident_id`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`requested_action` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_at` integer NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`note` text
);
--> statement-breakpoint
CREATE INDEX `approvals_status_idx` ON `approvals` (`status`);--> statement-breakpoint
CREATE INDEX `approvals_incident_id_idx` ON `approvals` (`incident_id`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`actor_label` text NOT NULL,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`before` text,
	`after` text,
	`reason` text,
	`ip` text,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_logs_ts_idx` ON `audit_logs` (`ts`);--> statement-breakpoint
CREATE INDEX `audit_logs_actor_idx` ON `audit_logs` (`actor_user_id`);--> statement-breakpoint
CREATE TABLE `hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`distro` text,
	`default_user` text,
	`enabled` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hosts_kind_distro_uq` ON `hosts` (`kind`,`distro`);--> statement-breakpoint
CREATE TABLE `incident_events` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`ts` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text
);
--> statement-breakpoint
CREATE INDEX `incident_events_incident_ts_idx` ON `incident_events` (`incident_id`,`ts`);--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`title` text NOT NULL,
	`severity` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`started_at` integer NOT NULL,
	`resolved_at` integer,
	`detected_by` text NOT NULL,
	`restart_attempts` integer DEFAULT 0 NOT NULL,
	`summary` text
);
--> statement-breakpoint
CREATE INDEX `incidents_fingerprint_started_idx` ON `incidents` (`fingerprint`,`started_at`);--> statement-breakpoint
CREATE INDEX `incidents_status_idx` ON `incidents` (`status`);--> statement-breakpoint
CREATE INDEX `incidents_service_id_idx` ON `incidents` (`service_id`);--> statement-breakpoint
CREATE TABLE `log_events` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`service_id` text NOT NULL,
	`ts` integer NOT NULL,
	`level` text NOT NULL,
	`stream` text NOT NULL,
	`message` text NOT NULL,
	`fields` text,
	`fingerprint` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `log_events_host_service_ts_idx` ON `log_events` (`host_id`,`service_id`,`ts`);--> statement-breakpoint
CREATE INDEX `log_events_fingerprint_ts_idx` ON `log_events` (`fingerprint`,`ts`);--> statement-breakpoint
CREATE TABLE `log_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`service_id` text,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`scope` text NOT NULL,
	`rules` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `port_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`port` integer NOT NULL,
	`protocol` text NOT NULL,
	`service_id` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `port_reservations_endpoint_uq` ON `port_reservations` (`scope`,`protocol`,`port`);--> statement-breakpoint
CREATE TABLE `ports` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`pid_host_id` text,
	`protocol` text NOT NULL,
	`address` text NOT NULL,
	`port` integer NOT NULL,
	`pid` integer,
	`process_name` text,
	`process_path` text,
	`command_line` text,
	`service_id` text,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ports_endpoint_uq` ON `ports` (`scope`,`protocol`,`address`,`port`);--> statement-breakpoint
CREATE INDEX `ports_port_idx` ON `ports` (`port`);--> statement-breakpoint
CREATE INDEX `ports_service_id_idx` ON `ports` (`service_id`);--> statement-breakpoint
CREATE TABLE `report_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`channel` text NOT NULL,
	`to_addr` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`sent_at` integer
);
--> statement-breakpoint
CREATE INDEX `report_deliveries_report_id_idx` ON `report_deliveries` (`report_id`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`format` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reports_incident_id_idx` ON `reports` (`incident_id`);--> statement-breakpoint
CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`name` text NOT NULL,
	`command` text NOT NULL,
	`cwd` text,
	`env` text,
	`expected_ports` text,
	`health_check` text,
	`depends_on` text,
	`auto_start` integer DEFAULT false NOT NULL,
	`auto_restart_phase` text DEFAULT 'observe' NOT NULL,
	`status` text DEFAULT 'stopped' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `services_host_name_uq` ON `services` (`host_id`,`name`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`user_agent` text,
	`ip` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_at_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`last_login_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);
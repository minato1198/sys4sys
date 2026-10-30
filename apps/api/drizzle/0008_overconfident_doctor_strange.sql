CREATE TABLE `incident_action_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`analysis_id` text,
	`service_id` text NOT NULL,
	`action_type` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`risk` text DEFAULT 'medium' NOT NULL,
	`confidence` real DEFAULT 0 NOT NULL,
	`rationale` text,
	`parameters` text,
	`snapshot` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`analysis_requested_by` text,
	`approval_id` text,
	`action_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_at` integer,
	`executed_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `incident_action_proposals_incident_status_idx` ON `incident_action_proposals` (`incident_id`,`status`);--> statement-breakpoint
CREATE INDEX `incident_action_proposals_service_status_idx` ON `incident_action_proposals` (`service_id`,`status`);--> statement-breakpoint
CREATE INDEX `incident_action_proposals_approval_idx` ON `incident_action_proposals` (`approval_id`);--> statement-breakpoint
CREATE INDEX `incident_action_proposals_action_idx` ON `incident_action_proposals` (`action_id`);--> statement-breakpoint
CREATE INDEX `incident_action_proposals_incident_dedupe_idx` ON `incident_action_proposals` (`incident_id`,`dedupe_key`);--> statement-breakpoint
ALTER TABLE `actions` ADD `proposal_id` text;--> statement-breakpoint
ALTER TABLE `actions` ADD `approval_id` text;--> statement-breakpoint
ALTER TABLE `actions` ADD `source` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
CREATE INDEX `actions_proposal_id_idx` ON `actions` (`proposal_id`);--> statement-breakpoint
CREATE INDEX `actions_approval_id_idx` ON `actions` (`approval_id`);--> statement-breakpoint
ALTER TABLE `approvals` ADD `proposal_id` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `source` text DEFAULT 'policy' NOT NULL;--> statement-breakpoint
ALTER TABLE `approvals` ADD `expires_at` integer;--> statement-breakpoint
CREATE INDEX `approvals_proposal_id_idx` ON `approvals` (`proposal_id`);
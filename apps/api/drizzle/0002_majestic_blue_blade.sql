DROP INDEX `port_reservations_endpoint_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `port_reservations_endpoint_uq` ON `port_reservations` (`protocol`,`port`);
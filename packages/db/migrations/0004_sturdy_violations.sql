CREATE TABLE `workshop_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workshop_id` integer NOT NULL,
	`role` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workshop_id`) REFERENCES `workshops`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workshops` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`bot_id` integer NOT NULL,
	`base_branch` text NOT NULL,
	`plan` text DEFAULT '' NOT NULL,
	`proposal` text,
	`session_id` text,
	`session_runner_id` integer,
	`parent_issue_id` integer,
	`created_by_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bot_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_runner_id`) REFERENCES `runners`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `jobs` ADD `workshop_id` integer REFERENCES workshops(id);--> statement-breakpoint
ALTER TABLE `jobs` ADD `workshop_mode` text;
CREATE TABLE `pipeline_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pipeline_id` integer NOT NULL,
	`name` text NOT NULL,
	`stage` text NOT NULL,
	`stage_index` integer NOT NULL,
	`script` text NOT NULL,
	`variables` text DEFAULT '{}' NOT NULL,
	`allow_failure` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'created' NOT NULL,
	`runner_id` integer,
	`token_hash` text,
	`error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`pipeline_id`) REFERENCES `pipelines`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`runner_id`) REFERENCES `runners`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pipeline_jobs_token_hash_unique` ON `pipeline_jobs` (`token_hash`);--> statement-breakpoint
CREATE TABLE `pipelines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`ref` text NOT NULL,
	`sha` text NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`triggered_by_id` integer NOT NULL,
	`merge_request_id` integer,
	`error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`triggered_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merge_request_id`) REFERENCES `merge_requests`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `pipelines_must_succeed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `auto_run_agent_pipelines` integer DEFAULT false NOT NULL;
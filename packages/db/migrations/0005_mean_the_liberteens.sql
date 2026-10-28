ALTER TABLE `issues` ADD `origin` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE `issues` ADD `branch` text;--> statement-breakpoint
ALTER TABLE `issues` ADD `split_proposal` text;
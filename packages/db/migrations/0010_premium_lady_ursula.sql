ALTER TABLE `merge_request_comments` ADD `path` text;--> statement-breakpoint
ALTER TABLE `merge_request_comments` ADD `line` integer;--> statement-breakpoint
ALTER TABLE `merge_request_comments` ADD `side` text;
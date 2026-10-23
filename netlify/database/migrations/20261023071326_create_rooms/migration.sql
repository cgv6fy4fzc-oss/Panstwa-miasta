CREATE TABLE "rooms" (
	"pin" text PRIMARY KEY,
	"host" text NOT NULL,
	"players" jsonb DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'lobby' NOT NULL,
	"letter" text DEFAULT '' NOT NULL,
	"time_selection" text DEFAULT 'unlimited' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

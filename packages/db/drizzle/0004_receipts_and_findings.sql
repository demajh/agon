CREATE TYPE "public"."finding_status" AS ENUM('open', 'closed_fixed', 'closed_tolerated');--> statement-breakpoint
CREATE TYPE "public"."result_kind" AS ENUM('model', 'measurement');--> statement-breakpoint
CREATE TABLE "findings" (
	"id" text PRIMARY KEY NOT NULL,
	"receipt_id" text NOT NULL,
	"invariant" text NOT NULL,
	"impact" text NOT NULL,
	"closure_owner" text NOT NULL,
	"status" "finding_status" DEFAULT 'open' NOT NULL,
	"settlement" jsonb NOT NULL,
	"requirements_digest" text,
	"created_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "kind" "result_kind" DEFAULT 'model' NOT NULL;--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "assumptions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "requirements_digest" text;--> statement-breakpoint
CREATE INDEX "findings_receipt_id_created_at_idx" ON "findings" USING btree ("receipt_id","created_at");--> statement-breakpoint
CREATE INDEX "findings_status_idx" ON "findings" USING btree ("status");
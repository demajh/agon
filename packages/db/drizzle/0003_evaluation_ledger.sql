CREATE TYPE "public"."ledger_event" AS ENUM('started', 'completed', 'discarded', 'promoted', 'killed');--> statement-breakpoint
CREATE TYPE "public"."ledger_role" AS ENUM('control', 'treatment');--> statement-breakpoint
CREATE TABLE "evaluation_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sample_hash" text NOT NULL,
	"run_id" text NOT NULL,
	"variant" text NOT NULL,
	"variant_key" text NOT NULL,
	"role" "ledger_role" NOT NULL,
	"event" "ledger_event" NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "sample_hash" text;--> statement-breakpoint
CREATE INDEX "evaluation_ledger_sample_hash_at_idx" ON "evaluation_ledger" USING btree ("sample_hash","at");--> statement-breakpoint
CREATE INDEX "evaluation_ledger_run_id_idx" ON "evaluation_ledger" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "runs_sample_hash_idx" ON "runs" USING btree ("sample_hash");
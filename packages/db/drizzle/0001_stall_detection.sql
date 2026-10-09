ALTER TYPE "public"."session_outcome" ADD VALUE 'stalled';--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "max_steps_since_progress" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_progress_step" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "progress_steps" jsonb;
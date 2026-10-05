CREATE TYPE "public"."analysis_method" AS ENUM('bayesian', 'sequential', 'fixed');--> statement-breakpoint
CREATE TYPE "public"."analytics_provider" AS ENUM('posthog', 'segment', 'amplitude', 'ga');--> statement-breakpoint
CREATE TYPE "public"."api_key_role" AS ENUM('observer', 'operator', 'squad');--> statement-breakpoint
CREATE TYPE "public"."decision_actor" AS ENUM('auto', 'human');--> statement-breakpoint
CREATE TYPE "public"."decision_status" AS ENUM('proposed', 'approved', 'rejected', 'executed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."event_source" AS ENUM('intercepted', 'inferred', 'judge');--> statement-breakpoint
CREATE TYPE "public"."policy_action" AS ENUM('reallocate', 'pause', 'resume', 'kill', 'notify');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."session_outcome" AS ENUM('success', 'gave_up', 'max_steps', 'budget_exceeded', 'error');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('pending', 'running', 'finished', 'failed');--> statement-breakpoint
CREATE TYPE "public"."squad_status" AS ENUM('active', 'paused', 'killed');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"role" "api_key_role" NOT NULL,
	"squad_id" text,
	"label" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_key" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "policy_action" NOT NULL,
	"status" "decision_status" NOT NULL,
	"squad_id" text,
	"policy_id" text,
	"actor" "decision_actor" NOT NULL,
	"rationale" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"session_id" text NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"event" text NOT NULL,
	"distinct_id" text NOT NULL,
	"source" "event_source" NOT NULL,
	"provider" "analytics_provider",
	"properties" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "results" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"method" "analysis_method" NOT NULL,
	"control" text NOT NULL,
	"primary_metric_id" text NOT NULL,
	"metrics" jsonb NOT NULL,
	"decision" jsonb NOT NULL,
	"calibration" jsonb NOT NULL,
	"sessions_analyzed" integer NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"engine" jsonb NOT NULL,
	CONSTRAINT "results_run_id_key" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"status" "run_status" NOT NULL,
	"variants" text[] NOT NULL,
	"seed" bigint NOT NULL,
	"config" jsonb NOT NULL,
	"counts" jsonb NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"result_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"index" integer NOT NULL,
	"variant" text NOT NULL,
	"scenario_id" text NOT NULL,
	"persona" jsonb NOT NULL,
	"status" "session_status" NOT NULL,
	"outcome" "session_outcome",
	"outcome_reason" text,
	"steps" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"judgement" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "sessions_run_id_index_key" UNIQUE("run_id","index")
);
--> statement-breakpoint
CREATE TABLE "squads" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" "squad_status" DEFAULT 'active' NOT NULL,
	"control_url" text,
	"ticket_source" jsonb,
	"allocation" double precision DEFAULT 0 NOT NULL,
	"score" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "squads_slug_key" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "steps" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"index" integer NOT NULL,
	"observation" jsonb NOT NULL,
	"decision" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"patience" double precision NOT NULL,
	"usage" jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	CONSTRAINT "steps_session_id_index_key" UNIQUE("session_id","index")
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"name" text NOT NULL,
	"spec" jsonb NOT NULL,
	"squad_id" text,
	"git_ref" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "variants_environment_id_name_key" UNIQUE("environment_id","name")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "steps_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_squad_id_idx" ON "api_keys" USING btree ("squad_id");--> statement-breakpoint
CREATE INDEX "decisions_squad_id_created_at_idx" ON "decisions" USING btree ("squad_id","created_at");--> statement-breakpoint
CREATE INDEX "decisions_created_at_idx" ON "decisions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "decisions_status_idx" ON "decisions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "environments_name_idx" ON "environments" USING btree ("name");--> statement-breakpoint
CREATE INDEX "environments_created_at_idx" ON "environments" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "events_run_id_timestamp_idx" ON "events" USING btree ("run_id","timestamp");--> statement-breakpoint
CREATE INDEX "events_session_id_timestamp_idx" ON "events" USING btree ("session_id","timestamp");--> statement-breakpoint
CREATE INDEX "runs_environment_id_created_at_idx" ON "runs" USING btree ("environment_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sessions_run_id_idx" ON "sessions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "sessions_run_id_variant_idx" ON "sessions" USING btree ("run_id","variant");--> statement-breakpoint
CREATE INDEX "variants_squad_id_idx" ON "variants" USING btree ("squad_id");
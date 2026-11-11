CREATE TYPE "public"."attempt_result" AS ENUM('success', 'failure');--> statement-breakpoint
CREATE TYPE "public"."channel_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."channel_status" AS ENUM('stopped', 'running', 'error');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('received', 'queued', 'processing', 'delivered', 'sent', 'rejected', 'failed');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"label" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"direction" "channel_direction" NOT NULL,
	"status" "channel_status" DEFAULT 'stopped' NOT NULL,
	"hl7_version" text NOT NULL,
	"retention_days" integer NOT NULL,
	"config" jsonb NOT NULL,
	"delivery" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"result" "attempt_result" NOT NULL,
	"response" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"direction" "channel_direction" NOT NULL,
	"raw" text,
	"json" jsonb,
	"message_type" text,
	"control_id" text,
	"status" "message_status" NOT NULL,
	"ack_code" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_unique" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_channel_idx" ON "api_keys" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_name_unique" ON "channels" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_inbound_port_unique" ON "channels" USING btree ((("config" ->> 'port'))) WHERE "channels"."direction" = 'inbound';--> statement-breakpoint
CREATE INDEX "delivery_attempts_message_idx" ON "delivery_attempts" USING btree ("message_id","attempt");--> statement-breakpoint
CREATE INDEX "messages_channel_created_idx" ON "messages" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_control_id_idx" ON "messages" USING btree ("channel_id","control_id");
CREATE TYPE "public"."channel_transport" AS ENUM('mllp', 'file');--> statement-breakpoint
CREATE TYPE "public"."file_import_status" AS ENUM('imported', 'error', 'duplicate');--> statement-breakpoint
CREATE TABLE "file_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"status" "file_import_status" NOT NULL,
	"message_id" uuid,
	"moved_to" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "channels_inbound_port_unique";--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "transport" "channel_transport" DEFAULT 'mllp' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "source_file" text;--> statement-breakpoint
ALTER TABLE "file_imports" ADD CONSTRAINT "file_imports_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_imports" ADD CONSTRAINT "file_imports_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "file_imports_channel_sha_imported_unique" ON "file_imports" USING btree ("channel_id","sha256") WHERE "file_imports"."status" = 'imported';--> statement-breakpoint
CREATE INDEX "file_imports_channel_created_idx" ON "file_imports" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_inbound_folder_unique" ON "channels" USING btree ((lower("config" ->> 'directory'))) WHERE "channels"."direction" = 'inbound' and "channels"."transport" = 'file';--> statement-breakpoint
CREATE UNIQUE INDEX "channels_inbound_port_unique" ON "channels" USING btree ((("config" ->> 'port'))) WHERE "channels"."direction" = 'inbound' and "channels"."transport" = 'mllp';
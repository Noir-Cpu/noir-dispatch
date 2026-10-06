CREATE TABLE "demo_usage" (
	"day" text PRIMARY KEY NOT NULL,
	"steps" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_demos" (
	"order_id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_step_at" timestamp with time zone NOT NULL,
	"demo_ms" integer DEFAULT 0 NOT NULL,
	"steps" integer DEFAULT 0 NOT NULL,
	"route_points" jsonb,
	"route_source" text,
	"route_distance_m" integer,
	"route_duration_s" integer
);
--> statement-breakpoint
ALTER TABLE "order_demos" ADD CONSTRAINT "order_demos_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
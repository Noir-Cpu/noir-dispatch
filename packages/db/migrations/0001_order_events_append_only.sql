-- order_events is append-only: the database refuses updates and deletes, not just the application.
CREATE FUNCTION order_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'order_events is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER order_events_no_update_delete
  BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION order_events_immutable();

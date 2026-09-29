-- Still append-only for everyone, with one exception: events of simulated orders may be deleted so the
-- cleanup job can expire old simulator traffic. Updates are always refused.
CREATE OR REPLACE FUNCTION order_events_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM orders WHERE id = OLD.order_id AND is_simulated) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'order_events is append-only';
END;
$$ LANGUAGE plpgsql;

-- Audit events are append-only (DESIGN §5.3). UPDATE and TRUNCATE are always
-- rejected; DELETE only for rows past the retention period, which the cleanup
-- job removes (AUDIT_RETENTION_DAYS in src/db/schema.ts: change both together).
-- The table owner can still disable the trigger: separating the migration and
-- runtime roles is planned for Phase 5 (docs/threat-model.md).
CREATE FUNCTION "audit_events_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.created_at < now() - interval '365 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only: % rejected', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "audit_events_append_only"
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION "audit_events_guard"();
--> statement-breakpoint
CREATE TRIGGER "audit_events_no_truncate"
  BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_events_guard"();

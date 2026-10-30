CREATE FUNCTION occ.gateway_outbound_is_valid(document jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE destination jsonb; host text;
BEGIN
  IF jsonb_typeof(document) IS DISTINCT FROM 'object'
    OR NOT (document ? 'destinations') OR document - 'destinations' <> '{}'::jsonb
    OR jsonb_typeof(document->'destinations') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF (SELECT count(DISTINCT entry->>'host') FROM jsonb_array_elements(document->'destinations') entry)
    <> jsonb_array_length(document->'destinations') THEN RETURN false; END IF;
  FOR destination IN SELECT * FROM jsonb_array_elements(document->'destinations') LOOP
    IF jsonb_typeof(destination) IS DISTINCT FROM 'object'
      OR NOT (destination ?& ARRAY['host', 'port'])
      OR destination - 'host' - 'port' <> '{}'::jsonb
      OR jsonb_typeof(destination->'host') IS DISTINCT FROM 'string'
      OR destination->'port' IS DISTINCT FROM '443'::jsonb THEN RETURN false; END IF;
    host := destination->>'host';
    IF char_length(host) > 253 OR host !~ '[.]' OR host ~ '^[0-9.]+$'
      OR host !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
      THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.gateway_outbound_is_valid(jsonb) TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.agents ADD COLUMN gateway_outbound jsonb NOT NULL DEFAULT '{"destinations":[]}'::jsonb;
--> statement-breakpoint
ALTER TABLE occ.agents ADD CONSTRAINT agents_gateway_outbound_valid CHECK (
  occ.gateway_outbound_is_valid(gateway_outbound)
  AND (execution_mode = 'dedicated' OR gateway_outbound = '{"destinations":[]}'::jsonb)
);
--> statement-breakpoint
GRANT UPDATE (gateway_outbound) ON occ.agents TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_gateway_outbound_valid CHECK (
  NOT (admitted_spec ? 'gateway_outbound') OR (
    occ.gateway_outbound_is_valid(admitted_spec->'gateway_outbound')
    AND (admitted_spec#>>'{harness,mode}' = 'dedicated' OR admitted_spec->'gateway_outbound' = '{"destinations":[]}'::jsonb)
  )
);
--> statement-breakpoint
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid = 'occ.agent_revisions'::regclass AND conname = 'agent_revisions_admitted_snapshot';
  ALTER TABLE occ.agent_revisions DROP CONSTRAINT agent_revisions_admitted_snapshot;
  EXECUTE 'ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_admitted_snapshot '
    || replace(
      replace(definition, '- ''execution_admission''::text', '- ''execution_admission''::text - ''gateway_outbound''::text'),
      '1024', '262144'
    );
END $$;

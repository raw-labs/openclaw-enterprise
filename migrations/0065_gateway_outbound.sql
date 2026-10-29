CREATE FUNCTION occ.gateway_outbound_is_valid(policy jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE host jsonb; name text; seen text[] := ARRAY[]::text[];
BEGIN
  IF policy IS NULL OR jsonb_typeof(policy) <> 'object' THEN RETURN false; END IF;
  IF policy = '{"mode":"publicHttps"}'::jsonb THEN RETURN true; END IF;
  IF policy->>'mode' IS DISTINCT FROM 'restricted'
    OR policy - 'mode' - 'hosts' <> '{}'::jsonb
    OR jsonb_typeof(policy->'hosts') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(policy->'hosts') > 64 THEN RETURN false; END IF;
  FOR host IN SELECT value FROM jsonb_array_elements(policy->'hosts') LOOP
    IF jsonb_typeof(host) <> 'string' THEN RETURN false; END IF;
    name := host #>> '{}';
    IF length(name) > 253 OR name <> lower(name)
      OR name !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z][a-z0-9-]*[a-z0-9]$'
      OR EXISTS (SELECT 1 FROM unnest(string_to_array(name, '.')) label WHERE length(label) > 63)
      OR name ~ '(^|[.])(localhost|local|internal|home|lan|localdomain|test|invalid|example|onion|arpa|svc|cluster[.]local|example[.](com|net|org)|nip[.]io|sslip[.]io)$'
      OR name = ANY(seen) THEN RETURN false; END IF;
    seen := array_append(seen, name);
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
ALTER TABLE occ.agents ADD COLUMN gateway_outbound jsonb NOT NULL DEFAULT '{"mode":"restricted","hosts":[]}';
--> statement-breakpoint
ALTER TABLE occ.agents ADD CONSTRAINT agents_gateway_outbound_valid CHECK (
  occ.gateway_outbound_is_valid(gateway_outbound) AND
  (execution_mode = 'dedicated' OR gateway_outbound = '{"mode":"restricted","hosts":[]}'::jsonb)
);
--> statement-breakpoint
GRANT UPDATE (gateway_outbound) ON occ.agents TO occ_app;
--> statement-breakpoint
CREATE FUNCTION occ.gateway_outbound_admission_is_valid(admission jsonb, policy jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE ceiling jsonb; destination jsonb; name text;
BEGIN
  IF admission IS NULL OR jsonb_typeof(admission) <> 'object'
    OR NOT (admission ?& ARRAY['ceiling', 'channelDestinations'])
    OR admission - 'ceiling' - 'channelDestinations' <> '{}'::jsonb THEN RETURN false; END IF;
  ceiling := admission->'ceiling';
  IF ceiling IS NULL OR jsonb_typeof(ceiling) <> 'object'
    OR NOT (ceiling ?& ARRAY['allowPublicHttps', 'hosts'])
    OR ceiling - 'allowPublicHttps' - 'hosts' <> '{}'::jsonb
    OR jsonb_typeof(ceiling->'allowPublicHttps') IS DISTINCT FROM 'boolean'
    OR NOT occ.gateway_outbound_is_valid(jsonb_build_object('mode', 'restricted', 'hosts', ceiling->'hosts'))
    OR NOT occ.gateway_outbound_is_valid(policy) THEN RETURN false; END IF;
  IF policy->>'mode' = 'publicHttps' THEN
    IF ceiling->'allowPublicHttps' <> 'true'::jsonb THEN RETURN false; END IF;
  ELSIF NOT ((ceiling->'hosts') @> (policy->'hosts')) THEN RETURN false; END IF;
  IF jsonb_typeof(admission->'channelDestinations') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(admission->'channelDestinations') > 256 THEN RETURN false; END IF;
  FOR destination IN SELECT value FROM jsonb_array_elements(admission->'channelDestinations') LOOP
    IF jsonb_typeof(destination) <> 'object'
      OR NOT (destination ?& ARRAY['host', 'ports', 'protocol'])
      OR destination - 'host' - 'ports' - 'protocol' <> '{}'::jsonb
      OR jsonb_typeof(destination->'host') IS DISTINCT FROM 'string'
      OR destination->'ports' IS DISTINCT FROM '[443]'::jsonb
      OR destination->>'protocol' IS NULL
      OR destination->>'protocol' NOT IN ('https', 'wss') THEN RETURN false; END IF;
    name := destination->>'host';
    IF left(name, 2) = '*.' THEN name := substring(name from 3); END IF;
    IF NOT occ.gateway_outbound_is_valid(jsonb_build_object('mode', 'restricted', 'hosts', jsonb_build_array(name))) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_gateway_outbound_valid CHECK (
  occ.gateway_outbound_is_valid(admitted_spec->'gateway_outbound') AND
  CASE WHEN admitted_spec #>> '{harness,mode}' = 'dedicated' THEN
    occ.gateway_outbound_admission_is_valid(admitted_spec->'gateway_outbound_admission', admitted_spec->'gateway_outbound')
  ELSE NOT (admitted_spec ? 'gateway_outbound_admission') AND admitted_spec->'gateway_outbound' = '{"mode":"restricted","hosts":[]}'::jsonb END
);

--> statement-breakpoint
ALTER TABLE occ.agent_revisions
  DROP CONSTRAINT agent_revisions_admitted_snapshot,
  ADD CONSTRAINT agent_revisions_admitted_snapshot CHECK (
    (admitted_spec ?& ARRAY[
      'configuration_id', 'configuration_kind', 'configuration_generation',
      'draft_spec', 'harness', 'compute', 'harness_auth'
    ])
    AND (admitted_spec
      - 'configuration_id' - 'configuration_kind' - 'configuration_generation'
      - 'draft_spec' - 'harness' - 'compute' - 'sandbox_driver_id' - 'sandbox_policy'
      - 'secret_driver_id' - 'secret_bindings' - 'harness_auth' - 'credential_sources' - 'plugins' - 'plugin_approvers'
      - 'repository_credentials' - 'egress_plan' - 'execution_admission' - 'gateway_outbound' - 'gateway_outbound_admission') = '{}'::jsonb
    AND jsonb_typeof(admitted_spec->'configuration_id') = 'string'
    AND (admitted_spec->>'configuration_id') ~ '^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND jsonb_typeof(admitted_spec->'configuration_kind') = 'string'
    AND (admitted_spec->>'configuration_kind') = 'agent'
    AND jsonb_typeof(admitted_spec->'configuration_generation') = 'number'
    AND (admitted_spec->>'configuration_generation')::numeric BETWEEN 1 AND 9007199254740991
    AND mod((admitted_spec->>'configuration_generation')::numeric, 1) = 0
    AND jsonb_typeof(admitted_spec->'draft_spec') = 'object'
    AND jsonb_typeof(admitted_spec->'harness') = 'object'
    AND ((admitted_spec->'harness') ?& ARRAY['id', 'version', 'mode'])
    AND ((admitted_spec->'harness') - 'id' - 'version' - 'mode') = '{}'::jsonb
    AND jsonb_typeof(admitted_spec #> '{harness,id}') = 'string'
    AND COALESCE(btrim(admitted_spec #>> '{harness,id}'), '') <> ''
    AND jsonb_typeof(admitted_spec #> '{harness,version}') = 'string'
    AND COALESCE(btrim(admitted_spec #>> '{harness,version}'), '') <> ''
    AND jsonb_typeof(admitted_spec #> '{harness,mode}') = 'string'
    AND (admitted_spec #>> '{harness,mode}') IN ('embedded', 'dedicated')
    AND jsonb_typeof(admitted_spec->'compute') = 'object'
    AND ((admitted_spec->'compute') ?& ARRAY['id', 'implementation'])
    AND ((admitted_spec->'compute') - 'id' - 'implementation' - 'admission') = '{}'::jsonb
    AND jsonb_typeof(admitted_spec #> '{compute,id}') = 'string'
    AND COALESCE(btrim(admitted_spec #>> '{compute,id}'), '') <> ''
    AND jsonb_typeof(admitted_spec #> '{compute,implementation}') = 'string'
    AND COALESCE(btrim(admitted_spec #>> '{compute,implementation}'), '') <> ''
    AND (
      NOT ((admitted_spec->'compute') ? 'admission')
      OR (jsonb_typeof(admitted_spec #> '{compute,admission}') = 'string'
          AND char_length(admitted_spec #>> '{compute,admission}') BETWEEN 1 AND 1024
          AND (admitted_spec #>> '{compute,admission}') ~ '^[ -~]+$')
    )
    AND (
      NOT (admitted_spec ? 'sandbox_driver_id')
      OR (
        jsonb_typeof(admitted_spec->'sandbox_driver_id') = 'string'
        AND COALESCE(btrim(admitted_spec->>'sandbox_driver_id'), '') <> ''
      )
    )
    AND (
      NOT (admitted_spec ? 'secret_driver_id')
      OR (
        jsonb_typeof(admitted_spec->'secret_driver_id') = 'string'
        AND COALESCE(btrim(admitted_spec->>'secret_driver_id'), '') <> ''
      )
    )
    AND (
      NOT (admitted_spec ? 'secret_bindings')
      OR occ.secret_bindings_are_valid(admitted_spec->'secret_bindings', namespace_id)
    )
    AND CASE WHEN jsonb_typeof(admitted_spec->'harness_auth') = 'object' THEN
      occ.harness_auth_is_valid((admitted_spec->'harness_auth') - 'protectedExecutionVersion', namespace_id, true)
    ELSE false END
    AND (
      NOT (admitted_spec ? 'repository_credentials')
      OR occ.repository_credentials_are_valid(admitted_spec->'repository_credentials')
    )
    AND (
      NOT (admitted_spec ? 'plugins')
      OR jsonb_typeof(admitted_spec->'plugins') = 'object'
    )
    AND (
      NOT (admitted_spec ? 'plugin_approvers')
      OR (jsonb_typeof(admitted_spec->'plugin_approvers') = 'array'
          AND jsonb_array_length(admitted_spec->'plugin_approvers') <= 64)
    )
    AND (
      NOT (admitted_spec ? 'credential_sources')
      OR occ.credential_source_snapshots_are_valid(admitted_spec->'credential_sources')
    )
  );

--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.gateway_outbound_is_valid(jsonb) TO occ_app;

--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.gateway_outbound_admission_is_valid(jsonb, jsonb) TO occ_app;

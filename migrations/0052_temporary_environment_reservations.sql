-- Draft persistence slice: no provider allocation or capacity release is enabled.
CREATE TABLE occ.temporary_environment_quotas (
  namespace_id text PRIMARY KEY REFERENCES occ.namespaces(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  max_environments integer NOT NULL CHECK (max_environments BETWEEN 1 AND 1000),
  max_cpu_millis integer NOT NULL CHECK (max_cpu_millis > 0),
  max_memory_mib integer NOT NULL CHECK (max_memory_mib > 0),
  reserved_environments integer NOT NULL DEFAULT 0,
  reserved_cpu_millis integer NOT NULL DEFAULT 0,
  reserved_memory_mib integer NOT NULL DEFAULT 0,
  CONSTRAINT temporary_environment_quota_usage_valid CHECK (
    reserved_environments BETWEEN 0 AND max_environments
    AND reserved_cpu_millis BETWEEN 0 AND max_cpu_millis
    AND reserved_memory_mib BETWEEN 0 AND max_memory_mib
  )
);
--> statement-breakpoint
CREATE TABLE occ.temporary_environments (
  id text PRIMARY KEY DEFAULT ('tenv_' || gen_random_uuid()::text),
  namespace_id text NOT NULL REFERENCES occ.temporary_environment_quotas(namespace_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  agent_id text NOT NULL,
  revision_id text NOT NULL,
  service_principal_id text NOT NULL,
  request_id text NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 128 AND request_id ~ '^[A-Za-z0-9]' AND request_id !~ '[^A-Za-z0-9._:-]'),
  profile_id text NOT NULL CHECK (char_length(profile_id) BETWEEN 1 AND 128 AND profile_id ~ '^[A-Za-z0-9]' AND profile_id !~ '[^A-Za-z0-9._:-]'),
  profile_fingerprint text NOT NULL CHECK (char_length(profile_fingerprint) = 64 AND profile_fingerprint !~ '[^a-f0-9]'),
  cpu_millis integer NOT NULL CHECK (cpu_millis > 0),
  memory_mib integer NOT NULL CHECK (memory_mib > 0),
  lifetime_seconds integer NOT NULL CHECK (lifetime_seconds BETWEEN 1 AND 86400),
  state text NOT NULL DEFAULT 'reserved' CHECK (state = 'reserved'),
  created_at timestamptz NOT NULL,
  hard_expires_at timestamptz NOT NULL,
  CONSTRAINT temporary_environments_request_unique UNIQUE (namespace_id, agent_id, request_id),
  CONSTRAINT temporary_environments_revision_owner FOREIGN KEY (namespace_id, agent_id, revision_id)
    REFERENCES occ.agent_revisions(namespace_id, agent_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT temporary_environments_principal_owner FOREIGN KEY (namespace_id, agent_id, service_principal_id)
    REFERENCES occ.iam_identities(namespace_id, agent_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT temporary_environments_deadline_valid CHECK (hard_expires_at = created_at + lifetime_seconds * interval '1 second')
);
--> statement-breakpoint
-- No generic UPDATE/DELETE can change identity, extend deadlines or erase cleanup ownership.
CREATE TRIGGER temporary_environments_immutable BEFORE UPDATE OR DELETE ON occ.temporary_environments
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE FUNCTION occ.reserve_temporary_environment(
  p_namespace_id text, p_agent_id text, p_revision_id text, p_request_id text,
  p_profile_id text, p_profile_fingerprint text, p_cpu_millis integer,
  p_memory_mib integer, p_lifetime_seconds integer
) RETURNS occ.temporary_environments
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
  namespace_status text;
  owner occ.agents%ROWTYPE;
  saved occ.temporary_environments%ROWTYPE;
  admitted_at timestamptz;
BEGIN
  -- Match the existing lifecycle lock order. Stop/deletion cannot race a new reservation.
  SELECT status INTO namespace_status FROM occ.namespaces WHERE id = p_namespace_id FOR UPDATE;
  IF namespace_status IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'Temporary environment Namespace is unavailable' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO owner FROM occ.agents
    WHERE namespace_id = p_namespace_id AND id = p_agent_id FOR UPDATE;
  IF owner.id IS NULL OR owner.status <> 'active' OR owner.desired_runtime_state <> 'running'
    OR owner.active_revision_id IS DISTINCT FROM p_revision_id THEN
    RAISE EXCEPTION 'Temporary environment Agent revision is unavailable' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO saved FROM occ.temporary_environments
    WHERE namespace_id = p_namespace_id AND agent_id = p_agent_id AND request_id = p_request_id;
  IF FOUND THEN
    IF ROW(saved.revision_id, saved.profile_id, saved.profile_fingerprint, saved.cpu_millis, saved.memory_mib, saved.lifetime_seconds)
      IS DISTINCT FROM ROW(p_revision_id, p_profile_id, p_profile_fingerprint, p_cpu_millis, p_memory_mib, p_lifetime_seconds) THEN
      RAISE EXCEPTION 'Temporary environment request identity conflicts' USING ERRCODE = '23505';
    END IF;
    RETURN saved;
  END IF;

  -- A single row update serializes all Agents competing for this Namespace's capacity.
  -- Expired reservations still count. Only a future confirmed-cleanup path may release them.
  UPDATE occ.temporary_environment_quotas SET
    reserved_environments = reserved_environments + 1,
    reserved_cpu_millis = reserved_cpu_millis + p_cpu_millis,
    reserved_memory_mib = reserved_memory_mib + p_memory_mib
  WHERE namespace_id = p_namespace_id
    AND reserved_environments < max_environments
    AND p_cpu_millis <= max_cpu_millis - reserved_cpu_millis
    AND p_memory_mib <= max_memory_mib - reserved_memory_mib;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Temporary environment quota is unavailable or exhausted' USING ERRCODE = '23514';
  END IF;
  admitted_at := clock_timestamp();
  INSERT INTO occ.temporary_environments
    (namespace_id, agent_id, revision_id, service_principal_id, request_id, profile_id,
     profile_fingerprint, cpu_millis, memory_mib, lifetime_seconds, created_at, hard_expires_at)
  VALUES (p_namespace_id, p_agent_id, p_revision_id, owner.service_principal_id, p_request_id,
    p_profile_id, p_profile_fingerprint, p_cpu_millis, p_memory_mib, p_lifetime_seconds,
    admitted_at, admitted_at + p_lifetime_seconds * interval '1 second') RETURNING * INTO saved;
  RETURN saved;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON occ.temporary_environment_quotas, occ.temporary_environments FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT ON occ.temporary_environment_quotas, occ.temporary_environments TO occ_app;
--> statement-breakpoint
GRANT INSERT (namespace_id, max_environments, max_cpu_millis, max_memory_mib),
  UPDATE (max_environments, max_cpu_millis, max_memory_mib)
  ON occ.temporary_environment_quotas TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.reserve_temporary_environment(text,text,text,text,text,text,integer,integer,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.reserve_temporary_environment(text,text,text,text,text,text,integer,integer,integer) TO occ_app;

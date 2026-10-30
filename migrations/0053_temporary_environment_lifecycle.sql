-- Reservations keep immutable owner snapshots; only live ownership links detach on absence.
DROP TRIGGER temporary_environments_immutable ON occ.temporary_environments;
ALTER TABLE occ.temporary_environments
  DROP CONSTRAINT temporary_environments_state_check,
  DROP CONSTRAINT temporary_environments_revision_owner,
  DROP CONSTRAINT temporary_environments_principal_owner,
  ADD COLUMN live_revision_id text,
  ADD COLUMN live_principal_id text,
  ADD COLUMN name text NOT NULL CONSTRAINT temporary_environments_name_check CHECK (length(name) BETWEEN 1 AND 128 AND name ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
  ADD COLUMN slug text NOT NULL CONSTRAINT temporary_environments_slug_check CHECK (length(slug) BETWEEN 1 AND 128 AND slug ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
  ADD COLUMN ssh_public_key text NOT NULL,
  ADD COLUMN idle_timeout_seconds integer NOT NULL CHECK (idle_timeout_seconds BETWEEN 1 AND 86400),
  ADD COLUMN idle_expires_at timestamptz NOT NULL,
  ADD COLUMN allocation_started boolean NOT NULL DEFAULT false,
  ADD COLUMN provider_ref text,
  ADD COLUMN ssh jsonb,
  ADD CONSTRAINT temporary_environments_state_check CHECK (state IN ('reserved','provisioning','ready','deleting','deleted')),
  ADD CONSTRAINT temporary_environments_idle_valid CHECK (idle_expires_at <= hard_expires_at AND idle_expires_at > created_at),
  ADD CONSTRAINT temporary_environments_key_valid CHECK (length(ssh_public_key) BETWEEN 20 AND 16384 AND ssh_public_key !~ E'[\r\n]'),
  ADD CONSTRAINT temporary_environments_revision_owner FOREIGN KEY (namespace_id,agent_id,live_revision_id) REFERENCES occ.agent_revisions(namespace_id,agent_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT temporary_environments_principal_owner FOREIGN KEY (namespace_id,agent_id,live_principal_id) REFERENCES occ.iam_identities(namespace_id,agent_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT temporary_environments_live_owner CHECK (
    (state = 'deleted' AND live_revision_id IS NULL AND live_principal_id IS NULL)
    OR (state <> 'deleted' AND live_revision_id = revision_id AND live_revision_id IS NOT NULL AND live_principal_id = service_principal_id AND live_principal_id IS NOT NULL)),
  ADD CONSTRAINT temporary_environments_ready CHECK (state <> 'ready' OR (allocation_started AND provider_ref IS NOT NULL AND ssh IS NOT NULL)),
  ADD CONSTRAINT temporary_environments_allocation_state CHECK ((state <> 'reserved' OR NOT allocation_started) AND (state NOT IN ('provisioning','ready') OR allocation_started)),
  ADD CONSTRAINT temporary_environments_receipt_valid CHECK (provider_ref IS NULL OR length(provider_ref) BETWEEN 1 AND 16384),
  ADD CONSTRAINT temporary_environments_ssh_valid CHECK (ssh IS NULL OR (jsonb_typeof(ssh)='object' AND ssh ?& ARRAY['host','port','user'] AND (ssh - 'host' - 'port' - 'user')='{}'::jsonb AND jsonb_typeof(ssh->'host')='string' AND length(ssh->>'host') BETWEEN 1 AND 253 AND jsonb_typeof(ssh->'user')='string' AND length(ssh->>'user') BETWEEN 1 AND 64 AND jsonb_typeof(ssh->'port')='number' AND (ssh->>'port') ~ '^[0-9]{1,5}$' AND (ssh->>'port')::integer BETWEEN 1 AND 65535));
--> statement-breakpoint
-- Existing reservations are development-only; no fabricated SSH key or replacement allocation.
-- A nonempty old table makes this migration fail explicitly at the required columns above.
ALTER TABLE occ.controller_work DROP CONSTRAINT controller_work_kind_valid,
  ADD CONSTRAINT controller_work_kind_valid CHECK (work_kind IN ('lifecycle','provisioning','temporary_environment'));
ALTER TABLE occ.controller_work DROP CONSTRAINT controller_work_namespace_target_valid,
  ADD CONSTRAINT controller_work_namespace_target_valid CHECK (
    (work_kind = 'temporary_environment' AND agent_id IS NULL AND revision_id IS NULL AND namespace_target IS NULL AND agent_target IS NULL AND idempotency_key ~ '^temporary_environment:tenv_[0-9a-f-]{36}$')
    OR (work_kind = 'lifecycle' AND agent_id IS NULL AND revision_id IS NULL AND namespace_target IN ('ready','deleted') AND namespace_target IS NOT NULL AND agent_target IS NULL)
    OR (work_kind = 'lifecycle' AND agent_id IS NOT NULL AND revision_id IS NULL AND namespace_target IS NULL AND agent_target IN ('stopped','deleted') AND agent_target IS NOT NULL)
    OR (work_kind = 'lifecycle' AND agent_id IS NOT NULL AND revision_id IS NOT NULL AND namespace_target IS NULL AND (agent_target IS NULL OR agent_target = 'credentials_withdrawn'))
    OR (work_kind = 'provisioning' AND agent_id IS NULL AND revision_id IS NULL AND namespace_target IS NULL AND agent_target IS NULL)
    OR (work_kind = 'lifecycle' AND agent_id IS NULL AND revision_id IS NULL AND namespace_target IS NULL AND agent_target IS NULL AND idempotency_key ~ '^agent_revision:rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:repository_cleanup:(retire:)?[0-9a-f]{64}$')
  );
--> statement-breakpoint
CREATE FUNCTION occ.guard_temporary_environment() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog,occ,pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Temporary environment evidence is retained' USING ERRCODE='23514'; END IF;
  IF OLD.state = 'deleted' OR
    (to_jsonb(NEW) - ARRAY['state','idle_expires_at','allocation_started','provider_ref','ssh','live_revision_id','live_principal_id']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['state','idle_expires_at','allocation_started','provider_ref','ssh','live_revision_id','live_principal_id'])
    OR (OLD.allocation_started AND NOT NEW.allocation_started)
    OR (OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref)
    OR (OLD.state = 'deleting' AND NEW.state NOT IN ('deleting','deleted'))
    OR (OLD.state = 'provisioning' AND NEW.state = 'reserved')
    OR (OLD.state = 'ready' AND NEW.state NOT IN ('ready','deleting'))
    OR (NEW.state = 'deleted' AND OLD.state <> 'deleting') THEN
    RAISE EXCEPTION 'Temporary environment evidence is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER temporary_environments_guard BEFORE UPDATE OR DELETE ON occ.temporary_environments FOR EACH ROW EXECUTE FUNCTION occ.guard_temporary_environment();
--> statement-breakpoint
DROP FUNCTION occ.reserve_temporary_environment(text,text,text,text,text,text,integer,integer,integer);
CREATE FUNCTION occ.reserve_temporary_environment(
 p_namespace_id text,p_agent_id text,p_revision_id text,p_request_id text,p_profile_id text,p_profile_fingerprint text,
 p_cpu_millis integer,p_memory_mib integer,p_lifetime_seconds integer,p_ssh_public_key text,p_idle_timeout_seconds integer,p_name text,p_slug text
) RETURNS occ.temporary_environments LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,occ,pg_temp AS $$
DECLARE owner occ.agents%ROWTYPE; saved occ.temporary_environments%ROWTYPE; namespace_status text; admitted_at timestamptz;
BEGIN
 SELECT status INTO namespace_status FROM occ.namespaces WHERE id=p_namespace_id FOR UPDATE;
 SELECT * INTO owner FROM occ.agents WHERE namespace_id=p_namespace_id AND id=p_agent_id FOR UPDATE;
 SELECT * INTO saved FROM occ.temporary_environments WHERE namespace_id=p_namespace_id AND agent_id=p_agent_id AND request_id=p_request_id FOR UPDATE;
 IF FOUND THEN
  IF ROW(saved.revision_id,saved.profile_id,saved.profile_fingerprint,saved.cpu_millis,saved.memory_mib,saved.lifetime_seconds,saved.ssh_public_key,saved.idle_timeout_seconds,saved.name,saved.slug)
   IS DISTINCT FROM ROW(p_revision_id,p_profile_id,p_profile_fingerprint,p_cpu_millis,p_memory_mib,p_lifetime_seconds,p_ssh_public_key,p_idle_timeout_seconds,p_name,p_slug) THEN
   RAISE EXCEPTION 'Temporary environment request identity conflicts' USING ERRCODE='23505';
  END IF;
  RETURN saved;
 END IF;
 IF namespace_status IS DISTINCT FROM 'ready' OR owner.id IS NULL OR owner.status <> 'active' OR owner.desired_runtime_state <> 'running' OR owner.active_revision_id IS DISTINCT FROM p_revision_id THEN
  RAISE EXCEPTION 'Temporary environment Agent revision is unavailable' USING ERRCODE='23514';
 END IF;
 UPDATE occ.temporary_environment_quotas SET reserved_environments=reserved_environments+1,reserved_cpu_millis=reserved_cpu_millis+p_cpu_millis,reserved_memory_mib=reserved_memory_mib+p_memory_mib
 WHERE namespace_id=p_namespace_id AND reserved_environments<max_environments AND p_cpu_millis<=max_cpu_millis-reserved_cpu_millis AND p_memory_mib<=max_memory_mib-reserved_memory_mib;
 IF NOT FOUND THEN RAISE EXCEPTION 'Temporary environment quota is unavailable or exhausted' USING ERRCODE='23514'; END IF;
 admitted_at:=clock_timestamp();
 INSERT INTO occ.temporary_environments(namespace_id,agent_id,revision_id,service_principal_id,live_revision_id,live_principal_id,request_id,profile_id,profile_fingerprint,cpu_millis,memory_mib,lifetime_seconds,ssh_public_key,idle_timeout_seconds,name,slug,created_at,hard_expires_at,idle_expires_at)
 VALUES(p_namespace_id,p_agent_id,p_revision_id,owner.service_principal_id,p_revision_id,owner.service_principal_id,p_request_id,p_profile_id,p_profile_fingerprint,p_cpu_millis,p_memory_mib,p_lifetime_seconds,p_ssh_public_key,p_idle_timeout_seconds,p_name,p_slug,admitted_at,admitted_at+p_lifetime_seconds*interval '1 second',admitted_at+LEAST(p_idle_timeout_seconds,p_lifetime_seconds)*interval '1 second') RETURNING * INTO saved;
 INSERT INTO occ.controller_work(work_kind,idempotency_key,namespace_id,actor_id,state,available_at,attempt_count,created_at,updated_at)
 VALUES('temporary_environment','temporary_environment:'||saved.id,p_namespace_id,owner.service_principal_id,'queued',admitted_at,0,admitted_at,admitted_at);
 RETURN saved;
END $$;
--> statement-breakpoint
CREATE FUNCTION occ.request_temporary_environment(p_namespace_id text,p_agent_id text,p_request_id text,p_action text)
RETURNS occ.temporary_environments LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,occ,pg_temp AS $$
DECLARE saved occ.temporary_environments%ROWTYPE;
BEGIN
 PERFORM 1 FROM occ.namespaces WHERE id=p_namespace_id FOR UPDATE;
 PERFORM 1 FROM occ.agents WHERE namespace_id=p_namespace_id AND id=p_agent_id FOR UPDATE;
 SELECT * INTO saved FROM occ.temporary_environments WHERE namespace_id=p_namespace_id AND agent_id=p_agent_id AND request_id=p_request_id FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF p_action='touch' THEN
  IF saved.state IN ('deleting','deleted') OR saved.idle_expires_at<=clock_timestamp() OR saved.hard_expires_at<=clock_timestamp() THEN RETURN NULL; END IF;
  UPDATE occ.temporary_environments SET idle_expires_at=LEAST(hard_expires_at,clock_timestamp()+idle_timeout_seconds*interval '1 second') WHERE id=saved.id RETURNING * INTO saved;
 ELSIF p_action='delete' THEN
  IF saved.state NOT IN ('deleting','deleted') THEN UPDATE occ.temporary_environments SET state='deleting' WHERE id=saved.id RETURNING * INTO saved; END IF;
  UPDATE occ.controller_work SET available_at=clock_timestamp(),updated_at=clock_timestamp() WHERE idempotency_key='temporary_environment:'||saved.id AND state='queued';
 ELSE RAISE EXCEPTION 'Unsupported temporary environment action' USING ERRCODE='23514'; END IF;
 RETURN saved;
END $$;
--> statement-breakpoint
CREATE FUNCTION occ.reconcile_temporary_environment(p_work text,p_token uuid,p_id text,p_action text,p_observation jsonb DEFAULT NULL)
RETURNS occ.temporary_environments LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,occ,pg_temp AS $$
DECLARE saved occ.temporary_environments%ROWTYPE; owner occ.agents%ROWTYPE; namespace_status text;
BEGIN
 SELECT * INTO saved FROM occ.temporary_environments WHERE id=p_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 -- Every transition locks Namespace, Agent, record, then quota and work, in that order.
 SELECT status INTO namespace_status FROM occ.namespaces WHERE id=saved.namespace_id FOR UPDATE;
 SELECT * INTO owner FROM occ.agents WHERE namespace_id=saved.namespace_id AND id=saved.agent_id FOR UPDATE;
 SELECT * INTO saved FROM occ.temporary_environments WHERE id=p_id FOR UPDATE;
 PERFORM 1 FROM occ.temporary_environment_quotas WHERE namespace_id=saved.namespace_id FOR UPDATE;
 PERFORM 1 FROM occ.controller_work WHERE idempotency_key=p_work AND p_work='temporary_environment:'||p_id AND work_kind='temporary_environment' AND namespace_id=saved.namespace_id AND state='claimed' AND claim_token=p_token AND lease_expires_at>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF saved.state='deleted' THEN RETURN saved; END IF;
 IF saved.state <> 'deleting' AND (namespace_status IS DISTINCT FROM 'ready' OR owner.id IS NULL OR owner.status <> 'active' OR owner.desired_runtime_state <> 'running' OR owner.active_revision_id IS DISTINCT FROM saved.revision_id OR owner.service_principal_id IS DISTINCT FROM saved.service_principal_id OR saved.idle_expires_at<=clock_timestamp() OR saved.hard_expires_at<=clock_timestamp()) THEN
  UPDATE occ.temporary_environments SET state='deleting' WHERE id=p_id RETURNING * INTO saved;
 END IF;
 IF p_action='beginAllocation' THEN
  IF saved.state <> 'reserved' OR saved.allocation_started THEN RETURN NULL; END IF;
  UPDATE occ.temporary_environments SET allocation_started=true,state='provisioning' WHERE id=p_id RETURNING * INTO saved;
 ELSIF p_action='delete' THEN
  UPDATE occ.temporary_environments SET state='deleting' WHERE id=p_id RETURNING * INTO saved;
 ELSIF p_action='confirmAbsent' THEN
  IF saved.state <> 'deleting' THEN RAISE EXCEPTION 'Cleanup must be requested first' USING ERRCODE='23514'; END IF;
  UPDATE occ.temporary_environment_quotas SET reserved_environments=reserved_environments-1,reserved_cpu_millis=reserved_cpu_millis-saved.cpu_millis,reserved_memory_mib=reserved_memory_mib-saved.memory_mib WHERE namespace_id=saved.namespace_id;
  UPDATE occ.temporary_environments SET state='deleted',live_revision_id=NULL,live_principal_id=NULL WHERE id=p_id RETURNING * INTO saved;
 ELSIF p_action <> 'inspect' THEN RAISE EXCEPTION 'Unsupported temporary environment action' USING ERRCODE='23514'; END IF;
 IF p_observation IS NOT NULL AND saved.state <> 'deleted' AND p_observation->>'state' IN ('pending','ready') THEN
  IF saved.provider_ref IS NOT NULL AND p_observation ? 'providerRef' AND saved.provider_ref IS DISTINCT FROM p_observation->>'providerRef' THEN
   RAISE EXCEPTION 'Temporary environment provider identity changed' USING ERRCODE='23514';
  END IF;
  UPDATE occ.temporary_environments SET provider_ref=COALESCE(provider_ref,p_observation->>'providerRef'),
   ssh=CASE WHEN state <> 'deleting' AND p_observation->>'state'='ready' THEN p_observation->'ssh' ELSE ssh END,
   state=CASE WHEN state <> 'deleting' AND p_observation->>'state'='ready' THEN 'ready' ELSE state END
  WHERE id=p_id RETURNING * INTO saved;
 END IF;
 RETURN saved;
END $$;
--> statement-breakpoint
-- Lifecycle changes wake the existing obligation; they never perform provider effects or release usage.
CREATE FUNCTION occ.wake_temporary_environment_cleanup() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,occ,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='agents' THEN
  IF NEW.status='active' AND NEW.desired_runtime_state='running' AND NEW.active_revision_id IS NOT DISTINCT FROM OLD.active_revision_id THEN RETURN NEW; END IF;
  UPDATE occ.temporary_environments SET state='deleting' WHERE namespace_id=NEW.namespace_id AND agent_id=NEW.id AND state NOT IN ('deleting','deleted') AND (NEW.status<>'active' OR NEW.desired_runtime_state<>'running' OR revision_id IS DISTINCT FROM NEW.active_revision_id);
  UPDATE occ.controller_work SET available_at=clock_timestamp(),updated_at=clock_timestamp() WHERE state='queued' AND work_kind='temporary_environment' AND idempotency_key IN (SELECT 'temporary_environment:'||id FROM occ.temporary_environments WHERE namespace_id=NEW.namespace_id AND agent_id=NEW.id AND state='deleting');
 ELSE
  IF NEW.status='ready' THEN RETURN NEW; END IF;
  PERFORM 1 FROM occ.agents WHERE namespace_id=NEW.id ORDER BY id FOR UPDATE;
  UPDATE occ.temporary_environments SET state='deleting' WHERE namespace_id=NEW.id AND state NOT IN ('deleting','deleted');
  UPDATE occ.controller_work SET available_at=clock_timestamp(),updated_at=clock_timestamp() WHERE namespace_id=NEW.id AND state='queued' AND work_kind='temporary_environment';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER temporary_environment_agent_cleanup AFTER UPDATE OF status,desired_runtime_state,active_revision_id ON occ.agents FOR EACH ROW EXECUTE FUNCTION occ.wake_temporary_environment_cleanup();
CREATE TRIGGER temporary_environment_namespace_cleanup AFTER UPDATE OF status ON occ.namespaces FOR EACH ROW EXECUTE FUNCTION occ.wake_temporary_environment_cleanup();
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.reserve_temporary_environment(text,text,text,text,text,text,integer,integer,integer,text,integer,text,text),occ.request_temporary_environment(text,text,text,text),occ.reconcile_temporary_environment(text,uuid,text,text,jsonb),occ.guard_temporary_environment(),occ.wake_temporary_environment_cleanup() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION occ.reserve_temporary_environment(text,text,text,text,text,text,integer,integer,integer,text,integer,text,text),occ.request_temporary_environment(text,text,text,text),occ.reconcile_temporary_environment(text,uuid,text,text,jsonb) TO occ_app;

--> statement-breakpoint
-- Generic queue callers cannot abandon a provider obligation.
CREATE FUNCTION occ.guard_temporary_environment_work() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,occ,pg_temp AS $$
BEGIN
 IF NEW.work_kind='temporary_environment' AND (NEW.state='failed_permanent' OR (NEW.state='succeeded' AND NOT EXISTS (SELECT 1 FROM occ.temporary_environments WHERE 'temporary_environment:'||id=NEW.idempotency_key AND state='deleted'))) THEN
  RAISE EXCEPTION 'Temporary environment cleanup remains pending' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER temporary_environment_work_guard BEFORE UPDATE ON occ.controller_work FOR EACH ROW EXECUTE FUNCTION occ.guard_temporary_environment_work();
REVOKE ALL ON FUNCTION occ.guard_temporary_environment_work() FROM PUBLIC;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.finalize_agent_deletion(
  p_namespace_id text,
  p_agent_id text,
  p_idempotency_key text,
  p_claim_token uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
  v_service_principal_id text;
  v_actor_id text;
  v_attempt_count integer;
BEGIN
  PERFORM namespace.id FROM occ.namespaces AS namespace
  WHERE namespace.id = p_namespace_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT agent.service_principal_id
    INTO v_service_principal_id
  FROM occ.agents AS agent
  WHERE agent.namespace_id = p_namespace_id
    AND agent.id = p_agent_id
    AND agent.status = 'deleting'
    AND agent.desired_runtime_state = 'stopped'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT work.actor_id, work.attempt_count
    INTO v_actor_id, v_attempt_count
  FROM occ.controller_work AS work
  WHERE work.idempotency_key = p_idempotency_key
    AND work.namespace_id = p_namespace_id
    AND work.agent_id = p_agent_id
    AND work.revision_id IS NULL
    AND work.agent_target = 'deleted'
    AND work.work_kind = 'lifecycle'
    AND work.state = 'claimed'
    AND work.claim_token = p_claim_token
    AND work.lease_expires_at > pg_catalog.clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM attempt.admission_id FROM occ.repository_session_attempts AS attempt
  WHERE attempt.namespace_id = p_namespace_id AND attempt.agent_id = p_agent_id
  ORDER BY attempt.revision_id, attempt.admission_id FOR UPDATE;

  -- Revalidate lease time after every potentially blocking ownership lock.
  IF NOT EXISTS (
    SELECT 1 FROM occ.controller_work AS work
    WHERE work.idempotency_key = p_idempotency_key AND work.claim_token = p_claim_token
      AND work.state = 'claimed' AND work.lease_expires_at > pg_catalog.clock_timestamp()
  ) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM occ.agent_provisioning_work AS provisioning
    JOIN occ.controller_work AS work ON work.idempotency_key = provisioning.work_id
    WHERE provisioning.namespace_id = p_namespace_id
      AND provisioning.agent_id = p_agent_id
      AND (
        (
          provisioning.progress ? 'pendingEffect'
          AND NOT (
            provisioning.progress ? 'effectReceipt'
            AND provisioning.progress->'effectReceipt'->>'kind' =
              provisioning.progress->'pendingEffect'->>'kind'
            AND provisioning.progress->'effectReceipt'->>'owner' =
              provisioning.progress->'pendingEffect'->>'owner'
            AND provisioning.progress->'effectReceipt'->>'targetId' =
              provisioning.progress->'pendingEffect'->>'targetId'
          )
        )
        OR (
          provisioning.progress ? 'effectReceipt'
          AND NOT (provisioning.progress ? 'pendingEffect')
        )
        OR provisioning.status IN ('queued', 'running')
        OR work.state IN ('queued', 'claimed')
      )
  ) THEN
    RETURN NULL;
  END IF;

  -- Keep live FKs until the selected Driver confirms full absence.
  IF EXISTS (SELECT 1 FROM occ.temporary_environments WHERE namespace_id=p_namespace_id AND agent_id=p_agent_id AND state<>'deleted') THEN
    RETURN NULL;
  END IF;

  UPDATE occ.repository_session_attempts SET live_revision_id = NULL
  WHERE namespace_id = p_namespace_id AND agent_id = p_agent_id
    AND live_revision_id IS NOT NULL;

  UPDATE occ.controller_work AS work
  SET agent_id = NULL,
      revision_id = NULL,
      updated_at = pg_catalog.clock_timestamp()
  WHERE work.namespace_id = p_namespace_id
    AND work.agent_id = p_agent_id
    AND work.revision_id IS NOT NULL
    AND work.namespace_target IS NULL
    AND work.agent_target IS NULL
    AND work.revision_id ~ '^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND work.idempotency_key ~ (
      '^agent_revision:' || work.revision_id ||
      ':repository_cleanup:(retire:)?[0-9a-f]{64}$'
    );

  UPDATE occ.agents
  SET active_revision_id = NULL
  WHERE namespace_id = p_namespace_id AND id = p_agent_id;

  DELETE FROM occ.iam_access_bindings AS binding
  WHERE binding.identity_subject_id = v_service_principal_id
    OR (binding.resource_kind = 'agent' AND binding.resource_id = p_agent_id)
    OR (binding.resource_kind = 'agent_revision' AND binding.resource_id IN (
      SELECT revision.id FROM occ.agent_revisions AS revision
      WHERE revision.namespace_id = p_namespace_id AND revision.agent_id = p_agent_id
    ));

  DELETE FROM occ.iam_restrictions AS restriction
  WHERE (restriction.resource_kind = 'agent' AND restriction.resource_id = p_agent_id)
    OR (restriction.resource_kind = 'agent_revision' AND restriction.resource_id IN (
      SELECT revision.id FROM occ.agent_revisions AS revision
      WHERE revision.namespace_id = p_namespace_id AND revision.agent_id = p_agent_id
    ));

  DELETE FROM occ.apikey WHERE reference_id = v_service_principal_id;
  DELETE FROM occ.controller_work AS work
  USING occ.agent_provisioning_work AS provisioning
  WHERE work.idempotency_key = provisioning.work_id
    AND provisioning.namespace_id = p_namespace_id
    AND provisioning.agent_id = p_agent_id
    AND work.work_kind = 'provisioning';
  DELETE FROM occ.agent_revisions
    WHERE namespace_id = p_namespace_id AND agent_id = p_agent_id;
  DELETE FROM occ.iam_identities
    WHERE id = v_service_principal_id
      AND namespace_id = p_namespace_id
      AND agent_id = p_agent_id
      AND kind = 'service_principal';
  DELETE FROM occ.agents
    WHERE namespace_id = p_namespace_id AND id = p_agent_id;

  INSERT INTO occ.audit_events (
    id, occurred_at, kind, actor_id, action, namespace_id,
    resource_kind, resource_id, outcome, details
  ) VALUES (
    'aud_' || pg_catalog.gen_random_uuid()::text,
    pg_catalog.clock_timestamp(),
    'mutation',
    v_actor_id,
    'openclaw.agents.lifecycle.delete',
    p_namespace_id,
    'agent',
    p_agent_id,
    'success',
    pg_catalog.jsonb_build_object(
      'reasonCode', 'AGENT_DELETED',
      'attemptCount', v_attempt_count
    )
  );

  DELETE FROM occ.controller_work
  WHERE namespace_id = p_namespace_id AND agent_id = p_agent_id;
  RETURN true;
END;
$$;

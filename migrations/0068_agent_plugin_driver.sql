ALTER TABLE occ.agents ADD COLUMN plugin_driver jsonb;
--> statement-breakpoint
-- Recover ownership from this Agent's admitted deployments, never from a bundled
-- catalog default. Ambiguous or missing evidence remains NULL and fails validation.
UPDATE occ.agents AS agent
SET plugin_driver = (
  SELECT (jsonb_agg(DISTINCT revision.admitted_spec #> '{plugins,driver}'))->0
  FROM occ.agent_revisions AS revision
  WHERE revision.agent_id = agent.id AND revision.namespace_id = agent.namespace_id
    AND jsonb_typeof(revision.admitted_spec #> '{plugins,driver}') = 'object'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_object_keys(agent.plugins) AS selection(id)
      WHERE NOT starts_with(selection.id, (revision.admitted_spec #>> '{plugins,driver,id}') || ':')
    )
  HAVING count(DISTINCT revision.admitted_spec #> '{plugins,driver}') = 1
)
WHERE coalesce(agent.plugins, '{}'::jsonb) <> '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE occ.agents
  ADD CONSTRAINT agents_plugin_driver_selection CHECK (
    CASE WHEN coalesce(plugins, '{}'::jsonb) = '{}'::jsonb THEN plugin_driver IS NULL
    ELSE plugin_driver IS NOT NULL
      AND jsonb_typeof(plugin_driver) = 'object'
      AND plugin_driver ?& ARRAY['id', 'implementation']
      AND (plugin_driver - 'id' - 'implementation') = '{}'::jsonb
      AND jsonb_typeof(plugin_driver->'id') = 'string'
      AND jsonb_typeof(plugin_driver->'implementation') = 'string'
      AND (plugin_driver->>'id') ~ '[^[:space:]]'
      AND (plugin_driver->>'implementation') ~ '[^[:space:]]'
    END
  );
--> statement-breakpoint
GRANT UPDATE (plugin_driver) ON occ.agents TO occ_app;

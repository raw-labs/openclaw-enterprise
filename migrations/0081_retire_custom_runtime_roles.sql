-- Remove obsolete per-person runtime assignments without granting broader Agent authority.
-- Existing operate/administer grants remain the only source of upstream browser access.
DELETE FROM occ.iam_access_bindings WHERE runtime_role IS NOT NULL;
--> statement-breakpoint
DROP TRIGGER iam_runtime_assignment_is_valid ON occ.iam_access_bindings;
--> statement-breakpoint
DROP FUNCTION occ.validate_runtime_assignment();
--> statement-breakpoint
ALTER TABLE occ.iam_access_bindings DROP COLUMN runtime_role;
--> statement-breakpoint
UPDATE occ.iam_roles AS role SET permissions = (
  SELECT COALESCE(jsonb_agg(permission ORDER BY ordinality), '[]'::jsonb)
  FROM jsonb_array_elements(role.permissions) WITH ORDINALITY AS grants(permission, ordinality)
  WHERE permission->>'action' <> 'use'
) WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(role.permissions) permission WHERE permission->>'action' = 'use'
);
--> statement-breakpoint
DELETE FROM occ.iam_restrictions WHERE action = 'use';
--> statement-breakpoint
ALTER TABLE occ.iam_restrictions DROP CONSTRAINT iam_restrictions_action_valid;
--> statement-breakpoint
ALTER TABLE occ.iam_restrictions ADD CONSTRAINT iam_restrictions_action_valid CHECK (
  action IN ('create', 'read', 'update', 'delete', 'deploy', 'operate', 'administer', 'read_logs', 'manage_policy')
);

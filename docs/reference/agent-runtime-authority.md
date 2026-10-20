# Native Gateway authority and managed configuration

With configured roles, the native Gateway sees `oce:<Principal ID>`, a stable account identifier verified against the OCE session, and the server-selected role. It finds or creates that native profile and commits the named role before admitting its connection. The proxy also supplies a SHA-256 digest of the role definition; missing roles or changed native definitions reject admission. Browser-supplied identity, role, policy-digest and scope headers are discarded.

For native authenticated HTTP, creating a profile or changing its role retires the authority captured before acquisition. That request returns `401` before the handler runs; a separate request uses the committed role. OCC never automatically replays an HTTP write. WebSocket admission acquires authority after role publication.

Saved `gateway.roles` defines assignable roles; the active revision defines deployed policy. Compute owns the built-in administrator policy. The exact human/Agent AccessBinding stores `runtimeRole`. Native edits cannot change that assignment: the next admission reapplies it. Profiles linked to multiple OCE people cannot admit them as one person.

The [runtime-role catalog](api.md#get-namespacesnamespaceidagentsagentidruntimeroles) returns saved Configuration ID/generation, assignable roles, runtime state and optional deployed summaries, including before deployment and while stopped. Administrators create/change assignments with `runtimeRole` and the catalog’s `configuration` as `runtimeRoleConfiguration`; PATCH preserves binding identity, DELETE revokes entry. Stale Configuration returns `409`; unknown roles return `400`. Definitions require deployment; missing deployed roles deny entry. One direct person/Agent assignment is allowed; groups, services, broad bindings and Installation administration select no native role.

Kubernetes configures `gateway.auth.trustedProxy.managedIdentityPrefixes: ["oce:"]` and `managedIdentities: ["occ-workspace-files"]`. The bridge refuses undeclared identities and profiles with multiple managed identities. Selectors must be nonempty, trimmed lowercase values; role headers require at least one prefix or exact identity. Compute rejects conflicts.

Kubernetes retains the separate `occ-workspace-files` identity with the reserved `oce-service` role for server operations. The role catalog excludes that reserved role. OCE core consumes opaque role names and Compute descriptors; native profile details stay in the runtime and Driver.

Policy digests use SHA-256 of UTF-8 JSON role definitions, recursively sorting object keys with English locale comparison and preserving array order. Driver and runtime use identical rules. Digests check policy agreement; trusted-proxy authentication establishes authority.

Manage durable configuration through OCE. Native edits change a Pod-local copy outside AgentRevisions; Pod recreation or redeployment restores the managed snapshot.
See [Kubernetes managed native configuration](drivers/kubernetes-compute/storage-and-credentials.md#managed-native-configuration)
for the opt-in predicate, mounts, and copy lifecycle.

Do not change `gateway.bind`, `gateway.customBindHost`, or
`gateway.tailscale.mode` in that copy. OCE checks these listener settings in the
managed Configuration at deployment, not after a native edit. The edit
survives same-Pod restarts. With `loopback`, the Gateway stays Ready, because its
readiness check uses loopback, but refuses traffic to the Pod IP: the native
admin UI goes dark and cannot undo the edit. With Tailscale `serve` or `funnel`
and the rendered `lan` bind, native startup fails and the container restarts in
a loop. To
recover, delete the Pod or redeploy the Agent.

Redeployment does not imply a factory reset of native files, conversations,
device state, plugins, or other persistent gateway data.

## Related

- [Agent native admin UI](agent-native-admin.md)
- [Agent sharing](../guides/console/agent-sharing.md)

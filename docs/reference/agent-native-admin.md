# Agent native admin UI

Agent OpenClaw access gives explicitly assigned people their configured runtime permissions. OCE controls entry and assignments; OpenClaw enforces role permissions. Files, plugins and provider accounts remain shared.

The feature is disabled by default. Disabled status needs exact Agent `administer`; enabled access needs a human session, exact Agent `use` and a direct person/Agent `runtimeRole`. The **OpenClaw** panel opens the serving Gateway through OCC using the ordinary shared OCE session cookie. Unassigned Installation administrators see an assignment hint and **Refresh access**.

## Who can open it

OCE Agent management and OpenClaw entry are separate permissions. Existing effective human administrators receive explicit `platform-administrator` assignments, including Installation, Namespace-group and exact-Agent grants. Denied administrators and service identities are excluded. Group-derived assignments become individual grants managed in Sharing. Downgrading or removing an assignment does not remove OCE administration or restore entry through old grants.

Kubernetes reserves `platform-administrator` for full native access. Without `gateway.roles`, it retains the shared administrator transport/profile, including running Gateways. Configured roles use individual profiles and a Driver-owned administrator policy. Other roles require configured definitions and qualified human transport; the reserved policy cannot be overridden.

GitHub, Google and OIDC sign-in reject native admin enablement. Their HTTPS `__Host-openclaw_occ.session_token` cookie cannot carry the Domain attribute needed by Agent hosts. See [shared sessions](authentication.md#native-admin-shared-sessions).

## Requirements

- `agentNativeAdmin.enabled: true` in Helm, which sets `OCC_AGENT_NATIVE_ADMIN_ENABLED=true` on the API and worker.
- `agentNativeAdmin.domain` set to the Agent host suffix, such as `agents.oce.example.com`, without scheme, wildcard, port, or path. Helm passes it as `OCC_AGENT_NATIVE_ADMIN_DOMAIN`. Use a previously unused DNS suffix for the first pilot rollout; the proxy blocks new service-worker registration but does not evict service workers that a prior experiment registered on the same origin.
- `agentNativeAdmin.sharedCookieDomain` set to the explicit shared OCE session cookie parent domain, such as `oce.example.com`. Helm passes it as `OCC_AUTH_COOKIE_DOMAIN` when `agentNativeAdmin.enabled` is true. The console host and Agent host suffix must both be inside this parent on DNS-label boundaries. Public suffixes, malformed domains, and DNS-label boundary violations fail closed. Helm has no public suffix list, so it renders a suffix such as `co.uk` or `github.io`; the installation profile renderer refuses it, and so does API startup (`AUTH_BASE_URL_INVALID`). The Agent suffix may equal the cookie domain; OCC excludes its configured Console hostname from native proxy routing.
- `gatewayRouting.enabled: true`. Helm rejects native admin enablement without private gateway routing because the API process must reach each Agent gateway through the private route.
- `OCC_AUTH_BASE_URL` on API and worker set to the public OCC origin that serves the console, for example `https://console.oce.example.com`.
- Better Auth cookie configuration using the shared cookie parent domain while preserving `Secure`, `HttpOnly`, appropriate `SameSite`, CSRF, and trusted-origin protections. A domain-scoped cookie cannot use a host-only `__Host-` prefix. The shared-domain session uses the `openclaw_occ_shared` cookie prefix and clears prior host-only `openclaw_occ` and `openclaw_occ_shared` session-cookie names during sign-in/sign-out migration. When native admin is disabled, OCC ignores leftover shared-cookie-domain configuration and keeps the legacy host-only `openclaw_occ` session cookie scope.
- Private Agent gateway routing configured through [Gateway routing with Envoy](gateway-routing.md).
- The Agent must be running, have an active revision, and provide the Compute Driver's human-access descriptor for the selected role and active revision.
- Configured roles require the [runtime proxy-role bridge](../../deploy/runtime/README.md); unpatched runtimes reject them. Save and deploy `gateway.roles` with default/named definitions before use. The role-free built-in administrator needs no bridge. Canonical native Agent IDs and de-duplicated scope/agent arrays are required; normalization mismatches fail the policy-digest check.
- The native Agent configuration must keep the trusted-proxy `occ-workspace-files` identity with `operator.admin`, enable native `controlUi`, allow the derived Agent origin, and enable trusted-proxy device auto-approval with every scope used by the selected role. The support check rejects token auth, disabled device auth, and host-header origin fallback.

## First-deployment configuration

With the Installation feature and private Kubernetes gateway routing enabled,
OCC prepares native admin access when `gateway.controlUi.enabled` is `true`.
The Standard OpenClaw and Standard Codex Presets already select this setting.
At deployment admission, Kubernetes Compute adds its trusted-proxy service
identity, administrator device approval, the exact Agent `allowedOrigins` entry,
and `gateway.publicOrigin`. OCC derives the origin from the Installation,
Namespace and allocated Agent identities, retaining the configured public scheme
and port. Guided dedicated provisioning uses the same admission path after
allocating its Agent identity.

The immutable revision contains the effective policy; the reusable Configuration
and its generation stay unchanged. Agents sharing one Configuration receive
separate origins. Redeploying does not accumulate sibling origins. Existing
Agents adopt this behavior on their next explicit deployment; OCC does not
rewrite active or historical revisions or start a rollout.

Disabled or omitted `controlUi.enabled`, disabled `deviceAutoApprove.enabled`,
and disabled Installation access leave the native policy unprepared. Unsafe
device-auth or host-header fallback settings do not enable managed access.
Conflicting authentication, approval scopes, `publicOrigin`, wildcard origins,
or another origin inside the Installation's Agent domain refuse deployment with
a setting-specific message. Omit managed origins from reusable Configurations.
Compatible password SecretRefs, loopback policy, other exact origins, model,
Harness, plugin settings and Secret bindings are preserved. Drivers without the
admission hook retain their existing availability requirements.

This enables the existing full native administrator surface, including its
native terminal where supported. It adds no OCE grants and does not change
native tool restrictions or support external-sign-in profiles.

The local Compose-control-plane profile enables this capability only when both
Kubernetes Compute and OpenShell are selected. Its development proxy terminates
HTTPS on host loopback for the installation's console and wildcard Agent hosts;
the private Envoy route in k3d still carries OCC-to-gateway traffic. The
first-Agent helper's `--control-ui` option supplies the exact per-Agent native
configuration. Other Compose profiles do not expose this browser endpoint.

## Authorization and availability

`GET /namespaces/:namespaceId/agents/:agentId/native-admin` is the console-facing availability check. It requires a human session and exact Agent existence. When the feature is disabled, exact Agent `administer` permission is sufficient; no runtime assignment is required. When enabled, the route requires exact Agent `use` permission and one explicit runtime assignment. Agent `read`, Agent `operate`, native device credentials, native tokens, service API keys, and possession of a derived Agent host do not grant this API route.

The response reports:

| Status        | Meaning                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `disabled`    | The Installation has not enabled native admin UI access.                                                       |
| `stopped`     | The Agent is not in desired running state.                                                                     |
| `unsupported` | The selected Compute Driver, active revision, or native configuration does not support native admin UI access. |
| `unavailable` | No revision is serving yet: the Agent has no active revision, or a newer revision is replacing it.             |
| `available`   | The caller may open the returned `url` for the current active revision.                                        |

A stopped Agent with no active revision returns only `status: "stopped"`, including before its first deployment and after stop reconciliation clears its active revision. A stopped Agent with a selectable active revision still includes its target fields. If a desired-running Agent has no active revision, OCC returns `unavailable` in the success envelope so the console can show a retryable state. A dependency outage, the IAM Driver included, returns `503 DEPENDENCY_UNAVAILABLE`. Malformed requests, denied IAM access and missing sessions also use the normal protected-route error envelope.

Changing Compute does not migrate active revisions. After lifecycle and native
configuration checks, OCC requires the selected Driver ID and implementation to
match the revision owner. A mismatch returns `503 DEPENDENCY_UNAVAILABLE` before
endpoint/key lookup. Agent-host HTTP returns `403`; WebSocket admission destroys
the socket, and lease-time mismatches close existing connections. Earlier stopped,
replacing and unsupported states retain precedence.

Each API process logs one `native_admin.compute_owner_mismatch` warning per
revision and selected Driver. Restore the original Driver ID and implementation;
refreshing cannot repair ownership.

## Agent host identity

OCC derives a stable browser host from the Installation ID, Namespace ID, Agent ID, and configured `agentNativeAdmin.domain`. The hostname is opaque and must not be reused for another Agent identity. The derived host is separate from the console origin, which gives each Agent UI its own browser origin.

An Agent URL uses the derived host directly:

```text
https://agent-<opaque-hash>.<agentNativeAdmin.domain>/
```

Native-host admission resolves the opaque host through platform state. Unknown,
wrong-suffix, deleted or ambiguous Agent hosts fail closed, without a registry
or cache.

The Kubernetes human route uses a separate `/people` path:

```text
wss://<private-host>/people/namespaces/<namespaceId>/agents/<agentId>
```

For browser proxying, OCC maps that value to the same authority and Agent path over `https:`. Workspace-file access continues to use the original `wss:` endpoint. Native admin HTTP requests and WebSocket upgrades both pass through the OCC API process before reaching the private gateway. The HTTP proxy blocks native service-worker script requests and appends `worker-src 'none'` to proxied Content Security Policy so Agent content cannot register a browser service worker on the isolated Agent origin.

## Shared session boundary

The console and Agent hosts share the ordinary OCE session cookie through the configured cookie parent domain. That expands the cookie trust boundary: every host under the console and Agent subdomains that can receive the cookie must be a trusted OCE ingress endpoint. Public Agent hosts route to OCC, not Envoy or tenant gateway Services. OCC strips browser cookies, `Authorization`, API keys, forwarded identity, scope headers, and native `Set-Cookie` before forwarding upstream, so the native gateway never receives the OCE session cookie.

Native chat or other activity in the Agent tab does not renew the console session. Session expiry, logout, session revocation, permission removal, role changes, pilot disablement, Agent unavailability, or a revision change closes active WebSockets during the authorization lease. Reconnecting uses the same stable Agent host and the current active revision when the shared OCE session, exact Agent permission, and native configuration remain valid.

## Native authority and drift

Configured roles identify each person as `oce:<Principal ID>` from the verified
OCE session. Gateway admission resolves their profile, commits the assigned role
and verifies the policy’s SHA-256 digest. Missing/changed roles reject entry.
Browser-supplied identity, role, digest and scope headers are discarded.

For native authenticated HTTP, creating a profile or changing its role retires the authority captured before acquisition. That request returns `401` before the handler runs; a separate request uses the committed role. OCC never automatically replays an HTTP write. WebSocket admission acquires authority after role publication.

Compute owns the built-in administrator policy. Each exact person/Agent AccessBinding stores `runtimeRole`; admission reapplies it after native edits. Profiles linked to different people cannot admit them as one person.

`GET /namespaces/:namespaceId/agents/:agentId/runtime-roles` returns Configuration ID/generation, role names and permission summaries, desired runtime state and optional active-revision summaries, including before deployment and while stopped. An Installation administrator creates or changes an assignment using `runtimeRole` and the catalog's `configuration` as `runtimeRoleConfiguration`. Changes use `PATCH /namespaces/:namespaceId/iam/access-bindings/:bindingId/runtime-role`; deletion revokes entry. A stale Configuration ID/generation returns `409`; unknown roles return `400`. Definitions require deployment; roles absent from the active catalog deny entry. Only one assignment per person/Agent is allowed. Groups, services, broad bindings and Installation administration select no native role.

Kubernetes configures `gateway.auth.trustedProxy.managedIdentityPrefixes: ["oce:"]` and `managedIdentities: ["occ-workspace-files"]`. The bridge refuses undeclared identities and profiles with multiple managed identities. Selectors must be nonempty, trimmed lowercase values; role headers require at least one prefix or exact identity. Compute rejects conflicts.

Kubernetes retains the separate `occ-workspace-files` identity with the reserved `oce-service` role for server operations. The role catalog excludes that reserved role. OCE core consumes opaque role names and Compute descriptors; native profile details stay in the runtime and Driver.

The bridge computes its policy digest as SHA-256 of the UTF-8 JSON role definition. It recursively sorts object keys with English locale comparison and preserves array order. The Driver and runtime use the same rules; the digest checks agreement with native policy, while verified proxy authentication establishes authority.

Native admin changes affect gateway-local state outside OCE Configurations and
immutable AgentRevisions. Manage durable configuration through OCE. In the
Kubernetes pilot, native configuration edits affect a Pod-local copy that resets
from the managed snapshot when the Pod is recreated or the Agent is redeployed.
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

## Failure behavior

- Helm rendering fails when `agentNativeAdmin.enabled` is true without `gatewayRouting.enabled`, or with an `auth.baseUrl` that is not HTTPS or whose host is outside `agentNativeAdmin.sharedCookieDomain`.
- Better Auth validates first: malformed/public-suffix shared domains, a console outside the parent, or non-HTTPS console origins report `AUTH_BASE_URL_INVALID`; secrets under 32 characters report `AUTH_SECRET_INVALID`. Missing `OCC_GATEWAY_API_KEY_PATH` reports `GATEWAY_API_KEY_UNAVAILABLE`.
- Startup fails with `AGENT_NATIVE_ADMIN_INVALID` when enablement, Agent domain, shared cookie domain, public origin, Better Auth cookie scope, or cookie-secret requirements are invalid.
- Availability follows the status table above. `unsupported` reasons are
  `ui_configuration`, `role_unavailable`, `device_approval_required` and
  `transport_unsupported`; none grants authorization. Dependency outages return
  `503`.
- Denied ordinary users see no panel; denied Installation administrators see
  Sharing and **Refresh access**. Explicit refresh retries; automatic reloads
  retain denial. Other statuses show feedback; available access opens `url`.
- Attributable IAM denials remain audit events for status checks, native-host proxy admission, and recurring WebSocket lease renewal. Those denial paths preserve the human IAM principal and exact Agent target instead of collapsing into unaudited dependency failures.
- HTTP and WebSocket proxying strips browser credentials, service keys, forwarded authority and native `Set-Cookie`. Upgrades require an exact non-null Agent `Origin`. Accepted `101` connections audit connect/close with matching `connectionId` and `closeReason` (lifecycle, revocation, dependency, client, upstream or shutdown). Authorization renews every 25 seconds; failure or a check exceeding 5 seconds closes the connection. API `preClose` destroys remaining sockets.

## Related

- [Platform console](console.md#open-the-native-admin-ui)
- [Agents](agents.md#native-admin-ui)
- [Authentication](authentication.md#native-admin-shared-sessions)
- [Gateway routing with Envoy](gateway-routing.md#native-admin-ui-routing)
- [Deploy native admin UI access](../guides/deploy/native-admin.md)
- [Agent native admin UI flow](../flows/agent-native-admin.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-14 01:20: Documented the Compute-owner mismatch warning and how to restore access. (fix-1287)

- 2026-10-14 00:10: Distinguished HTTP refusal from WebSocket socket closure without a response. (01a13783-3cb5-7f53-8668-b2e3affa2b12 - e64d04f12cb80eb438a4c442180e56c2a2adae38)

- 2026-10-13 23:57: Documented native-admin refusal when selected Compute ownership differs from the active revision. (01a13783-3cb5-7f53-8668-b2e3affa2b12 - e64d04f12cb80eb438a4c442180e56c2a2adae38)

- 2026-10-10 09:20: Documented that native listener edits are not re-checked and how to recover. (docs-1014)

- 2026-10-06 12:00: Documented the Compose/OpenShell development endpoint and first-Agent Control UI option.

- 2026-09-21 21:20: Documented status-only stopped results before deployment and after stop reconciliation. (01a0c750-0c10-7492-97eb-f4124cded820 - 156dd67b7bd280a380d96b5c34a64e402fe3b96b)
- 2026-09-20 08:21: Linked Kubernetes configuration-copy details to the implementation reference after the Driver documentation refactor. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - f4e22e48)
- 2026-09-20 08:53: Replaced the temporary exchange launch description with the shared OCE session cookie model, cookie-domain trust boundary, host-to-Agent admission, and current-revision reconnect behavior. (cody/01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 5e5f12f37842ae7239d73432e00609547627ded8)
- 2026-09-19 22:27: Documented exact-Agent disabled-status gating, IAM denial audit preservation, and WebSocket `connectionId`/`closeReason` audit fields. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 9621ce4e)
- 2026-09-19 21:14: Documented gateway-routing Helm validation, service-worker domain setup, and the explicit native-admin writable-config predicate. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)
- 2026-09-19 21:07: Documented the `unavailable` availability success state and separated it from protected-route error envelopes. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)
- 2026-09-19 20:19: Added the current native admin UI reference for enablement, authorization, routing reuse, and source-confirmed launch status behavior. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)

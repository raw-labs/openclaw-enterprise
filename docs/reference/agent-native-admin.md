# Agent native admin UI

People open Gateways under assigned OpenClaw permissions; OCE assigns roles and OpenClaw enforces them. Files, plugins and provider accounts remain shared.
Access remains subject to [Gateway managed mode](#gateway-managed-mode).

Native access defaults off. **OpenClaw** opens the Agent host using the OCE session cookie; OCC proxies HTTP/WebSockets. Denied administrators see Sharing guidance and **Refresh access**.

## Who can open it

Opening OpenClaw requires a human session, Agent `use` permission and an explicit runtime assignment. OCE `administer` permission controls Agent management separately.

Runtime-role introduction gives effective human Installation, Namespace-group and exact-Agent administrators explicit `platform-administrator` assignments, excluding denied administrators and services. Sharing manages group-derived grants individually. Downgrade/removal is independent of OCE administration; old administrator grants never restore removed access.

Kubernetes reserves full-access `platform-administrator` with non-overridable policy. Without `gateway.roles`, running Gateways retain the shared administrator transport/profile; configured roles use personal profiles and Driver-owned administrator policy. Other roles require definitions and qualified human transport.

GitHub, Google and OIDC sign-in reject enablement at startup:
`<Provider> sign-in does not support native administration.` Their host-only
`__Host-openclaw_occ.session_token` cookie cannot carry the Domain attribute
required for [shared sessions](authentication.md#native-admin-shared-sessions).

## Requirements

- `agentNativeAdmin.enabled: true` in Helm, which sets `OCC_AGENT_NATIVE_ADMIN_ENABLED=true` on the API and worker.
- `agentNativeAdmin.domain` is a DNS suffix such as `agents.oce.example.com`, without scheme, wildcard, port or path. Helm passes `OCC_AGENT_NATIVE_ADMIN_DOMAIN`. Use a previously unused suffix: the proxy blocks new service workers but cannot evict previously registered workers.
- `agentNativeAdmin.sharedCookieDomain` is the explicit cookie parent, passed as API `OCC_AUTH_COOKIE_DOMAIN` when enabled. It must contain console and Agent hosts on DNS-label boundaries. Malformed domains and public suffixes fail closed in the profile renderer and API startup (`AUTH_BASE_URL_INVALID`); Helm has no public suffix list. The Agent suffix may equal the cookie domain: OCC excludes the Console hostname from native routing.
- `gatewayRouting.enabled: true` with [private Gateway routing](gateway-routing.md). Helm rejects native admin enablement without it: the API must reach each Agent gateway through the private route.
- `OCC_AUTH_BASE_URL` on API and worker set to the public OCC origin that serves the console, for example `https://console.oce.example.com`.
- Better Auth must use the [shared session cookie](authentication.md#native-admin-shared-sessions), preserving Secure, HttpOnly, SameSite, CSRF and trusted-origin protections. Domain cookies cannot use a `__Host-` prefix. Sign in again after enabling shared cookies to clear prior host-only cookies. Disabling native admin restores host-only scope.
- The Agent must be running with a selected version owned by the selected Compute Driver: both Driver ID and implementation must match the version. Its `ComputeDriver.getGatewayEndpoint` value must map from private `wss:` to private `https:`.
- The native Agent configuration must keep the trusted-proxy `occ-workspace-files` identity with `operator.admin`, enable native `controlUi`, allow the derived Agent origin, and enable trusted-proxy admin device auto-approval. The support check rejects token auth, disabled device auth, and host-header origin fallback.

Local Compose exposes the browser endpoint only with Kubernetes Compute and
OpenShell. The development proxy terminates HTTPS on loopback; k3d Envoy carries
private gateway traffic. The [first-Agent helper](../guides/first-agent.md)
accepts `--control-ui` for per-Agent configuration.

## First-deployment configuration

With Installation access and private Kubernetes routing enabled, Kubernetes
Compute prepares native administration for `gateway.controlUi.enabled: true`,
which both Standard Presets select. Deployment and guided provisioning add the
trusted-proxy identity, administrator device approval, exact Agent `allowedOrigins`
entry and `gateway.publicOrigin`. Origins derive from Installation, Namespace and
Agent IDs, preserving the public scheme and port.

With configured roles, preparation adds the reserved role headers and uses the
union of configured role scopes, including `operator.admin`, for device approval.
An explicit approval scope list must match that union. Without named roles,
preparation keeps the shared administrator transport. Preparation grants no person
runtime access: each person still needs an exact Agent `use` assignment.

Only the new Agent revision receives this policy. Saved Configuration values,
generations and historical revisions stay unchanged. Shared Configurations receive
separate Agent origins without accumulating sibling origins. Existing Agents adopt
the policy on their next explicit deployment.

Disabled or omitted UI, disabled device approval or disabled Installation access
leaves policy unprepared. Disabled device authentication and host-header fallback
cannot enable access. Conflicting authentication, approval scopes, `publicOrigin`,
wildcards or other Agent-domain origins refuse deployment with the setting to fix.
This includes a Console origin under the Agent suffix. Omit managed origins from
reusable Configurations. Compatible SecretRefs, loopback policy, other exact origins,
model, Harness, plugin settings and Secret bindings remain intact.

Preparation adds no OCE grants, changes no native tool restrictions and does not
support external sign-in. Native administrator authority remains subject to
[Gateway managed mode](#gateway-managed-mode). Drivers without this hook retain
the existing availability requirements.

## Authorization and availability

`GET /namespaces/:namespaceId/agents/:agentId/native-admin` checks availability for an existing Agent and human session. Disabled access requires exact Agent `administer`; enabled access requires exact Agent `use` and an explicit runtime assignment. Agent `read`/`operate`, native device credentials/tokens, service keys and the Agent hostname grant no access.

The response reports:

| Status        | Meaning                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| `disabled`    | The Installation has not enabled native admin UI access.                                                        |
| `stopped`     | The Agent is not in desired running state.                                                                      |
| `unsupported` | The selected Compute Driver, selected version, or native configuration does not support native admin UI access. |
| `unavailable` | No version is serving yet: the Agent has no selected version, or a newer version is replacing it.               |
| `available`   | The caller may open the returned `url` for the selected version.                                                |

Stopped Agents without a selected version return only `status: "stopped"`, including before first deployment and after stop reconciliation. Those with a selectable version include target fields. Desired-running Agents without a selected version return `unavailable` in the success envelope for console retry. Dependency outages, including IAM, return `503 DEPENDENCY_UNAVAILABLE`. Malformed requests, IAM denials and missing sessions use the protected-route error envelope.

Changing Compute Drivers does not migrate versions. After lifecycle and native-configuration checks, OCC compares both Driver ID and implementation with the version's owner. Mismatch returns `503 DEPENDENCY_UNAVAILABLE` from availability before endpoint/key/transport lookup. Agent-host HTTP returns `403`; WebSocket admission closes without an HTTP response or gateway connection. A lease mismatch closes the connection. Stopped, replacing and unsupported outcomes retain precedence.

Refreshing cannot fix a mismatch: restore the version's Driver ID and implementation. Each API process logs one `native_admin.compute_owner_mismatch` warning per version/selected Driver, naming both owners.

Without a valid session, opening `/`, `/chat/main` or `/chat/main/<32 lowercase hex digits>` redirects `302` to the configured console. Only the opaque Agent-host key enters the fragment; chat suffixes and queries are dropped. OCC sets `Cache-Control: no-store` and `Referrer-Policy: no-referrer` without checking Agent existence.

After sign-in if needed, authenticated `GET /native-admin/return/<key>` requires exact Agent `use` and a runtime assignment, returning Namespace/Agent IDs even when stopped. Unknown and unauthorized keys share `404`. Recovery opens Agent detail; native chat requires another action. Redirects require user-activated top-level HTML navigation. Link previews, API requests, WebSocket upgrades and signed-in denials retain their refusals without sign-in redirects.

A signed-in person lacking `use` or an assignment receives HTTP `403` at `/` or `/chat/main`. The unnamed-Agent page links only **Go to your Agents** at the public console's `/console/agents`, with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. JSON requests retain JSON `403`; WebSocket upgrades close without the page.

After reconnect failure and a same-origin health `401`/`403`, **Reconnect in browser** opens `/` on the current Agent host. Navigation is manual and drops chat paths/queries. This response does not prove session expiry; OCC decides whether to offer sign-in or refuse access.

## Agent host identity

Installation, Namespace and Agent IDs plus `agentNativeAdmin.domain` determine an opaque stable host. Never reuse it for another Agent identity. Each Agent UI has an origin separate from the console.

An Agent URL uses the derived host directly:

```text
https://agent-<opaque-hash>.<agentNativeAdmin.domain>/
```

Admission resolves the host hash through platform state without a registry/cache. Unknown hosts, wrong suffixes, deleted Agents and non-unique matches fail closed.

The Kubernetes human route uses a separate `/people` path:

```text
wss://<private-host>/people/namespaces/<namespaceId>/agents/<agentId>
```

For browser proxying, OCC maps that value to the same authority and Agent path over `https:`. Workspace-file access continues to use the original `wss:` endpoint. Native admin HTTP requests and WebSocket upgrades both pass through the OCC API process before reaching the private gateway. The HTTP proxy blocks native service-worker script requests and appends `worker-src 'none'` to proxied Content Security Policy so Agent content cannot register a browser service worker on the isolated Agent origin.

## Shared session boundary

The shared cookie parent expands the trust boundary: every console/Agent host receiving the OCE cookie must be trusted ingress. Public Agent hosts route to OCC. Before forwarding to Envoy or tenant Gateways, OCC strips cookies, `Authorization`, API keys, forwarded identity/scope headers and native `Set-Cookie`; Gateways never receive the OCE session cookie.

Native chat or other activity in the Agent tab does not renew the console session. Session expiry, logout, session revocation, permission removal, pilot disablement, Agent unavailability, or a version change closes active WebSockets during the authorization lease. Reconnecting uses the same stable Agent host and the selected version when the shared OCE session, exact Agent permission, and native configuration remain valid.

## Gateway managed mode

Managed mode defaults on where the Compute Driver supports it. It prevents Gateway administrators from editing native
configuration, opening Gateway-local terminals, and running Gateway-hosted command
jobs. An Installation administrator can change the setting in OCE for the next
deployment. See [Gateway managed mode](agents/gateway-managed-mode.md) for runtime
requirements and behavior when managed mode is off.

## Native authority and drift

With configured roles, the native Gateway sees `oce:<Principal ID>`, a stable account identifier verified against the OCE session, and the server-selected role. It finds or creates that native profile and commits the named role before admitting its connection. The proxy also supplies a SHA-256 digest of the role definition; missing roles or changed native definitions reject admission.

For native authenticated HTTP, creating a profile or changing its role retires the authority captured before acquisition. That request returns `401` before the handler runs; a separate request uses the committed role. OCC never automatically replays an HTTP write. WebSocket admission acquires authority after role publication.

Saved `gateway.roles` defines assignable roles; the active revision defines deployed policy. Compute owns the built-in administrator policy. The exact human/Agent AccessBinding stores `runtimeRole`. Native edits cannot change that assignment: the next admission reapplies it. Profiles linked to multiple OCE people cannot admit them as one person.

The [runtime-role catalog](api.md#get-namespacesnamespaceidagentsagentidruntimeroles) returns saved Configuration ID/generation, assignable roles, runtime state and optional deployed summaries, even before deployment or while stopped. Assignments use `runtimeRole` and catalog `configuration` as `runtimeRoleConfiguration`. PATCH preserves binding identity; DELETE revokes. Stale Configuration returns `409`, unknown roles `400`; undeployed definitions deny entry. Only one direct person/Agent assignment selects a role; groups, services, broad grants and Installation administration do not.

Kubernetes configures `gateway.auth.trustedProxy.managedIdentityPrefixes: ["oce:"]` and `managedIdentities: ["occ-workspace-files"]`. The bridge refuses undeclared identities and profiles with multiple managed identities. Selectors must be nonempty, trimmed lowercase values; role headers require at least one prefix or exact identity. Compute rejects conflicts.

Kubernetes retains the separate `occ-workspace-files` identity with the reserved `oce-service` role for server operations. The role catalog excludes that reserved role. OCE core consumes opaque role names and Compute descriptors; native profile details stay in the runtime and Driver.

Policy digests use SHA-256 of UTF-8 JSON role definitions, recursively sorting object keys with English locale comparison and preserving array order. Driver and runtime use identical rules. Digests check policy agreement; trusted-proxy authentication establishes authority.

When Gateway managed mode is off, native admin changes affect gateway-local state
outside OCE Configurations and Agent revisions. To keep a setting across Pod
recreation or redeployment, save it in the OCE Configuration. In the Kubernetes pilot, native configuration edits
affect a Pod-local copy that resets from the managed snapshot when the Pod is
recreated or the Agent is redeployed.
See [Kubernetes managed native configuration](drivers/kubernetes-compute/storage-and-credentials.md#managed-native-configuration)
for mount selection and the copy lifecycle.

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
- Better Auth setup runs before the native admin checks below and reports its own codes instead: `AUTH_BASE_URL_INVALID` for a malformed or public-suffix shared cookie domain, one that does not contain the public origin's host, or a non-HTTPS public origin with that cookie domain set, and `AUTH_SECRET_INVALID` for an auth secret under 32 characters. A missing `OCC_GATEWAY_API_KEY_PATH` reports `GATEWAY_API_KEY_UNAVAILABLE`.
- Startup fails with `AGENT_NATIVE_ADMIN_INVALID` when enablement, Agent domain, shared cookie domain, public origin, Better Auth cookie scope, or cookie-secret requirements are invalid.
- Availability returns `stopped` without a selected version, or `unavailable` while awaiting deployment/replacement. Dependency outages return `503`. Routing, native configuration or an unqualified Compute descriptor returns `unsupported` with the derived origin. Its `reason` distinguishes `ui_configuration`, `role_unavailable`, `device_approval_required` and `transport_unsupported`.
- Disabled and ordinary-user denials hide the panel. Denied Installation administrators see a Sharing hint and **Refresh access**. Explicit refresh retries; automatic reloads retain the denial. Other states show feedback; available access opens `url`.
- Attributable IAM denials remain audit events for status checks, native-host proxy admission, and recurring WebSocket lease renewal. Those denial paths preserve the human IAM principal and exact Agent target instead of collapsing into unaudited dependency failures.
- Proxying follows the [shared session boundary](#shared-session-boundary). WebSocket upgrades require a non-null exact Agent `Origin`. Accepted connections audit `websocket.connect` and `websocket.close` with a shared `connectionId`. Authorization repeats every 25 seconds; failure or a 5-second timeout closes both sockets. `closeReason` distinguishes lifecycle, revocation, dependency, client, upstream and shutdown. API `preClose` destroys retained sockets.

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

- 2026-10-13 23:57: Documented native-admin refusal when selected Compute ownership differs from the selected version. (01a13783-3cb5-7f53-8668-b2e3affa2b12 - e64d04f12cb80eb438a4c442180e56c2a2adae38)

- 2026-10-10 09:20: Documented that native listener edits are not re-checked and how to recover. (docs-1014)

- 2026-10-06 12:00: Documented the Compose/OpenShell development endpoint and first-Agent Control UI option.

- 2026-09-21 21:20: Documented status-only stopped results before deployment and after stop reconciliation. (01a0c750-0c10-7492-97eb-f4124cded820 - 156dd67b7bd280a380d96b5c34a64e402fe3b96b)
- 2026-09-20 08:21: Linked Kubernetes configuration-copy details to the implementation reference after the Driver documentation refactor. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - f4e22e48)
- 2026-09-20 08:53: Replaced the temporary exchange launch description with the shared OCE session cookie model, cookie-domain trust boundary, host-to-Agent admission, and current-version reconnect behavior. (cody/01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 5e5f12f37842ae7239d73432e00609547627ded8)
- 2026-09-19 22:27: Documented exact-Agent disabled-status gating, IAM denial audit preservation, and WebSocket `connectionId`/`closeReason` audit fields. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 9621ce4e)
- 2026-09-19 21:14: Documented gateway-routing Helm validation, service-worker domain setup, and the explicit native-admin writable-config predicate. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)
- 2026-09-19 21:07: Documented the `unavailable` availability success state and separated it from protected-route error envelopes. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)
- 2026-09-19 20:19: Added the current native admin UI reference for enablement, authorization, routing reuse, and source-confirmed launch status behavior. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)

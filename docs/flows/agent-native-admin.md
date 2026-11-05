---
created: "2026-09-19"
updated: 2026-11-04
last_updated_session: authoring-run/4ca8557c-b280-4cc8-a285-e585c7da9e43
---

# Agent Native Admin UI Flow

## Overview

OCC checks a Console user's exact Agent `use` grant and runtime assignment,
then returns the active Gateway's stable per-Agent URL. That host authenticates
the shared OCE session cookie, resolves the exact Agent, rechecks authorization,
and proxies native HTTP and WebSocket traffic.

## Entry Points

- Trigger: Console opts into native admin during Agent creation, opens an Agent native admin URL, or `scripts/first-agent.mjs --control-ui` creates a compatible local Compose/OpenShell Agent.
- Source: `scripts/first-agent.mjs:nativeConfiguration`
- Source: `apps/controller/src/console/agents/runtime-access.mts:renderRuntimeAccess`
- Source: `apps/controller/src/http/native-admin.ts:resolveNativeAdminAvailability`
- Assumptions: The API has a valid controller session, `agentNativeAdmin.enabled` is true, `agentNativeAdmin.domain` and `agentNativeAdmin.sharedCookieDomain` are configured, Better Auth emits the shared session cookie at that parent domain, and private Agent gateway routing can return a `ComputeDriver.getAgentRuntimeAccess` value.

## Flow

```mermaid
graph TD
  C0["Create Agent opts into Native admin UI"] --> C1["Authorize provisioning and reserve Agent identity"]
  C1 --> C2["Prepare exact origin and trusted-proxy policy"]
  C2 -->|conflicting policy or feature disabled| C3["Refuse before queueing work"]
  C2 -->|valid| C4["Save prepared plan, Configuration and first version"]
  C4 --> A
  LC["Local first-Agent selects Control UI"] --> L2["Create Agent, derive exact origin,<br/>and save Configuration generation 2"]
  L2 --> A
  A["Console opens Agent detail tab"] --> B["GET exact Agent native-admin status"]
  B --> C["Resolve OCC session and human principal"]
  C --> F{"Installation enabled?"}
  F -->|no| D["Require exact Agent administer and existence"]
  D --> G["Return disabled"]
  F -->|yes| H["Require exact Agent use and runtime assignment"]
  H --> I{"Active revision selection available?"}
  I -->|no| J{"Authorized stopped Agent without an active revision?"}
  J -->|yes| X["Return stopped without an origin"]
  J -->|no| Y["Return unavailable"]
  I -->|yes| K{"Agent desired running?"}
  K -->|no| L["Return stopped with derived origin"]
  K -->|yes| R2{"Newer revision replacing it on an exclusive Compute Driver?"}
  R2 -->|yes| Y
  R2 -->|no| M{"Native config supported?"}
  M -->|no| N["Return unsupported with derived origin"]
  M -->|yes| CO{"Compute ID and implementation match active revision?"}
  CO -->|no| CF["Return 503 dependency error"]
  CO -->|yes| EP{"Private gateway endpoint supported?"}
  EP -->|no| N
  EP -->|yes| O["Available; Agent URL"]
  O --> P["Browser opens Agent host with shared cookie"]
  P -->|HTTP| Q["Resolve host to exact Agent"]
  P -->|WebSocket| V["OCC guards client socket during admission"]
  V --> Q
  Q --> R{"Shared session and exact Agent use and assigned role still valid?"}
  R -->|no| S["Reject request; audit exact-Agent authorization denial"]
  R -->|yes| T["Resolve current revision, native config and Compute owner"]
  T -->|owner mismatch| RF["Refuse before key lookup or gateway connection"]
  T -->|matching owner| U["OCC strips browser credentials and proxies HTTP to private gateway"]
  T -->|WebSocket client reset| VB["Stop before gateway connection"]
  T -->|WebSocket client connected with matching owner and exact Origin| VC["Proxy 101 upgrade with revision lease"]
  VC --> AD{"Gateway has configured roles?"}
  AD -->|yes| AB["Native Gateway verifies assignment and commits profile role"]
  AD -->|no, explicit administrator| AC
  AB --> AC["Native policy authorizes subsequent commands"]
  U -->|HTML preview with sandbox routing enabled| W["Browser loads public shell from separate preview origin"]
  W --> Z["Envoy sandbox listener routes to Agent sandbox port"]
  Z --> AA["Native UI delivers HTML into runtime-isolated iframe"]
```

## Execution Trace

### 0. Console opts in before the first deployment

`apps/controller/src/console/agents/create.mts:renderCreateAgent`
`apps/controller/src/http/agents.ts:createAgentHandlers`
`apps/controller/src/gateway/native-admin.ts:prepareNativeAdminConfiguration`
`packages/occ/src/index.ts:provisionAgent`

The unchecked checkbox requires Installation native admin support and runtime
provisioning support. It sends `nativeAdmin: true`. After authorization,
provisioning reserves an Agent ID. The HTTP adapter prepares Configuration from
the configured public origin and Agent domain, never a browser-supplied origin.
It merges the policy or refuses conflicts before queueing. The request fingerprint
includes the preparation choice; retries reuse the saved plan and identity.
The worker creates that Agent and deploys its initial Configuration through
the normal provisioning lifecycle, without a later patch or second deployment.

### 0a. Local first-Agent opts into native admin

`scripts/first-agent.mjs:loadLocalInstallation`
`scripts/first-agent.mjs:nativeConfiguration`
`scripts/first-agent.mjs:ensureManagedConfiguration`

With launcher-owned Compose/OpenShell browser state, the helper saves disabled
Configuration generation 1, creates the Agent, then derives its origin. Before
deployment, generation 2 enables `controlUi`, pins origins, and grants
`occ-workspace-files` trusted-proxy `operator.admin` with device auto-approval.
Identity grants supply admin independently of device scopes.
An existing helper-owned name cannot change this selection.

### 0.5. Deployment admission prepares the Agent copy

`apps/controller/src/gateway/native-admin-origin.ts:nativeAdminOriginResolver`
`packages/occ/src/index.ts:deployAgentWithAuthorization`
`apps/controller/src/drivers/compute/kubernetes/index.ts:configureAgent`

API and worker derive trusted Installation origins through `nativeAdminTarget`.
Helm supplies matching inputs. For the Compose/OpenShell profile,
`compose.native-admin.yaml:services` supplies the same enablement, Agent domain
and public HTTPS origin to the controller and Kubernetes worker. Cookie settings
remain API-only. Deployment and provisioning pass the allocated
Agent and frozen Sandbox copy to Compute through `agentRuntimeConfiguration`.
Agent save remains unchanged. Kubernetes prepares gateway identity, device
approval and exact origins; conflicts refuse admission and opt-outs stay disabled.
OCC then applies logging and validation, freezing the result in an Agent revision.
The source Configuration and history stay unchanged. `admitRevision` records
separate Compute metadata; the runtime renders a writable copy.

### 1. Console renders native admin availability

`apps/controller/src/console/agents/runtime-access.mts:renderRuntimeAccess`

Agent detail reads `${path}/native-admin`. Disabled responses and ordinary-user denials hide the panel; denied Installation administrators see self-assignment guidance and **Refresh access**. Other states explain refusals. Only `available` shows **Open Agent UI** with `noopener noreferrer`.

`sessionStorage` caches audited `403` paths per session owner/tab. **Refresh access** forgets the path and retries; logout, sign-in or a new tab resets it. The [page cache](platform-console.md#2-resolve-the-session-before-private-reads) owns Back revalidation. Polling/**Refresh deployment** retries changed `activeRevisionId`/`desiredRuntimeState`, queuing one follow-up during pending reads. Native edits do not update OCE Configuration.
The target description names the version selected for service; browsing a historical
version does not change the destination. Stopped and unsupported states offer
**Open draft**. An unavailable deployment offers **View deployment** when a
readable version exists. Other unavailable states keep **Refresh access**.

The warning describes Gateway managed mode and OCE overwriting changes made while
it is off; durable configuration belongs in OCE.

Docker and Kubernetes also pass `OPENCLAW_CONFIG_READONLY_NOTICE` to the Gateway
child when the deployed revision enables managed mode
(`apps/controller/src/drivers/compute/runtime-startup.ts:gatewayManagedModeEnvironment`).
A supporting Gateway uses this text to direct administrators to the Console when
configuration is read-only. A change to the draft's managed mode takes effect at deployment.

### 2. OCC protects the availability route

`apps/controller/src/http/native-admin.ts:nativeAdminStatusOperation`

`createNativeAdminAccess` owns host interception, upgrades and socket shutdown.
A getter supplies the initialized controller after bootstrap. Shared route
admission remains in `apps/controller/src/index.ts`.

`GET /namespaces/:namespaceId/agents/:agentId/native-admin` admits humans through `admit`/`resolveIdentity`. Enabled access requires exact Agent `use` plus a runtime assignment, not just `read`/`operate`. Disabled access requires exact Agent `administer` and existence, without an assignment.

### 3. Shared availability resolver checks feature and active revision state

`apps/controller/src/http/native-admin.ts:getNativeAdminStatus`
`apps/controller/src/http/native-admin.ts:resolveNativeAdminAvailability`
`packages/occ/src/index.ts:getUsableActiveAgentRevision`

Enabled access requires a public origin and native domain.
`getUsableActiveAgentRevision` selects the active revision and successor.
Without an active revision, stopped Agents raise `ResourceStateConflictError`,
returning `stopped` even before first deployment. Desired-running Agents awaiting
activation raise `NoActiveAgentRevisionError`, returning `unavailable`.
Dependencies, including IAM Driver errors caught by `authorizeAgentRuntimeAccess`,
return `503`; denials return `403` with human IAM audits.
The panel reports the active revision.

A successor on a Compute Driver requiring stopped predecessors produces `unavailable`: the worker removes the old workload first. Failed replacement leaves the old revision active without a serving workload. Status and proxy admission both check this boundary.

OCC derives the target from the active revision; desired state other than
`running` returns `stopped`. Compute qualifies trusted-proxy identity, role
headers and device approval covering the selected role.
`nativeAdminConfigurationSupported` checks `controlUi.enabled`, exact
`allowedOrigins` and host-header/device-auth settings. Rejection returns
`unsupported` with the target and a reason: UI configuration, missing role,
insufficient device approval or unsupported transport. Missing endpoints and
unclean private `wss:` URLs also return `unsupported`. Only `available` carries
private `gatewayBase`, omitted from browser responses.
The selected Compute Driver ID and implementation must match `revision.compute`; mismatch returns `503 DEPENDENCY_UNAVAILABLE` before endpoint/key/transport lookup. Driver changes do not migrate revisions.

### 4. OCC derives the isolated Agent host

`apps/controller/src/gateway/native-admin.ts:nativeAdminTarget`
`apps/controller/src/gateway/native-admin-host.mjs:deriveNativeAdminHost`

`deriveNativeAdminHost` hashes Installation, Namespace and Agent IDs into an opaque hostname under the configured domain. `nativeAdminTarget` substitutes that host in `publicOrigin` and returns `/`. first-Agent imports this helper without workspace dependencies.

Native-host admission resolves the hash from Installation, Namespace, and Agent state. Unknown hosts, wrong suffixes, deleted Agents, and non-unique matches fail closed.

`nativeAdminGatewayHttpBase` requires a `wss:` endpoint without userinfo, query, or hash, then converts it to `https:` preserving authority and the Agent base path. Workspace-file WSS behavior stays unchanged.

### 5. Shared cookie admits the Agent host

`apps/controller/src/auth/index.ts:createControllerAuth`

When enabled, native admin passes the configured shared cookie domain to Better Auth. The controller validates that the console and Agent hosts fit that parent on DNS-label boundaries, rejecting public suffixes and malformed domains. It never infers a parent domain. When disabled, the console uses the host-only `openclaw_occ` cookie. A shared-domain cookie cannot use the `__Host-` prefix; one canonical name and scope prevents ambiguous duplicates.

### 6. OCC intercepts native-host HTTP requests

`apps/controller/src/http/native-admin.ts:interceptNativeAdminHttp`

The `onRequest` hook intercepts the native admin domain before routing, so an
Agent origin cannot expose console or controller routes. OCC authenticates the
shared session, resolves the IAM identity and exact Agent, requires exact Agent `use` and a runtime-role assignment,
then checks the selected version and native configuration. An attributable IAM
denial records the human and Agent in the denial audit.
Admission owns one audit attempt per such denial, also when it arrives after the
five-second admission wait, a client disconnect or the shutdown wait. A timely HTTP
denial waits for its append before returning `403`; a failed append or admission
timeout returns `503`.

Without a session, a user-activated top-level HTML GET to `/`, `/chat/main` or
`/chat/main/<32 hex>`, optionally with a trailing slash, gets a `302` to the
console; its fragment carries only the opaque host key. Without
`Sec-Fetch-User: ?1` (never sent by Safari) it gets a 403 **Sign in** link there.
Link previews, APIs, writes and WebSockets keep their refusal.

A signed-in `use` denial on a top-level page load stays HTTP 403. The page does
not name the Agent and links **Go to your Agents** to `/console/agents` on the
configured public origin. A JSON refusal names the `use` grant but not
the Agent, the same for an unknown host; WebSocket refusals stay unchanged.

Status and proxy checks reuse one Better Auth lookup for identity, expiry and
attribution. Each WebSocket lease checks the current session again. After handling
stopped, replacing or unsupported Agents, admission rechecks both Compute owner
fields. A mismatch returns HTTP `403` or closes an upgrading socket without an
HTTP response, before gateway-key lookup or connection. A failed lease closes
both sockets.

`apps/controller/src/gateway/native-admin-proxy.ts:proxyNativeAdminHttp`

The proxy bounds paths to the Agent base, checks exact `Origin` for writes, strips browser credentials, forwarding/native authority headers and upstream `Set-Cookie`, and forwards to private HTTPS. It rewrites same-upstream redirects, refuses service-worker scripts and adds CSP `worker-src 'none'`. A user-photo `/api/users/<id>/avatar` upstream `502` becomes an empty `404`: the offline Gateway cannot fetch Gravatar, so the UI shows initials. The native Gateway never receives the OCE cookie.

### 7. OCC proxies native WebSocket upgrades

`apps/controller/src/http/native-admin.ts:handleNativeAdminUpgrade`

The API process intercepts `upgrade` before Fastify routing. It accepts only derived Agent hosts and tracks active sockets so `preClose` destroys them during shutdown. Before awaiting shared-session and exact-Agent admission, it handles client socket errors; a TCP reset during admission therefore does not raise an uncaught socket error. A refused socket closes without waiting for its denial audit, which still runs after a reset. An allowed admission checks for client destruction and shutdown before and after resolving the private transport context, so late success cannot open a gateway connection. A connected client proceeds with the selected version.

`apps/controller/src/gateway/native-admin-proxy.ts:proxyNativeAdminWebSocket`

The WebSocket proxy requires a non-null exact Agent `Origin`, forwards a sanitized upgrade request to the private `https:` gateway base, and only connects the browser after the upstream returns `101`. `onConnect` appends `openclaw.agents.native_admin.websocket.connect`; `onClose` appends `openclaw.agents.native_admin.websocket.close`. The `websocket.connect` audit record includes `connectionId`; the matching `websocket.close` audit record reuses that `connectionId` and includes `closeReason`, whose value distinguishes lifecycle, revocation, dependency, client, upstream, and shutdown paths. A timer rechecks the shared-session admission path every 25 seconds, with each check subject to a five-second timeout. Failed, denied, timed-out, or version-changed lease checks close both sockets. Denial closure does not wait for the append; a late attributable lease denial still gets its single audit attempt. An authorized reconnect uses the selected version. Native chat does not renew the OCE session.

Admission and close audits share one five-second shutdown drain. Work still pending
afterwards logs `native_admin.pending_work_unresolved` with its count and keeps its
audit attempt while the process lives. The drain neither cancels producers nor
guarantees durable delivery; process exit can prevent or interrupt an audit attempt.

### 8. Runtime commits the verified role before admission

`apps/controller/src/drivers/compute/kubernetes/runtime-access.ts:humanRuntimeAccess`
`deploy/runtime/openclaw-trusted-proxy-role.patch`

Kubernetes offers configured roles and `platform-administrator`; [runtime access](../reference/agent-native-admin.md#who-can-open-it) defines upgrade grants and compatibility. Malformed roles deny entry. `humanRuntimeAccess` rejects invalid scope headers with `role_unavailable` before proxy handoff.

Configured roles use `/people/namespaces/<namespaceId>/agents/<agentId>`, `oce:<Principal ID>` and a policy digest; service traffic uses `/namespaces`. Preparation preserves the serving route across failed candidates; role-free successors leave it for predecessor retirement. OCC overwrites browser authority headers.

The Gateway verifies trusted-proxy authentication, managed identity scope and policy digest. Profiles with multiple managed identities fail. Admission commits the role; HTTP retires prior authority with `401`. Subsequent requests use that role without OCC replay. OpenClaw enforces permissions; backend connections retain `oce-service` and independently authenticated local owners retain access.

OpenClaw intersects requested/proxy scopes for operators; other connections require exact matches. Leases close changed assignments/descriptors within 30 seconds. HTTP/upgrades check current policy; reconnect updates profiles.

### 9. Runtime renders HTML on a separate origin

`apps/controller/src/drivers/compute/kubernetes/index.ts:gatewaySandboxConfiguration`
`apps/controller/src/drivers/compute/kubernetes/index.ts:reconcileGatewayRoute`

With operator sandbox routing configured, preparation and activation render the
Agent's stable preview origin and adjacent sandbox port in its native document.
The worker reconciles its GET/HEAD route, public-shell SecurityPolicy and
Agent-scoped backend ingress policy under the serving revision. A separate Helm listener admits only configured ingress
peers, and the backend targets the sandbox port instead of the admin port.
The preview domain is outside the shared session cookie scope. Native UI still
reads private file content through its authenticated connection, then delivers
it to the runtime's isolated iframe. The sandbox listener serves public shell
and registered renderer assets; runtime CSP and nested frame isolation remain
responsible for executing generated content. See the [routing contract](../reference/gateway-routing.md#public-preview-routing).

For opted-in Kubernetes gateways, `KubernetesComputeDriver.privateStateInitContainer`
copies the admitted configuration from `/etc/openclaw-managed/openclaw.json` to
`/runtime-state/home/.openclaw/openclaw.json` on the init container's writable
volume. The gateway mounts that same home subdirectory at `/home/node`, so native
edits remain Pod-local and the next Pod starts from the admitted configuration.
The init container cannot write through the gateway's later mount path.

`apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts:configureNativeWorkerProfile`
reuses only the exact generated worker profile after a container restart;
conflicting settings fail. `KubernetesComputeDriver.gatewayPrivateStateVolumeMounts`
retains `client/` and its migration receipt with the Gateway database. Native
admin Configuration remains Pod-local.

## Debugging and Verification

Use the [availability states and startup checks](../reference/agent-native-admin.md#failure-behavior)
to distinguish configuration, lifecycle, authorization and dependency failures.
Check `agentNativeAdmin.domain` and platform state for host refusals. The Gateway
must never receive the OCE session cookie.

Attributable IAM denials identify the human and exact Agent. Socket connect/close
audits share `connectionId`; `closeReason` identifies lifecycle, revocation,
dependency, client, upstream or shutdown. A TCP reset during admission must leave
the API running, preserve a later denial audit and open no upstream connection.
Service workers are blocked by the HTTP proxy and `worker-src 'none'`.

Browser tests cover panel states, warnings and launch. Integration covers shared
cookies, service-key/host denials, assets, WebSocket leases/reconnects and native
edits. The [installed sharing case](../testing/kubernetes.md#native-gateway-sharing)
checks role changes and selective revocation with real model turns.

## Related docs

- [Proposed Compute preparation contract](../../specs/rfcs/0032-native-admin-deployment-preparation.md)
- [Agent native admin UI](../reference/agent-native-admin.md)
- [Platform console](../reference/console.md#open-the-native-admin-ui)
- [Gateway routing with Envoy](../reference/gateway-routing.md#native-admin-ui-routing)
- [Deploy native admin UI access](../guides/deploy/native-admin.md)
- [Workspace files flow](workspace-files.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-04 23:07: Preserve creation preparation and audit lifecycle while refreshing role-managed access. Accompanying uncommitted changes. (authoring-run/4ca8557c-b280-4cc8-a285-e585c7da9e43 - f30db5c4045cbf2c1f5eef4576361112535ed8b4)

[Agent native admin documentation history](agent-native-admin/history.md) preserves the older dated entries.
- 2026-10-23 18:34: Pass matching native-admin origin inputs to the Compose Kubernetes worker for guided provisioning. (authoring-run/fe91b832-589c-438d-88f4-117e449312fe - f3fbd358b87b6e0fc0090ba55e6d12fa6de2b1ef)

- 2026-10-20 14:54: Extract persistence repair; trim repeated prose. (agent:roboclaw:dashboard:830a6ba7-3357-4ae0-9037-95d98205608c - 1ce18eeea10c83c856c8c08f6b0815e4b39308e0)

- 2026-10-19 23:14: Retain Gateway client state and reuse the exact generated native worker profile on restart. (authoring-run/45df354e-6d46-4430-83a5-3885d8a9fb76 - c584934287f78a4f3cf7c84cfb02febd9f3437ab)

- 2026-10-19 22:11: Document return to the requested page after session expiry. (authoring-run/e63eaa44-e02d-49aa-b1c6-4711bd49d919 - 332455338271720ef29c63e5e7fb209fa3da6ec2)
- 2026-10-17 19:03: Linked the submitted Compute contract proposal and refreshed upstream provisioning support. (authoring-run/400ef44f-ab67-4b2e-901a-064afa6e9e12 - 54614e31d67a9825684d1906feed3a6ab1c671c9)
- 2026-10-16 12:59: Retained copied-chat recovery and first-deployment preparation while adopting the current Sandbox contract. (authoring-run/5e253249-62fe-4167-90cb-1b82da91396c - 9c309cf67287428bdd762232d542759db7465198)
- 2026-10-15 21:30: Present the authorized launch and its access boundaries in the Agent overview. (authoring-run/6d9b833d-e4fc-4f58-98a8-f0fac29f709d - 7adac57cc03545bdd3cdc383c88219396a677fd9)
- 2026-10-15 20:27: Redirect copied chat navigation to the canonical console. (authoring-run/98164c0a-da1e-45c5-9d9a-8f6649a3a9c3 - b899534fae0070fab31489d54a8763bb81e4842e)
- 2026-10-15 13:30: Merged deployment preparation with upstream local first-Agent and Compute-owner flows. (authoring-run/40b9b9bd-a17c-4a00-8101-d13ebd2facd5 - 128433480bdc186f460312eece38a8ad486ecdeb)

- 2026-10-14 11:53: Extracted shared hostname derivation so the first-Agent script starts without installed workspace dependencies. (authoring-run/fba0a85c-ba37-4764-871e-9fdf80ee1083 - 5511d28d1)

- 2026-10-14 00:10: Distinguished HTTP refusal from WebSocket socket closure without a response. (01a13783-3cb5-7f53-8668-b2e3affa2b12 - e64d04f12cb80eb438a4c442180e56c2a2adae38)

- 2026-10-13 23:57: Documented the active revision Compute-owner comparison and status/proxy refusal before gateway effects. (01a13783-3cb5-7f53-8668-b2e3affa2b12 - e64d04f12cb80eb438a4c442180e56c2a2adae38)

- 2026-10-12 15:30: Refreshed first-deployment admission for the shared configuration helper on latest inspected upstream; Agent save remains unchanged. (authoring-run/522f2037-41de-4f2e-ae7b-8b26a769aa47 - b195e54e9b0ce98ead2b2306015a5209325e837b)

- 2026-10-12 14:04: Ported first-deployment admission onto inspected pure-main baseline with accompanying code changes. (authoring-run/c4085970-fd77-4614-a01b-95819dc08e6f - 80725162a946f80652b939a32a57ee4e922eeb5c)
- 2026-10-12 12:20: Documented first-deployment Compute admission and provisioning origin preparation. (authoring-run/ed71af64-d4b4-45ac-9ad4-6c2d65a97d17 - b195e54e9b0ce98ead2b2306015a5209325e837b)

- 2026-10-08 03:40: Documented client reset handling during native-admin WebSocket admission and the denial-audit and upstream-connection ordering at inspected revision `002d0f796`. (authoring-run/1e4aaf85-2e38-434d-99c0-75881fe9991c - 002d0f79639a9c814eb1fa2799530516a6c90cde)

- 2026-10-06 12:00: Traced the optional first-Agent Configuration generation that derives and allows the exact local native-admin origin before deployment. (authoring-run/0e6b1c8a-1723-4b20-ae51-08fa9457204a - 99641a7ab)

- 2026-10-04 07:30: Only a missing active revision reports `unavailable`; IAM and other dependency outages return `503`, and close or refuse proxied requests as `dependency_failure`. (bh11-native-status)

- 2026-10-03 12:00: Reread availability once when deployment polling observes a new active revision or runtime state.

- 2026-10-01 17:20: Move native-admin admission, availability, sockets and shutdown ownership into the HTTP module. (authoring-run/bef09bf6-deaa-4189-9568-5f13beb451e7 - 7a6cc931d)

- 2026-10-01 21:00: Reported `unavailable` while a newer exclusive revision replaces the active workload, including after that replacement fails.
- 2026-10-01 18:20: Answered unreachable user-photo fallbacks with `404` instead of `502`.

- 2026-09-30 19:00: Remembered a denied availability read per tab and session owner so reloads do not add an audited denial per view.

- 2026-09-29 21:35: Corrected native configuration initialization to write through the init volume mount. (89a4ccd7-3974-43c6-b08a-be02269a8d01 - cc96e34f33868555d4a89cb44bc022859d76c815)

- 2026-09-28 16:20: Added the accompanying optional sandbox routing implementation and separate-origin preview flow. (01a0cf72-6985-7712-ba92-d8cc32470f24 - 33a2528163d5bbff311bb685345e60aadb24a70a)

- 2026-09-21 21:20: Distinguished authorized stopped Agents with no active revision from unavailable running deployments. (01a0c750-0c10-7492-97eb-f4124cded820 - 156dd67b7bd280a380d96b5c34a64e402fe3b96b)
- 2026-09-21 21:17: Clarified the console's active-revision dependency message and its independence from the viewed configuration snapshot. (01a0c750-0c10-7492-97eb-f4124cded820 - f3dbdd41c8f3b49573d1353a4b06ce510ee43a56)
- 2026-09-20 09:45: Reused session metadata from admission and replaced launch bookkeeping with a direct browser link; socket lifecycle state remains owned by the proxy. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - bbb864aadc709dcc4f7b95d4b42b74823c18363a)
- 2026-09-20 08:53: Replaced the native-admin exchange flow with shared OCE session cookie admission, host-to-Agent resolution, credential stripping, and current-revision reconnect behavior. (cody/01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 5e5f12f37842ae7239d73432e00609547627ded8)
- 2026-09-19 22:27: Documented exact-Agent disabled-status gating, IAM denial audit preservation, and WebSocket `connectionId`/`closeReason` audit fields. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 9621ce4e)
- 2026-09-19 21:14: Updated the flow for the shared availability resolver names and service-worker blocking behavior. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)
- 2026-09-19 21:07: Added the `DependencyUnavailableError` to `unavailable` status branch and clarified derived-origin status payloads. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)
- 2026-09-19 20:19: Added the source-backed native admin UI availability, launch, cookie redemption, HTTP proxy, and WebSocket proxy flow. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)

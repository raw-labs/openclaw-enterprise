---
published: false
---

# Agent native admin documentation history

This record preserves the dated changes to the Agent native admin flow. See the [parent flow](../agent-native-admin.md) for its context and overall sequence.

## Changelog

- 2026-10-23 18:34: Pass matching native-admin origin inputs to the Compose Kubernetes worker for guided provisioning. (authoring-run/fe91b832-589c-438d-88f4-117e449312fe - f3fbd358b87b6e0fc0090ba55e6d12fa6de2b1ef)
- 2026-10-17 19:03: Linked the submitted Compute contract proposal and refreshed upstream provisioning support. (authoring-run/400ef44f-ab67-4b2e-901a-064afa6e9e12 - 54614e31d67a9825684d1906feed3a6ab1c671c9)
- 2026-10-16 12:59: Retained copied-chat recovery and first-deployment preparation while adopting the current Sandbox contract. (authoring-run/5e253249-62fe-4167-90cb-1b82da91396c - 9c309cf67287428bdd762232d542759db7465198)
- 2026-10-15 13:30: Merged deployment preparation with upstream local first-Agent and Compute-owner flows. (authoring-run/40b9b9bd-a17c-4a00-8101-d13ebd2facd5 - 128433480bdc186f460312eece38a8ad486ecdeb)
- 2026-10-12 15:30: Refreshed first-deployment admission for the shared configuration helper on latest inspected upstream; Agent save remains unchanged. (authoring-run/522f2037-41de-4f2e-ae7b-8b26a769aa47 - b195e54e9b0ce98ead2b2306015a5209325e837b)
- 2026-10-12 14:04: Ported first-deployment admission onto inspected pure-main baseline with accompanying code changes. (authoring-run/c4085970-fd77-4614-a01b-95819dc08e6f - 80725162a946f80652b939a32a57ee4e922eeb5c)
- 2026-10-12 12:20: Documented first-deployment Compute admission and provisioning origin preparation. (authoring-run/ed71af64-d4b4-45ac-9ad4-6c2d65a97d17 - b195e54e9b0ce98ead2b2306015a5209325e837b)

- 2026-10-19 23:14: Retain Gateway client state and reuse the exact generated native worker profile on restart. (authoring-run/45df354e-6d46-4430-83a5-3885d8a9fb76 - c584934287f78a4f3cf7c84cfb02febd9f3437ab)
- 2026-10-19 22:11: Document return to the requested page after session expiry. (authoring-run/e63eaa44-e02d-49aa-b1c6-4711bd49d919 - 332455338271720ef29c63e5e7fb209fa3da6ec2)
- 2026-10-15 21:30: Present the authorized launch and its access boundaries in the Agent overview. (authoring-run/6d9b833d-e4fc-4f58-98a8-f0fac29f709d - 7adac57cc03545bdd3cdc383c88219396a677fd9)
- 2026-10-15 20:27: Redirect copied chat navigation to the canonical console. (authoring-run/98164c0a-da1e-45c5-9d9a-8f6649a3a9c3 - b899534fae0070fab31489d54a8763bb81e4842e)
- 2026-10-14 11:53: Extracted shared hostname derivation so the first-Agent script starts without installed workspace dependencies. (authoring-run/fba0a85c-ba37-4764-871e-9fdf80ee1083 - 5511d28d1)
- 2026-10-14 00:10: Distinguished HTTP refusal from WebSocket socket closure without a response. (01a13783-3cb5-7f53-8668-b2e3affa2b12 - e64d04f12cb80eb438a4c442180e56c2a2adae38)
- 2026-10-13 23:57: Documented the selected version Compute-owner comparison and status/proxy refusal before gateway effects. (01a13783-3cb5-7f53-8668-b2e3affa2b12 - e64d04f12cb80eb438a4c442180e56c2a2adae38)
- 2026-10-08 03:40: Documented client reset handling during native-admin WebSocket admission and the denial-audit and upstream-connection ordering at inspected commit `002d0f796`. (authoring-run/1e4aaf85-2e38-434d-99c0-75881fe9991c - 002d0f79639a9c814eb1fa2799530516a6c90cde)
- 2026-10-06 12:00: Traced the optional first-Agent Configuration generation that derives and allows the exact local native-admin origin before deployment. (authoring-run/0e6b1c8a-1723-4b20-ae51-08fa9457204a - 99641a7ab)
- 2026-10-04 07:30: Only a missing selected version reports `unavailable`; IAM and other dependency outages return `503`, and close or refuse proxied requests as `dependency_failure`. (bh11-native-status)
- 2026-10-03 12:00: Reread availability once when deployment polling observes a new selected version or runtime state.
- 2026-10-01 17:20: Move native-admin admission, availability, sockets and shutdown ownership into the HTTP module. (authoring-run/bef09bf6-deaa-4189-9568-5f13beb451e7 - 7a6cc931d)
- 2026-10-01 21:00: Reported `unavailable` while a newer exclusive version replaces the active workload, including after that replacement fails.
- 2026-10-01 18:20: Answered unreachable user-photo fallbacks with `404` instead of `502`.
- 2026-09-30 19:00: Remembered a denied availability read per tab and session owner so reloads do not add an audited denial per view.
- 2026-09-29 21:35: Corrected native configuration initialization to write through the init volume mount. (89a4ccd7-3974-43c6-b08a-be02269a8d01 - cc96e34f33868555d4a89cb44bc022859d76c815)
- 2026-09-28 16:20: Added the accompanying optional sandbox routing implementation and separate-origin preview flow. (01a0cf72-6985-7712-ba92-d8cc32470f24 - 33a2528163d5bbff311bb685345e60aadb24a70a)
- 2026-09-21 21:20: Distinguished authorized stopped Agents with no selected version from unavailable running deployments. (01a0c750-0c10-7492-97eb-f4124cded820 - 156dd67b7bd280a380d96b5c34a64e402fe3b96b)
- 2026-09-21 21:17: Clarified the console's selected version dependency message and its independence from the viewed configuration snapshot. (01a0c750-0c10-7492-97eb-f4124cded820 - f3dbdd41c8f3b49573d1353a4b06ce510ee43a56)
- 2026-09-20 09:45: Reused session metadata from admission and replaced launch bookkeeping with a direct browser link; socket lifecycle state remains owned by the proxy. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - bbb864aadc709dcc4f7b95d4b42b74823c18363a)
- 2026-09-20 08:53: Replaced the native-admin exchange flow with shared OCE session cookie admission, host-to-Agent resolution, credential stripping, and current-version reconnect behavior. (cody/01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 5e5f12f37842ae7239d73432e00609547627ded8)
- 2026-09-19 22:27: Documented exact-Agent disabled-status gating, IAM denial audit preservation, and WebSocket `connectionId`/`closeReason` audit fields. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 9621ce4e)
- 2026-09-19 21:14: Updated the flow for the shared availability resolver names and service-worker blocking behavior. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)
- 2026-09-19 21:07: Added the `DependencyUnavailableError` to `unavailable` status branch and clarified derived-origin status payloads. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)
- 2026-09-19 20:19: Added the source-backed native admin UI availability, launch, cookie redemption, HTTP proxy, and WebSocket proxy flow. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)

- 2026-10-24 09:18: Trace scope-header rejection before proxy handoff. (authoring-run/b03c3827-26e7-498c-a025-39aff6107cf8 - 04fa993cf6562e5d2eedf6ee4dae37e2cc7eb82c)


- 2026-10-19 18:15: Map runtime IAM failures to `503`. (authoring-run/d8ce5783-eee5-4fb5-94e1-d6f87dd05219 - 57e6bcd87f06abd13ca4092b15f764d7c284d1d6)


- 2026-10-16 13:04: Use runtime assignments for copied-link recovery and retain the updated Agent overview. (authoring-run/b88902de-ac9a-4c44-98a7-073323cfb09b - ff0edc4f28ab3fa423cc1f331ba209d1cda04372)


- 2026-10-15 13:36: Preserve Compute ownership checks and shared hostname derivation with per-person runtime admission. (authoring-run/f64d2a52-ee3c-4e67-9d22-30f2e4d89aa3 - b0fdd771426669636fc97b59c651a383b5d64984)


- 2026-10-08 14:03: Return disabled status without a runtime assignment; keep administrator assignment guidance visible and retry remembered denial on explicit Refresh. (authoring-run/3bee1cb2-aeb2-4700-8ff4-3da9ac7f098c - 346b1fe14)


- 2026-10-05 17:34: Trace Namespace-scoped entry Roles and consistent human-route selection for runtime assignments. (authoring-run/593fb00e-b94d-46a0-a339-f3a8973764cb - aecffb24a16b5252c55ddf47bed2c66e622f1813)


- 2026-10-05: Preserve explicit administrator entry during upgrade explain access configuration failures, and retain serving-route ownership during preparation. (authoring-run/fabe27b6-d360-4a29-8a8c-17547858f84a - 379dc56084c92d7847849f2b3f96ddc0eccc17d8)


- 2026-10-03 08:54: Preserve access refresh, visible read failures, service-key feedback and cached pages after optional access denial. (authoring-run/59d7541c-66d2-414c-8139-174fca84fe33 - b6f9185159f14399905bf495b3cdef3ce2d14e30)


- 2026-10-02 14:32: Trace per-person roles, configured managed identities, disjoint routing, verified admission, scope intersection and revocation. (authoring-run/32e6f4fe-d1a7-4d1a-96f4-282e75750412 - 3b2369155e55b0e9bed49de9e46d68a958dc5278)

---
rfc: ../rfcs/0030-temporary-embedded-channel-trial.md
---

# Implementation plan: Trial native channels in embedded OpenClaw

- **ID:** RFC-0030
- **Delivery status:** In progress
- **Owner:** miguelbranco80
- **Authority:** [Temporary embedded channel proposal](../rfcs/0030-temporary-embedded-channel-trial.md)
- **Source baseline:** `d7595b9ce392c0558cf84c268bc31f093aba36bf`

## Outcome and scope

An Installation administrator can opt into native Slack/Teams channels through
the regular Agent API and worker with embedded OpenClaw. Default Installations
continue to refuse that topology. This is a disposable evaluation, with the
shared-credential trust decision and removal condition owned by the proposed RFC.
Live provider qualification is excluded at the requesting user's direction.

## Contract and source touchpoints

Kubernetes Compute owns trusted admission, provisioning modes, Secret projection
and callback lifecycle. Configuration, Namespace Secrets, Native IAM and the
PostgreSQL worker retain their existing contracts. The
[channel runtime flow](../../docs/flows/agent-channel-runtime.md) identifies source
entry points and revision fences. The
[trial guide](../../docs/guides/integrations/embedded-channel-trial.md) owns setup,
proxy limits and credential withdrawal.

## Implementation

1. **Shared Teams prerequisites:** Package the pinned native `msteams` plugin;
   admit its Public-cloud app-password shape; add a separately configured public
   listener and exact Agent callback. Publish the callback through a
   revision-selecting Service; retire it with existing ownership and revision
   fences. Keep the Microsoft proxy destinations explicitly opt-in. These changes
   end at commit `2579df489` and can be evaluated independently of embedded mode.
2. **Temporary exception:** Add the trusted default-false
   `runtime.channels.experimentalEmbeddedChannels` setting. Apply it at admission,
   preparation and activation, and advertise embedded provisioning only when
   enabled. Preserve OpenClaw execution and exact Secret/IAM scope. Keep stop/delete
   available after disabling the setting. Implementation is commit `8d81c946b`.
3. **Supported workflow proof:** Extend the existing API/PostgreSQL/Kubernetes
   provisioning integration with synthetic credentials and a closed model endpoint.
   Exercise default refusal, trusted enablement, missing/cross-Namespace bindings,
   exact kubelet projections, revision replacement, callback disable/reenable and
   teardown with the option disabled. CI prepares real callback CRD schemas.
4. **Qualification and removal:** Obtain the specified independent review and
   native image checks before any adoption. Keep this fork PR a draft. Responsible
   maintainers must decide the RFC's trust exception; this evaluation authorizes
   no merge, image publication or production deployment. Remove the exception when
   supported dedicated native parity supplies the required models and integrations.

## Original delivery verification

| Required outcome                                              | Check                                                                           | Result or remaining proof                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| API admission, IAM, projections and lifecycle                 | Three required real Kubernetes fixture files; migrated limited application role | 5 passed, no failures or skips at `8d81c946b`; fixture protocol is simulated |
| Admission, proxy policy and Helm contracts                    | Six focused conformance/integration files                                       | 723 passed, 1 existing Linux-only skip; no live upstream requests            |
| Documentation and workspace consistency                       | Formatting, lint, typecheck, workspace, OpenAPI and documentation checks        | Passed; generated API unchanged                                              |
| Native image startup on both architectures                    | Exact-head `container-check.yml`                                                | Required before merge; not established by fixture images                     |
| Independent GPT-6.1 Sol review                                | Canonical autoreview helper                                                     | Unavailable: account rejects the requested model; fallback prevented         |
| Public callback, native JWT, channel delivery and model turns | Native runtime, public TLS, authorized recipients and provider credentials      | Excluded from this evaluation; remains unverified                            |

## Original delivery record

Source implementation and supported workflow fixtures are complete in the
evaluation branch. The RFC remains Proposed and delivery remains In progress
because independent review, native image qualification and the adoption decision
are unresolved. Fixture routes prove Kubernetes resource lifecycle, not installed
Envoy enforcement. The API/native JSON trial adds no console editor, universal
provider support or native Connections installation management.

## Refresh verification — 2026-11-05

The refresh merges pinned upstream `b891554203643c769f19d71860d03382bb9717bc`
without changing the trial's Proposed trust decision. RFC-0023 was allocated
upstream, so this unmerged proposal and its plan now use RFC-0029.

On the 2026-11-05 refresh, upstream allocated RFC-0029 to per-Agent plugin
catalogs. The unmerged trial now uses RFC-0030; this existing plan filename is
retained. The proposal remains Proposed and this delivery remains partial.

Current admission retains upstream model-provider ownership: the fixture sets the
same closed endpoint in trusted Installation settings and native configuration.
The callback uses the observed serving Deployment revision, a revision-selecting
Service, exact Envoy ingress, and UID/resourceVersion cleanup fences. The refresh
retains current guarded-fetch proxy trust and Teams packaging from the shared
Teams implementation; it does not copy its Console editor.

- Kubernetes Compute conformance: **406 passed, no failures or skips**.
- Compute and CI contract rerun before the callback repair: **544 passed, no
  failures or skips**; Compute was rerun after that repair as recorded above.
- Real Kubernetes/PostgreSQL fixtures: all **5 distinct cases** pass across
  sequential runs. The latest affected provisioning file passes **3/3, no skips**
  at `7b0da6fca`; the other cases passed in the preceding run. Coverage includes
  API/worker admission, exact Secret projection, callback replacement/removal,
  denied ungranted Agent and stop/delete with the option disabled. Invalid
  Installation callback routing returns the existing `409 RESOURCE_CONFLICT`
  without stopping the original revision, Pod or callback. Earlier failures
  exposed a missing callback HTTPRoute and an incorrect test response expectation;
  both were corrected before the affected rerun.
- The fixture uses simulated native probe responses, not native provider or
  installed Envoy qualification. All disposable cluster/database resources were
  cleaned up. Live provider execution remains excluded by the requesting user.
- Final typecheck, lint, formatting, workspace isolation, OpenAPI, CI audit,
  workflow actionlint and three affected flow validators pass. Documentation
  validates 321 pages, 5,169 links and 107 specifications. The new runtime flow
  renders in Chromium/Mermaid with 11 nodes and no rendering errors.
- Console credential browser coverage: **37 passed, no failures or skips**.
  The seccomp/AppArmor option check passes; it does not establish native startup.
- Complete refreshed-diff independent review at `7b0da6fca` found no actionable
  P0–P2 issues. Earlier review findings were causally reproduced and fixed:
  Teams proxy opt-in, inherited CI AppArmor and callback admission before
  predecessor stop. Affected checks pass, including real CONNECT **15/15** and
  the named CI AppArmor check. Delivery-record edits follow that reviewed code.
- Both-architecture final-head native image qualification and the maintainer's
  adoption decision remain required before merge/adoption.

## Manual Notes

## Changelog

- 2026-10-14: Record delivered source, separated Teams prerequisites and outstanding qualification (`8d81c946b`; authoring-run/63947ba2-fb2a-4559-b79d-a00d1cd4043c).

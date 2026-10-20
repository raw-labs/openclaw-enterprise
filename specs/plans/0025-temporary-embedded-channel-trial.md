---
rfc: ../rfcs/0025-temporary-embedded-channel-trial.md
---

# Implementation plan: Trial native channels in embedded OpenClaw

- **ID:** RFC-0025
- **Delivery status:** In progress
- **Owner:** miguelbranco80
- **Authority:** [Temporary embedded channel proposal](../rfcs/0025-temporary-embedded-channel-trial.md)
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

## Verification

| Required outcome                                              | Check                                                                           | Result or remaining proof                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| API admission, IAM, projections and lifecycle                 | Three required real Kubernetes fixture files; migrated limited application role | 5 passed, no failures or skips at `8d81c946b`; fixture protocol is simulated |
| Admission, proxy policy and Helm contracts                    | Six focused conformance/integration files                                       | 723 passed, 1 existing Linux-only skip; no live upstream requests            |
| Documentation and workspace consistency                       | Formatting, lint, typecheck, workspace, OpenAPI and documentation checks        | Passed; generated API unchanged                                              |
| Native image startup on both architectures                    | Exact-head `container-check.yml`                                                | Required before merge; not established by fixture images                     |
| Independent GPT-6.1 Sol review                                | Canonical autoreview helper                                                     | Unavailable: account rejects the requested model; fallback prevented         |
| Public callback, native JWT, channel delivery and model turns | Native runtime, public TLS, authorized recipients and provider credentials      | Excluded from this evaluation; remains unverified                            |

## Delivery record

Source implementation and supported workflow fixtures are complete in the
evaluation branch. The RFC remains Proposed and delivery remains In progress
because independent review, native image qualification and the adoption decision
are unresolved. Fixture routes prove Kubernetes resource lifecycle, not installed
Envoy enforcement. The API/native JSON trial adds no console editor, universal
provider support or native Connections installation management.

## Manual Notes

## Changelog

- 2026-10-14: Record delivered source, separated Teams prerequisites and outstanding qualification (`8d81c946b`; authoring-run/63947ba2-fb2a-4559-b79d-a00d1cd4043c).

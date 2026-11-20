---
status: Proposed
implementation_status: Not implemented
author: miguelbranco80
---

# Proposal: Per-provider Channel Drivers in OCC

- **ID:** RFC-20261120-channel-provider-drivers
- **Created:** 2026-11-20
- **Last updated:** 2026-11-20
- **RFC PR:** [raw-labs/openclaw-enterprise#39](https://github.com/raw-labs/openclaw-enterprise/pull/39)
- **Implementation plan:** [TASK-0045](../plans/0045-teams-channel-support.md)
- **Related:** [RFC-20261118-channel-egress](20261118-channel-egress.md),
  [Teams channels RFC](https://github.com/raw-labs/openclaw-enterprise/pull/29),
  [ChannelDriver contract](../../docs/reference/drivers/channel.md)

## Summary

OpenClaw Control Plane (OCC) installs one Channel Driver for each channel
provider, the same provider-to-Driver set that Kubernetes Compute already
receives. A directory lookup names its provider, and OCC sends the request only
to that provider's Driver. The Driver lookup input gains optional
provider-owned `context`. Installation YAML gets an optional `drivers.channel`
list that selects the bundled Channel Drivers and carries their configuration.
The Microsoft Teams Driver uses this configuration for its storage hosts.

## Motivation

[RFC-20261118-channel-egress](20261118-channel-egress.md) maps each enabled
provider to exactly one installed Channel Driver for Compute admission and
egress. OCC still selects a single `channel` Driver for directory lookup and
credential validation. That shape assumes one provider.

Microsoft Teams is the second provider. Its directory lookup needs more than a
token: the application ID, the tenant ID and the selected Team. Its Gateways
also need operator-approved Microsoft storage hosts for attachment downloads.
No current contract carries either input.

The first Teams draft put a `provider` field in every Driver's lookup input,
wrapped both providers in a composite Driver, and stored Teams storage hosts in
the Kubernetes Compute configuration. Each Driver then received a field it did
not need, the composite reported the union of all destinations as its own, and
Compute carried a setting that only the Teams Driver reads.

## Goals

- OCC and Compute use the same provider-to-Driver set from trusted composition.
- A lookup reaches only the Driver of the provider that it names.
- Each Driver validates only its own provider configuration and context.
- Channel Driver configuration has one owner: its Driver selection.

## Non-goals

- Third-party Channel Driver packages. Only bundled Drivers are selectable.
- Typed Secrets. A Secret is not bound to one provider; see
  [Rationale](#rationale-and-alternatives).
- Changes to destination rules, Envoy enforcement or listener allocation.

## Proposal

### Composition

Trusted composition builds one `ChannelProviderDriver` (`{ provider, driver }`)
for each selected Channel Driver. It gives the same frozen list to Kubernetes
Compute and to OCC. OCC refuses a list that repeats a provider or a Driver
identity, as it does for Plugin Drivers.

`drivers.channel` is an optional list of bundled selections:

```yaml
drivers:
  channel:
    - id: slack-channel
      configuration: {}
    - id: teams-channel
      configuration:
        fileHosts:
          - tenant.sharepoint.com
```

| Selection       | Provider  | Configuration                                                                              |
| --------------- | --------- | ------------------------------------------------------------------------------------------ |
| `slack-channel` | `slack`   | Empty, closed schema.                                                                      |
| `teams-channel` | `msteams` | Optional `fileHosts`: at most 32 exact lowercase Microsoft storage hostnames; default `[]`. |

If the list is absent, composition installs both bundled Drivers with default
configuration. If the list is present, composition installs only the listed
Drivers; an Agent that enables another provider fails admission because no
Driver resolves it. Each Driver declares a closed configuration schema, so
startup refuses unknown fields. The startup configuration inspection reports
the accepted values, like other Driver selections.

### Directory lookup

The API request names the `provider`. OCC authorizes the caller and the Secret
as it does today, then selects the installed Driver for that provider. If no
Driver is installed for the provider, OCC reports that lookup is unavailable,
not a provider response error. OCC does not interpret `context`; it checks only
the bounded shape defined by the API.

### Credential validation and deployment admission

OCC runs `validateCredentials` for each installed Driver that implements it. A
validator reads only its own provider's configuration section and returns when
that section is absent or disabled. Deployment admission records the installed
Driver list and validator identities that it checked, and it refuses the
deployment if they changed before the revision is recorded.

## Interface changes

### APIs

| Change  | Operation                                                 | Behavior and contract change                                                                                                                          |
| ------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changed | `POST /namespaces/{namespaceId}/channel-directory/lookup` | Search and ID hydration bodies require `provider`. Optional `context` holds at most eight nonsecret strings. An uninstalled provider is unavailable. |

### IAM

No changes. Lookup still requires the target edit permission and `operate` on
the exact same-Namespace Secret.

### Database entities

No changes.

### Driver contracts

- [`ChannelDirectoryLookupInput`](../../packages/contracts/src/drivers/channel/index.ts)
  gains `context?: Readonly<Record<string, string>>`. It does not gain a
  `provider` field. A Driver rejects missing, unknown or malformed context
  before it sends a request; a Driver that uses no context rejects any context.
- `ChannelDirectoryError` gains the `invalid_request` reason for caller input
  that a Driver refuses, such as context or a cursor from another lookup. OCC
  returns it as `400 INVALID_REQUEST`, not as a provider failure.
- `ChannelProviderDriver` moves from the controller to the shared contracts
  package and is exported from its top-level index.
- `validateCredentials` must read only the Driver's own provider section.
- The bundled Drivers expose closed configuration schemas through the existing
  `DriverImplementation` definition.
- Kubernetes Compute `runtime.channelEgress` does not accept Teams storage hosts.

## Simplifications

This proposal removes the composite Channel Driver and its merged destination
list. It also removes a provider-specific field from the Compute configuration
and gives OCC the provider mapping that Compute already uses. A simpler option
would keep one selected Driver and dispatch inside it. That option keeps the
composite and its incorrect `enableRouting` result.

## Acceptance Criteria

- **AC-1 — Lookup reaches one provider:** Given installed Slack and Teams
  Drivers, when an authorized caller looks up Teams channels through the real
  API, then only the Teams Driver receives the request. A lookup for an
  uninstalled provider returns the unavailable error. Verify with the Teams
  directory and OCC API integration tests.
- **AC-2 — Context stays provider-owned:** When a Teams lookup has an unknown
  context key, or a Slack lookup has any context, the Driver refuses it with
  `400 INVALID_REQUEST` before it sends a request. Verify with the Teams
  directory integration test.
- **AC-3 — Selection controls installation:** Given `drivers.channel` lists only
  `teams-channel`, when an Agent enables Slack, then routing resolution refuses
  it. Unknown or malformed configuration fails startup. Verify with the Channel
  Driver startup integration test.
- **AC-4 — Storage hosts reach Teams Gateways only:** Given Teams `fileHosts`,
  when a Teams Agent deploys, then its Envoy listener permits those hosts and a
  Slack-only Agent's listener does not. Verify with the real Helm and Envoy
  integration test.

## Delivery and verification

Delivery is in [TASK-0045](../plans/0045-teams-channel-support.md), together
with the Teams channel implementation. Verification results map to the
criteria above in that plan.

## Rationale and alternatives

- **Provider field in the Driver input.** Every Driver would receive a field
  that composition already decides. It also needs a composite Driver to
  dispatch. Rejected.
- **Teams storage hosts in Compute configuration.** Compute never reads them;
  only the Teams Driver turns them into destination rules. Rejected.
- **Bind a Secret to one provider.** Secrets are untyped. A caller with
  `operate` on a Secret can already bind it into any provider's Agent
  configuration and deploy it, so a lookup with another provider grants no new
  authority. A Secret type is a separate decision.

## References

- [RFC-20261118-channel-egress](20261118-channel-egress.md)
- [ChannelDriver contract](../../docs/reference/drivers/channel.md)
- [Driver selection](../../docs/reference/drivers/selection.md)
- [Plugin Driver installation](../../packages/occ/src/index.ts), the existing
  multi-Driver precedent (`installPluginDrivers`)

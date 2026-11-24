---
status: Proposed
implementation_status: Not implemented
author: miguelbranco80
---

# Proposal: Per-provider Channel Drivers in OCC

- **ID:** RFC-20261120-channel-provider-drivers
- **Created:** 2026-11-20
- **Last updated:** 2026-11-24
- **RFC PR:** pending
- **Implementation plan:** to follow with the implementation
- **Related:** [RFC-20261118-channel-egress](20261118-channel-egress.md),
  [Teams channels RFC](https://github.com/raw-labs/openclaw-enterprise/pull/29),
  [raw-labs/openclaw-enterprise#39](https://github.com/raw-labs/openclaw-enterprise/pull/39),
  [ChannelDriver contract](../../docs/reference/drivers/channel.md)

## Summary

OpenClaw Control Plane (OCC) installs one Channel Driver for each channel
provider, the same provider-to-Driver set that Kubernetes Compute already
receives. A directory lookup names its provider, and OCC sends the request only
to that provider's Driver. A lookup without a provider is a Slack lookup, so
existing Slack clients keep working. The Driver lookup input gains optional
`context`: lookup fields that each provider's Driver defines and validates.
Installation YAML gets an optional `drivers.channel` list that selects the
bundled Channel Drivers and carries their configuration.

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
- Each provider defines and validates its own lookup fields.
- Existing Slack lookup requests, which name no provider, keep working.
- Channel Driver configuration has one owner: its Driver selection.

## Non-goals

- The Teams Channel Driver. [raw-labs/openclaw-enterprise#39](https://github.com/raw-labs/openclaw-enterprise/pull/39)
  delivers it on top of this contract.
- Third-party Channel Driver packages. Only bundled Drivers are selectable.
- Typed Secrets. A Secret is not bound to one provider; see
  [Rationale](#rationale-and-alternatives).
- Changes to destination rules, Envoy enforcement or listener allocation. An
  [Agent Gateway channel proxy](https://github.com/openclaw/openclaw-enterprise/pull/6842)
  applies to each provider's destinations unchanged; Channel Drivers still
  declare them.

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
```

| Selection       | Provider | Configuration         |
| --------------- | -------- | --------------------- |
| `slack-channel` | `slack`  | Empty, closed schema. |

If the list is absent, composition installs every bundled Driver with default
configuration. If the list is present, composition installs only the listed
Drivers; an Agent that enables another provider fails admission because no
Driver resolves it. Each Driver declares a closed configuration schema, so
startup refuses unknown fields. The startup configuration inspection reports
the accepted values, like other Driver selections. The Teams Driver adds a
`teams-channel` selection whose configuration holds its storage hosts.

### Directory lookup

The API request names the `provider`. A request without `provider` is a Slack
lookup: clients written before provider selection, including a Console tab that
was open during an upgrade, keep their behavior. OCC authorizes the caller and
the Secret as it does today, then selects the installed Driver for the
provider. If no Driver is installed for the provider, OCC reports that lookup
is unavailable, not a provider response error.

Optional `context` carries the provider's own lookup fields, such as a tenant
ID. OCC checks only the bounded shape that the API defines and does not
interpret the keys. Each Driver defines the keys that it accepts and validates
them before it sends a request. A Driver that defines no context, such as
Slack, refuses any context.

### Credential validation and deployment admission

OCC runs `validateCredentials` for each installed Driver that implements it. A
validator reads only its own provider's configuration section and returns when
that section is absent or disabled. Deployment admission records the installed
Driver list and validator identities that it checked, and it refuses the
deployment if they changed before the revision is recorded.

## Interface changes

### APIs

| Change  | Operation                                                 | Behavior and contract change                                                                                                                                                                    |
| ------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changed | `POST /namespaces/{namespaceId}/channel-directory/lookup` | Search and ID hydration bodies accept optional `provider`; omitted means `slack`. Optional `context` holds at most eight nonsecret strings. An uninstalled provider returns `501 NOT_IMPLEMENTED`. |

### IAM

No changes. Lookup still requires the target edit permission and `operate` on
the exact same-Namespace Secret.

### Database entities

No changes.

### Driver contracts

- [`ChannelDirectoryLookupInput`](../../packages/contracts/src/drivers/channel/index.ts)
  gains `context?: Readonly<Record<string, string>>`. It does not gain a
  `provider` field. A Driver rejects missing, unknown or malformed context
  before it sends a request; a Driver that defines no context rejects any
  context.
- `ChannelDirectoryError` gains the `invalid_request` reason for caller input
  that a Driver refuses, such as context or a cursor from another lookup. OCC
  returns it as `400 INVALID_REQUEST`, not as a provider failure.
- `ChannelProviderDriver` moves from the controller to the shared contracts
  package and is exported from its top-level index.
- OCC installs Channel Drivers per provider with `installChannelDrivers`.
  Single-Driver `channel` selection is refused.
- `validateCredentials` must read only the Driver's own provider section.
- The bundled Drivers expose closed configuration schemas through the existing
  `DriverImplementation` definition.

## Simplifications

This proposal replaces the single selected Channel Driver, and the composite
Driver that the first Teams draft needed, with the provider mapping that
Compute already uses. A simpler option would keep one selected Driver and
dispatch inside it. That option keeps a composite and its incorrect
`enableRouting` result.

## Acceptance Criteria

- **AC-1 — Lookup reaches one provider:** Given two installed providers, when
  an authorized caller looks up one provider through the real API, then only
  that provider's Driver receives the request, with its context. A lookup for
  an uninstalled provider returns `501 NOT_IMPLEMENTED`. Verify with the OCC
  API channel directory integration test.
- **AC-2 — Provider-less requests stay Slack:** When a caller omits `provider`
  in a search or ID hydration request, then the Slack Driver serves it. Verify
  with the OCC API channel directory integration test.
- **AC-3 — Context stays provider-owned:** When a Slack lookup, with or without
  `provider`, has any context, the Driver refuses it with `400 INVALID_REQUEST`
  before it sends a request. Verify with the OCC API channel directory
  integration test.
- **AC-4 — Selection controls installation:** Given an empty `drivers.channel`
  list, when an Agent enables Slack, then routing resolution refuses it.
  Unknown or malformed configuration fails startup. Verify with the Channel
  Driver startup integration test.

## Delivery and verification

The implementation follows this proposal in a separate change with its primary
implementation plan. The Teams Driver, its lookup context and its
`drivers.channel` configuration follow in
[raw-labs/openclaw-enterprise#39](https://github.com/raw-labs/openclaw-enterprise/pull/39).

- **AC-1, AC-2, AC-3:** the OCC API channel directory integration test must pass
  through the real Fastify API, OCC and the bundled Slack Driver, with an HTTP
  fixture at the Slack boundary.
- **AC-4:** the Channel Driver startup integration test must pass through the
  real Installation loader.

## Rationale and alternatives

- **Provider field in the Driver input.** Every Driver would receive a field
  that composition already decides. It also needs a composite Driver to
  dispatch. Rejected.
- **Require `provider` in the API.** Existing Slack clients omit it; requiring
  it turns their searches and saved-ID lookups into `400` responses after an
  upgrade. Rejected after maintainer review.
- **Typed provider fields in the API.** A union of per-provider request bodies
  makes OCC and the API change for each new provider. `context` keeps the field
  definitions with the Driver that uses them. Rejected.
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

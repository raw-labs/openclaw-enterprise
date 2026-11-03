---
status: Proposed
implementation_status: Not implemented
author: miguelbranco80
---

# Proposal: Preserve native plugin permissions when switching Harness

- **ID:** RFC-0019
- **Created:** 2026-11-03
- **Implementation candidate:** [Fork PR #15](https://github.com/raw-labs/openclaw-enterprise/pull/15)

## Summary

Keep authored native `plugins.allow` and `plugins.deny` unchanged when the user
switches Harness. If the selected Harness requires a blocked plugin, explain the
conflict and require an explicit policy edit instead of silently changing access.

## Problem and scope

Adding Codex can turn an unrestricted allowlist into a restrictive Codex-only
list. Removing Codex can empty that list, making it unrestricted. A Harness switch
should change runtime wiring, not quietly narrow or widen plugin permissions.

This proposal is an OpenClaw Enterprise (OCE) admission rule. It complements the
existing [native plugin policy](0009-native-plugin-tool-policy.md) and
[policy-enforcement RFC](0014-plugin-policy-enforcement.md); it does not redesign
native tool policy or add a permission service.

## Proposal

### Preserve policy, change wiring

The Create Agent workflow may add or remove Codex runtime wiring when the Harness
changes, but it must preserve authored allow/deny lists. A missing or empty
allowlist remains unrestricted. Do not insert a required plugin into a restrictive
list or remove its denial automatically.

Codex requires `codex`. Native OpenClaw requires the plugin for its selected
supported model provider, currently `openai` or `anthropic`. Refuse when global
plugin disablement, an explicit denial, allowlist exclusion, a disabled required
entry or duplicate normalized required-entry aliases makes that requirement
ambiguous or blocked.

A refusal names the required plugin and tells the operator to edit **Advanced
settings → Configuration JSON**, preserving existing entries. For example,
switching a `["codex"]` allowlist to OpenClaw/OpenAI requires the operator to
choose a compatible policy, such as `["codex", "openai"]`, before saving.

### Enforce at the server boundary

The Console refuses an incompatible selection before writes. Kubernetes Compute
also checks the existing Harness admission path for Agent save/update, deployment,
and fresh or stored provisioning/retry. A direct API call or an older saved plan
must not bypass the rule. Recheck queued work before Secret reads, credential
materialization or Kubernetes effects; retain existing exact-resource and
initiating-actor authorization.

Do not add persisted workaround state, a remembered previous allowlist or another
Driver interface. A refusal must leave authored policy unchanged and must not
queue a partial deployment.

### Native compatibility

The pinned native Gateway can accept some configurations and auto-enable a
provider in memory despite an allowlist exclusion. Configuration acceptance is
not proof of successful provider execution. This proposal intentionally applies
a stricter OCE rule: required plugin permission must be explicit before admission.
Existing Configurations and stored plans may need an operator edit; do not add a
silent compatibility grant.

## Delivery and verification

Exercise Harness switches with unrestricted, restrictive, denied, disabled and
ambiguous required-plugin settings. Verify unchanged allow/deny values, clear
repair guidance, zero writes on Console refusal and successful explicit repair.
Cover direct API, stored-plan replay, retry and worker paths as well as the UI.

Use real PostgreSQL and Kubernetes/Secret Drivers to observe zero Secret reads
and infrastructure writes after server refusal. In the allowed control, verify
model credentials reach only the selected Harness, not the separate Gateway.
Provider execution is a separate proof from configuration admission.

## Alternatives and decision

Automatically repairing permissions feels convenient but turns a runtime choice
into an implicit authorization change. Trusting native auto-enable behavior alone
leaves OCE's declared policy misleading. Prefer preserving policy and refusing
incompatible selections. Harness and plugin-policy maintainers must approve the
stricter admission rule and its effect on existing plans.

## Source and review status

Prepared from [candidate source `65dc3e90e`](https://github.com/raw-labs/openclaw-enterprise/blob/65dc3e90ecb0799ddeb22899bbbc41a5548d37a1) and its current documentation.
Candidate code exists in the linked implementation PR, not in this documentation
branch. `Not implemented` describes this review baseline; it does not erase the
candidate's delivery history or certify that the candidate meets this proposal.
Design approval and implementation qualification remain separate. This PR changes
neither the existing implementation nor the integration bundle.

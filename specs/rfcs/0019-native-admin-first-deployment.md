---
status: Proposed
implementation_status: Not implemented
author: miguelbranco80
---

# Proposal: Prepare native administration on first deployment

- **ID:** RFC-0019
- **Created:** 2026-11-03
- **Draft implementation:** [PR #12](https://github.com/raw-labs/openclaw-enterprise/pull/12)

## Summary

Prepare the exact Agent origin and existing native administrator device policy
before admitting a deployment revision. An operator should be able to open an
already-enabled native UI after the first deployment, without editing reusable
Configuration JSON and deploying again.

## Problem and scope

Standard OpenClaw and Codex Configurations already enable native Control UI, but
a reusable Configuration cannot know a future Agent's allocated browser origin.
OpenClaw Control Plane (OCC) knows that identity. Kubernetes Compute owns native
Gateway policy. Preparation must join those inputs without moving Driver policy
into OCC or changing saved Configuration.

Preparation applies only when the Installation enables native administration.
It does not enable native administration by default, grant human permissions or
change native terminal policy.

## Proposal

Add optional, synchronous, side-effect-free `ComputeDriver.configureAgent`.
It accepts a read-only deployment Configuration and trusted context containing
`nativeAdminOrigin`, then returns the prepared copy. Drivers that omit the hook
keep their existing behavior. Do not use the metadata-only `admitRevision` hook
to transform Configuration.

OCC derives the origin from trusted Installation routing, Namespace and allocated
Agent identity, not request headers or Agent JSON. During deployment, it passes
a frozen, Sandbox-adjusted copy to Compute, then applies logging configuration,
validates the result and freezes the immutable admitted revision. Ordinary
Agent-save validation does not call this hook.

For Kubernetes with private routing and enabled Control UI, prepare `publicOrigin`,
the exact allowed Agent origin, the existing machine trusted-proxy identity and
`operator.admin` device auto-approval. Preserve compatible settings. Refuse
conflicting authentication, approval scopes, public origin or another isolated
Agent's origin with a setting-specific error. Do not overwrite authored policy
or widen origin trust merely to make deployment succeed.

Respect Installation disablement and explicit Agent UI or device-approval
opt-outs. API deployment and guided worker provisioning must use the same trusted
inputs and preparation order. Enabled malformed origin settings fail startup;
API and worker configuration must agree.

Do not change saved Configuration values or generations, Presets, Secret bindings
or historical revisions. Existing Agents adopt preparation only on their next
explicit deployment; no automatic rollout or database migration is proposed.

## Authority and interactions

The existing private human route still requires a valid session and exact-Agent
`administer` authority. Retain its bounded WebSocket authorization lease. This
proposal does not cancel commands that the Gateway has already accepted.

Preparation uses the machine trusted-proxy identity. If per-person roles are
enabled, device approval must preserve each person's assigned scopes and identity.
It must not grant a limited user administrator scopes or replace their identity
with the machine identity. That combination requires a compatible identity and
device-approval policy.

## Required verification

Verify first deployment through the actual API and guided worker path, including
replay, denied callers, opt-outs and each conflict. Check saved Configuration,
generations and old revisions remain unchanged. Verify compatible explicit
settings remain intact.

Exercise native browser access on first deployment using the packaged Gateway
behind the installed Kubernetes routing path. Verify origin checks and native
authorization as well as successful page access. Verify that the prepared
Configuration still supports normal model execution.

## Alternatives

Manual JSON preparation avoids a new hook but retains the first-deployment
problem. Hardcoding Kubernetes policy in OCC breaks Driver ownership. Prefer
the optional Compute transformation to keep Agent identity in OCC and native
Gateway policy in the selected Driver.

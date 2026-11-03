---
status: Proposed
implementation_status: Not implemented
author: miguelbranco80
---

# Proposal: Prepare native administration on first deployment

- **ID:** RFC-0019
- **Created:** 2026-11-03
- **Implementation candidate:** [Fork PR #12](https://github.com/raw-labs/openclaw-enterprise/pull/12)

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

This remains the existing Installation-enabled native-admin pilot. It does not
enable the pilot by default, grant new human permissions, change native terminal
policy, or approve the broader native execution design.

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

The selected candidate prepares the existing machine identity. Per-person native
roles in implementation #1 need a separately reviewed combination: administrator
auto-approval must not silently grant a limited human administrator scopes or
replace their identity with the machine identity.

## Delivery and verification

Verify first deployment through the actual API and guided worker path, including
replay, denied callers, opt-outs and each conflict. Check saved Configuration,
generations and old revisions remain unchanged. Verify compatible explicit
settings remain intact.

Installed Gateway/browser access and current-image Kubernetes/model checks are
separate from source or fixture proof. Record the exact tested revision and
remaining gaps in the implementation, not as implied acceptance of this RFC.

## Alternatives and decision

Manual JSON preparation avoids a new hook but retains the first-deployment
problem. Hardcoding Kubernetes policy in OCC breaks Driver ownership. Prefer
the optional Compute transformation. Compute and native-admin owners must decide
whether to approve automatic administrator preparation within the enabled pilot;
existing candidate code does not settle that decision.

## Source and review status

Prepared from [candidate source `37fac70df`](https://github.com/raw-labs/openclaw-enterprise/blob/37fac70dfb784351544189ad07909588b327ef47) and its current documentation.
Candidate code exists in the linked implementation PR, not in this documentation
branch. `Not implemented` describes this review baseline; it does not erase the
candidate's delivery history or certify that the candidate meets this proposal.
Design approval and implementation qualification remain separate. This PR changes
neither the existing implementation nor the integration bundle.

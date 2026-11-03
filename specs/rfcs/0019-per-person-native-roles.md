---
status: Proposed
implementation_status: Not implemented
author: miguelbranco80
---

# Proposal: Per-person native roles

- **ID:** RFC-0019
- **Created:** 2026-11-03
- **Implementation candidate:** [Fork PR #1](https://github.com/raw-labs/openclaw-enterprise/pull/1)

## Summary

Let an administrator assign each person a configured OpenClaw role on one Agent.
OpenClaw Enterprise (OCE) controls who may enter that Agent. OpenClaw controls
what the person may do inside it. Permission to manage an OCE deployment remains
separate from permission to use its native interface.

## Problem

The initial sharing path admits people through a shared native administrator
identity. Sharing an Agent should not require giving every person administrator
access. The broader [Agent access RFC](0010-agent-access.md) covers identity and
sharing; this proposal isolates the native Gateway-entry decision for review.

## Proposal

### Assignment and role ownership

Add Agent `use` permission and an exact human-to-Agent assignment with an opaque
`runtimeRole` name. Persist the assignment through the existing IAM policy API,
with one runtime-role assignment per person and Agent. Sharing administration
still requires the existing policy-management authority; `use` does not permit
changing assignments, deployment settings or Secrets.

OpenClaw's active `gateway.roles` configuration defines native role names and
permissions. OCE exposes those roles in the sharing editor; it does not maintain
a second native permission engine. Show when saved role definitions differ from
the deployed ones. A role that the active revision cannot supply is unavailable,
not a reason to fall back to administrator access. Preserve the existing
administrator path only for an explicit administrator assignment.

### Browser admission and revocation

For each connection, OCE verifies the signed-in person, exact Agent assignment
and active role policy. The trusted proxy removes browser-supplied identity,
role and scope headers. It sends the verified stable person identity, assigned
role and a digest of the selected policy to the native Gateway. The Gateway
checks that policy before admitting the person and applies native permissions
to that person's profile. Missing identity, changed policy or unsupported
transport must refuse entry.

Recheck long-lived WebSocket authority and close a connection within 30 seconds
of a changed or revoked assignment. Reconnection must use current authority.
This is not a promise to cancel commands already accepted by the runtime.
Keep owner password/token access and the separate workspace service identity;
automation must not borrow a person's profile or lose its required platform
access when that person is revoked. Reserved service roles cannot be replaced
by user-authored role definitions.

## Limits

People still share the Agent's files, tools, plugins and provider accounts.
Native roles are permission checks, not process or credential isolation. This
proposal does not map Slack or Teams senders to people, add named teams, delegate
external accounts, or complete the wider Agent access RFC. It does not resolve
the interaction with automatic native-admin preparation in implementation #12;
that combination needs an explicit compatible identity and device policy.

## Delivery and verification

Keep execution details in the [existing role-assignment plan](https://github.com/raw-labs/openclaw-enterprise/blob/f30db5c4045cbf2c1f5eef4576361112535ed8b4/specs/plans/0047-agent-runtime-role-assignments.md). The
candidate also needs a bridge to the pinned native Gateway; its compatibility
and maintenance cost need runtime-owner review.

Required outcomes are distinct identities and allowed/denied native actions,
authorized assignment changes, downgrade and revocation of open connections,
refusal of forged headers or policy mismatches, and retained workspace service
access. Exercise the real sharing API, PostgreSQL, proxy and native Gateway;
UI fixtures alone do not prove those boundaries. Qualify the actual packaged
runtime and show the sharing workflow in the Console.

## Alternatives and decision

Keeping shared administrator access is simpler but cannot provide limited
sharing. Reimplementing native permissions in OCE creates two authorities that
can disagree. Prefer exact OCE assignments to native roles. IAM and native-runtime
maintainers must approve the assignment and identity bridge; this proposal does
not record their acceptance.

## Source and review status

Prepared from [candidate source `f30db5c40`](https://github.com/raw-labs/openclaw-enterprise/blob/f30db5c4045cbf2c1f5eef4576361112535ed8b4) and its current documentation.
Candidate code exists in the linked implementation PR, not in this documentation
branch. `Not implemented` describes this review baseline; it does not erase the
candidate's delivery history or certify that the candidate meets this proposal.
Design approval and implementation qualification remain separate. This PR changes
neither the existing implementation nor the integration bundle.

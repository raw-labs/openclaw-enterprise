---
status: Proposed
implementation_status: Not implemented
author: miguelbranco80
---

# Proposal: Per-person native roles

- **ID:** RFC-0029
- **Created:** 2026-11-03
- **Draft implementation:** [PR #1](https://github.com/raw-labs/openclaw-enterprise/pull/1)

## Summary

Let an administrator assign each person a configured OpenClaw role on one Agent.
OpenClaw Enterprise (OCE) controls who may enter that Agent. OpenClaw controls
what the person may do inside it. Permission to manage an OCE deployment remains
separate from permission to use its native interface.

## Problem

Sharing currently admits people through a shared native administrator identity.
Sharing an Agent should not require giving every person administrator access. The broader [Agent access RFC](0010-agent-access.md) covers identity and
sharing. This proposal adds per-person roles at Gateway entry.

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
Closing a connection does not cancel commands already accepted by the runtime.
Keep owner password/token access and the separate workspace service identity;
automation must not borrow a person's profile or lose its required platform
access when that person is revoked. Reserved service roles cannot be replaced
by user-authored role definitions.

## Limits

People still share the Agent's files, tools, plugins and provider accounts.
Native roles are permission checks, not process or credential isolation. This
proposal does not map Slack or Teams senders to people, add named teams or
delegate external accounts. When combined with automatic native administration,
device approval must preserve the person's assigned role rather than grant
administrator scopes or substitute a shared machine identity.

## Required verification

Required outcomes are distinct identities and allowed/denied native actions,
authorized assignment changes, downgrade and revocation of open connections,
refusal of forged headers or policy mismatches, and retained workspace service
access. Exercise the real sharing API, PostgreSQL, proxy and native Gateway.
Package the identity bridge with the pinned native Gateway, verify policy-digest
compatibility, and exercise assignment changes through the Console.

## Alternatives

Keeping shared administrator access is simpler but cannot provide limited
sharing. Reimplementing native permissions in OCE creates two authorities that
can disagree. Exact OCE assignments to native roles keep entry authorization
and native permission enforcement with their existing owners.

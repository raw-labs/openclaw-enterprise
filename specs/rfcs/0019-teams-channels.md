---
status: Proposed
implementation_status: Not implemented
author: miguelbranco80
---

# Proposal: Microsoft Teams channels for Dedicated Agents

- **ID:** RFC-0019
- **Created:** 2026-11-03
- **Implementation candidate:** [Fork PR #2](https://github.com/raw-labs/openclaw-enterprise/pull/2)

## Summary

Let a Dedicated Agent receive Microsoft Teams messages and reply through the
native `msteams` plugin. OpenClaw Enterprise (OCE) supplies configuration, Secret
access and the public callback route. The native plugin and Microsoft SDK own
message handling and provider authentication.

## Problem and scope

Recognizing Teams configuration is not enough: operators need a bundled plugin,
a usable editor, a reachable callback and the right network destinations.
The initial target is Microsoft Public cloud with an app password and Kubernetes
Compute. Embedded execution, sovereign clouds, SSO, federated credentials and
Teams approval workflows are outside this proposal.

The existing implementation plan predates directory lookup and file settings.
This proposal includes those current additions rather than treating that plan's
original exclusions as the complete feature scope.

## Proposal

### Configure the Agent

Bundle the pinned native Teams plugin and its locked dependencies. Add a Console
editor for application and tenant IDs, an app-password Secret, one selected Team,
channel/member restrictions, mention requirements and independent personal-message
policy. Keep advanced native access shapes intact; unsupported shapes must not
be flattened into the simple editor.

Saving uses the existing Configuration and exact Secret-grant workflow. Deliver
the password only to this Agent's Gateway. Saving credentials does not prove
that Microsoft accepts them. OCE never grants Microsoft permissions on the
operator's behalf.

### Receive and send messages

Kubernetes Compute owns a separate public HTTPS channel listener with an exact
Agent-specific POST callback. Rewrite that path to the native Teams handler,
preserve Microsoft's Authorization header, and remove OCE cookies, API keys and
identity headers. The native SDK verifies the provider token. This route must
not expose the private administrative listener or other Gateway paths.

Bind the callback to the serving revision. A failed replacement must not remove
its predecessor's route. Disablement, stop and deletion remove the serving
callback and its authentication override through the existing lifecycle.

Reuse the channel proxy for declared Microsoft destinations, without depending
on the separate general Gateway-outbound proposal. Keep direct Gateway egress
fenced. Only Installation operators may configure proxy destinations or declare
that a reviewed proxy enforces guarded-download address checks; Agent JSON cannot
replace that policy. The managed proxy rejects private/reserved DNS answers and
pins the checked public IPv4 address. Native URL, redirect and credential-forwarding
checks remain active.

### Find channels and people

Extend the Channel Driver lookup contract with provider-owned context for the
application, tenant and selected Team. Require the caller's exact edit and Secret
permissions. Use Team-scoped Graph resource-specific consent, not tenant-wide
directory grants. Keep tokens in the API process and return bounded, sanitized
results. Persist native Team/channel IDs and user IDs, not display names.

Directory lookup is optional: consent failure, missing network access or provider
outage must leave exact-ID entry available. An Entra group ID used for Graph is
not interchangeable with the native Team ID used for message routing.

### Files

Allow an optional native `sharePointSiteId` setting to be saved, reopened and
cleared without altering other native configuration. This adds configuration,
not an OCE upload engine or a Microsoft permission grant. Explain that the native
channel-file path creates organization-scoped links, which can reach people
outside the Team who obtain them.

Incoming downloads require separately approved exact storage/redirect hosts and
native media/authentication restrictions. Do not forward provider credentials
merely because a storage host is reachable. Live file delivery remains a separate
qualification requirement.

## Delivery and verification

The [existing plan](https://github.com/raw-labs/openclaw-enterprise/blob/93c1dc4f24b9f544b26a451b71a0cfeff34be4fc/specs/plans/0045-teams-channel-support.md) is implementation history, not acceptance of this
expanded proposal. Before claiming support, exercise Console save/reopen and
Secret denial, native SDK rejection of invalid callbacks, real public TLS and
routing, live permitted/denied messages, replies, directory-consent failures,
attachments and serving-revision cleanup. Keep Slack behavior unchanged.
Kubernetes fixtures and local SDK checks do not prove live Microsoft delivery.

## Alternatives and decision

Manual native JSON avoids an editor but leaves packaging, routing and Secret
problems unresolved. A second OCE message service would duplicate the native
plugin. Prefer the native plugin with Compute-owned infrastructure. Channel and
Compute maintainers must review the public authentication boundary and expanded
lookup/file scope before adoption.

## Source and review status

Prepared from [candidate source `93c1dc4f2`](https://github.com/raw-labs/openclaw-enterprise/blob/93c1dc4f24b9f544b26a451b71a0cfeff34be4fc) and its current documentation.
Candidate code exists in the linked implementation PR, not in this documentation
branch. `Not implemented` describes this review baseline; it does not erase the
candidate's delivery history or certify that the candidate meets this proposal.
Design approval and implementation qualification remain separate. This PR changes
neither the existing implementation nor the integration bundle.

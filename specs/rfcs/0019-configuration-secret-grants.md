---
status: Proposed
implementation_status: Not implemented
author: miguelbranco80
---

# Proposal: Grant access to accepted Configuration Secrets

- **ID:** RFC-0019
- **Created:** 2026-11-03
- **Implementation candidate:** [Fork PR #13](https://github.com/raw-labs/openclaw-enterprise/pull/13)

## Summary

When the Console creates an Agent draft, grant that Agent access to every accepted
Secret binding in its saved Configuration, not just Secrets selected during the
current editor session. Reuse the existing exact Secret `operate` grant operation.

## Problem

A Preset can already contain environment Secret bindings. The Console can save
that Configuration and Agent while overlooking an inherited tool or model Secret.
Deployment then fails because the saved Agent lacks access to a Secret it is
configured to use.

This is a correction to the ordinary draft-creation workflow, not a new Secret
permission model or an automatic grant whenever any Configuration is edited.

## Proposal

After confirming the saved Configuration and Agent responses, enumerate the
saved Configuration's accepted `secretBindings`. Each source must be a nonempty
same-Namespace Secret reference with environment delivery. Reject an unsupported
binding; do not guess its target or grant a broader resource scope.

Deduplicate by Secret ID. For each distinct source, call the existing IAM helper
to ensure an exact `operate` binding for the saved Agent's service principal and
that Secret. Keep the separate existing model Secret/Credential Source grant
path. The result must not depend on which Secret pickers the user touched.

For example, a Preset binds both `TOOL_TOKEN` and `SECOND_TOKEN` to the same Secret.
Creating the Agent retains both destinations and ensures one exact Secret grant;
it neither creates a replacement Secret nor grants Namespace-wide access.

### Authorization and partial failure

The signed-in caller still needs the existing Installation administration/delegation
authority to create grants. Saving a Configuration does not confer that authority.
The IAM API remains responsible for authorization and audit. A refused grant must
not trigger an elevated fallback.

Agent/Configuration creation and the grant writes are not one atomic transaction.
If a grant fails or its response is uncertain, retain the saved resources and
show that credential access is not confirmed. Retry against the same Agent and
Configuration, reading exact existing bindings before adding missing ones. Do not
recreate the Agent, duplicate grants, silently change saved inputs or report
successful credential setup when only some grants succeeded.

The supported queued-provisioning path keeps worker-owned grant handling. Worker
delivery must recheck current authority: revocation after admission must prevent
Secret delivery even if earlier Console grant creation succeeded.

## Delivery and verification

Exercise ordinary Console creation from a Preset with inherited tool and model
Secrets, including repeated destinations. Observe the retained Configuration,
exact IAM bindings and successful deployment admission through the real API.
Verify an unauthorized grant leaves no binding, a failed retry preserves saved
IDs, and a repeated/uncertain request creates no duplicate resources.

Use PostgreSQL and the real worker/Compute path to verify that revocation before
queued delivery prevents Secret reads/materialization and workloads, while the
authorized case delivers the original value only to its intended workload.
UI fixtures and synthetic credentials do not establish genuine model execution.

## Alternatives and decision

Granting only newly picked Secrets misses inherited bindings. Granting access
to all Namespace Secrets is broader than the accepted Configuration requires.
Prefer enumeration of the confirmed saved bindings and the existing exact-grant
operation. This small proposal needs no new Driver contract or separate execution
plan; Console and IAM owners review the creation and retry behavior.

## Source and review status

Prepared from [candidate source `b698b30ab`](https://github.com/raw-labs/openclaw-enterprise/blob/b698b30abc802185905bf4ff28792a7b9cc1c04e) and its current documentation.
Candidate code exists in the linked implementation PR, not in this documentation
branch. `Not implemented` describes this review baseline; it does not erase the
candidate's delivery history or certify that the candidate meets this proposal.
Design approval and implementation qualification remain separate. This PR changes
neither the existing implementation nor the integration bundle.

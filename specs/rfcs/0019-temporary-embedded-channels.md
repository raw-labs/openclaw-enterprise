---
status: Proposed
implementation_status: Not implemented
author: miguelbranco80
---

# Proposal: Temporary channel trial in embedded OpenClaw

- **ID:** RFC-0019
- **Created:** 2026-11-03
- **Draft implementation:** [PR #17](https://github.com/raw-labs/openclaw-enterprise/pull/17)

## Summary

Allow an Installation administrator to make a temporary exception to OCE's rule
against running Slack in embedded OpenClaw. The administrator accepts that the
Agent's tools and Slack credentials share the same workload.

This is not a feature we want as the permanent product design. It is a temporary
administrator exception while OCE works out the mechanisms for supported native
execution, integrations and credential isolation. Keep this RFC and the exception
implementation in this fork; they must not be included in upstream OCE.

## Why Slack is normally blocked

In dedicated execution, the Gateway receives Slack messages and holds the Slack
tokens. A separate Agent worker calls the model and runs tools. The worker does
not receive the Slack tokens directly.

In embedded execution, one workload receives Slack messages, calls the model and
runs tools. The Slack tokens and model credential are available within that same
workload. Tools, plugins or subprocesses may be able to read them.

A Slack message can influence what the Agent does. Restricting who can send
messages or which tools can run helps limit behavior, but does not separate tool
execution from those credentials.

OCE therefore refuses Slack in embedded mode by default. This is an OCE security
rule, not a technical limitation of native OpenClaw or Slack.

## The temporary administrator exception

An administrator who needs to evaluate embedded OpenClaw with Slack can enable
the trusted Kubernetes Compute setting
`runtime.channels.experimentalEmbeddedChannels: true`. It defaults to false.
An Agent's Configuration JSON cannot enable it.

The exception permits the shared workload; it does not make that workload safe
from reading its own credentials. Dedicated native execution already exists as
an experimental path. This exception does not replace work on that path or
establish equivalent credential isolation.

Use the existing Agent API and worker. Check the setting when accepting a
request, preparing its workload and activating it. Advertise embedded provisioning
only when the exception is enabled.

Keep exact IAM checks, same-Namespace Secret access, revision ownership, Pod
controls and audit. Do not grant access to another Agent's Secrets or widen
network permissions. Existing proxy settings are not a containment guarantee:
embedded processes may bypass them through their existing direct egress.

## End the exception

Turning the setting off refuses later requests, preparation and activation. It
does not stop an already running Agent or revoke its credentials. Stop and delete
must remain available while the setting is off.

To end an evaluation, turn the setting off, stop the trial Agents and separately
revoke or rotate their provider credentials. Stopping retains private Gateway
state and Namespace Secrets; it does not wipe cached credentials.

Remove the flag, embedded-channel exception, provisioning advertisement and trial
documentation when the evaluation no longer needs them. Do not turn this
workaround into a permanent supported mode or send it upstream.

## Required verification

Through the actual API and worker, verify default refusal, administrator opt-in,
rejection of Agent-authored opt-in, exact Secret access, revision replacement and
disablement. Verify that stop and delete still work after disablement.

Before claiming the evaluation works, verify a real model turn and Slack message
delivery with the packaged runtime and authorized provider credentials. Lifecycle
fixtures do not prove either outcome.

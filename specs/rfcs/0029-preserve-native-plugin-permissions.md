---
status: Proposed
implementation_status: Not implemented
author: miguelbranco80
---

# Preserve native plugin permissions when switching Harness

## Decision

Keep authored `plugins.allow` and `plugins.deny` unchanged when the user switches
Harness in Create Agent. Change runtime wiring separately, and use the existing
server admission rules. Do not add stricter required-plugin validation to this
editor fix.

Implementation: [PR #15](https://github.com/raw-labs/openclaw-enterprise/pull/15).
The proposal remains subject to maintainer review; an unmerged implementation is
not release evidence.

## Problem

Adding Codex can turn a missing or empty allowlist into a restrictive Codex-only
list. Removing Codex can empty a Codex-only list, making it unrestricted. Both
changes alter plugin permissions without an explicit policy edit.

Selecting a Harness should change how the Agent runs, not silently narrow or
widen its authored allow/deny lists.

## Behavior and ownership

The Console's Create Agent form owns changes to the draft Configuration. When
Harness selection changes:

- Preserve `plugins.allow` and `plugins.deny`, including omitted fields, empty
  arrays, unrelated plugin IDs and their order.
- Add or remove Codex runtime wiring without inserting Codex into the allowlist
  or removing it from either list.
- Preserve an explicitly disabled Codex entry through a Harness round trip.
  When no entry exists, selecting Codex supplies the normal runtime defaults.
- Keep unrelated Configuration fields and ordinary draft restoration intact.

An explicit JSON edit or applying a different Preset can replace policy. Merely
switching Harness cannot.

Kubernetes Compute remains the owner of its admission decisions. The Console
uses the existing preflight and provisioning paths rather than duplicating those
rules in the browser. Direct API calls, deployment, queued work, authorization
and credential handling keep their existing contracts. This change adds no
Driver interface, persisted state, remembered policy or worker validation layer.

## Saved settings and effective runtime

A saved `plugins.entries.codex.enabled: false` is accepted for Dedicated Codex.
Its runtime overlay enables the required Codex plugin at startup without changing
the saved Configuration. Preserving the authored setting does not mean the
running Codex plugin stays disabled.

Existing admission rejects settings that prevent that Gateway from starting,
including `plugins.enabled: false`, a denial of Codex, or a nonempty allowlist
that excludes Codex. The Console leaves those settings editable when admission
refuses them; it does not silently repair the lists.

OpenClaw's model-provider admission also stays unchanged. This proposal does not
add an explicit-permission rule for the OpenAI or Anthropic provider plugins.
Configuration acceptance alone does not prove provider loading or a model turn.
The [Harness reference](../../docs/reference/harness-execution.md#native-runtime-selection)
owns current runtime and admission behavior.

## Alternatives and tradeoffs

**Automatically add or remove required IDs.** This makes Harness switching
convenient but can change a restrictive allowlist into unrestricted access, or
restrict an unrestricted Configuration. Keep runtime wiring separate instead.

**Reject every disabled or excluded required plugin before saving.** This makes
saved intent more literal, but creates a broader admission policy and rejects
some settings that the runtime accepts and corrects. It also duplicates server
rules in the Console. That policy is outside this editor fix.

**Discard an explicit disabled entry when changing Harness.** This simplifies
wiring cleanup but loses authored state during a round trip. Preserve it and
explain the effective-runtime distinction instead.

## Verification

Exercise the real Console form and supported API save/readback path with missing,
empty and restrictive allowlists, a denylist, unrelated plugin entries and an
explicit disabled Codex entry. Verify unchanged policy after switching to Codex
and back, explicit JSON edits, navigation and restored drafts.

Verify that a disabled Codex entry saves without an editor repair. Retain existing
server admission coverage for actual Gateway blockers; do not replace it with
new browser-only policy tests. Demonstrate that the original editor fails the
permission-preservation regression tests.

Rebuild and inspect the matching Storybook scenarios. Capture Harness switching
and the unchanged Configuration, including the accepted disabled-entry path.
Storybook simulates API/runtime state; browser/API tests do not establish live
plugin execution, credential delivery or a model turn.

---
status: Proposed
implementation_status: Not implemented
author: miguelbranco80
---

# Proposal: Custom Installation profiles and readable Preset starters

- **ID:** RFC-0019
- **Created:** 2026-11-03
- **Implementation candidate:** [Fork PR #11](https://github.com/raw-labs/openclaw-enterprise/pull/11)

## Summary

Let operators render a trusted custom Installation profile, choose whether to
seed bundled Presets, and use a readable custom Preset as the Console's starter.
Extend the existing profile renderer and Preset selection; do not add a new
profile system or install arbitrary Driver code.

## Problem and scope

The [Installation profiles RFC](0018-installation-profiles-design/index.md)
defines the bundled `openclaw` and `codex` families. Operators also need to select
a supported Plugin Driver and supply their own Presets. A Namespace with only
custom Presets should still have a useful Create Agent shortcut.

This proposal covers those additions, not a replacement for the original profile
architecture, resource provisioning, or a user-selectable Console profile catalog.

## Proposal

### Trusted profile input

Add `--profile-file` to the existing renderer. The file replaces the bundled
profile input and must name the same `openclaw` or `codex` family selected by
`--profile`. Require the documented shape and reject unknown fields, unreadable
files, invalid JSON and mismatched names. Do not silently use the bundled profile
when custom input fails. A failed rerender must remove stale generated outputs
so that callers cannot mistake them for the new result.

Copy only the supported Plugin Driver selection and its configuration into the
Installation. Accept the bundled `occ-plugin` and `codex-plugin` selections;
this does not load external Driver modules. Configuration must be an object,
but the selected Driver still validates its own options at controller startup.
Successful rendering does not prove startup or deployment.

Descriptive profile metadata, including `recommendedPreset`, is not a second
source of deployment policy and does not choose the Console starter. Hosted
catalog credential and discovery-network requirements follow the selected
Plugin Driver, independently of the profile family. Runtime credentials remain
owned by each Agent.

### Preset seeding

Add `presets.includeDefaults`, defaulting to `true`. When false, seed only
explicitly listed files; with no files, seed none. Preserve saved and edited
Presets across startup and upgrades. Disabling seeding must not delete existing
resources or overwrite custom Configuration. The renderer checks paths; startup
still needs readable, valid Preset files.

### Console starter

Prefer a readable Preset named `default-codex`. Otherwise choose the first
readable Preset using case-insensitive browser-locale name order, with exact-name
ordering to break ties. Authorize the exact Preset read; listing visibility alone
is insufficient. Show a custom starter's name before the user selects it.

If no Preset is readable, keep the ordinary chooser/empty state. Keep variable
entry, editable drafts, navigation and explicit cancellation behavior. Switching
starters must not silently discard an unsaved draft.

## Delivery and verification

Verify both renderer entry points, strict input refusal and stale-output removal.
Exercise default/custom/no-default seeding and real PostgreSQL restart/upgrade
preservation. Check that hosted prerequisites follow the Plugin Driver rather
than the profile name. Exercise exact-read denial, unreadable `default-codex`,
custom names, ties and retained drafts through the Console/API.

These outcomes belong to the linked implementation. Rendering and UI fixtures
do not qualify installed infrastructure, images or model execution.

## Alternatives and decision

Editing bundled profiles works locally but creates changes to carry across every
upstream update. Requiring a readable `default-codex` forces operators to retain
a stock naming convention. Prefer a validated input file and a readable-starter
fallback. Installation and Console maintainers must review those two contracts;
profile metadata must not become an implicit permission or provisioning mechanism.

## Source and review status

Prepared from [candidate source `5acf92b89`](https://github.com/raw-labs/openclaw-enterprise/blob/5acf92b89f9053fec747a802e3790822a5b4340d) and its current documentation.
Candidate code exists in the linked implementation PR, not in this documentation
branch. `Not implemented` describes this review baseline; it does not erase the
candidate's delivery history or certify that the candidate meets this proposal.
Design approval and implementation qualification remain separate. This PR changes
neither the existing implementation nor the integration bundle.

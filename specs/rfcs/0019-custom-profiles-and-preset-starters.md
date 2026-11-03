---
status: Proposed
implementation_status: Not implemented
author: miguelbranco80
---

# Proposal: Custom Installation profiles and Preset quick-start

- **ID:** RFC-0019
- **Created:** 2026-11-03
- **Draft implementation:** [PR #11](https://github.com/raw-labs/openclaw-enterprise/pull/11)

## Summary

Let operators render a trusted custom Installation profile and choose whether to
create bundled Presets at startup. Let users start an Agent from a custom Preset
they have permission to read.

## Problem and scope

The [Installation profiles RFC](0018-installation-profiles-design/index.md)
defines the bundled `openclaw` and `codex` families. Operators also need to select
a supported Plugin Driver and supply their own Presets. A Namespace with only
custom Presets should still have a useful Create Agent shortcut.

The scope is custom profile input, Preset seeding and starter selection. Resource
provisioning and a user-selectable Console profile catalog are out of scope.

## Proposal

### Trusted profile input

Add `--profile-file` to the existing renderer. The file replaces the bundled
profile input and must name the same `openclaw` or `codex` family selected by
`--profile`. Require the documented shape and reject unknown fields, unreadable
files, invalid JSON and mismatched names. Do not silently use the bundled profile
when custom input fails. A failed rerender must remove stale generated outputs
so that callers cannot mistake them for the new result.

Copy the selected Plugin Driver and its configuration into the Installation.
Select either bundled Plugin Driver, `occ-plugin` or `codex-plugin`. Custom
profiles cannot install additional Plugin Drivers. If supplied, `configuration`
must be a JSON object; the selected Driver validates its options at controller
startup.

Profile metadata, including `recommendedPreset`, describes the profile; it does
not configure the deployment or choose the Console starter. When the selected
Plugin Driver uses a hosted catalog, its credential and network access
requirements apply regardless of the profile family. Runtime credentials remain
owned by each Agent.

### Preset seeding

Add `presets.includeDefaults`, defaulting to `true`. When false, seed only
explicitly listed files; with no files, seed none. A custom file takes precedence
over a bundled Preset with the same name. Reject the configuration if two custom
files define Presets with the same name.

Preserve saved and edited Presets across startup and upgrades. Disabling seeding
must not delete existing resources or overwrite custom Configuration. The
renderer checks paths; the controller must be able to read and validate the
Preset files at startup.

### Console starter

For the quick-start shortcut, choose the first Preset the current user has
permission to read, using case-insensitive browser-locale name order, with
exact-name ordering to break ties. No Preset name gets special priority.
Check permission to read the selected Preset when loading it; appearing in the
list alone is insufficient.
Show the starter's name before the user selects it.

If the user cannot read any Preset, disable quick-start and show the ordinary
chooser's empty state. Keep variable entry, editable drafts, navigation and
explicit cancellation behavior. Switching starters must not silently discard an
unsaved draft.

## Required verification

Verify the renderer's CLI and programmatic entry points, rejection of invalid
input and removal of stale outputs.
Exercise default/custom/no-default seeding and real PostgreSQL restart/upgrade
preservation. Verify that a custom file takes precedence over a bundled Preset
with the same name and that duplicate names across custom files are rejected.
Check that hosted catalog requirements follow the Plugin Driver rather than the
profile name. Through the Console/API, verify denied reads, Presets the user
cannot read, name ordering, ties and retained drafts. Verify that bundled Preset
names receive no priority over custom names.

## Alternatives

Editing bundled profiles works locally but creates changes to carry across every
upstream update. Requiring a particular Preset name forces operators to retain
a stock naming convention. Prefer a validated input file and a starter selected
by name order from Presets the user can read. Keep descriptive profile metadata
separate from permissions and provisioning settings.

---
status: Proposed
implementation_status: Not implemented
author: miguelbranco80
---

# Proposal: Custom Installation profiles and readable Preset starters

- **ID:** RFC-0019
- **Created:** 2026-11-03
- **Draft implementation:** [PR #11](https://github.com/raw-labs/openclaw-enterprise/pull/11)

## Summary

Let operators render a trusted custom Installation profile, choose whether to
seed bundled Presets, and use a readable custom Preset as the Console's starter.

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

Copy only the supported Plugin Driver selection and its configuration into the
Installation. Accept the bundled `occ-plugin` and `codex-plugin` selections;
this does not load external Driver modules. Configuration must be an object,
but the selected Driver still validates its own options at controller startup.

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

For the quick-start shortcut, choose the first Preset the current user has
permission to read, using case-insensitive browser-locale name order, with
exact-name ordering to break ties. No Preset name gets special priority.
Authorize the exact Preset read; listing visibility alone is insufficient.
Show the starter's name before the user selects it.

If no Preset is readable, keep the ordinary chooser/empty state. Keep variable
entry, editable drafts, navigation and explicit cancellation behavior. Switching
starters must not silently discard an unsaved draft.

## Required verification

Verify both renderer entry points, strict input refusal and stale-output removal.
Exercise default/custom/no-default seeding and real PostgreSQL restart/upgrade
preservation. Check that hosted prerequisites follow the Plugin Driver rather
than the profile name. Exercise exact-read denial, inaccessible Presets, name
ordering, ties and retained drafts through the Console/API. Verify that bundled
Preset names receive no priority over custom names.

## Alternatives

Editing bundled profiles works locally but creates changes to carry across every
upstream update. Requiring a particular Preset name forces operators to retain
a stock naming convention. Prefer a validated input file and a starter selected
by name order from accessible Presets. Keep descriptive profile metadata separate
from permissions and provisioning settings.

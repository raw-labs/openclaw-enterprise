# Maintain the downstream integration branch

The fork's `codex/raw-integration` combines selected feature revisions without
changing their upstream-facing branches. Its authoritative input record is
[`scripts/integration/selection.json`](../../scripts/integration/selection.json).
Fork `main`, feature PRs, releases and downstream repositories are outside this
procedure. Feature PRs remain open; local Git composition does not authorize
merging or closing them on GitHub.

## Inspect the selected inputs

From the integration checkout, run:

```sh
node scripts/integration/check-selection.mjs
```

The checker verifies selected commits are ancestors, excluded PRs are not selected,
compatibility references exist, and mapped migration bytes match their source.
It does not establish runtime correctness or detect every semantic change.
Compare current PR heads separately; newer heads are candidates for a later batch,
not permission to change an in-progress selection.

## Prepare one update batch

1. Start a clean candidate from the published integration head. Record that commit
   in `batch.startingIntegration`; preserve published history.
2. Verify the requesting author's identity, source repositories and PR heads.
   Freeze exact commits, choose a compatible upstream baseline, and record the
   ordered update steps before changing product code. Keep explicitly excluded
   PRs excluded.
3. Incorporate the upstream baseline once, then selected feature advances.
   Preserve existing compatibility changes; resolve overlapping contracts in
   focused integration-only commits with meaningful combined regressions.
4. Update the manifest's compatibility ownership and migration mappings. Preserve
   already recorded integration migration identities. The source PRs retain
   their own migration names and comparison bases.
5. Run the selection checker and proportional combined checks. Image recipes
   require the repository's native image workflow. Capture UI evidence when UI
   changes. Store qualification in CI run receipts identifying the exact final
   SHA; checks of an individual feature PR do not qualify the combined branch.
6. Verify the published integration has not advanced, then push normally to its
   exact ref. Recheck source PRs remain open and unchanged and fork main is
   untouched. Report selected revisions, CI links and any verification gaps.

The manifest records inputs and intent. Git merge and compatibility commits
preserve manual resolutions; the manifest alone cannot replay them automatically.
Do not use force pushes to make published history match a cleaner diagram.

## Retire or replace an input

When upstream absorbs a feature, record its upstream replacement before removing
it from the outstanding selection. Squashed commits require comparing behavior
and tests; ancestry alone cannot prove equivalence. Remove compatibility code
only after the selected upstream composition supplies its behavior.

Deleting a manifest entry does not remove code. Removing a feature requires an
explicit behavior change and review of its dependent compatibility work.
Independently rewritten source history also requires a deliberate replacement,
not a blind merge. Build a fresh unpublished reconstruction only when a major
baseline change or accumulated replacements justify it; compare and test its
result and preserve the published integration's history and persistence ledger.

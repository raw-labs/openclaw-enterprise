import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const selection = JSON.parse(readFileSync(new URL("./selection.json", import.meta.url), "utf8"));
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const sha = (value) => assert.match(value, /^[a-f0-9]{40}$/);
const ancestor = (value) => {
  sha(value);
  git("merge-base", "--is-ancestor", value, "HEAD");
};

assert.equal(selection.version, 1);
assert.equal(selection.repository, "raw-labs/openclaw-enterprise");
assert.equal(selection.integrationBranch, "codex/raw-integration");
ancestor(selection.upstream.commit);
ancestor(selection.batch.startingIntegration);
let previous = selection.batch.startingIntegration;
for (const step of selection.batch.steps) {
  ancestor(step.commit);
  ancestor(step.input);
  git("merge-base", "--is-ancestor", previous, step.commit);
  git("merge-base", "--is-ancestor", step.input, step.commit);
  previous = step.commit;
}
if (selection.reconstruction) {
  const reconstruction = selection.reconstruction;
  assert.equal(reconstruction.startingCommit, selection.upstream.commit);
  let base = reconstruction.startingCommit;
  for (const step of reconstruction.steps) {
    ancestor(step.commit);
    git("merge-base", "--is-ancestor", base, step.commit);
    const parents = git("show", "-s", "--format=%P", step.commit).split(" ");
    assert.deepEqual(parents, [base, step.input], "Reconstruction must record exact merge parents");
    const feature = selection.features.find(({ number }) => number === step.pullRequest);
    assert.equal(step.input, feature?.commit);
    base = step.commit;
  }
  assert.equal(reconstruction.steps.length, selection.features.length);
  assert.equal(
    new Set(reconstruction.steps.map(({ pullRequest }) => pullRequest)).size,
    selection.features.length,
  );
  ancestor(reconstruction.reconciliationCommit);
  git("merge-base", "--is-ancestor", base, reconstruction.reconciliationCommit);
  assert.deepEqual(git("show", "-s", "--format=%P", reconstruction.historyJoin).split(" "), [
    reconstruction.reconciliationCommit,
    selection.batch.steps[0].commit,
  ]);
  assert.equal(
    git("rev-parse", `${reconstruction.historyJoin}^{tree}`),
    git("rev-parse", `${reconstruction.reconciliationCommit}^{tree}`),
  );
}
const selected = new Set();
for (const feature of selection.features) {
  assert.ok(!selected.has(feature.number), `Duplicate PR #${feature.number}`);
  selected.add(feature.number);
  assert.equal(feature.author, "miguelbranco80");
  assert.equal(feature.status, "included");
  ancestor(feature.commit);
}
const known = new Set(selected);
for (const feature of selection.absorbedFeatures ?? []) {
  assert.ok(!known.has(feature.number), `Duplicate absorbed PR #${feature.number}`);
  known.add(feature.number);
  assert.equal(feature.author, "miguelbranco80");
  assert.equal(feature.status, "absorbed-upstream");
  assert.equal(feature.forkState, "closed");
  ancestor(feature.priorSelectedCommit);
  ancestor(feature.upstreamCommit);
  git("merge-base", "--is-ancestor", feature.upstreamCommit, selection.upstream.commit);
}
for (const feature of selection.excluded) {
  assert.ok(!selected.has(feature.number), `Excluded PR #${feature.number} is selected`);
}
for (const bridge of selection.compatibility) {
  assert.ok(bridge.pullRequests.every((number) => known.has(number)));
  for (const commit of bridge.commits) {
    ancestor(commit);
  }
  for (const path of bridge.paths) {
    git("ls-files", "--error-unmatch", path);
  }
}
for (const mapping of selection.migrationMappings) {
  assert.ok(selected.has(mapping.pullRequest));
  const feature = selection.features.find(({ number }) => number === mapping.pullRequest);
  const sourceCommit = mapping.sourceCommit ?? feature.commit;
  ancestor(sourceCommit);
  git("merge-base", "--is-ancestor", sourceCommit, feature.commit);
  const source = execFileSync("git", ["show", `${sourceCommit}:${mapping.source}`]);
  const integrated = readFileSync(mapping.integrated);
  assert.deepEqual(integrated, source, `Migration bytes changed: ${mapping.integrated}`);
  assert.equal(createHash("sha256").update(integrated).digest("hex"), mapping.sha256);
}
for (const mapping of selection.upstreamMigrationMappings ?? []) {
  ancestor(mapping.commit);
  const source = execFileSync("git", ["show", `${selection.upstream.commit}:${mapping.source}`]);
  const integrated = readFileSync(mapping.integrated);
  if (mapping.sourceSha256) {
    assert.equal(createHash("sha256").update(source).digest("hex"), mapping.sourceSha256);
  }
  let transformed = source.toString("utf8");
  for (const transformation of mapping.transforms ?? []) {
    assert.ok(transformation.reason);
    assert.ok(transformation.from.length > 0);
    assert.equal(
      transformed.split(transformation.from).length,
      2,
      "Migration transformation must match exactly once",
    );
    transformed = transformed.replace(transformation.from, transformation.to);
  }
  assert.deepEqual(
    integrated,
    Buffer.from(transformed),
    `Upstream migration provenance differs: ${mapping.integrated}`,
  );
  assert.equal(createHash("sha256").update(integrated).digest("hex"), mapping.sha256);
}
for (const migration of selection.integrationMigrations ?? []) {
  ancestor(migration.commit);
  assert.ok(migration.pullRequests.every((number) => known.has(number)));
  git("ls-files", "--error-unmatch", migration.path);
  assert.deepEqual(
    readFileSync(migration.path),
    execFileSync("git", ["show", `${migration.commit}:${migration.path}`]),
    `Integration migration differs from its recorded commit: ${migration.path}`,
  );
  assert.equal(
    createHash("sha256").update(readFileSync(migration.path)).digest("hex"),
    migration.sha256,
  );
}
for (const reconciliation of selection.migrationReconciliations ?? []) {
  const feature = selection.features.find(({ number }) => number === reconciliation.pullRequest);
  assert.equal(reconciliation.sourceCommit, feature?.commit);
  const source = execFileSync("git", ["show", `${feature.commit}:${reconciliation.source}`]);
  assert.equal(createHash("sha256").update(source).digest("hex"), reconciliation.sourceSha256);
  assert.ok(reconciliation.reason);
}
if (selection.publishedMigrationPrefix) {
  const prefix = selection.publishedMigrationPrefix;
  ancestor(prefix.commit);
  const journalPath = "migrations/meta/_journal.json";
  const prior = JSON.parse(git("show", `${prefix.commit}:${journalPath}`));
  const current = JSON.parse(readFileSync(journalPath, "utf8"));
  assert.equal(prior.entries.length, prefix.entryCount);
  assert.deepEqual(
    current.entries.slice(0, prefix.entryCount),
    prior.entries,
    "Published migration journal changed",
  );
  for (const entry of prior.entries) {
    const path = `migrations/${entry.tag}.sql`;
    assert.deepEqual(
      readFileSync(path),
      execFileSync("git", ["show", `${prefix.commit}:${path}`]),
      `Published migration bytes changed: ${path}`,
    );
  }
}
console.log(
  `Integration selection verified at ${git("rev-parse", "HEAD")}: ${selected.size} PR inputs.`,
);
console.log(
  "Ancestry verifies provenance; combined behavior still requires integration qualification.",
);

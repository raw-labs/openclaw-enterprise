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
const selected = new Set();
for (const feature of selection.features) {
  assert.ok(!selected.has(feature.number), `Duplicate PR #${feature.number}`);
  selected.add(feature.number);
  assert.equal(feature.author, "miguelbranco80");
  assert.equal(feature.status, "included");
  ancestor(feature.commit);
}
for (const feature of selection.excluded) {
  assert.ok(!selected.has(feature.number), `Excluded PR #${feature.number} is selected`);
}
for (const bridge of selection.compatibility) {
  assert.ok(bridge.pullRequests.every((number) => selected.has(number)));
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
  const source = execFileSync("git", ["show", `${feature.commit}:${mapping.source}`]);
  const integrated = readFileSync(mapping.integrated);
  assert.deepEqual(integrated, source, `Migration bytes changed: ${mapping.integrated}`);
  assert.equal(createHash("sha256").update(integrated).digest("hex"), mapping.sha256);
}
console.log(
  `Integration selection verified at ${git("rev-parse", "HEAD")}: ${selected.size} PR inputs.`,
);
console.log(
  "Ancestry verifies provenance; combined behavior still requires integration qualification.",
);

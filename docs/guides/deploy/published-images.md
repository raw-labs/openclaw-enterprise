# Use the latest published images

Select the controller and runtime with their `latest` tags, then use the source
checkout and chart that match those images. This procedure works for
[local setup](../quickstart.md#optional-use-matching-published-images) and
[production installation](production-installation.md#use-published-images).
Run it before generating Installation configuration.

You need Bash, Docker, Git, and an existing repository checkout. The published
GHCR packages are public. The deployment tools use immutable image references
internally; the commands below resolve the selected tags so you do not need to
find or copy a SHA manually.

## Pull the latest pair

From a Bash shell in the repository root, select and pull both images
anonymously. Run the
whole block; it clears earlier selections and exports them only after both pulls
and revision checks succeed:

```bash
unset CONTROLLER_IMAGE RUNTIME_IMAGE OCE_IMAGE_REVISION
CONTROLLER_TAG='ghcr.io/openclaw/openclaw-enterprise-controller:latest'
RUNTIME_TAG='ghcr.io/openclaw/openclaw-enterprise-runtime:latest'
if docker pull "$CONTROLLER_TAG" && docker pull "$RUNTIME_TAG" &&
   controller_image="$(docker image inspect "$CONTROLLER_TAG" --format '{{index .RepoDigests 0}}')" &&
   runtime_image="$(docker image inspect "$RUNTIME_TAG" --format '{{index .RepoDigests 0}}')" &&
   controller_revision="$(docker image inspect "$controller_image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" &&
   runtime_revision="$(docker image inspect "$runtime_image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" &&
   [[ "$controller_image" =~ @sha256:[a-f0-9]{64}$ ]] &&
   [[ "$runtime_image" =~ @sha256:[a-f0-9]{64}$ ]] &&
   [[ "$controller_revision" =~ ^[a-f0-9]{40}$ ]] &&
   [[ "$controller_revision" = "$runtime_revision" ]]; then
  export CONTROLLER_IMAGE="$controller_image"
  export RUNTIME_IMAGE="$runtime_image"
  export OCE_IMAGE_REVISION="$controller_revision"
  printf 'Source: %s\nController: %s\nRuntime: %s\n' \
    "$OCE_IMAGE_REVISION" "$CONTROLLER_IMAGE" "$RUNTIME_IMAGE"
else
  printf '%s\n' 'Image selection failed or revisions differ; stop before installation.' >&2
  false
fi
```

Stop if selection fails. If an anonymous pull fails with `unauthorized` or
`denied`, the packages have not been published publicly yet:
[build images from your checkout](production-installation.md#build-and-publish-production-images)
instead, or [start the local stack](../quickstart.md#start-the-local-stack)
without image selections, which builds this checkout. The two aliases are not
updated atomically; retry both pulls after publication completes if they refer
to different source revisions.
`latest` identifies the last publication to that alias, not necessarily the
newest source commit: custom-tag publications leave it unchanged.

## Check publication and source

Open the [Enterprise Containers runs](https://github.com/openclaw/openclaw-enterprise/actions/workflows/container-publish.yml)
and find the image publication for the printed source revision. Preparation-only
runs can succeed without publishing. Check the image transfer steps and receipt,
not just the overall run result: a later chart failure can leave verified images
published. Compare both resolved image references with its publication summary
or receipt. Matching
labels establish consistency; the publication record establishes which bytes
passed the image checks. If the record is missing or either reference differs,
stop and ask the publisher to identify the approved pair.

### Verified image-to-source mapping

On 2026-10-07, both official `latest` tags resolved to the pair below. Both
`linux/amd64` and `linux/arm64` image configurations label OCE source
`2d251975fba5b05bd83e96f95ee89c2c67635d50`. The runtime declares Codex
`0.158.0` and OpenClaw source `9d9c8568c51e340540f634f71bd7c7582a70debc`,
matching that OCE revision's runtime Dockerfile and pinned OpenClaw dependency.
The [Codex `0.160.0` source update](https://github.com/openclaw/openclaw-enterprise/commit/5b4689e3cc0dca42b7b7469d81f7e8848b4396c3)
landed later, on 2026-10-05.

[Publication run 36597039249, attempt 1](https://github.com/openclaw/openclaw-enterprise/actions/runs/36597039249)
verified both source tags and `latest` aliases, then uploaded
[receipt `container-publication-36597039249-1`](https://github.com/openclaw/openclaw-enterprise/actions/runs/36597039249/artifacts/11047513896).
Its overall result is failure because the subsequent chart package lookup returned
404; it did not publish a Helm chart. The receipt's index digests match the registry:

```bash
export OCE_IMAGE_REVISION='2d251975fba5b05bd83e96f95ee89c2c67635d50'
export CONTROLLER_IMAGE='ghcr.io/openclaw/openclaw-enterprise-controller@sha256:a74697bf6f803d6ed4643d701006a62a1d1fc797fd4b86b80bb174a4dd942fe0'
export RUNTIME_IMAGE='ghcr.io/openclaw/openclaw-enterprise-runtime@sha256:82bc109471f2a8f307ca9917d8271d5ec5b1f239692f4a32051803f275cbdc65'
```

Use these immutable references to select this recorded pair, then create the
matching checkout below. This dated mapping does not track later alias moves;
resolve and verify both tags again when selecting a newer publication.

### Use the matching checkout

Compare the source revision with your checkout:

```bash
git rev-parse HEAD
printf '%s\n' "${OCE_IMAGE_REVISION:?Select the latest images first}"
```

If they differ, keep the existing checkout and create a separate release
worktree. Choose a new path; do not reuse a worktree containing other work:

```bash
OCE_RELEASE_CHECKOUT="../oce-release-${OCE_IMAGE_REVISION:?}"
git fetch origin "$OCE_IMAGE_REVISION" &&
  git worktree add --detach "$OCE_RELEASE_CHECKOUT" "$OCE_IMAGE_REVISION" &&
  cd "$OCE_RELEASE_CHECKOUT"
```

Continue in this shell so the image selections remain exported. Use the chart,
CLI, configuration renderer, and installation instructions from this matching
checkout. If you need a feature introduced after the published revision,
[build images from that newer checkout](production-installation.md#build-and-publish-production-images)
instead of combining its configuration with older `latest` images.

For production, public GHCR pulls need no pull Secret. See
[private-registry delivery](private-registry-images.md) only when copying images
to a private mirror. For local setup, export the resolved pair as
[development image selections](../quickstart.md#optional-use-matching-published-images).

## Resolve a Codex version mismatch

`Codex version mismatch: expected 0.160.0, got 0.158.0` means the sandbox probe
expects a different Codex version from the selected runtime. For the recorded
pair above, use OCE checkout `2d251975fba5b05bd83e96f95ee89c2c67635d50`, whose
probe expects `0.158.0`, and its own installation instructions. Confirm the actual
selected digest and source labels before applying that mapping to another tag.

If you need the current checkout, build and verify both images from it or wait
for a maintainer to publish that revision. Keep the exact version check enabled;
changing the expected version alone does not make an older image compatible
with a newer chart, configuration, or sandbox preparation.

## Verify after installation

The publication's startup checks do not establish a working Agent on your
cluster. Finish [local first-Agent verification](../first-agent.md) or
[production Agent verification](production-agents.md#verify-production-workloads).
Keep the resolved image references with your deployment record so a later move
of `latest` does not change which images were selected for this installation.

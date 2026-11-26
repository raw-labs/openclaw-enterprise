---
rfc: index.md
---

# Proposed workspace skill archive installation

This companion extends [RFC-0021](index.md). A release job that already deploys an Agent can carry a private skill ZIP alongside the Agent configuration. Give the job a way to install a reviewed archive into the active embedded OpenClaw workspace after deployment. The release repository owns the version and SHA-256. OCC owns authorization and routing. OpenClaw owns extraction, skill policy, and installation.

## Request and authority

The operator selects a Namespace, Agent, active revision, skill slug, local ZIP, and expected SHA-256. The CLI checks the bytes against that digest before contacting OCC. The service key must grant `administer` on the exact Agent. The active revision must select embedded OpenClaw and explicitly enable `skills.install.allowUploadedArchives`. The service key never becomes a Gateway identity usable by the caller. Dedicated workspaces need a separate design with the Harness that owns their files.

OCC rejects a stopped, deleting, replacing, or mismatched revision. It checks the Agent again immediately before dispatching the install. The server resolves the Gateway using the recorded Compute owner. The private connection must report a single native workspace and grant administrative access. The caller cannot choose a host, native agent, workspace path, or upload ID.

## Transfer and outcome

Bound archive size and concurrent requests before buffering. Validate the digest again in OCC. Open a fresh native upload, send bounded chunks, verify the committed digest, and pass the upload to the native installer. An existing skill requires an explicit replacement request. Return an Agent, revision, slug and digest receipt only after the native receipt and audit succeed. Archive bytes and connection details do not belong in audit records.

A disconnect after install dispatch can leave the outcome unknown. The CLI sends one request. Operators must inspect installed provenance before retrying or replacing a skill. A newly deployed revision may retain its workspace. Presence in the skill catalog alone does not prove which bytes were installed.

## Qualification

Exercise the CLI against a real OCC deployment and native Gateway with a multi-chunk ZIP. Confirm the skill is available to a fresh turn. Cover an unauthorized service key, wrong Agent or revision, disabled upload policy, dedicated or ambiguous workspace, corrupt digest, existing slug, native policy rejection and disconnect after install dispatch.

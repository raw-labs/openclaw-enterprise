import { createHash } from "node:crypto";
import {
  WORKSPACE_SKILL_MAX_BYTES,
  type WorkspaceSkillArchiveBody,
} from "@openclaw-enterprise/contracts";
import type { ActiveAgentRevisionSelection } from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";
import { failure } from "./errors.ts";

export function checkSkillTarget(
  { agent, revision, successor, predecessorPhase }: ActiveAgentRevisionSelection,
  expectedRevision?: string,
) {
  if (
    agent.status !== "active" ||
    agent.desiredRuntimeState !== "running" ||
    successor !== undefined ||
    predecessorPhase !== undefined ||
    (expectedRevision !== undefined && revision.id !== expectedRevision)
  ) {
    throw failure(
      409,
      "RESOURCE_CONFLICT",
      "The requested revision must be the latest admitted revision and the Agent must be running.",
    );
  }
  const skills = asRecord(revision.configuration.skills);
  if (
    revision.harness.id !== "openclaw" ||
    revision.harness.mode !== "embedded" ||
    asRecord(skills?.install)?.allowUploadedArchives !== true
  ) {
    throw failure(
      409,
      "RESOURCE_CONFLICT",
      "The revision must enable uploaded archives in an embedded OpenClaw workspace.",
    );
  }
  return revision;
}

export function verifiedSkillBytes(body: WorkspaceSkillArchiveBody): Buffer {
  const bytes = Buffer.from(body.archiveBase64, "base64");
  if (
    !bytes.length ||
    bytes.length > WORKSPACE_SKILL_MAX_BYTES ||
    bytes.toString("base64") !== body.archiveBase64 ||
    createHash("sha256").update(bytes).digest("hex") !== body.sha256
  ) {
    throw failure(
      400,
      "INVALID_REQUEST",
      "The archive must contain valid base64 matching the pinned SHA-256.",
    );
  }
  return bytes;
}

import { GatewayClient, GatewayClientRequestError } from "@openclaw/gateway-client";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import type { WorkspaceSkillInstallRequest } from "./contracts.ts";
import {
  remainingDeadlineMs,
  waitForHello,
  type GatewayHello,
  type NativeWorkspaceFilesTarget,
} from "./workspace-files-client.ts";
import { dependencyUnavailable, failure } from "../http/errors.ts";

export function skillInstallUnknown() {
  return failure(
    503,
    "UNKNOWN_OUTCOME",
    "OCC could not confirm the skill installation. Check installed provenance before retrying.",
  );
}

interface UploadChannel {
  send(
    method:
      "skills.upload.begin" | "skills.upload.chunk" | "skills.upload.commit" | "skills.install",
    params: Record<string, unknown>,
    onSent?: () => void,
  ): Promise<unknown>;
}

export async function transferWorkspaceSkill(
  request: Pick<
    WorkspaceSkillInstallRequest,
    "archive" | "slug" | "sha256" | "replace" | "beforeInstall"
  >,
  channel: UploadChannel,
  agentId: string,
  chunkBytes: number,
): Promise<void> {
  const { archive, sha256, slug, replace: force } = request;
  const begin = asRecord(
    await channel.send("skills.upload.begin", {
      kind: "skill-archive",
      slug,
      sizeBytes: archive.length,
      sha256,
      force,
    }),
  );
  if (!isNonEmptyString(begin?.uploadId) || begin.receivedBytes !== 0) {
    throw dependencyUnavailable();
  }
  const uploadId = begin.uploadId;
  for (let offset = 0; offset < archive.length; offset += chunkBytes) {
    const chunk = archive.subarray(offset, offset + chunkBytes);
    const ack = asRecord(
      await channel.send("skills.upload.chunk", {
        uploadId,
        offset,
        dataBase64: chunk.toString("base64"),
      }),
    );
    if (ack?.uploadId !== uploadId || ack.receivedBytes !== offset + chunk.length) {
      throw dependencyUnavailable();
    }
  }
  const committed = asRecord(await channel.send("skills.upload.commit", { uploadId, sha256 }));
  if (
    committed?.uploadId !== uploadId ||
    committed.sha256 !== sha256 ||
    committed.receivedBytes !== archive.length
  ) {
    throw dependencyUnavailable();
  }

  await request.beforeInstall();
  let sent = false;
  let receipt;
  try {
    receipt = asRecord(
      await channel.send(
        "skills.install",
        { source: "upload", agentId, uploadId, slug, sha256, force },
        () => {
          sent = true;
        },
      ),
    );
  } catch (error) {
    if (error instanceof GatewayClientRequestError) {
      throw failure(
        409,
        "RESOURCE_CONFLICT",
        "The Gateway declined the skill installation. Check the skill policy and whether the slug is already installed.",
      );
    }
    throw sent ? skillInstallUnknown() : dependencyUnavailable();
  }
  if (
    receipt?.ok !== true ||
    receipt.slug !== slug ||
    receipt.sha256 !== sha256 ||
    !isNonEmptyString(receipt.targetDir) ||
    !receipt.targetDir.endsWith("/skills/" + slug)
  ) {
    throw skillInstallUnknown();
  }
}

export async function installWorkspaceSkill(
  request: WorkspaceSkillInstallRequest,
  target: NativeWorkspaceFilesTarget,
): Promise<void> {
  let onHelloOk!: (value: GatewayHello) => void;
  let onConnectError!: (reason: Error) => void;
  const connected = new Promise<GatewayHello>((resolve, reject) => {
    onHelloOk = resolve;
    onConnectError = reject;
  });
  const client = new GatewayClient({
    url: target.url,
    clientName: "gateway-client",
    mode: "backend",
    role: "operator",
    scopes: [],
    deviceIdentity: null,
    edgeAuthHeaders: { "x-api-key": target.apiKey },
    onHelloOk,
    onConnectError,
  });
  const timeLeft = () => {
    const ms = remainingDeadlineMs(request.deadline);
    if (ms === undefined || request.signal.aborted) {
      throw dependencyUnavailable();
    }
    return ms;
  };
  try {
    const timeout = timeLeft();
    client.start();
    const hello = await waitForHello(connected, request, timeout).catch(() => {
      throw dependencyUnavailable();
    });
    const defaults = hello.snapshot.sessionDefaults;
    if (
      hello.auth?.role !== "operator" ||
      !hello.auth.scopes?.includes("operator.admin") ||
      defaults?.ownership !== "sole" ||
      defaults.selectionRequired !== false ||
      !isNonEmptyString(defaults.defaultAgentId)
    ) {
      throw dependencyUnavailable();
    }
    const chunkBytes = Math.min(128 * 1024, 3 * Math.floor((hello.policy.maxPayload - 1024) / 4));
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
      throw dependencyUnavailable();
    }
    await transferWorkspaceSkill(
      request,
      {
        send: async (method, params, onSent) => {
          try {
            return await client.request(method, params, {
              signal: request.signal,
              timeoutMs: timeLeft(),
              ...(onSent ? { onSent } : {}),
            });
          } catch (error) {
            if (method === "skills.install") {
              throw error;
            }
            throw dependencyUnavailable();
          }
        },
      },
      defaults.defaultAgentId,
      chunkBytes,
    );
  } finally {
    client.stop();
    await client.stopAndWait({ timeoutMs: 1000 }).catch(() => undefined);
  }
}

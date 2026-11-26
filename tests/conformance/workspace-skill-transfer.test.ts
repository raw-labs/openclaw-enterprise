import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { transferWorkspaceSkill } from "../../apps/controller/src/gateway/workspace-skill.ts";
import { verifiedSkillBytes } from "../../apps/controller/src/http/workspace-skill.ts";

test("OCC verifies the bytes and native acknowledgements before installing", async () => {
  // Large enough to cover the use case for skills that include binary assets.
  const archive = Buffer.alloc(33 * 1024 * 1024, 0x6a);
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const slug = "example-guide";
  const body = {
    revisionId: "rev_123e4567-e89b-42d3-a456-426614174000",
    slug,
    sha256,
    archiveBase64: archive.toString("base64"),
  };
  assert.equal(verifiedSkillBytes(body).length, archive.length);
  assert.throws(() => verifiedSkillBytes({ ...body, archiveBase64: "bad pin" }), {
    code: "INVALID_REQUEST",
  });
  for (const scenario of [
    "success",
    "commit mismatch",
    "offset mismatch",
    "revoked",
    "disconnect",
    "bad receipt",
  ]) {
    const data = scenario === "success" ? archive : archive.subarray(0, 32);
    const pin = createHash("sha256").update(data).digest("hex");
    const hash = createHash("sha256");
    let offset = 0;
    let installs = 0;
    let checked = false;
    const operation = transferWorkspaceSkill(
      {
        archive: data,
        sha256: pin,
        slug,
        replace: false,
        beforeInstall: async () => {
          if (scenario === "revoked") {
            throw new Error("revoked");
          }
          checked = true;
        },
      },
      {
        send: async (method, params, onSent) => {
          const uploadId = "opaque-native-id";
          if (method === "skills.upload.begin") {
            return { uploadId, receivedBytes: 0 };
          }
          assert.equal(params.uploadId, uploadId);
          if (method === "skills.upload.chunk") {
            assert.equal(params.offset, offset);
            const bytes = Buffer.from(String(params.dataBase64), "base64");
            offset += bytes.length;
            hash.update(bytes);
            return { uploadId, receivedBytes: scenario === "offset mismatch" ? 0 : offset };
          }
          if (method === "skills.upload.commit") {
            assert.equal(hash.digest("hex"), pin);
            return {
              uploadId,
              receivedBytes: offset,
              sha256: scenario === "commit mismatch" ? "" : pin,
            };
          }
          assert.deepEqual(params, {
            source: "upload",
            agentId: "researcher",
            uploadId,
            slug,
            sha256: pin,
            force: false,
          });
          assert.equal(checked, true);
          installs++;
          onSent?.();
          if (scenario === "disconnect") {
            throw new Error("disconnected");
          }
          return {
            ok: true,
            slug,
            sha256: scenario === "bad receipt" ? "" : pin,
            targetDir: "/workspace/skills/" + slug,
          };
        },
      },
      "researcher",
      128 * 1024,
    );
    if (scenario === "success") {
      await operation;
    } else if (scenario === "bad receipt" || scenario === "disconnect") {
      await assert.rejects(operation, { code: "UNKNOWN_OUTCOME" });
    } else if (scenario === "revoked") {
      await assert.rejects(operation, { message: "revoked" });
    } else {
      await assert.rejects(operation, { code: "DEPENDENCY_UNAVAILABLE" });
    }
    assert.equal(installs, ["success", "bad receipt", "disconnect"].includes(scenario) ? 1 : 0);
  }
});

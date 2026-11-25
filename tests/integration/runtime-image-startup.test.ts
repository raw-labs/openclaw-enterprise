import { verifyEmbeddedHttpsPolicy } from "./runtime-image-embedded-https-case.ts";
import { execute, runDocker } from "../helpers/runtime-image-docker.ts";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { temporaryDirectory } from "../fixtures/repository-credentials/process.ts";
import { createModelProbeCertificates } from "../helpers/runtime-model-probe-certificates.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  image,
  runtimeImageModel,
  imageTestOptions,
  createAdmittedRuntimeImageConfiguration,
  runGatewaySmoke,
  reviewedCodexSeccompSecurityOptions,
} from "../helpers/runtime-image-startup.ts";
import { gatewayLogsThroughReady } from "../helpers/runtime-image-gateway-observations.ts";
import { verifyRuntimeSeccompRecord } from "./runtime-image-seccomp-case.ts";
import { verifyRuntimeCodexAuthMount } from "./runtime-image-codex-auth-mount-case.ts";
import { verifyRuntimeGatewayProbeCleanup } from "./runtime-image-gateway-probe-cleanup-case.ts";
import { verifyBundledCodexStartup } from "./runtime-image-bundled-codex-case.ts";
import { verifyDedicatedGatewayAssets } from "./runtime-image-dedicated-assets-case.ts";
import {
  assertBundledPluginLoaded,
  assertBundledSlackPluginLoaded,
  assertGatewayModelLog,
  assertGatewayReadyLog,
  assertNoPackagingFailure,
} from "./runtime-image-startup-assertions.ts";
import { verifyDedicatedCommand } from "./runtime-image-dedicated-command-case.ts";
import { verifyDedicatedSchema } from "./runtime-image-dedicated-schema-case.ts";
import { verifyOpenShellPolicy } from "./runtime-image-openshell-policy-case.ts";
import { verifyStockBroker } from "./runtime-image-stock-broker-case.ts";
import { verifyCodexPackaging } from "./runtime-image-codex-packaging-case.ts";
import { verifyNativeThread } from "./runtime-image-native-thread-case.ts";
import { selectStartupProfile } from "./runtime-image-startup-support.ts";

const profile = await selectStartupProfile(process.env);
const { stagingCodexVersion, historicalCodex, controller } = profile;
const syntheticCodexApiKey = "sk-openclaw-runtime-image-smoke-synthetic";

function requiredImage() {
  assert.ok(image, "This case requires the selected runtime image.");
  return image;
}

function seccompOptions() {
  return reviewedCodexSeccompSecurityOptions({ codexVersion: stagingCodexVersion });
}

async function verifyGatewaySmoke(t: TestContext, collectPlugins: boolean) {
  const configuration = createAdmittedRuntimeImageConfiguration("openclaw", {
    enableSlack: true,
  });
  const { containerName, pluginList } = await runGatewaySmoke(t, "openclaw", {
    entrypoint: controller.dockerGateway,
    configuration,
    collectPlugins,
    ...(!collectPlugins ? { extraEnvironment: ["OPENCLAW_LOG_LEVEL=error"] } : {}),
  });
  const { logs, entries } = await gatewayLogsThroughReady(containerName);
  assertGatewayReadyLog(entries);
  assertGatewayModelLog(entries, "openai/" + runtimeImageModel);
  if (collectPlugins) {
    assertBundledSlackPluginLoaded(pluginList);
  }
  assertNoPackagingFailure(logs);
}

test("runtime image seccomp option requires the CI-prepared profile record", (t) =>
  verifyRuntimeSeccompRecord(t, { stagingCodexVersion, historicalCodex }));

test(
  "runtime image applies Dedicated repository policy to native Codex command execution",
  imageTestOptions,
  () => verifyDedicatedCommand(requiredImage(), controller.harness, historicalCodex),
);

test(
  "runtime image gateway ignores inherited OPENCLAW_LOG_LEVEL in favor of native configuration",
  imageTestOptions,
  (t) => verifyGatewaySmoke(t, false),
);

test(
  "runtime image starts an embedded OpenClaw gateway with the Docker driver entrypoint",
  imageTestOptions,
  (t) => verifyGatewaySmoke(t, true),
);

test(
  "runtime image discovers the bundled Codex plugin from a fresh gateway home",
  imageTestOptions,
  (t) => verifyBundledCodexStartup(t, { entrypoint: controller.dockerGateway }),
);

test(
  "runtime image keeps Codex auth writable with a nested generated images mount",
  imageTestOptions,
  (t) => verifyRuntimeCodexAuthMount(t, syntheticCodexApiKey),
);

test(
  "runtime image publishes dedicated assets with the Kubernetes gateway entrypoint",
  imageTestOptions,
  (t) =>
    verifyDedicatedGatewayAssets(t, {
      entrypoint: controller.kubernetesGateway,
      stopTimeoutMs: controller.gatewayStopTimeoutMs,
      assertGatewayReadyLog,
      assertGatewayModelLog,
      assertNoPackagingFailure,
    }),
);

test(
  "runtime image validates the configuration dedicated native OpenClaw renders",
  imageTestOptions,
  (t) => verifyDedicatedSchema(t, requiredImage(), controller),
);

test("runtime image Gateway preserves OpenShell Codex isolation policy", imageTestOptions, () =>
  verifyOpenShellPolicy(requiredImage(), historicalCodex),
);

test(
  "runtime image Gateway probes time out and recover without CLI descendants",
  imageTestOptions,
  (t) => verifyRuntimeGatewayProbeCleanup(t, controller.pluginRuntimeHelpers),
);

test(
  "runtime image routes sandboxed Git through stock Codex and a development token sender",
  imageTestOptions,
  (t) => verifyStockBroker(t, requiredImage(), controller, seccompOptions),
);

test(
  "runtime image shares the reviewed Codex version between the plugin and Dedicated command",
  imageTestOptions,
  () => verifyCodexPackaging(requiredImage(), profile),
);

test(
  "runtime image applies the repository profile to a native thread shell turn",
  imageTestOptions,
  () =>
    verifyNativeThread(requiredImage(), controller.harness, seccompOptions, syntheticCodexApiKey),
);

test(
  "runtime image serves the bundled Teams callback with SDK authentication and no legacy listener",
  imageTestOptions,
  async (t) => {
    // Synthetic credentials never leave the network-disabled container. This proves
    // packaging and JWT rejection, not Microsoft tenant access or a model reply.
    const { logs, containerName, pluginList } = await runGatewaySmoke(t, "openclaw", {
      collectPlugins: true,
      configuration: createAdmittedRuntimeImageConfiguration("openclaw", { enableTeams: true }),
      extraEnvironment: ["MSTEAMS_APP_PASSWORD=synthetic-teams-password"],
    });
    assertBundledPluginLoaded(pluginList, "msteams");
    // Wait for the asynchronous channel to register its route after gateway readiness.
    const probe = String.raw`
const deadline = Date.now() + 20000;
let response;
while (Date.now() < deadline) {
  response = await fetch("http://127.0.0.1:8080/api/messages", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (response.status === 401) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (response.status !== 401) throw new Error("Teams callback is not protected: " + response.status);
const forged = await fetch("http://127.0.0.1:8080/api/messages", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer not-a-jwt", "x-occ-identity": "occ-workspace-files" }, body: "{}" });
if (![401, 403].includes(forged.status)) throw new Error("Teams SDK accepted an invalid token: " + forged.status);
const socket = await import("node:net");
await new Promise((resolve, reject) => {
  const client = socket.connect(3978, "127.0.0.1");
  client.once("connect", () => { client.destroy(); reject(new Error("Legacy Teams listener is exposed")); });
  client.once("error", (error) => error.code === "ECONNREFUSED" ? resolve() : reject(error));
});
`;
    assert.ok(containerName);
    await runDocker(["exec", containerName, "node", "--input-type=module", "-e", probe]);
    assert.equal(typeof logs, "string");
    assert.ok(logs !== undefined);
    assertNoPackagingFailure(logs);
  },
);

test(
  "runtime image downloads native guarded Teams media through the channel proxy",
  imageTestOptions,
  async (t) => {
    const directory = await temporaryDirectory(t, "oce-teams-attachment-certificates-");
    await createModelProbeCertificates({
      directory,
      caName: "Teams attachment transport test CA",
      dnsNames: ["graph.microsoft.com", "tenant.sharepoint.com"],
      run: execute,
    });
    await rm(join(directory, "ca-key.pem"));
    // Mount only the test leaf and public certificates for the image's non-root user.
    // The host parent stays private, including during the permission change.
    const mount = join(directory, "mount");
    await mkdir(mount);
    await chmod(mount, 0o755);
    for (const file of ["ca.pem", "cert.pem", "key.pem"]) {
      await rename(join(directory, file), join(mount, file));
      await chmod(join(mount, file), 0o644);
    }
    const repository = fileURLToPath(new URL("../../", import.meta.url));
    const result = await runDocker([
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
      "--mount",
      `type=bind,source=${repository},target=/checkout,readonly`,
      "--mount",
      `type=bind,source=${mount},target=/certificates,readonly`,
      "--env",
      "NODE_EXTRA_CA_CERTS=/certificates/ca.pem",
      "--env",
      "OPENCLAW_STATE_DIR=/tmp/openclaw",
      "--entrypoint",
      "node",
      requiredImage(),
      "--test",
      "--test-reporter=tap",
      "/checkout/tests/fixtures/teams-attachment-download.ts",
    ]);
    assert.match(result.stdout, /# pass 1/);
    assert.match(result.stdout, /# fail 0/);
  },
);

test(
  "embedded Teams HTTPS wildcards preserve resolved IP checks and listener isolation",
  imageTestOptions,
  (t) => verifyEmbeddedHttpsPolicy(t, requiredImage()),
);

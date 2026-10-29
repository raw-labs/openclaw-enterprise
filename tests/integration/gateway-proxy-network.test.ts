import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { openShellGatewayDestinations } from "../../apps/controller/src/drivers/egress-proxy/gateway-destinations.ts";

const run = promisify(execFile);
const docker = async (...args: string[]) =>
  (await run("docker", args, { timeout: 30_000, maxBuffer: 2 ** 20 })).stdout.trim();
const assets = JSON.parse(
  await readFile(
    new URL("../../deploy/runtime/gateway-proxy/assets.json", import.meta.url),
    "utf8",
  ),
);

test(
  "stock OpenShell destination proxy enforces exact endpoints and fails closed on proxy or relay death",
  { skip: process.env.OCC_TEST_GATEWAY_PROXY_NETWORK !== "1", timeout: 120_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "oce-gateway-proxy-"));
    const prefix = "oce-gateway-proxy-" + randomUUID().slice(0, 8);
    const supervisor = prefix + "-supervisor";
    const relay = prefix + "-relay";
    const nativeContainers: string[] = [];
    t.after(async () => {
      for (const name of [...nativeContainers, relay, supervisor]) {
        await docker("rm", "-f", name).catch(() => undefined);
      }
      await rm(directory, { recursive: true, force: true });
    });
    // No substitute evaluator: these are the immutable production images and unchanged upstream Rego.
    const rulesPath = resolve("deploy/runtime/gateway-proxy/sandbox-policy.rego");
    assert.equal(
      createHash("sha256")
        .update(await readFile(rulesPath))
        .digest("hex"),
      assets.policyRules.sha256,
    );
    for (const image of [assets.supervisorImage, assets.relayImage]) {
      await docker("image", "inspect", image).catch(() => docker("pull", image));
    }
    const nativeClients = process.env.OCC_TEST_GATEWAY_PROXY_NATIVE_CLIENTS === "1";
    const nativeImage =
      process.env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE ?? process.env.OCC_TEST_RUNTIME_IMAGE;
    if (nativeClients) {
      assert.ok(nativeImage, "Native-client proof requires the selected Gateway runtime image.");
    }
    const selected = openShellGatewayDestinations(
      {
        policyRulesPath: rulesPath,
        supervisorImage: assets.supervisorImage,
        relayImage: assets.relayImage,
        blockedCidrs: ["10.0.0.0/8"],
      },
      "selected-openshell",
      "selected-openshell",
    );
    const plan = selected.admit(
      {
        id: "rev_00000000-0000-4000-8000-000000000001",
        namespaceId: "ns_00000000-0000-4000-8000-000000000001",
        agentId: "agent_00000000-0000-4000-8000-000000000001",
        revision: 1,
        backendId: "openshell",
        configurationId: "cfg_00000000-0000-4000-8000-000000000001",
        configurationKind: "agent",
        configurationGeneration: 1,
        configuration: {},
        gatewayManagedMode: true,
        harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
        harnessAuth: { method: "runtime" },
        executionAdmission: { version: 2, mode: "unprotected" },
        compute: { id: "kubernetes", implementation: "kubernetes-local" },
        sandboxDriverId: "selected-openshell",
        servicePrincipalId: "principal_00000000-0000-4000-8000-000000000001",
        createdAt: "2026-10-29T00:00:00.000Z",
      },
      (nativeClients ? ["example.com", "slack.com", "ws.postman-echo.com"] : ["example.com"]).map(
        (host) => ({ host, port: 443 as const }),
      ),
    );
    const policyPath = join(directory, "policy.json");
    await writeFile(policyPath, plan.policy, { mode: 0o644 });
    async function nativeProbe(mode: string, namespaceOwner = supervisor) {
      const source = JSON.parse(await readFile("deploy/runtime/openclaw-source.json", "utf8"));
      const containerName = prefix + "-native-" + mode;
      nativeContainers.push(containerName);
      const { stdout } = await run(
        "docker",
        [
          "run",
          "--rm",
          "--name",
          containerName,
          "--network",
          "container:" + namespaceOwner,
          "--entrypoint",
          "node",
          "--env",
          "HTTP_PROXY=http://127.0.0.1:3129",
          "--env",
          "HTTPS_PROXY=http://127.0.0.1:3129",
          "--env",
          "NO_PROXY=",
          "--env",
          "NODE_USE_ENV_PROXY=1",
          "--env",
          "PROOF_MODE=" + mode,
          "--env",
          "EXPECTED_OPENCLAW_COMMIT=" + source.commit,
          "--mount",
          "type=bind,src=" +
            resolve("tests/fixtures/gateway-native-transports.mjs") +
            ",dst=/tmp/native-transports.mjs,readonly",
          nativeImage!,
          "/tmp/native-transports.mjs",
        ],
        { timeout: 60000, maxBuffer: 2 ** 20 },
      );
      t.diagnostic(stdout.trim());
    }
    await docker(
      "run",
      "-d",
      "--name",
      supervisor,
      "--user",
      "10001:10001",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--tmpfs",
      "/tls:uid=10001,gid=10001,mode=700,size=8m",
      "--tmpfs",
      "/tmp:uid=10001,gid=10001,mode=700,size=8m",
      "--mount",
      "type=bind,src=" + rulesPath + ",dst=/policy/sandbox-policy.rego,readonly",
      "--mount",
      "type=bind,src=" + policyPath + ",dst=/policy/policy.json,readonly",
      assets.supervisorImage,
      "--role=network-proxy",
      "--listen=127.0.0.1:3128",
      "--policy-rules=/policy/sandbox-policy.rego",
      "--policy-data=/policy/policy.json",
      "--tls-dir=/tls",
    );
    await docker(
      "run",
      "-d",
      "--name",
      relay,
      "--network",
      "container:" + supervisor,
      "--user",
      "10001:10001",
      "--cap-drop",
      "ALL",
      "--read-only",
      assets.relayImage,
      "TCP4-LISTEN:3129,bind=0.0.0.0,reuseaddr,fork",
      "TCP4:127.0.0.1:3128",
    );
    async function connect(host: string, port: number, namespaceOwner = supervisor) {
      return docker(
        "run",
        "--rm",
        "--network",
        "container:" + namespaceOwner,
        "--entrypoint",
        "/bin/sh",
        assets.relayImage,
        "-ec",
        "printf 'CONNECT " +
          host +
          ":" +
          port +
          " HTTP/1.1\r\nHost: " +
          host +
          ":" +
          port +
          "\r\n\r\n' | nc -w 3 127.0.0.1 3129 || true",
      );
    }
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (
        (await connect("readiness-denied.invalid", 443).catch(() => "")).startsWith("HTTP/1.1 403 ")
      ) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, await docker("logs", supervisor));
    assert.match(await connect("example.com", 443), /^HTTP\/1\.1 200 Connection Established/);
    assert.match(await connect("example.org", 443), /^HTTP\/1\.1 403 /);
    assert.match(await connect("example.com", 80), /^HTTP\/1\.1 403 /);
    assert.match(await connect("93.184.216.34", 443), /^HTTP\/1\.1 403 /);
    if (nativeClients) {
      await nativeProbe("allowed");
      await nativeProbe("denied");
    }
    // Stock network-proxy intentionally does not hot-reload local files: a frozen revision needs replacement.
    await writeFile(policyPath, JSON.stringify({ version: 1, network_policies: {} }));
    assert.match(await connect("example.com", 443), /^HTTP\/1\.1 200 /);
    await docker("kill", relay);
    if (nativeClients) {
      await nativeProbe("relay-outage");
    }
    assert.doesNotMatch(await connect("example.com", 443), /^HTTP\/1\.1 200 /);
    await docker("start", relay);
    await docker("kill", supervisor);
    assert.equal(await docker("inspect", "--format", "{{.State.Running}}", relay), "true");
    if (nativeClients) {
      await nativeProbe("proxy-outage", relay);
    }
    assert.doesNotMatch(await connect("example.com", 443, relay), /^HTTP\/1\.1 200 /);
    // Docker proves policy/relay operation only, not Kubernetes admission, NetworkPolicy or bypass resistance.
  },
);

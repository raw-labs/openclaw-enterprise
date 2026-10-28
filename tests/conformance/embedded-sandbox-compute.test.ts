import assert from "node:assert/strict";
import test from "node:test";
import { embeddedSandboxRequirements } from "../../apps/controller/src/drivers/compute/kubernetes/embedded-sandbox-workload.ts";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import type { AgentRevision } from "../../packages/contracts/src/index.ts";
import { driverHasCapabilityContract } from "../../packages/occ/src/driver-contract.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";

const revisionHarness = { id: "openclaw", version: "1.0.0", mode: "embedded" as const };

function workload() {
  return {
    spec: {
      template: {
        metadata: {
          labels: {
            "openclaw.dev/namespace": "tenant",
            "openclaw.dev/agent": "agent",
            "openclaw.dev/revision": "revision",
            "openclaw.dev/workload-role": "gateway",
          },
        },
        spec: {
          volumes: [
            { name: "state", persistentVolumeClaim: { claimName: "agent-state" } },
            { name: "runtime-state", emptyDir: { sizeLimit: "64Mi" } },
            {
              name: "configuration",
              configMap: {
                name: "native-config",
                items: [{ key: "openclaw.json", path: "openclaw.json" }],
              },
            },
          ],
          initContainers: [
            {
              name: "prepare-private-state",
              image: "gateway:local",
              command: ["node", "-e", "prepare()"],
              volumeMounts: [{ name: "state", mountPath: "/gateway-state" }],
              securityContext: { readOnlyRootFilesystem: true },
            },
          ],
          securityContext: { runAsUser: 1000 },
          containers: [
            {
              name: "gateway",
              image: "gateway:local",
              command: ["/app/launcher"],
              args: ["normal-wrapper"],
              env: [
                {
                  name: "MODEL_KEY",
                  valueFrom: { secretKeyRef: { name: "model-auth", key: "value" } },
                },
                { name: "OPENCLAW_CONFIG_PATH", value: "/run/config/openclaw.json" },
              ],
              volumeMounts: [
                {
                  name: "state",
                  mountPath: "/home/node/.openclaw/workspace",
                  subPath: "workspace",
                },
                { name: "configuration", mountPath: "/run/config", readOnly: true },
              ],
              readinessProbe: {
                httpGet: { path: "/openclaw/runtime/ready", port: "plugin-status" },
              },
              securityContext: { readOnlyRootFilesystem: true },
              resources: { limits: { memory: "128Mi" } },
            },
          ],
        },
      },
    },
  };
}

// The provider boundary must preserve literal startup, native files and Secret references;
// it must not substitute an unrelated node command or revision-local workspace.
test("embedded workload projection preserves command, configuration, private state and credentials", () => {
  const projected = embeddedSandboxRequirements(
    workload(),
    "api_key",
    new Map([["native-config", { "openclaw.json": '{"plugins":{"entries":{}}}' }]]),
    undefined,
  );
  assert.deepEqual(projected.command, ["/app/launcher", "normal-wrapper"]);
  assert.deepEqual(projected.environment[0], {
    name: "MODEL_KEY",
    valueFrom: { secretKeyRef: { name: "model-auth", key: "value" } },
  });
  assert.deepEqual(projected.workspaceMounts, [
    {
      claimName: "agent-state",
      subPath: "workspace",
      mountPath: "/home/node/.openclaw/workspace",
      readOnly: false,
    },
  ]);
  assert.equal(projected.mountedFiles[0]?.mountPath, "/run/config/openclaw.json");
  assert.equal(projected.mountedFiles[0]?.mode, 0o644);
  assert.equal(projected.initializers[0]?.securityContext?.readOnlyRootFilesystem, true);
  assert.deepEqual(projected.ephemeralVolumes, [{ name: "runtime-state", sizeLimit: "64Mi" }]);
  assert.equal(projected.labels["openclaw.dev/network-profile"], "provider-fenced-v1");
});

test("embedded projection rejects unknown projected volumes and missing native configuration", () => {
  const input = workload();
  assert.throws(
    () => embeddedSandboxRequirements(input, "api_key", new Map(), undefined),
    /configuration material/,
  );
  const unknown = {
    ...input,
    spec: {
      template: {
        ...input.spec.template,
        spec: {
          ...input.spec.template.spec,
          volumes: [{ name: "foreign", projected: { sources: [{ secret: { name: "foreign" } }] } }],
        },
      },
    },
  };
  assert.throws(
    () => embeddedSandboxRequirements(unknown, "api_key", new Map(), undefined),
    /volume cannot be preserved/,
  );
});

test("normal Gateway preserves bounded owner-key memory and startup initializers", () => {
  const driver = createTestKubernetesComputeDriver("embedded-native", { gatewayRuntime: true });
  const runtime = driver as unknown as {
    gatewayConfiguration(revision: unknown): { name: string };
    deployment(...args: unknown[]): { spec?: Record<string, unknown> };
  };
  const revision = {
    agentId: "agent",
    id: "revision",
    revision: 1,
    namespaceId: "tenant",
    configurationId: "config",
    configurationKind: "agent",
    configurationGeneration: 1,
    gatewayManagedMode: true,
    harness: revisionHarness,
    configuration: admitLoggingConfiguration({}, "info"),
  };
  const configuration = runtime.gatewayConfiguration(revision);
  const template = runtime.deployment(
    "gateway",
    { namespaceId: "tenant", agentId: "agent" },
    { name: "tenant", plane: "execution" },
    "gateway:local",
    "agent",
    "gateway",
    {},
    "info",
    configuration,
    true,
    "principal",
    { loginMode: "api_key", environment: [] },
  );
  const projected = embeddedSandboxRequirements(
    template,
    "api_key",
    new Map([[configuration.name, { "openclaw.json": "{}" }]]),
    undefined,
  );
  assert.deepEqual(
    projected.ephemeralVolumes.filter((volume) => volume.medium === "Memory"),
    [
      { name: "gateway-owner-key", sizeLimit: "64Ki", medium: "Memory" },
      { name: "gateway-owner-start", sizeLimit: "64Ki", medium: "Memory" },
    ],
  );
  assert.deepEqual(
    projected.initializers.map((init) => init.name),
    ["prepare-private-state", "prepare-embedded-gateway-owner"],
  );
  assert.equal(projected.podUidEnvironment[0], "OPENCLAW_POD_UID");
  assert.deepEqual(projected.readinessProbe, {
    httpGet: { path: "/readyz", port: "plugin-status" },
    periodSeconds: 2,
  });
});

test("Sandbox embedded capability requires operations rather than a truthy flag", () => {
  const base = {
    id: "sandbox",
    implementation: "external",
    capability: "sandbox" as const,
    facets: ["networking" as const],
    cleanup: async () => {},
  };
  assert.equal(driverHasCapabilityContract({ ...base, embeddedRuntime: true } as never), false);
  assert.equal(
    driverHasCapabilityContract({
      ...base,
      embeddedRuntime: { provision: async () => {}, podSelector: async () => {} },
    } as never),
    false,
  );
});

test("embedded Sandbox placement uses exclusive predecessor replacement", () => {
  const driver = createTestKubernetesComputeDriver("embedded-placement");
  const embedded: AgentRevision = {
    id: "revision",
    namespaceId: "tenant",
    agentId: "agent",
    backendId: null,
    revision: 1,
    configurationId: "configuration",
    configurationKind: "agent",
    configurationGeneration: 1,
    gatewayManagedMode: true,
    configuration: {},
    harness: revisionHarness,
    harnessAuth: { method: "runtime" },
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "principal",
    createdAt: "2026-10-28T00:00:00.000Z",
    executionAdmission: { version: 2, mode: "unprotected" },
  };
  assert.equal(driver.requiresStoppedPredecessors(embedded), false);
  assert.equal(
    driver.requiresStoppedPredecessors({ ...embedded, sandboxDriverId: "external" }),
    true,
  );
});

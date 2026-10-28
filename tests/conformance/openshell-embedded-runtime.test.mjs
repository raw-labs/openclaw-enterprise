import assert from "node:assert/strict";
import test from "node:test";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { SandboxRevisionUnsupportedError } from "../../packages/occ/src/errors.ts";

function fixture() {
  const providerCalls = [];
  const gatewayClient = new Proxy(
    {},
    {
      get(_target, operation) {
        providerCalls.push(operation);
        throw new Error("An unsupported runtime must not acquire provider authority.");
      },
    },
  );
  const driver = new OpenShellSandboxDriver(
    {
      gateway: { workspaceMode: "operator" },
      kubernetes: {
        runtimeClassName: "openshell-sandbox",
        userNamespaces: false,
        serviceAccount: { mode: "gatewayConfigured" },
        sandboxDataMount: {
          subPath: "workspace",
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        },
      },
      policy: {
        process: { runAsUser: "1000", runAsGroup: "1000" },
        networkPolicies: [
          {
            name: "model-egress",
            binaries: [{ path: "/usr/local/bin/node" }],
            endpoints: [{ host: "api.openai.com", ports: [443], tls: "skip" }],
          },
        ],
      },
    },
    {
      id: "openshell-sandbox",
      implementation: "openshell",
      backend: {
        id: "openshell",
        drivers: { sandbox: "openshell-sandbox" },
        client: new OpenShellGateway({ serviceName: "openshell-gateway" }, { gatewayClient }),
      },
    },
  );
  const namespace = { id: "ns_embedded", name: "tenant-embedded" };
  const revision = {
    id: "rev_6f894a7d-97e7-4be6-8109-3cce77137f12",
    namespaceId: namespace.id,
    agentId: "agent_embedded",
    sandboxDriverId: driver.id,
    harness: { id: "openclaw", mode: "embedded" },
  };
  const requirements = {
    loginMode: "api_key",
    image: "registry.example.test/openclaw:admitted",
    command: ["/usr/local/bin/node", "-e", "throw new Error('must not execute')"],
    workspaceMounts: [
      {
        claimName: "agent-state",
        subPath: "workspace",
        mountPath: "/sandbox/enterprise",
        readOnly: false,
      },
    ],
    environment: [
      {
        name: "OPENAI_API_KEY",
        valueFrom: { secretKeyRef: { name: "model-owner", key: "api-key" } },
      },
    ],
    files: [],
    credentialAttachments: [],
    labels: { "openclaw.dev/revision": revision.id },
    mountedFiles: [],
    ephemeralVolumes: [
      { name: "runtime-state", sizeLimit: "256Mi" },
      { name: "runtime-temporary", sizeLimit: "64Mi" },
    ],
    volumeMounts: [
      { name: "runtime-state", mountPath: "/home/node", subPath: "home", readOnly: false },
    ],
    initializers: [],
    secretVolumes: [],
    persistentVolumes: [{ name: "agent-state", claimName: "agent-state" }],
  };
  const context = {
    namespace,
    revision,
    requirements,
    signal: AbortSignal.timeout(5000),
    get kubernetes() {
      throw new Error("Refusal must precede Kubernetes Secret reads or mutations.");
    },
  };
  return { driver, context, providerCalls };
}

const unsupported = (pattern) => (error) => {
  assert.ok(error instanceof SandboxRevisionUnsupportedError);
  assert.equal(error.code, "SANDBOX_HARNESS_UNSUPPORTED");
  assert.match(error.message, pattern);
  return true;
};

test("OpenShell refuses embedded admission and bounded native runtime storage before acquiring provider or Secret authority", async () => {
  const { driver, context, providerCalls } = fixture();
  assert.throws(
    () => driver.configureAgent({}, context.revision.harness),
    /bounded Pod-local storage/,
  );
  await assert.rejects(
    driver.embeddedRuntime.provision(context),
    unsupported(/bounded Pod-local volumes/),
  );
  assert.deepEqual(providerCalls, []);
});

test("OpenShell does not silently discard initializer, Secret mount, identity or immutable file requirements", async (t) => {
  const { driver, context, providerCalls } = fixture();
  const cases = [
    [
      {
        workloadIdentity: {
          serviceAccountName: "agent-workload",
          token: {
            audience: "occ",
            expirationSeconds: 600,
            mountPath: "/identity",
            path: "token",
            readOnly: true,
          },
        },
      },
      /projected identity/,
    ],
    [
      {
        initializers: [
          {
            name: "prepare-private-state",
            image: context.requirements.image,
            command: ["node", "-e", "process.exit(0)"],
            environment: [],
            volumeMounts: [],
          },
        ],
      },
      /initializer container/,
    ],
    [
      { secretVolumes: [{ name: "channel-material", secretName: "agent-channel" }] },
      /projected Secret volumes/,
    ],
    [
      {
        mountedFiles: [
          {
            name: "configuration",
            mountPath: "/etc/openclaw/openclaw.json",
            content: "{}",
            readOnly: true,
          },
        ],
      },
      /read-only mounted-file/,
    ],
    [{}, /not qualified/],
  ];
  for (const [extra, reason] of cases) {
    await t.test(reason.source, async () => {
      await assert.rejects(
        driver.embeddedRuntime.provision(
          Object.assign(Object.create(context), {
            requirements: { ...context.requirements, ephemeralVolumes: [], ...extra },
          }),
        ),
        unsupported(reason),
      );
    });
  }
  assert.deepEqual(providerCalls, []);
});

test("OpenShell cannot qualify an embedded ingress selector or readiness without a supported provisioning path", async () => {
  const { driver, context, providerCalls } = fixture();
  await assert.rejects(driver.embeddedRuntime.podSelector(context), unsupported(/not qualified/));
  await assert.rejects(driver.embeddedRuntime.observe(context), unsupported(/not qualified/));
  assert.deepEqual(providerCalls, []);
});

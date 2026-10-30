import assert from "node:assert/strict";
import test from "node:test";
import { rootCertificates } from "node:tls";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";

const namespaceId = "ns_00000000-0000-4000-8000-000000000001";
const profile = {
  id: "small",
  namespaceIds: [namespaceId],
  image: "registry.example/ssh@sha256:" + "a".repeat(64),
  cpuMillis: 100,
  memoryMiB: 128,
  lifetimeSeconds: 600,
  idleTimeoutSeconds: 60,
  egress: [],
};
function options() {
  return {
    ...conformanceKubernetesOptions({ gatewayTrustedProxyCidrs: ["127.0.0.1/32"] }),
    temporaryEnvironments: {
      profiles: [structuredClone(profile)],
      quota: { maxEnvironments: 2, maxCpuMillis: 200, maxMemoryMiB: 256 },
    },
  };
}
function setup() {
  const driver = new KubernetesComputeDriver(options());
  const request = {
    id: "tenv-test",
    namespaceId,
    agentId: "agent-test",
    revisionId: "revision-test",
    servicePrincipalId: "principal-test",
    profileId: "small",
    profileFingerprint: driver.getTemporaryEnvironmentPolicy().profiles[0].fingerprint,
    cpuMillis: 100,
    memoryMiB: 128,
    lifetimeSeconds: 600,
    hardExpiresAt: new Date(Date.now() + 590000).toISOString(),
    sshPublicKey:
      "ssh-ed25519 " +
      Buffer.concat([
        Buffer.from([0, 0, 0, 11]),
        Buffer.from("ssh-ed25519"),
        Buffer.from([0, 0, 0, 32]),
        Buffer.alloc(32, 1),
      ]).toString("base64"),
    allocationStarted: true,
  };
  const namespace = kubernetesNamespaceName(namespaceId);
  const metadata = {
    name: namespace,
    uid: "namespace-uid",
    labels: {
      "app.kubernetes.io/managed-by": "openclaw-enterprise",
      "openclaw.dev/namespace": namespaceId,
    },
    annotations: { "openclaw.dev/namespace-id": namespaceId },
  };
  const objects = new Map();
  const writes = [];
  const missing = () => {
    throw Object.assign(new Error("not found"), { code: 404 });
  };
  const read =
    (kind) =>
    async ({ name }) =>
      structuredClone(
        objects.get(
          kind === "NetworkPolicy" && name.endsWith("-owner") ? "OwnerNetworkPolicy" : kind,
        ) ?? missing(),
      );
  const create =
    (kind) =>
    async ({ body }) => {
      if (kind === "NetworkPolicy" && body.metadata.name.endsWith("-owner")) {
        kind = "OwnerNetworkPolicy";
      }
      writes.push(kind);
      const object = structuredClone(body);
      object.metadata.uid = kind + "-uid";
      if (kind === "Pod") {
        object.status = { phase: "Pending" };
      }
      if (kind === "Service") {
        object.spec.clusterIP = "10.42.0.5";
      }
      objects.set(kind, object);
      return structuredClone(object);
    };
  const remove =
    (kind) =>
    async ({ body, name }) => {
      if (kind === "NetworkPolicy" && name.endsWith("-owner")) {
        kind = "OwnerNetworkPolicy";
      }
      assert.equal(
        body.preconditions.uid,
        objects.get(kind).metadata.uid,
        "deletion must bind the observed resource UID",
      );
      writes.push("delete " + kind);
      objects.delete(kind);
    };
  // SDK doubles exercise Driver decisions only: they are not cluster/network enforcement proof.
  driver.apiClients = Promise.resolve({
    core: {
      listNamespace: async () => ({ items: [{ metadata }] }),
      readNamespace: async ({ name }) => ({
        apiVersion: "v1",
        kind: "Namespace",
        metadata: name === "kube-system" ? { name, uid: "cluster-uid" } : metadata,
        status: { phase: "Active" },
      }),
      readNamespacedResourceQuota: async () => ({
        apiVersion: "v1",
        kind: "ResourceQuota",
        metadata: { ...metadata, name: "openclaw-quota", namespace },
        spec: { hard: { pods: "10" } },
      }),
      readNamespacedPod: read("Pod"),
      readNamespacedService: read("Service"),
      createNamespacedPod: create("Pod"),
      createNamespacedService: create("Service"),
      deleteNamespacedPod: remove("Pod"),
      deleteNamespacedService: remove("Service"),
    },
    networking: {
      readNamespacedNetworkPolicy: read("NetworkPolicy"),
      createNamespacedNetworkPolicy: create("NetworkPolicy"),
      deleteNamespacedNetworkPolicy: remove("NetworkPolicy"),
    },
    discovery: { listNamespacedEndpointSlice: async () => ({ items: [] }) },
  });
  return { driver, request, objects, writes, namespace };
}

test("temporary profiles default disabled and reject caller-like privilege, mutable images, broad egress and oversized bounds", () => {
  const disabled = options();
  delete disabled.temporaryEnvironments;
  assert.equal(new KubernetesComputeDriver(disabled).getTemporaryEnvironmentPolicy(), undefined);
  for (const change of [
    { privileged: true },
    { image: "ssh:latest" },
    { egress: [{ cidr: "0.0.0.0/0", port: 443 }] },
    { lifetimeSeconds: 86401 },
    { idleTimeoutSeconds: 601 },
    { namespaceIds: [] },
  ]) {
    const value = options();
    Object.assign(value.temporaryEnvironments.profiles[0], change);
    assert.throws(() => new KubernetesComputeDriver(value), /Temporary environment/);
  }
  const value = options();
  const driver = new KubernetesComputeDriver(value);
  const before = driver.getTemporaryEnvironmentPolicy();
  value.temporaryEnvironments.profiles[0].image = "changed";
  assert.deepEqual(
    driver.getTemporaryEnvironmentPolicy(),
    before,
    "startup policy must not retain mutable caller references",
  );
});

test("allocation constrains the executable Pod and does not publish SSH readiness before exact EndpointSlice proof", async () => {
  const { driver, request, objects, writes, namespace } = setup();
  const observation = await driver.createTemporaryEnvironment(request);
  assert.equal(observation.state, "pending");
  assert.deepEqual(writes, ["NetworkPolicy", "OwnerNetworkPolicy", "Service", "Pod"]);
  const pod = objects.get("Pod");
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.hostNetwork, false);
  assert.equal(pod.spec.securityContext.runAsNonRoot, true);
  assert.deepEqual(pod.spec.containers[0].securityContext.capabilities.drop, ["ALL"]);
  assert.equal(pod.spec.containers[0].resources.limits.cpu, "100m");
  assert.ok(pod.spec.activeDeadlineSeconds <= 600);
  assert.ok(pod.spec.volumes.every((volume) => volume.emptyDir && !volume.hostPath));
  assert.deepEqual(objects.get("NetworkPolicy").spec.egress, []);
  pod.status = { phase: "Running", conditions: [{ type: "Ready", status: "True" }] };
  const clients = await driver.apiClients;
  const endpoint = {
    conditions: { ready: true },
    targetRef: { kind: "Pod", name: pod.metadata.name, uid: "unrelated-pod", namespace },
  };
  clients.discovery.listNamespacedEndpointSlice = async () => ({
    items: [
      {
        metadata: {
          ownerReferences: [{ kind: "Service", name: pod.metadata.name, uid: "Service-uid" }],
        },
        ports: [{ name: "ssh", port: 2222, protocol: "TCP" }],
        endpoints: [endpoint],
      },
    ],
  });
  assert.equal(
    (await driver.observeTemporaryEnvironment({ ...request, providerRef: observation.providerRef }))
      .state,
    "pending",
  );
  endpoint.targetRef.uid = pod.metadata.uid;
  const ready = await driver.observeTemporaryEnvironment({
    ...request,
    providerRef: observation.providerRef,
  });
  assert.equal(ready.state, "ready");
  assert.deepEqual(ready.ssh, { host: "10.42.0.5", port: 2222, user: "worker" });
  assert.deepEqual(
    await driver.deleteTemporaryEnvironment({ ...request, providerRef: ready.providerRef }),
    { state: "absent" },
  );
  assert.equal(objects.size, 0);
});

test("uncertain allocation never treats a transient 404 as release proof or recreates during observation", async () => {
  const { driver, request, writes } = setup();
  assert.deepEqual(await driver.observeTemporaryEnvironment(request), { state: "pending" });
  assert.deepEqual(await driver.deleteTemporaryEnvironment(request), { state: "pending" });
  assert.deepEqual(writes, []);
});

test("replacement resource UID or changed owner fences all deletion before mutation", async () => {
  for (const change of ["uid", "owner"]) {
    const { driver, request, objects, writes } = setup();
    const observation = await driver.createTemporaryEnvironment(request);
    if (change === "uid") {
      objects.get("Service").metadata.uid = "replacement";
    } else {
      objects.get("NetworkPolicy").metadata.annotations["openclaw.dev/agent-id"] = "other-agent";
    }
    await assert.rejects(
      driver.deleteTemporaryEnvironment({ ...request, providerRef: observation.providerRef }),
      /ownership|unowned/,
    );
    assert.deepEqual(writes, ["NetworkPolicy", "OwnerNetworkPolicy", "Service", "Pod"]);
  }
});

test("failed allocation is not retried and partial cleanup retains unresolved quota", async () => {
  const { driver, request, objects, writes } = setup();
  const clients = await driver.apiClients;
  clients.core.createNamespacedService = async () => {
    throw Object.assign(new Error("unavailable"), { code: 503 });
  };
  await assert.rejects(driver.createTemporaryEnvironment(request), /unavailable/);
  assert.deepEqual(writes, ["NetworkPolicy", "OwnerNetworkPolicy"]);
  assert.deepEqual(await driver.deleteTemporaryEnvironment(request), { state: "pending" });
  assert.equal(objects.size, 0);
});

test("terminating Pod retains policy and quota until its UID is absent", async () => {
  const { driver, request, objects, writes } = setup();
  const observation = await driver.createTemporaryEnvironment(request);
  const clients = await driver.apiClients;
  clients.core.deleteNamespacedPod = async () => {
    objects.get("Pod").metadata.deletionTimestamp = new Date().toISOString();
    writes.push("delete Pod");
  };
  const tracked = { ...request, providerRef: observation.providerRef };
  assert.deepEqual(await driver.deleteTemporaryEnvironment(tracked), { state: "pending" });
  assert.equal(objects.size, 4, "a terminating executable retains its isolation policy");
  objects.delete("Pod");
  assert.deepEqual(await driver.deleteTemporaryEnvironment(tracked), { state: "absent" });
  assert.deepEqual(writes, [
    "NetworkPolicy",
    "OwnerNetworkPolicy",
    "Service",
    "Pod",
    "delete Pod",
    "delete Service",
    "delete NetworkPolicy",
    "delete OwnerNetworkPolicy",
  ]);
});

test("changed immutable profile and disallowed Namespace fail before SDK allocation", async () => {
  for (const change of [
    { profileFingerprint: "changed" },
    { namespaceId: "ns_other" },
    { cpuMillis: 200 },
    { allocationStarted: false },
    { sshPublicKey: "ssh-ed25519 " + "A".repeat(68) },
  ]) {
    const { driver, request, writes } = setup();
    await assert.rejects(
      driver.createTemporaryEnvironment({ ...request, ...change }),
      /Temporary environment/,
    );
    assert.deepEqual(writes, []);
  }
});

function runtimeOptions() {
  const value = options();
  value.runtime = {
    transportSecretPrefix: "transport",
    gatewayStorageClassName: "local-path",
    gatewayNodeSelector: { "oce-role": "control-plane" },
  };
  value.servicePrincipalCredentials = {
    mode: "projectedServiceAccountToken",
    audience: "occ-workload",
    expirationSeconds: 600,
  };
  value.temporaryEnvironmentApiUrl = "https://occ.example.test";
  value.temporaryEnvironmentApiEgress = { cidr: "10.42.0.20/32", port: 8443 };
  return value;
}

test("temporary adapter configuration rejects unapproved fields and broad API destinations", () => {
  for (const mutate of [
    (v) => {
      delete v.temporaryEnvironmentApiEgress;
    },
    (v) => {
      v.temporaryEnvironmentApiEgress.cidr = "10.42.0.0/16";
    },
    (v) => {
      v.temporaryEnvironmentApiEgress.cidr = "169.254.169.254/32";
    },
    (v) => {
      v.temporaryEnvironments.unapprovedOption = "unknown";
    },
    (v) => {
      v.temporaryEnvironmentApiCaBundle = "not a certificate";
    },
    (v) => {
      v.servicePrincipalCredentials = { mode: "disabled" };
    },
  ]) {
    const value = runtimeOptions();
    mutate(value);
    assert.throws(() => new KubernetesComputeDriver(value), /Temporary environment/);
  }
});

function runtimeWorkload(
  driver,
  role = "agent",
  embedded = false,
  ownerNamespace = namespaceId,
  selection = { profileId: "small" },
) {
  return driver.deployment(
    "runtime-test",
    { namespaceId: ownerNamespace, agentId: "agent-test", revisionId: "revision-test" },
    { name: kubernetesNamespaceName(ownerNamespace), plane: "execution" },
    "runtime:fixture",
    "agent-test",
    role,
    {},
    "info",
    role === "gateway"
      ? {
          name: "config-test",
          revision: 1,
          revisionId: "revision-test",
          annotations: {},
          harnessNamespace: { name: kubernetesNamespaceName(ownerNamespace), plane: "execution" },
        }
      : undefined,
    embedded,
    "principal-test",
    { environment: [], volumes: [], volumeMounts: [], initContainers: [] },
    [],
    [],
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    selection,
  );
}

test("normal Agent deployment selects trusted Crabbox config but never equips its separate gateway", () => {
  const configuration = runtimeOptions();
  configuration.temporaryEnvironmentApiCaBundle = rootCertificates[0];
  const driver = new KubernetesComputeDriver(configuration);
  for (const [role, embedded, selected] of [
    ["agent", false, true],
    ["gateway", true, true],
    ["gateway", false, false],
  ]) {
    const workload = runtimeWorkload(driver, role, embedded);
    const env = Object.fromEntries(
      workload.spec.template.spec.containers[0].env.map(({ name, value }) => [name, value]),
    );
    assert.equal(env.OCC_WORKLOAD_TEMPORARY_PROFILE, selected ? "small" : undefined);
    assert.equal(env.NODE_EXTRA_CA_CERTS, selected ? "/home/node/occ-workload-ca.pem" : undefined);
    assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
    assert.equal(
      env.CRABBOX_CONFIG,
      selected ? "/home/node/.config/crabbox/config.yaml" : undefined,
    );
    assert.equal(
      env.OCC_WORKLOAD_SSH_KEY_FILE,
      selected ? "/home/node/.ssh/occ-temporary" : undefined,
    );
    assert.equal(env.OCC_WORKLOAD_URL, selected ? "https://occ.example.test" : undefined);
  }
  assert.throws(() => runtimeWorkload(driver, "agent", false, "ns-other"), /not eligible/);
  for (const selection of [undefined, { profileId: "small" }]) {
    const native = driver.temporaryEnvironmentSkillConfiguration(
      { temporaryEnvironments: selection },
      {
        skills: {
          entries: { crabbox: { enabled: true }, "crabbox-quickstart": { enabled: true } },
        },
      },
    );
    for (const name of ["crabbox", "crabbox-quickstart"]) {
      assert.equal(native.skills.entries[name].enabled, selection !== undefined);
    }
  }
  const disabledWorkload = runtimeWorkload(driver, "agent", false, "ns-other", null);
  assert.ok(
    !JSON.stringify(disabledWorkload.spec.template.spec.initContainers).includes("ssh-keygen"),
  );
  assert.ok(
    !disabledWorkload.spec.template.spec.containers[0].env.some(
      ({ name }) => name.startsWith("OCC_WORKLOAD_") || name === "CRABBOX_CONFIG",
    ),
  );
  const discovery = runtimeOptions();
  const discoveryDriver = new KubernetesComputeDriver(discovery);
  assert.equal(discoveryDriver.getTemporaryEnvironmentPolicy().profiles[0].id, "small");
  assert.ok(
    !runtimeWorkload(
      discoveryDriver,
      "agent",
      false,
      "ns-other",
      null,
    ).spec.template.spec.containers[0].env.some(({ name }) => name === "CRABBOX_CONFIG"),
  );
});

test("translated OCC API egress belongs only to the Agent runtime network selector", () => {
  const driver = new KubernetesComputeDriver(runtimeOptions());
  for (const mode of ["embedded", "dedicated"]) {
    const revision = {
      id: "revision-test",
      namespaceId,
      agentId: "agent-test",
      harness: { id: mode === "embedded" ? "openclaw" : "codex", version: "1.0.0", mode },
      configuration: {},
      temporaryEnvironments: { profileId: "small" },
    };
    const policies = driver
      .agentNetworkPolicies(revision, {
        name: kubernetesNamespaceName(namespaceId),
        plane: "execution",
      })
      .map(({ resource }) => resource);
    const grants = policies.filter((policy) =>
      policy.spec.egress?.some((rule) =>
        rule.to?.some((peer) => peer.ipBlock?.cidr === "10.42.0.20/32"),
      ),
    );
    assert.ok(
      !driver
        .agentNetworkPolicies(
          { ...revision, temporaryEnvironments: undefined },
          { name: kubernetesNamespaceName(namespaceId), plane: "execution" },
        )
        .some(({ resource }) =>
          resource.spec.egress?.some((rule) =>
            rule.to?.some((peer) => peer.ipBlock?.cidr === "10.42.0.20/32"),
          ),
        ),
    );
    assert.equal(grants.length, 1);
    assert.equal(
      grants[0].spec.podSelector.matchLabels["openclaw.dev/workload-role"],
      mode === "embedded" ? "gateway" : "agent",
    );
    assert.equal(grants[0].spec.podSelector.matchLabels["openclaw.dev/agent"], "agent-test");
    assert.equal(grants[0].spec.podSelector.matchLabels["openclaw.dev/revision"], "revision-test");
    assert.ok(grants[0].spec.podSelector.matchLabels["openclaw.dev/network-profile"]);
    assert.deepEqual(grants[0].spec.egress.at(-1), {
      to: [{ ipBlock: { cidr: "10.42.0.20/32" } }],
      ports: [{ protocol: "TCP", port: 8443 }],
    });
  }
});

test("a receipt refuses empty replacement-cluster evidence before confirming absence", async () => {
  const { driver, request, objects, writes } = setup();
  const created = await driver.createTemporaryEnvironment(request);
  objects.clear();
  const clients = await driver.apiClients;
  // A changed kubeconfig can retain the Driver ID while pointing at an empty cluster.
  // Its missing objects are not evidence about the cluster that owns the receipt.
  clients.core.readNamespace = async ({ name }) => {
    if (name === "kube-system") {
      return { metadata: { name, uid: "replacement-cluster" } };
    }
    throw Object.assign(new Error("not found"), { code: 404 });
  };
  await assert.rejects(
    driver.deleteTemporaryEnvironment({ ...request, providerRef: created.providerRef }),
    /cluster identity changed/u,
  );
  assert.equal(writes.length, 4, "wrong-cluster evidence must not authorize mutation");
});

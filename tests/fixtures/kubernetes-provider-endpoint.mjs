import assert from "node:assert/strict";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { tenant, digest, authContext } from "../helpers/kubernetes-routed-scenarios.mjs";
import {
  providerReadinessFixture,
  supervisorPeerLabels,
} from "./kubernetes-provider-readiness.mjs";

// In-memory Kubernetes transport plus Sandbox/lifecycle responses. No cluster I/O.
// Tests own readiness transitions and assertions; prepare/activate remain real Driver calls.
export function providerEndpointFixture({
  harnessEndpoint = async () => ({
    url: "ws://tenant--sandbox.openshell.localhost:8080/",
    workspaceRoot: "/sandbox/enterprise",
  }),
  providerNetwork,
  revisionOverrides,
} = {}) {
  const hooks = [];
  const provisions = [];
  const endpoints = [];
  const setupRequests = [];
  const peerLookups = [];
  const provisioningPolicies = [];
  const fixture = providerReadinessFixture({
    providerNetwork,
    revisionOverrides,
    // The Sandbox, and so its relay Pod's labels, exists only once provisioned.
    async workspaceNodePeerLabels({ revision: target }) {
      peerLookups.push(target.id);
      return provisions.some(({ revision: { id } }) => id === target.id)
        ? supervisorPeerLabels(target.id)
        : undefined;
    },
    async provisionHarness(context) {
      provisioningPolicies.push(
        structuredClone([...objects.values()].filter(({ kind }) => kind === "NetworkPolicy")),
      );
      provisions.push(context);
      return {
        namespaceName: context.namespace.name,
        resourceName: "provider-sandbox",
        agentId: context.revision.agentId,
        revisionId: context.revision.id,
        ...(context.requirements.proxyWiring === undefined
          ? {}
          : { proxyWiring: context.requirements.proxyWiring }),
      };
    },
    async harnessEndpoint(context) {
      endpoints.push(context);
      return harnessEndpoint(context);
    },
    lifecycleDrivers: [
      {
        id: "configuration-lifecycle",
        capability: "configuration",
        implementation: "conformance-lifecycle",
        computeLifecycleHooks: {
          async beforeWorkloadStart() {
            hooks.push("start");
          },
          async beforeWorkloadStop() {
            hooks.push("stop");
          },
        },
      },
    ],
    nodeEnrollment: {
      async createSetup(url, nodeUrl) {
        setupRequests.push({ url, nodeUrl });
        return {
          setupId: "provider-setup",
          setupCode: "provider-setup-code",
          expiresAtMs: Date.now() + 600_000,
        };
      },
      async isConnected() {
        return true;
      },
    },
  });
  const { driver, revision, namespace, core, containedGateway } = fixture;
  const gatewayName = `gateway-${digest(revision.agentId)}`;
  const gatewayNamespace = kubernetesNamespaceName(tenant.id);
  const objects = new Map();
  const writes = [];
  const key = (kind, name, target = namespace) =>
    `${kind}:${kind === "Namespace" ? "" : target}:${name}`;
  const save = (object) =>
    objects.set(
      key(object.kind, object.metadata.name, object.metadata.namespace),
      structuredClone(object),
    );
  const read = (kind, name, target = namespace) =>
    structuredClone(objects.get(key(kind, name, target)));
  const readRequired = (kind, name, target) => {
    const object = read(kind, name, target);
    if (object === undefined) {
      throw Object.assign(new Error("not found"), { statusCode: 404 });
    }
    return object;
  };
  save({
    ...driver.manifest("v1", "Namespace", namespace, { namespaceId: tenant.id }),
    status: { phase: "Active" },
  });
  save({
    ...driver.gatewayNamespaceManifest({ namespaceId: tenant.id }),
    status: { phase: "Active" },
  });
  const transport = driver.manifest(
    "v1",
    "Secret",
    `transport-${digest(revision.agentId)}`,
    { namespaceId: tenant.id, agentId: revision.agentId },
    { name: gatewayNamespace, plane: "control" },
  );
  save({
    ...transport,
    type: "Opaque",
    metadata: { ...transport.metadata, uid: "transport-uid", resourceVersion: "1" },
    data: { "app-server-token": Buffer.from("test-transport").toString("base64") },
  });
  save({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "occ-model-key",
      namespace: kubernetesNamespaceName(tenant.id),
      uid: "model-secret-uid",
    },
    data: { value: Buffer.from("fixture-model-key").toString("base64") },
  });
  for (const target of [
    { name: namespace, plane: "execution" },
    { name: kubernetesNamespaceName(tenant.id), plane: "control" },
  ]) {
    for (const policy of driver.networkPolicies({ namespaceId: tenant.id }, target)) {
      save(policy);
    }
  }
  const clients = {
    core,
    apps: {},
    networking: {},
    objects: {
      async read(object) {
        return readRequired(object.kind, object.metadata.name, object.metadata.namespace);
      },
      async patch(object) {
        writes.push(structuredClone(object));
        save({
          ...object,
          metadata: { ...object.metadata, uid: object.metadata.name + "-uid", generation: 1 },
        });
        return object;
      },
    },
    discovery: {
      async listNamespacedEndpointSlice() {
        return {
          items: [
            {
              metadata: {
                labels: { "kubernetes.io/service-name": gatewayName },
                ownerReferences: [
                  { kind: "Service", name: gatewayName, uid: `${gatewayName}-uid` },
                ],
              },
              endpoints: [{ conditions: { ready: true } }],
            },
          ],
        };
      },
    },
  };
  core.readNamespace = async ({ name }) => read("Namespace", name);
  const enrollmentSecret = core.readNamespacedSecret;
  let workspaceNodeSetupAvailable = false;
  core.readNamespacedSecret = async ({ name, namespace: target }) => {
    if (name === driver.workspaceNodeName(revision)) {
      if (!workspaceNodeSetupAvailable) {
        throw Object.assign(new Error("not found"), { statusCode: 404 });
      }
      return enrollmentSecret({ name });
    }
    return readRequired("Secret", name, target);
  };
  core.createNamespacedSecret = core.replaceNamespacedSecret = async ({ body }) => {
    const value = {
      ...body,
      metadata: { ...body.metadata, uid: `${body.metadata.name}-uid`, resourceVersion: "1" },
    };
    writes.push(structuredClone(value));
    save(value);
    return value;
  };
  for (const [api, kinds] of [
    [core, ["ConfigMap", "Service", "ServiceAccount", "PersistentVolumeClaim"]],
    [clients.apps, ["Deployment"]],
    [clients.networking, ["NetworkPolicy"]],
  ]) {
    for (const kind of kinds) {
      api[`readNamespaced${kind}`] = async ({ name, namespace: requestedNamespace }) => {
        return readRequired(kind, name, requestedNamespace);
      };
      api[`patchNamespaced${kind}`] = async ({ body, namespace: requestedNamespace }) => {
        assert.equal(requestedNamespace, body.metadata.namespace);
        writes.push(structuredClone(body));
        const previous = read(kind, body.metadata.name, body.metadata.namespace);
        save({
          ...previous,
          ...body,
          ...(kind === "Service"
            ? { spec: { ...body.spec, clusterIP: previous?.spec?.clusterIP ?? "10.43.0.81" } }
            : {}),
          metadata: {
            ...previous?.metadata,
            ...body.metadata,
            uid: body.metadata.name + "-uid",
            generation: 1,
          },
        });
      };
    }
  }
  driver.apiClients = Promise.resolve(clients);
  // What the workspace-node policy admitted each time Compute observed the
  // provider Harness after provisioning: the relay must already be admitted.
  const policiesAtHarnessObservation = [];
  const listPods = core.listNamespacedPod;
  core.listNamespacedPod = async (request) => {
    if (
      provisions.length > 0 &&
      !request.labelSelector.includes("openclaw.dev/workload-role=gateway")
    ) {
      policiesAtHarnessObservation.push(
        read(
          "NetworkPolicy",
          `allow-gateway-workspace-node-${digest(revision.agentId)}`,
          gatewayNamespace,
        ),
      );
    }
    return listPods(request);
  };

  return {
    ...fixture,
    objects,
    key,
    save,
    read,
    // These delegate to the production Driver without caching readiness between calls.
    prepare(targetRevision = revision, context = authContext(targetRevision)) {
      return driver.prepareRevision(targetRevision, context);
    },
    activate(targetRevision = revision, context = authContext(targetRevision)) {
      return driver.activateRevision(targetRevision, context);
    },
    observePods(pods) {
      fixture.setObservation({ items: pods });
    },
    clients,
    writes,
    hooks,
    provisions,
    endpoints,
    setupRequests,
    peerLookups,
    provisioningPolicies,
    policiesAtHarnessObservation,
    gatewayName,
    gatewayNamespace,
    gateway() {
      return read("Deployment", gatewayName, gatewayNamespace);
    },
    setGatewayServing() {
      // Explicit provider and Gateway API observations. Writes alone do not establish readiness.
      containedGateway.setReady();
      for (const object of objects.values()) {
        if (!["HTTPRoute", "BackendTLSPolicy"].includes(object.kind)) {
          continue;
        }
        const parent = {
          name: driver.options.gatewayRouting.gatewayName,
          namespace: driver.options.gatewayRouting.gatewayNamespace,
        };
        object.status =
          object.kind === "HTTPRoute"
            ? {
                parents: [
                  {
                    parentRef: parent,
                    conditions: ["Accepted", "ResolvedRefs"].map((type) => ({
                      type,
                      status: "True",
                      observedGeneration: object.metadata.generation,
                    })),
                  },
                ],
              }
            : {
                ancestors: [
                  {
                    ancestorRef: parent,
                    conditions: [
                      {
                        type: "Accepted",
                        status: "True",
                        observedGeneration: object.metadata.generation,
                      },
                    ],
                  },
                ],
              };
      }
    },
    setSetupAvailable(value) {
      workspaceNodeSetupAvailable = value;
    },
  };
}

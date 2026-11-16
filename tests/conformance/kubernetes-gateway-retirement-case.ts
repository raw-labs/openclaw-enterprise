import { asRecord } from "../../packages/utils/src/objects.ts";
import assert from "node:assert/strict";
import {
  createKubernetesComputeDriver,
  kubernetesNamespaceName,
  type KubernetesComputeDriver,
  type KubernetesComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import type { AgentRevision } from "../../packages/contracts/src/index.ts";
import {
  digest,
  gatewayRouting,
  routedOptions,
  routedRevision,
  tenant,
} from "../helpers/kubernetes-routed-scenarios.mjs";

type KubernetesSdk = Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];
type Clients = {
  apps: InstanceType<KubernetesSdk["AppsV1Api"]>;
  core: InstanceType<KubernetesSdk["CoreV1Api"]>;
  objects: InstanceType<KubernetesSdk["KubernetesObjectApi"]>;
};
type ObjectDelete = Parameters<Clients["objects"]["delete"]>;
type KubernetesObject = ObjectDelete[0];
type ObservedResource = KubernetesObject & {
  kind: string;
  metadata: { name: string };
};
type NamespacedRead = Pick<
  Parameters<Clients["apps"]["readNamespacedDeployment"]>[0],
  "name" | "namespace"
>;
type NamespacedDelete = {
  Deployment: Parameters<Clients["apps"]["deleteNamespacedDeployment"]>[0];
  Service: Parameters<Clients["core"]["deleteNamespacedService"]>[0];
  ServiceAccount: Parameters<Clients["core"]["deleteNamespacedServiceAccount"]>[0];
  PersistentVolumeClaim: Parameters<Clients["core"]["deleteNamespacedPersistentVolumeClaim"]>[0];
};
type Deletion =
  | {
      [Kind in keyof NamespacedDelete]: [kind: Kind, request: NamespacedDelete[Kind]];
    }[keyof NamespacedDelete]
  | [
      kind: "HTTPRoute" | "SecurityPolicy" | "NetworkPolicy",
      request: { spec: ObjectDelete[0]; body: ObjectDelete[6] },
    ];

function resourceKey(kind: string | undefined, namespace: string | undefined, name: string) {
  return JSON.stringify([kind, namespace, name]);
}

function retirementFixture(
  driver: KubernetesComputeDriver,
  namespace: string,
  gatewayName: string,
  nodeName: string,
) {
  const resources = new Map<string, ObservedResource>();
  const deletions: Deletion[] = [];
  let failServiceDelete = false;

  function observe(resource: ObservedResource) {
    const { kind, metadata } = resource;
    resources.set(resourceKey(kind, metadata.namespace, metadata.name), structuredClone(resource));
  }

  function reset(...snapshot: ObservedResource[]) {
    resources.clear();
    for (const resource of snapshot) {
      observe(resource);
    }
  }

  function read(kind: string | undefined, target: string | undefined, name: string) {
    const resource = resources.get(resourceKey(kind, target, name));
    if (resource === undefined) {
      throw Object.assign(new Error("Not found"), { code: 404 });
    }
    return structuredClone(resource);
  }

  function readNamespaced(kind: string) {
    return async ({ name, namespace: target }: NamespacedRead) => read(kind, target, name);
  }

  function namedResources(name = nodeName) {
    const nodes = new Map<string, ObservedResource>();
    for (const resource of resources.values()) {
      if (resource.metadata.namespace === namespace && resource.metadata.name === name) {
        nodes.set(resource.kind, structuredClone(resource));
      }
    }
    return nodes;
  }

  function clearNodeResources() {
    for (const resource of namedResources().values()) {
      resources.delete(resourceKey(resource.kind, namespace, nodeName));
    }
  }

  function patchResource(body: KubernetesObject, kind = body.kind) {
    assert.ok(kind && body.metadata?.name);
    observe({
      ...body,
      kind,
      metadata: {
        ...body.metadata,
        name: body.metadata.name,
        uid: body.metadata.name === gatewayName ? "route-uid" : kind + "-node-uid",
        resourceVersion: "1",
      },
    });
  }

  // Delete attempts are recorded independently of the observed snapshots. This
  // lets the retry exercise a Deployment that still exists after the failure.
  Object.assign(driver, {
    apiClients: Promise.resolve({
      apps: {
        readNamespacedDeployment: readNamespaced("Deployment"),
        async deleteNamespacedDeployment(request: NamespacedDelete["Deployment"]) {
          deletions.push(["Deployment", request]);
        },
      },
      core: {
        async listNamespacedPod() {
          return { apiVersion: "v1", kind: "PodList", items: [] };
        },
        readNamespacedConfigMap: readNamespaced("ConfigMap"),
        readNamespacedSecret: readNamespaced("Secret"),
        readNamespacedPersistentVolumeClaim: readNamespaced("PersistentVolumeClaim"),
        async deleteNamespacedPersistentVolumeClaim(
          request: NamespacedDelete["PersistentVolumeClaim"],
        ) {
          deletions.push(["PersistentVolumeClaim", request]);
        },
        readNamespacedService: readNamespaced("Service"),
        async patchNamespacedService({ body }: { body: KubernetesObject }) {
          patchResource(body, "Service");
        },
        async deleteNamespacedService(request: NamespacedDelete["Service"]) {
          deletions.push(["Service", request]);
          if (failServiceDelete) {
            throw new Error("service delete failed");
          }
        },
        readNamespacedServiceAccount: readNamespaced("ServiceAccount"),
        async deleteNamespacedServiceAccount(request: NamespacedDelete["ServiceAccount"]) {
          deletions.push(["ServiceAccount", request]);
        },
      },
      networking: {
        async patchNamespacedNetworkPolicy({ body }: { body: KubernetesObject }) {
          patchResource(body, "NetworkPolicy");
        },
        readNamespacedNetworkPolicy: readNamespaced("NetworkPolicy"),
      },
      objects: {
        async read({ kind, metadata }: Parameters<Clients["objects"]["read"]>[0]) {
          return read(kind, metadata.namespace, metadata.name);
        },
        async patch(body: Parameters<Clients["objects"]["patch"]>[0]) {
          assert.ok(body.metadata?.name);
          assert.equal(body.metadata.namespace, namespace);
          assert.ok([gatewayName, nodeName, gatewayName + "-msteams"].includes(body.metadata.name));
          patchResource(body);
        },
        async delete(...args: ObjectDelete) {
          const [spec, , , , , , body] = args;
          const { kind } = spec;
          assert.ok(
            kind === "HTTPRoute" ||
              kind === "Service" ||
              kind === "SecurityPolicy" ||
              kind === "NetworkPolicy",
          );
          deletions.push([kind, { spec, body }]);
          assert.ok(spec.metadata?.name);
          if (spec.metadata.name.endsWith("-msteams")) {
            resources.delete(resourceKey(kind, namespace, spec.metadata.name));
          }
        },
      },
    }),
  });

  return {
    observe,
    reset,
    nodeResources: () => namedResources(),
    teamsResources: () => namedResources(gatewayName + "-msteams"),
    clearNodeResources,
    deletions,
    setServiceDeleteFailure(value: boolean) {
      failServiceDelete = value;
    },
  };
}

export async function checkGatewayRetirement() {
  const driver = createKubernetesComputeDriver(
    routedOptions({
      gatewayRouting: { ...gatewayRouting, channels: { hostname: "callbacks.example.test" } },
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }) as KubernetesComputeDriverOptions,
  );
  const agentId = "agent-revision-storage";
  const ownership = { namespaceId: tenant.id, agentId };
  const target = { name: kubernetesNamespaceName(tenant.id), plane: "execution" } as const;
  const namespace = target.name;
  const gatewayName = "gateway-" + digest(agentId);
  const nodeName = gatewayName + "-node";
  const agentName = "agent-" + digest(agentId);
  const agentOwnership = { ...ownership, servicePrincipalId: "service-agent-revision-storage" };
  const revision = { id: "revision-2", revision: 2, agentId };
  const routeRevision = routedRevision(driver, revision);
  const active: AgentRevision = routedRevision(driver, {
    ...revision,
    servicePrincipalId: agentOwnership.servicePrincipalId,
  });
  const predecessor = { ...active, id: "revision-1", revision: 1 };
  const candidate = { ...active, id: "revision-3", revision: 3 };

  const gateway = driver["manifest"]("apps/v1", "Deployment", gatewayName, ownership, target);
  gateway.metadata.uid = "gateway-uid";
  assert.ok(gateway.metadata.annotations);
  gateway.metadata.annotations["openclaw.dev/agent-revision-id"] = "revision-2";
  const gatewayService = driver["service"](gatewayName, ownership, target, {
    "app.kubernetes.io/name": gatewayName,
  });
  gatewayService.metadata.uid = "gateway-service-uid";
  const gatewayAccount = driver["manifest"]("v1", "ServiceAccount", gatewayName, ownership, target);
  gatewayAccount.metadata.uid = "gateway-account-uid";
  const agentService = driver["service"](agentName, agentOwnership, target, {
    "openclaw.dev/agent": agentId,
    "openclaw.dev/revision": "revision-2",
    "openclaw.dev/workload-role": "agent",
  });
  agentService.metadata.uid = "agent-service-uid";
  const agentAccount = driver["manifest"](
    "v1",
    "ServiceAccount",
    agentName,
    agentOwnership,
    target,
  );
  agentAccount.metadata.uid = "agent-account-uid";
  const route = driver["gatewayRoute"](routeRevision, ownership, target, gatewayService);
  assert.ok(route);
  route.metadata.uid = "route-uid";
  route.metadata.resourceVersion = "route-version-2";
  const claims = [
    driver["gatewayPrivateStateClaim"](agentId, ownership, target),
    driver["harnessWorkspaceClaim"](agentId, ownership, target),
  ];
  for (const claim of claims) {
    claim.metadata.uid = claim.metadata.name + "-uid";
  }

  const fixture = retirementFixture(driver, namespace, gatewayName, nodeName);
  const { deletions } = fixture;
  const survivingResources = [
    gatewayService,
    gatewayAccount,
    agentService,
    agentAccount,
    route,
    ...claims,
  ];
  fixture.reset(gateway, ...survivingResources);

  const gatewayDeletes: Deletion[] = [
    [
      "HTTPRoute",
      {
        spec: {
          apiVersion: "gateway.networking.k8s.io/v1",
          kind: "HTTPRoute",
          metadata: { name: gatewayName, namespace },
        },
        body: { preconditions: { uid: "route-uid", resourceVersion: "route-version-2" } },
      },
    ],
    [
      "Service",
      { name: gatewayName, namespace, body: { preconditions: { uid: "gateway-service-uid" } } },
    ],
    [
      "ServiceAccount",
      { name: gatewayName, namespace, body: { preconditions: { uid: "gateway-account-uid" } } },
    ],
  ];
  const harnessDeletes: Deletion[] = [
    [
      "Service",
      { name: agentName, namespace, body: { preconditions: { uid: "agent-service-uid" } } },
    ],
    [
      "ServiceAccount",
      { name: agentName, namespace, body: { preconditions: { uid: "agent-account-uid" } } },
    ],
  ];

  await driver["removeRetiredGateway"](predecessor, target);
  assert.equal(deletions.length, 0);

  fixture.setServiceDeleteFailure(true);
  await assert.rejects(driver["removeRetiredGateway"](active, target), /service delete failed/);
  assert.deepEqual(deletions, gatewayDeletes.slice(0, 2));
  assert.equal(
    deletions.some(([kind]) => kind === "Deployment"),
    false,
    "Deployment must remain as the retry witness until Service deletion succeeds",
  );

  deletions.length = 0;
  fixture.setServiceDeleteFailure(false);
  await driver["removeRetiredGateway"](active, target);
  assert.deepEqual(deletions, [
    ...gatewayDeletes,
    [
      "Deployment",
      { name: gatewayName, namespace, body: { preconditions: { uid: "gateway-uid" } } },
    ],
    ...harnessDeletes,
  ]);

  // With the Deployment absent, the surviving route still identifies its owner.
  deletions.length = 0;
  fixture.reset(...survivingResources);
  await driver["removeRetiredGateway"](active, target);
  assert.deepEqual(deletions, [...gatewayDeletes, ...harnessDeletes]);
  assert.equal(
    deletions.some(([kind]) => kind === "PersistentVolumeClaim"),
    false,
  );

  deletions.length = 0;
  fixture.observe({
    ...route,
    metadata: {
      ...route.metadata,
      annotations: {
        ...route.metadata.annotations,
        "openclaw.dev/agent-revision-id": "revision-3",
      },
    },
  });
  await driver["removeRetiredGateway"](active, target);
  assert.equal(deletions.length, 0);

  function observeGateway(revision: Pick<typeof active, "id" | "revision">) {
    fixture.observe({
      ...gateway,
      metadata: {
        ...gateway.metadata,
        annotations: {
          ...gateway.metadata.annotations,
          "openclaw.dev/agent-revision-id": revision.id,
          "openclaw.dev/agent-revision": String(revision.revision),
          "openclaw.dev/msteams-webhook": "true",
        },
      },
    });
  }

  // Preparation can run while the previous Gateway still serves requests. A
  // failed candidate must not acquire and then delete that Gateway's node route.
  observeGateway(active);
  await driver["reconcileGatewayRoute"](active, ownership, target);
  const activeTeamsResources = fixture.teamsResources();
  const callback = asRecord(fixture.teamsResources().get("HTTPRoute"));
  const spec = asRecord(callback?.spec);
  assert.ok(spec);
  assert.deepEqual(spec.hostnames, ["callbacks.example.test"]);
  const parents = spec.parentRefs;
  const rules = spec.rules;
  assert.ok(Array.isArray(parents) && Array.isArray(rules));
  assert.equal(asRecord(parents[0])?.sectionName, "channels");
  assert.equal(rules.length, 1);
  const rule = asRecord(rules[0]);
  assert.ok(rule);
  assert.deepEqual(rule.matches, [
    {
      method: "POST",
      path: {
        type: "Exact",
        value: `/namespaces/${tenant.id}/agents/${agentId}/channels/msteams`,
      },
    },
  ]);
  const filters = rule.filters;
  assert.ok(Array.isArray(filters));
  const rewrite = asRecord(asRecord(filters[0])?.urlRewrite);
  assert.equal(asRecord(rewrite?.path)?.replaceFullPath, "/api/messages");
  const headers = asRecord(asRecord(filters[1])?.requestHeaderModifier);
  assert.ok(headers && Array.isArray(headers.remove) && Array.isArray(headers.set));
  assert.equal(headers.remove.includes("authorization"), false);
  for (const header of ["x-occ-identity", "x-api-key", "cookie", "x-openclaw-scopes"]) {
    assert.ok(headers.remove.includes(header));
  }
  assert.equal(
    headers.set.some((value) => asRecord(value)?.name === "x-occ-identity"),
    false,
  );
  assert.equal(
    asRecord(asRecord(fixture.teamsResources().get("SecurityPolicy"))?.spec)?.apiKeyAuth,
    undefined,
  );
  const activeNodeResources = fixture.nodeResources();
  assert.equal(activeNodeResources.size, 2);
  await driver["reconcileGatewayRoute"](candidate, ownership, target);
  assert.deepEqual(fixture.nodeResources(), activeNodeResources);
  assert.deepEqual(fixture.teamsResources(), activeTeamsResources);

  // A serving Gateway predating node enrollment may have no node endpoint.
  // Preparing its successor must create one under the serving revision, or
  // node readiness would wait for activation while activation waits for it.
  fixture.clearNodeResources();
  await driver["reconcileGatewayRoute"](candidate, ownership, target);
  assert.deepEqual(fixture.nodeResources(), activeNodeResources);
  assert.deepEqual(fixture.teamsResources(), activeTeamsResources);
  await driver["removeRetiredGateway"](candidate, target);
  assert.equal(deletions.length, 0);

  // Once activation replaces the Gateway, the same endpoint belongs to the new
  // revision. Retiring the predecessor must leave it usable by the new node.
  observeGateway(candidate);
  await driver["reconcileGatewayRoute"](candidate, ownership, target);
  const candidateNodes = fixture.nodeResources();
  for (const resource of candidateNodes.values()) {
    assert.equal(resource.metadata.annotations?.["openclaw.dev/agent-revision-id"], candidate.id);
  }
  await driver["removeRetiredGateway"](active, target);
  assert.equal(deletions.length, 0);
  for (const resource of fixture.teamsResources().values()) {
    assert.equal(resource.metadata.annotations?.["openclaw.dev/agent-revision-id"], candidate.id);
  }
  fixture.observe({
    ...gateway,
    metadata: {
      ...gateway.metadata,
      annotations: {
        ...gateway.metadata.annotations,
        "openclaw.dev/agent-revision-id": candidate.id,
        "openclaw.dev/agent-revision": String(candidate.revision),
        "openclaw.dev/msteams-webhook": "false",
      },
    },
  });
  await driver["reconcileGatewayRoute"](candidate, ownership, target);
  assert.equal(fixture.teamsResources().size, 0);
  assert.deepEqual(
    deletions.map(([kind, request]) => [
      kind,
      "spec" in request ? request.spec.metadata?.name : request.name,
    ]),
    [
      ["HTTPRoute", gatewayName + "-msteams"],
      ["Service", gatewayName + "-msteams"],
      ["SecurityPolicy", gatewayName + "-msteams"],
      ["NetworkPolicy", gatewayName + "-msteams"],
    ],
  );
  deletions.length = 0;
  await driver["removeRetiredGateway"](candidate, target);
  assert.deepEqual(deletions.slice(0, 2), [
    [
      "HTTPRoute",
      {
        spec: {
          apiVersion: "gateway.networking.k8s.io/v1",
          kind: "HTTPRoute",
          metadata: { name: nodeName, namespace },
        },
        body: { preconditions: { uid: "HTTPRoute-node-uid", resourceVersion: "1" } },
      },
    ],
    [
      "SecurityPolicy",
      {
        spec: {
          apiVersion: "gateway.envoyproxy.io/v1alpha1",
          kind: "SecurityPolicy",
          metadata: { name: nodeName, namespace },
        },
        body: { preconditions: { uid: "SecurityPolicy-node-uid", resourceVersion: "1" } },
      },
    ],
  ]);
  assert.equal(
    deletions.some(([kind]) => kind === "PersistentVolumeClaim"),
    false,
  );

  // The same name and revision do not authorize deletion of another Agent's route.
  deletions.length = 0;
  const candidateRoute = candidateNodes.get("HTTPRoute");
  assert.ok(candidateRoute);
  fixture.observe({
    ...candidateRoute,
    metadata: {
      ...candidateRoute.metadata,
      labels: { ...candidateRoute.metadata.labels, "openclaw.dev/agent": "foreign-agent" },
      annotations: {
        ...candidateRoute.metadata.annotations,
        "openclaw.dev/agent-id": "foreign-agent",
      },
    },
  });
  await assert.rejects(driver["removeRetiredGateway"](candidate, target), {
    message: "Refusing unowned Kubernetes HTTPRoute " + nodeName + ".",
  });
  assert.equal(deletions.length, 0);
}

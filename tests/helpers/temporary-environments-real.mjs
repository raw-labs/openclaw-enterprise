import assert from "node:assert/strict";

// Called only by the explicitly selected production Helm workflow. This helper
// uses its actual API, worker, Agent image and SSH image; it never substitutes a provider.
export async function configureTemporaryEnvironmentWorkflow({
  configuration,
  namespace,
  system,
  image,
  ca,
  get,
  createSecret,
  kubectl,
}) {
  assert.match(image, /^\S+@sha256:[a-f0-9]{64}$/u);
  const compute = configuration.drivers.compute.configuration;
  const proxyIP = (await get("pod", "operator")).status.podIP;
  compute.servicePrincipalCredentials = {
    mode: "projectedServiceAccountToken",
    audience: "occ-temporary-environment",
  };
  compute.temporaryEnvironmentApiUrl = "https://occ-workload." + system + ".svc.cluster.local:8443";
  compute.temporaryEnvironmentApiEgress = { cidr: proxyIP + "/32", port: 8443 };
  compute.temporaryEnvironmentApiCaBundle = ca.toString();
  compute.temporaryEnvironments = {
    profiles: [
      {
        id: "acceptance",
        namespaceIds: [namespace.id],
        image,
        cpuMillis: 100,
        memoryMiB: 128,
        lifetimeSeconds: 600,
        idleTimeoutSeconds: 120,
        egress: [],
      },
    ],
    quota: { maxEnvironments: 1, maxCpuMillis: 100, maxMemoryMiB: 128 },
  };
  await createSecret("occ-installation-startup", {
    "installation.yaml": JSON.stringify(configuration),
  });
  for (const component of ["api", "worker"]) {
    await kubectl(
      "-n",
      system,
      "rollout",
      "restart",
      "deployment/openclaw-enterprise-" + component,
    );
    await kubectl(
      "-n",
      system,
      "rollout",
      "status",
      "deployment/openclaw-enterprise-" + component,
      "--timeout=180s",
    );
  }
}

export async function allowTemporaryEnvironmentWorkflow({ system, tenant, agent, apply }) {
  await apply({
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: "occ-workload", namespace: system },
    spec: {
      type: "ClusterIP",
      selector: { app: "production-tui-proxy" },
      ports: [{ name: "https", port: 8443, targetPort: 8443 }],
    },
  });
  await apply({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "allow-temporary-workload-api", namespace: system },
    spec: {
      podSelector: { matchLabels: { app: "production-tui-proxy" } },
      policyTypes: ["Ingress"],
      ingress: [
        {
          from: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": tenant } },
              podSelector: {
                matchLabels: { "openclaw.dev/agent": agent.id },
                matchExpressions: [
                  {
                    key: "openclaw.dev/workload-role",
                    operator: "In",
                    values: ["agent", "gateway"],
                  },
                ],
              },
            },
          ],
          ports: [{ protocol: "TCP", port: 8443 }],
        },
      ],
    },
  });
}

export async function exerciseTemporaryEnvironmentWorkflow({
  api,
  kubectl,
  tenant,
  namespace,
  agent,
  pod,
  suffix,
  record,
}) {
  const role = await api(
    "POST",
    "/namespaces/" + namespace.id + "/iam/roles",
    {
      name: "Temporary environment acceptance",
      permissions: [{ action: "operate", resourceKind: "agent" }],
    },
    201,
  );
  await api(
    "POST",
    "/namespaces/" + namespace.id + "/iam/access-bindings",
    {
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId: role.id,
      resourceKind: "agent",
      resourceId: agent.id,
    },
    201,
  );
  const firstSlug = "temporary-" + suffix;
  const secondSlug = firstSlug + "-second";
  const nonce = "dirty-checkout-" + suffix;
  // Keys and the projected credential stay inside the real Agent. Two one-shot
  // runs at capacity one prove cleanup and quota reuse, not just SSH reachability.
  const command = [
    "set -eu",
    "directory=$(mktemp -d /tmp/oce-crabbox-proof.XXXXXX)",
    "trap 'rm -rf -- \"$directory\"' EXIT",
    'cd "$directory"',
    "git init -q",
    "git config user.name 'OCE integration'",
    "git config user.email 'integration@example.invalid'",
    "printf base > fixture.txt",
    "git add fixture.txt",
    "git commit -q -m fixture",
    "printf " + nonce + " > fixture.txt",
    "/usr/local/bin/crabbox doctor --provider external",
    ...[firstSlug, secondSlug].map(
      (slug) =>
        "/usr/local/bin/crabbox run --provider external --slug " +
        slug +
        ' -- sh -c \'set -eu; test "$(cat fixture.txt)" = ' +
        nonce +
        "; printf temporary-workflow-confirmed'",
    ),
  ].join("; ");
  const output = await kubectl("-n", tenant, "exec", pod, "--", "sh", "-c", command);
  assert.match(output, /temporary-workflow-confirmed/u);
  const inspect =
    'const fs=require("node:fs"); const base=(process.env.OCC_WORKLOAD_URL.endsWith("/")?process.env.OCC_WORKLOAD_URL.slice(0,-1):process.env.OCC_WORKLOAD_URL)+"/namespaces/"+process.env.OCC_WORKLOAD_NAMESPACE_ID+"/agents/"+process.env.OCC_WORKLOAD_AGENT_ID+"/temporary-environments"; fetch(base,{headers:{authorization:"Bearer "+fs.readFileSync(process.env.OCC_WORKLOAD_TOKEN_FILE,"utf8").trim()},redirect:"error",signal:AbortSignal.timeout(15000)}).then(async r=>{if(!r.ok)throw Error("workload read failed"); const body=await r.json(); console.log(JSON.stringify(body.data.filter(x=>' +
    JSON.stringify([firstSlug, secondSlug]) +
    ".includes(x.slug)).map(x=>({state:x.state,usable:x.usable,slug:x.slug}))));}).catch(()=>process.exit(1));";
  const receipts = JSON.parse(
    await kubectl("-n", tenant, "exec", pod, "--", "node", "-e", inspect),
  );
  assert.equal(receipts.length, 2);
  assert.ok(receipts.every((value) => value.state === "deleted" && value.usable === false));
  await record(
    "Packaged unmodified Crabbox transfers dirty checkout, executes SSH and confirms cleanup at capacity one",
  );
}

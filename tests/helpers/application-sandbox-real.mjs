import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import pg from "pg";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import { waitForResult } from "./wait-for.mjs";
import { createKubernetesClient, validateExplicitK3dLoopbackContext } from "./kubernetes-real.mjs";
import { protectedText, redactQaError, registerQaSecret } from "./qa-secrets.mjs";

const inheritedEnvironment = [
  "OCC_TEST_KUBERNETES_KUBECONFIG",
  "OCC_TEST_KUBERNETES_CONTEXT",
  "OCC_KUBECTL_BIN",
  "OCC_TEST_OPENSHELL_HELM",
  "OCC_TEST_OPENSHELL_WORKSPACE_HELM_CHART",
  "OCC_TEST_OPENSHELL_RUNTIME_CLASS",
];

function required(name) {
  assert.ok(
    process.env[name]?.trim(),
    `${name} is required for the selected application Sandbox workflow`,
  );
  return process.env[name].trim();
}

function successful(response, status) {
  assert.equal(
    response.status,
    status,
    `API returned ${response.status}: ${response.error?.code ?? "unexpected response"}`,
  );
  return response.data;
}

async function wait(description, operation) {
  return waitForResult(description, operation, { timeoutMs: 360000, intervalMs: 1000 });
}

/** A real prepared operator-mode manager, never a replacement runtime or mocked client. */
export async function verifyApplicationSandboxWorkflow(context) {
  for (const name of [
    "OPENAI_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "OCC_TEST_DATABASE_URL",
    "OCC_MIGRATION_DATABASE_URL",
  ]) {
    if (process.env[name]) {
      registerQaSecret(process.env[name]);
    }
  }
  const descriptor = JSON.parse(
    await readFile(required("OCC_TEST_APPLICATION_SANDBOX_ENV"), "utf8"),
  );
  assert.equal(descriptor.status, "ready", "the selected owned cluster must be ready");
  assert.equal(
    descriptor.networkPolicyProof?.denied,
    true,
    "the owned cluster must enforce NetworkPolicies",
  );
  for (const name of inheritedEnvironment) {
    const value = descriptor.environment?.[name];
    assert.equal(
      typeof value,
      "string",
      `${name} must be recorded in the owned fixture descriptor`,
    );
    if (process.env[name] !== undefined) {
      assert.equal(process.env[name], value, `${name} must match the selected owned fixture`);
    }
    process.env[name] = value;
  }
  const selection = {
    kubeconfigPath: required("OCC_TEST_KUBERNETES_KUBECONFIG"),
    kubernetesContext: required("OCC_TEST_KUBERNETES_CONTEXT"),
  };
  await validateExplicitK3dLoopbackContext(selection);
  const cluster = createKubernetesClient({ selection });
  const databaseUrl = required("OCC_TEST_DATABASE_URL");
  const database = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(database.hostname));
  assert.match(
    database.pathname,
    /^\/openclaw_k8s_[a-z0-9_]+$/u,
    "the workflow requires a dedicated Kubernetes test database",
  );
  const migrator = new URL(required("OCC_MIGRATION_DATABASE_URL"));
  assert.equal(
    migrator.pathname,
    database.pathname,
    "migrator and application must target the same disposable database",
  );
  assert.notEqual(
    migrator.username,
    database.username,
    "the application must not use the migration role",
  );
  const observer = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  context.after(() => observer.end());
  const role = (
    await observer.query(
      "SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user",
    )
  ).rows[0];
  assert.deepEqual(
    role,
    { rolsuper: false, rolcreatedb: false, rolcreaterole: false },
    "the real application requires the limited database role",
  );
  const { PostgresPlatformState } = await import("../../packages/occ/src/index.ts");
  assert.equal(
    await new PostgresPlatformState(observer).loadInstallation(),
    undefined,
    "application Sandbox qualification requires a freshly migrated disposable database without an Installation",
  );
  const gatewayImage = required("OCC_TEST_KUBERNETES_GATEWAY_IMAGE");
  const codexImage = required("OCC_TEST_KUBERNETES_AGENT_IMAGE");
  for (const image of [gatewayImage, codexImage]) {
    assert.match(
      image,
      /@sha256:[a-f0-9]{64}$/u,
      "real runtimes must be selected by immutable digest",
    );
  }
  const modes = (process.env.OCC_TEST_APPLICATION_SANDBOX_MODES ?? "embedded,dedicated").split(",");
  assert.ok(modes.length > 0 && modes.every((mode) => ["embedded", "dedicated"].includes(mode)));
  assert.equal(new Set(modes).size, modes.length);
  for (const mode of modes) {
    required(mode === "embedded" ? "OPENAI_API_KEY" : "CODEX_ACCESS_TOKEN");
  }
  const model = required("OCC_TEST_OPENAI_MODEL").replace(/^(?:openai|codex)\//u, "");
  const { OpenShellGateway } = await import("../../apps/controller/src/backends/openshell.ts");
  const { GrpcOpenShellGatewayClient } =
    await import("../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts");
  const { createOpenShellSandboxDriver } =
    await import("../../apps/controller/src/drivers/sandbox/openshell.ts");
  const { KubernetesComputeDriver, kubernetesNamespaceName } =
    await import("../../apps/controller/src/drivers/compute/kubernetes/index.ts");
  const { OCCPluginDriver, CodexPluginDriver } =
    await import("../../apps/controller/src/drivers/plugin/index.ts");
  const { createGatewayNodeEnrollment } =
    await import("../../apps/controller/src/gateway/node-enrollment-client.ts");
  const {
    createProvisioningApiFixture,
    createScopedController,
    fixtureComputeConfiguration,
    kubectl,
    resource,
    resources,
    deleteNamespaces,
    hash,
    execute,
  } = await import("./kubernetes-compute-real.mjs");
  const managerNamespace = descriptor.namespaceName;
  assert.equal(
    (await resource("namespace", managerNamespace)).metadata.uid,
    descriptor.namespaceUid,
  );
  const manager = await resource("pod", descriptor.gatewayPodName, managerNamespace);
  const managerAccount = manager.spec.serviceAccountName;
  const nativeAccount = `${descriptor.gatewayServiceName}-sandbox`;
  const managerService = await resource("service", descriptor.gatewayServiceName, managerNamespace);
  const managerPort = managerService.spec.ports.find(({ port }) => port === 8080)?.port;
  assert.equal(
    managerPort,
    8080,
    "the selected stock manager must expose its qualified service listener",
  );
  const managerLabels = {
    "app.kubernetes.io/name": "openshell",
    "app.kubernetes.io/instance": descriptor.gatewayServiceName,
  };
  const managerOrigin = `http://${descriptor.gatewayServiceName}.${managerNamespace}.svc:${managerPort}`;
  assert.match(descriptor.endpoint ?? "", /^http:\/\/127\.0\.0\.1:[0-9]+$/u);
  const nativeClient = new GrpcOpenShellGatewayClient({ endpoint: descriptor.endpoint });
  context.after(() => nativeClient.close());
  await nativeClient.health(AbortSignal.timeout(10000));
  const backendDefinition = {
    id: "application-workflow-openshell",
    type: "openshell",
    configuration: { endpoint: managerOrigin, insecureTransport: "network-policy" },
    drivers: { sandbox: "application-workflow-sandbox" },
  };
  const backend = {
    id: backendDefinition.id,
    drivers: backendDefinition.drivers,
    client: new OpenShellGateway(backendDefinition.configuration, { gatewayClient: nativeClient }),
  };
  const platformNamespace = `oce-app-test-${hash(randomUUID())}`;
  await kubectl("create", "namespace", platformNamespace);
  context.after(() => deleteNamespaces(platformNamespace));
  const identity = await createScopedController(context, randomUUID(), platformNamespace);
  // Application cleanup lists only exact-owned private resources. Match the
  // production tenant permissions rather than using an administrator as OCC.
  await kubectl(
    "patch",
    "clusterrole",
    identity.tenantRole,
    "--type=json",
    "--patch",
    JSON.stringify([
      {
        op: "add",
        path: "/rules/-",
        value: {
          apiGroups: [""],
          resources: ["secrets", "persistentvolumeclaims"],
          verbs: ["get", "list", "create", "patch", "update", "delete"],
        },
      },
    ]),
  );
  const infrastructure = await resource("service", "kubernetes", "default");
  const apiEndpoints = await resource("endpoints", "kubernetes", "default");
  const denyCidrs = [
    ...new Set([
      ...(infrastructure.spec.clusterIPs ?? [infrastructure.spec.clusterIP]),
      ...(apiEndpoints.subsets ?? []).flatMap(({ addresses = [] }) =>
        addresses.map(({ ip }) => ip),
      ),
      managerService.spec.clusterIP,
    ]),
  ].map((address) => {
    const family = isIP(address);
    assert.notEqual(family, 0);
    return `${address}/${family === 4 ? 32 : 128}`;
  });
  const sandboxOptions = {
    workloadTarget: "application",
    application: {
      developmentOnly: true,
      servicePeer: { namespace: managerNamespace, podLabels: managerLabels, port: managerPort },
    },
    gateway: {
      workspaceMode: "operator",
      operatorNamespaceLabels: { "openshell.ai/openclaw-workspace": "true" },
      operatorWorkspaceResources: [],
      networkPolicyResources: [],
    },
    kubernetes: {
      runtimeClassName: required("OCC_TEST_OPENSHELL_RUNTIME_CLASS"),
      userNamespaces: false,
      serviceAccount: { mode: "gatewayConfigured" },
      sandboxDataMount: { subPath: "workspace", mountPath: "/sandbox/enterprise", readOnly: false },
    },
    policy: { process: { runAsUser: "10001", runAsGroup: "10001" }, networkPolicies: [] },
  };
  const sandbox = createOpenShellSandboxDriver(sandboxOptions, {
    id: "application-workflow-sandbox",
    backend,
  });
  const workload = {
    requests: { cpu: "100m", memory: "256Mi" },
    limits: { cpu: "2", memory: "4Gi" },
  };
  const configuration = fixtureComputeConfiguration({
    authentication: identity.authentication,
    images: { gateway: gatewayImage, agent: codexImage, requireImmutableDigest: true },
    resources: {
      gateway: workload,
      agent: workload,
      namespace: {
        quota: {
          pods: "20",
          "requests.cpu": "6",
          "requests.memory": "8Gi",
          "limits.cpu": "20",
          "limits.memory": "24Gi",
        },
        containerDefaults: workload,
      },
    },
    network: {
      dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
      gatewayPort: 18789,
      gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
      pluginStatusProxySourceCidrs: (
        process.env.OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS ?? ""
      )
        .split(",")
        .filter(Boolean),
    },
    servicePrincipalCredentials: { mode: "disabled" },
    runtime: {
      transportSecretPrefix: "application-transport",
      gatewayStorageClassName: "local-path",
      gatewayOutbound: { enabled: true, denyCidrs, image: gatewayImage },
    },
    ...(descriptor.gatewayRouting ? { gatewayRouting: descriptor.gatewayRouting } : {}),
  });
  if (modes.includes("dedicated")) {
    assert.ok(
      descriptor.gatewayRouting,
      "dedicated execution requires genuine prepared Gateway routing and node enrollment",
    );
    required("OCC_TEST_APPLICATION_GATEWAY_API_KEY_FILE");
    assert.ok(
      configuration.network.pluginStatusProxySourceCidrs.length > 0,
      "dedicated status requires the actual API-server proxy source CIDRs",
    );
  }
  const gatewayApiKey = modes.includes("dedicated")
    ? await protectedText(
        required("OCC_TEST_APPLICATION_GATEWAY_API_KEY_FILE"),
        "Gateway routing credential",
      )
    : undefined;
  for (const mode of modes) {
    await context.test(
      `real ${mode} Gateway containment`,
      { timeout: 900000 },
      async (scenario) => {
        try {
          const events = [];
          const nodeEnrollment =
            mode === "dedicated"
              ? createGatewayNodeEnrollment(async () => gatewayApiKey)
              : undefined;
          const compute = new KubernetesComputeDriver(configuration, {
            sandboxDriver: sandbox,
            ...(nodeEnrollment ? { nodeEnrollment } : {}),
          });
          const fixture = await createProvisioningApiFixture(
            scenario,
            compute,
            identity.authentication,
            {
              sandboxDriver: sandbox,
              backendDefinitions: [backendDefinition],
              pluginDriver: mode === "embedded" ? new OCCPluginDriver() : new CodexPluginDriver(),
              mockSlackCredentials: false,
              emit: (event) => events.push(event),
            },
          );
          const owner = successful(
            await fixture.request("POST", "/namespaces", {
              name: `Application ${mode} ${randomUUID()}`,
            }),
            201,
          );
          const placement = kubernetesNamespaceName(owner.id);
          scenario.after(async () => {
            try {
              const workspace = await nativeClient.getWorkspace(
                placement,
                AbortSignal.timeout(30000),
              );
              if (workspace) {
                assert.equal(
                  workspace.labels["openclaw.dev/namespace-id"],
                  owner.id,
                  "cleanup may remove only this test Namespace's native Workspace",
                );
                await nativeClient.deleteWorkspace(placement, AbortSignal.timeout(60000));
              }
            } finally {
              await deleteNamespaces(
                placement,
                ...fixture.bootstrapNamespaceIds.map(kubernetesNamespaceName),
              );
            }
          });
          // The operator workspace RoleBinding can only be installed after OCC has
          // materialized the tenant namespace. The queued worker still owns the
          // platform Namespace transition and all subsequent Agent deployment.
          await compute.ensureNamespace(owner);
          await wait("the exact API-created tenant Kubernetes namespace", async () => {
            try {
              return await resource("namespace", placement);
            } catch {
              return undefined;
            }
          });
          await kubectl(
            "create",
            "rolebinding",
            "openclaw-controller",
            "--namespace",
            placement,
            `--clusterrole=${identity.tenantRole}`,
            `--serviceaccount=${platformNamespace}:${identity.account}`,
          );
          await execute(
            required("OCC_TEST_OPENSHELL_HELM"),
            [
              "upgrade",
              "--install",
              `app-workspace-${hash(owner.id)}`,
              required("OCC_TEST_OPENSHELL_WORKSPACE_HELM_CHART"),
              "--namespace",
              placement,
              "--kubeconfig",
              selection.kubeconfigPath,
              "--kube-context",
              selection.kubernetesContext,
              "--wait",
              "--timeout",
              "240s",
              "--set=gateway.allowDriverConfig=true",
              `--set-string=gateway.serviceAccount.name=${managerAccount}`,
              `--set-string=gateway.serviceAccount.namespace=${managerNamespace}`,
              `--set-string=sandboxServiceAccount.name=${nativeAccount}`,
            ],
            { maxBuffer: 4 * 1024 * 1024 },
          );
          const ingressPolicy = `application-test-${hash(owner.id)}`;
          await cluster.applyManifest({
            apiVersion: "networking.k8s.io/v1",
            kind: "NetworkPolicy",
            metadata: { name: ingressPolicy, namespace: managerNamespace },
            spec: {
              podSelector: { matchLabels: managerLabels },
              policyTypes: ["Ingress"],
              ingress: [
                {
                  from: [
                    {
                      namespaceSelector: {
                        matchLabels: { "kubernetes.io/metadata.name": placement },
                      },
                      podSelector: {
                        matchExpressions: [
                          {
                            key: "openshell.ai/boundary-role",
                            operator: "In",
                            values: ["supervisor"],
                          },
                        ],
                      },
                    },
                    {
                      namespaceSelector: {
                        matchLabels: { "kubernetes.io/metadata.name": placement },
                      },
                      podSelector: { matchLabels: { "openclaw.dev/workload-role": "gateway" } },
                    },
                  ],
                  ports: [{ protocol: "TCP", port: managerPort }],
                },
              ],
            },
          });
          scenario.after(() =>
            kubectl(
              "delete",
              "networkpolicy",
              ingressPolicy,
              "--namespace",
              managerNamespace,
              "--ignore-not-found=true",
            ),
          );
          await fixture.startWorker();
          await wait("the normal Namespace worker transition", async () => {
            const observed = successful(
              await fixture.request("GET", `/namespaces/${owner.id}`),
              200,
            );
            return observed.status === "ready" ? observed : undefined;
          });
          const credential = required(
            mode === "embedded" ? "OPENAI_API_KEY" : "CODEX_ACCESS_TOKEN",
          );
          const secret = successful(
            await fixture.request("POST", `/namespaces/${owner.id}/secrets`, {
              name: `Model ${mode}`,
              value: credential,
            }),
            201,
          );
          const admitted = successful(
            await fixture.request("POST", `/namespaces/${owner.id}/agents/provision`, {
              requestId: `req_${randomUUID()}`,
              name: `Contained ${mode}`,
              executionMode: mode,
              configuration: {
                kind: "agent",
                values: createHarnessConfiguration(
                  mode === "embedded" ? "openclaw" : "codex",
                  model,
                ),
              },
              harnessAuth: {
                method: mode === "embedded" ? "api_key" : "codex_pat",
                source: secret.ref,
              },
            }),
            202,
          );
          const provisioned = await wait(
            "real API provisioning and immutable revision handoff",
            async () => {
              const observed = successful(
                await fixture.request("GET", admitted.provisioning.url),
                200,
              );
              assert.notEqual(
                observed.status,
                "failed",
                `provisioning failed: ${observed.error?.code ?? "unknown"}`,
              );
              return observed.status === "succeeded" && observed.agentId && observed.revisionId
                ? observed
                : undefined;
            },
          );
          const agentPath = `/namespaces/${owner.id}/agents/${provisioned.agentId}`;
          let revisionId = provisioned.revisionId;
          const active = async () =>
            wait("the exact worker-activated revision", async () => {
              const agent = successful(await fixture.request("GET", agentPath), 200);
              const completed = events.some(
                (event) =>
                  event.event === "worker.completed" &&
                  event.revisionId === revisionId &&
                  event.outcome === "success",
              );
              return agent.activeRevisionId === revisionId && completed ? agent : undefined;
            });
          let agent = await active();
          const nativePod = async () =>
            wait("one exact contained native Gateway Pod", async () => {
              const pods = (await resources("pods", placement)).filter(
                ({ metadata }) =>
                  metadata.labels?.["openclaw.dev/contained-agent"] === agent.id &&
                  metadata.labels?.["openclaw.dev/contained-revision"] === revisionId &&
                  metadata.labels?.["openshell.ai/boundary-role"] === "workload" &&
                  !metadata.deletionTimestamp,
              );
              return pods.length === 1 ? pods[0] : undefined;
            });
          const rpc = async (method, params, expectFinal = false) => {
            const pod = await nativePod();
            // This is only a loopback RPC client. Gateway outbound requests and
            // model execution run in the existing, genuinely contained application.
            const program = `const fs=require('node:fs');const cp=require('node:child_process');const env={...process.env,...JSON.parse(fs.readFileSync('/oce-application-environment/private/environment.json','utf8'))};delete env.OCE_APPLICATION_TRANSPORT_TOKEN;const args=['/app/openclaw.mjs','gateway','call',${JSON.stringify(method)},'--params',${JSON.stringify(JSON.stringify(params))},'--json','--timeout','180000',${expectFinal ? "'--expect-final'" : "...[]"}];process.stdout.write(cp.execFileSync(process.execPath,args,{env,encoding:'utf8',timeout:210000,maxBuffer:4*1024*1024}));`;
            const raw = await kubectl(
              "exec",
              pod.metadata.name,
              "--namespace",
              placement,
              "--container",
              "agent",
              "--",
              "node",
              "-e",
              program,
            );
            assert.equal(
              raw.includes(credential),
              false,
              "runtime responses must not expose model credentials",
            );
            return JSON.parse(raw);
          };
          const turn = async () => {
            const nonce = `containment-${randomUUID()}`;
            const reply = await rpc(
              "agent",
              {
                message: `Reply with exactly ${nonce} and nothing else.`,
                sessionKey: `agent:main:containment-${randomUUID()}`,
                idempotencyKey: randomUUID(),
              },
              true,
            );
            assert.equal(reply.status, "ok");
            const text = reply.result?.payloads
              ?.filter((payload) => !payload.isError)
              .map(({ text }) => text ?? "")
              .join("\n");
            assert.ok(
              text?.includes(nonce),
              "the real provider-backed Gateway turn must return its nonce",
            );
          };
          await turn();
          const denied = await rpc("plugins.catalog.browse", { intent: "trending", pageSize: 5 });
          assert.equal(
            typeof denied.remoteError,
            "string",
            "unapproved ClawHub access must fail remotely, not masquerade as bundled results",
          );
          const harnessEgress = async () =>
            (await resources("networkpolicy", placement))
              .filter(
                ({ spec }) =>
                  spec.podSelector?.matchLabels?.["openclaw.dev/workload-role"] === "agent" &&
                  spec.policyTypes?.includes("Egress"),
              )
              .map(({ metadata, spec }) => ({ name: metadata.name, egress: spec.egress ?? [] }))
              .sort((left, right) => left.name.localeCompare(right.name));
          const originalHarnessEgress = mode === "dedicated" ? await harnessEgress() : undefined;
          const statePath = `/home/node/.openclaw/agents/containment-${randomUUID()}.txt`;
          const stateValue = randomUUID();
          const sandboxName = `oa-${hash(`${revisionId}/${mode === "embedded" ? "embedded" : "gateway"}`, 16)}`;
          const filesystem = `const fs=require('node:fs');fs.mkdirSync('/home/node/.openclaw/agents',{recursive:true});fs.writeFileSync(${JSON.stringify(statePath)},${JSON.stringify(stateValue)});for(const [operation,target] of [['read','/.openshell/pod-identity/uid'],['write','/app/.application-forbidden']]){let denied=false;try{if(operation==='read')fs.readFileSync(target);else fs.writeFileSync(target,'forbidden')}catch(error){denied=['EACCES','EPERM','EROFS'].includes(error.code)}if(!denied)process.exit(1)}`;
          assert.equal(
            await nativeClient.execSandbox(
              {
                workspace: placement,
                sandbox: sandboxName,
                command: ["node", "-e", filesystem],
                environment: {},
                stdin: "",
                timeoutSeconds: 30,
              },
              AbortSignal.timeout(40000),
            ),
            0,
            "native exec must permit private state and reject forbidden filesystem operations",
          );
          successful(
            await fixture.request("PATCH", agentPath, {
              configurationId: agent.configurationId,
              gatewayOutbound: { mode: "restricted", hosts: ["clawhub.ai"] },
            }),
            200,
          );
          revisionId = successful(await fixture.request("POST", `${agentPath}/deploy`), 202).id;
          agent = await active();
          const allowed = await rpc("plugins.catalog.browse", { intent: "trending", pageSize: 5 });
          assert.equal(
            allowed.remoteError,
            undefined,
            "an admitted ClawHub request must actually reach the remote registry",
          );
          assert.ok(
            Array.isArray(allowed.items) && allowed.items.length > 0,
            "trending remote-only results must be nonempty; bundled fallback is not proof",
          );
          if (mode === "dedicated") {
            assert.deepEqual(
              await harnessEgress(),
              originalHarnessEgress,
              "a Gateway destination grant must not widen the separate Harness egress policy",
            );
          }
          const successorName = `oa-${hash(`${revisionId}/${mode === "embedded" ? "embedded" : "gateway"}`, 16)}`;
          assert.equal(
            await nativeClient.execSandbox(
              {
                workspace: placement,
                sandbox: successorName,
                command: [
                  "node",
                  "-e",
                  "const socket=require('node:net').connect({host:'1.1.1.1',port:443});socket.once('connect',()=>{socket.destroy();process.exit(1)});socket.once('error',error=>process.exit(['EACCES','EPERM'].includes(error.code)?0:2));socket.setTimeout(5000,()=>{socket.destroy();process.exit(2)});",
                ],
                environment: {},
                stdin: "",
                timeoutSeconds: 10,
              },
              AbortSignal.timeout(15000),
            ),
            0,
            "an unapproved direct socket must receive an enforcement denial; timeout or generic network failure is not proof",
          );
          assert.equal(
            await nativeClient.execSandbox(
              {
                workspace: placement,
                sandbox: successorName,
                command: [
                  "node",
                  "-e",
                  `if(require('node:fs').readFileSync(${JSON.stringify(statePath)},'utf8')!==${JSON.stringify(stateValue)})process.exit(1)`,
                ],
                environment: {},
                stdin: "",
                timeoutSeconds: 30,
              },
              AbortSignal.timeout(40000),
            ),
            0,
            "normal replacement must retain the exact Agent-owned private state",
          );
          await turn();
          successful(await fixture.request("POST", `${agentPath}/stop`), 202);
          await wait(
            "normal stop to terminate frontend, Harness and contained payload",
            async () => {
              const pods = await resources("pods", placement);
              return pods.every(
                ({ metadata }) =>
                  metadata.labels?.["openclaw.dev/agent"] !== agent.id &&
                  metadata.labels?.["openclaw.dev/contained-agent"] !== agent.id,
              )
                ? true
                : undefined;
            },
          );
          await wait("exact private delivery cleanup while Agent state remains", async () => {
            const claims = await resources("persistentvolumeclaims", placement);
            const temporary = claims.filter(
              ({ metadata }) =>
                metadata.annotations?.["openclaw.dev/agent-id"] === agent.id &&
                metadata.labels?.["openclaw.dev/application-bootstrap"],
            );
            const retained = claims.some(
              ({ metadata }) =>
                metadata.annotations?.["openclaw.dev/agent-id"] === agent.id &&
                metadata.name === `gateway-state-${hash(agent.id)}`,
            );
            return temporary.length === 0 && retained ? true : undefined;
          });
          scenario.diagnostic(
            `Verified real ${mode} Agent API/worker deployment, model turns before/after replacement, remote ClawHub deny/allow, native filesystem confinement, retained state and stop cleanup. Model-directed HTTP tools, plugin installation and external Envoy routing are not covered by this case.`,
          );
        } catch (error) {
          throw redactQaError(error);
        }
      },
    );
  }
}

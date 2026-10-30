import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createConnection, isIP } from "node:net";
import {
  createKubernetesClient,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.mjs";

const execute = promisify(execFile);
const configurationFile = process.env.OCC_TEST_TWO_CLUSTER_CONFIG;

test(
  "installed OCE owns Gateway and Harness lifecycles across two real clusters",
  { skip: configurationFile === undefined, timeout: 900_000 },
  async (t) => {
    // The selected fixture is a complete Helm-installed OCE, with separate API
    // and worker credentials. Neither the controller nor its Drivers are mocked.
    const configuration = JSON.parse(await readFile(configurationFile, "utf8"));
    // Independent responders distinguish policy denial from an unavailable upstream.
    const destinations = configuration.gatewayDestinations;
    assert.ok(destinations, "gatewayDestinations.first and replacement are required.");
    for (const endpoint of [destinations.first, destinations.replacement]) {
      const url = new URL(endpoint.url);
      assert.equal(url.protocol, "https:");
      assert.equal(url.username + url.password + url.hash + url.port, "");
      assert.equal(isIP(url.hostname), 0);
      assert.match(url.hostname, /^[a-z0-9.-]+$/);
      assert.match(endpoint.marker, /^[a-zA-Z0-9_-]{8,120}$/);
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, 200);
      assert.ok((await response.text()).includes(endpoint.marker));
    }
    assert.notEqual(
      new URL(destinations.first.url).hostname,
      new URL(destinations.replacement.url).hostname,
    );
    const outbound = (endpoint) => ({
      destinations: [{ host: new URL(endpoint.url).hostname, port: 443 }],
    });
    const origin = new URL(configuration.apiUrl);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname));
    assert.ok(["http:", "https:"].includes(origin.protocol));
    assert.equal(origin.username + origin.password + origin.search + origin.hash, "");
    const authMethod = configuration.harnessAuthMethod ?? "api_key";
    assert.ok(["api_key", "codex_pat"].includes(authMethod), "Unsupported harnessAuthMethod.");
    const modelEnvironment = authMethod === "codex_pat" ? "CODEX_ACCESS_TOKEN" : "OPENAI_API_KEY";
    const modelCredential = process.env[modelEnvironment];
    assert.ok(modelCredential, `The selected real-runtime case requires ${modelEnvironment}.`);
    const key = JSON.parse(await readFile(configuration.serviceKeyFile, "utf8")).data.key;
    assert.equal(typeof key, "string");
    const planes = {};
    for (const plane of ["control", "execution"]) {
      await validateExplicitK3dLoopbackContext(configuration[plane]);
      planes[plane] = createKubernetesClient({
        selection: configuration[plane],
        waitTimeoutMs: 420_000,
      });
    }
    const cp = planes.control;
    const dp = planes.execution;
    const cpIdentity = await cp.resource("namespace", "kube-system");
    const dpIdentity = await dp.resource("namespace", "kube-system");
    assert.notEqual(cpIdentity.metadata.uid, dpIdentity.metadata.uid);

    assert.equal(
      typeof configuration.dockerContext,
      "string",
      "Select the owned local Docker context explicitly.",
    );
    const docker = async (...args) =>
      (
        await execute("docker", ["--context", configuration.dockerContext, ...args], {
          timeout: 30_000,
        })
      ).stdout;
    const dockerContext = JSON.parse(
      await docker("context", "inspect", configuration.dockerContext),
    )[0];
    assert.ok(
      dockerContext.Endpoints.docker.Host.startsWith("unix://"),
      "The outage test only operates on a local Docker VM.",
    );
    const executionNode = `${configuration.execution.kubernetesContext}-server-0`;
    const inspected = JSON.parse(await docker("inspect", executionNode))[0];
    assert.equal(
      inspected.Config.Labels["k3d.cluster"],
      configuration.execution.kubernetesContext.slice(4),
    );
    assert.equal(inspected.State.Running, true);
    const executionContainerId = inspected.Id;

    async function api(method, path, body) {
      const response = await fetch(new URL(path, origin), {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: {
          "x-api-key": key,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 204) {
        return undefined;
      }
      const envelope = await response.json();
      assert.ok(response.ok, `${method} ${path}: ${response.status} ${envelope.error?.code}`);
      return envelope.data;
    }

    const tenant = await api("POST", "/namespaces", { name: `two-cluster-${randomUUID()}` });
    const base = `/namespaces/${tenant.id}`;
    const namespaces = {};
    // Admin grants are deliberately outside OCC worker authority. The worker
    // must wait for each grant and cannot create or escalate its own RoleBindings.
    for (const plane of ["execution", "control"]) {
      const client = planes[plane];
      const label = plane === "control" ? "gateway-namespace" : "namespace";
      namespaces[plane] = await client.waitFor(`${plane} tenant namespace`, async () => {
        const result = JSON.parse(
          await client.kubectl(
            "get",
            "namespaces",
            "-l",
            `openclaw.dev/${label}=${tenant.id}`,
            "-o",
            "json",
          ),
        ).items;
        assert.ok(result.length <= 1);
        return result[0]?.metadata.name;
      });
      const release = configuration[plane].release;
      assert.match(release, /^[a-z0-9][a-z0-9-]*$/);
      const grants =
        plane === "control"
          ? [
              ["worker", "openclaw-tenant-worker"],
              ["api", "openclaw-tenant-api"],
              ["api", "openclaw-tenant-configuration"],
            ]
          : [
              ["worker", "execution-tenant-worker"],
              ["api", "execution-tenant-api"],
            ];
      for (const [component, role] of grants) {
        await client.applyManifest(
          JSON.stringify({
            apiVersion: "rbac.authorization.k8s.io/v1",
            kind: "RoleBinding",
            metadata: { name: `${role}-${component}`, namespace: namespaces[plane] },
            subjects: [
              {
                kind: "ServiceAccount",
                name: `openclaw-enterprise-${component}`,
                namespace: configuration[plane].systemNamespace,
              },
            ],
            roleRef: {
              apiGroup: "rbac.authorization.k8s.io",
              kind: "ClusterRole",
              name: `${release}-${role}`,
            },
          }),
        );
      }
    }
    await cp.waitFor(
      "ready platform Namespace",
      async () => (await api("GET", base)).status === "ready",
    );

    const secret = await api("POST", `${base}/secrets`, {
      name: "Model",
      value: modelCredential,
    });
    const native = await api("POST", `${base}/configurations`, configuration.agentConfiguration);
    const agent = await api("POST", `${base}/agents`, {
      name: "two-cluster-lifecycle",
      configurationId: native.id,
      executionMode: "dedicated",
      harnessAuth: { method: authMethod, source: secret.ref },
    });
    const agentPath = `${base}/agents/${agent.id}`;
    await api("PATCH", agentPath, { gatewayOutbound: outbound(destinations.first) });
    const role = await api("POST", `${base}/iam/roles`, {
      name: "Exact model Secret",
      permissions: [{ action: "operate", resourceKind: "secret" }],
    });
    await api("POST", `${base}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId: role.id,
      resourceKind: "secret",
      resourceId: secret.id,
    });
    await api("POST", `${agentPath}/runtime-credentials`, {});

    const peer = await api("POST", `${base}/agents`, {
      name: "two-cluster-peer",
      configurationId: native.id,
      executionMode: "dedicated",
      harnessAuth: { method: authMethod, source: secret.ref },
    });
    const peerPath = base + "/agents/" + peer.id;
    await api("PATCH", peerPath, { gatewayOutbound: outbound(destinations.replacement) });
    await api("POST", base + "/iam/access-bindings", {
      subjectKind: "identity",
      subjectId: peer.servicePrincipalId,
      roleId: role.id,
      resourceKind: "secret",
      resourceId: secret.id,
    });
    await api("POST", peerPath + "/runtime-credentials", {});

    async function waitForDeployment(revision, path = agentPath) {
      await cp.waitFor("successful exact revision", async () => {
        const status = await api("GET", `${path}/deployments/${revision.id}`);
        assert.notEqual(status.status, "failed", status.error?.code);
        return status.status === "succeeded";
      });
      return revision;
    }
    async function deploy() {
      return waitForDeployment(await api("POST", `${agentPath}/deploy`));
    }
    const authenticationPolicies = async () =>
      (await dp.resources("networkpolicies", namespaces.execution)).filter(
        (policy) =>
          policy.metadata.name.startsWith("allow-agent-auth-") &&
          policy.spec.podSelector.matchLabels["openclaw.dev/agent"] === agent.id,
      );
    const proxyResources = async (plane, owner = agent) =>
      JSON.parse(
        await planes[plane].kubectl(
          "get",
          "pods,services,deployments,configmaps,networkpolicies",
          "-n",
          namespaces[plane],
          "-l",
          "openclaw.dev/agent=" + owner.id,
          "-o",
          "json",
        ),
      ).items.filter((resource) => resource.metadata.name.startsWith("gateway-proxy-"));
    async function gatewayExecFor(owner, script, ...args) {
      const gateway = (await pods("control", "gateway", owner)).find(
        (pod) => !pod.metadata.deletionTimestamp,
      );
      assert.ok(gateway, "Gateway stays in the control cluster");
      return JSON.parse(
        await cp.kubectl(
          "exec",
          gateway.metadata.name,
          "-n",
          namespaces.control,
          "-c",
          "gateway",
          "--",
          "node",
          "--input-type=module",
          "-e",
          script,
          ...args,
        ),
      );
    }
    const gatewayExec = (script, ...args) => gatewayExecFor(agent, script, ...args);
    async function allowed(endpoint, owner = agent) {
      const result = await gatewayExecFor(
        owner,
        "const r=await fetch(process.argv[1],{redirect:'error',signal:AbortSignal.timeout(15000)});console.log(JSON.stringify({status:r.status,matched:(await r.text()).includes(process.argv[2])}));",
        endpoint.url,
        endpoint.marker,
      );
      assert.equal(result.status, 200);
      assert.equal(result.matched, true, "approved upstream returned its independent marker");
    }
    async function denied(endpoint, owner = agent) {
      const result = await gatewayExecFor(
        owner,
        "try{await fetch(process.argv[1],{redirect:'error',signal:AbortSignal.timeout(15000)});console.log(JSON.stringify({denied:false}));}catch{console.log(JSON.stringify({denied:true}));}",
        endpoint.url,
      );
      assert.equal(result.denied, true, "unapproved HTTPS destination must be refused");
    }
    async function assertProxyPlacement(revision) {
      const resources = await proxyResources("control");
      assert.equal(
        (await proxyResources("execution")).length,
        0,
        "no Gateway proxy in execution cluster",
      );
      const proxies = resources.filter(
        (resource) => resource.kind === "Pod" && !resource.metadata.deletionTimestamp,
      );
      assert.equal(proxies.length, 1);
      assert.equal(proxies[0].metadata.labels["openclaw.dev/revision"], revision.id);
      assert.ok(resources.some((resource) => resource.kind === "Service"));
      return resources;
    }
    const first = await deploy();
    const pods = (plane, role, owner = agent) =>
      planes[plane].resources(
        "pods",
        namespaces[plane],
        "-l",
        `openclaw.dev/agent=${owner.id},openclaw.dev/workload-role=${role}`,
      );
    assert.equal((await pods("control", "gateway")).length, 1);
    assert.equal((await pods("execution", "gateway")).length, 0);
    assert.equal((await pods("control", "agent")).length, 0);
    const peerRevision = await waitForDeployment(await api("POST", peerPath + "/deploy"), peerPath);
    const peerGateway = (await pods("control", "gateway", peer))[0];
    assert.ok(peerGateway);
    const peerProxies = await proxyResources("control", peer);
    assert.ok(
      peerProxies.some(
        (resource) =>
          resource.kind === "Pod" &&
          resource.metadata.labels["openclaw.dev/revision"] === peerRevision.id,
      ),
    );
    assert.equal((await proxyResources("execution", peer)).length, 0);
    await allowed(destinations.replacement, peer);
    await denied(destinations.first, peer);
    const firstProxy = await assertProxyPlacement(first);
    // A reachable own frontend controls for CNI refusal of the peer's proxy.
    const tcp =
      "import net from 'node:net';const s=net.connect({host:process.argv[1],port:3129});let done=false;function finish(connected){if(done)return;done=true;s.destroy();console.log(JSON.stringify({connected}));}s.setTimeout(5000,()=>finish(false));s.once('connect',()=>finish(true));s.once('error',()=>finish(false));";
    const firstAddress = firstProxy.find((resource) => resource.kind === "Service").spec.clusterIP;
    const peerAddress = peerProxies.find((resource) => resource.kind === "Service").spec.clusterIP;
    for (const [owner, ownAddress, otherAddress] of [
      [agent, firstAddress, peerAddress],
      [peer, peerAddress, firstAddress],
    ]) {
      assert.equal((await gatewayExecFor(owner, tcp, ownAddress)).connected, true);
      assert.equal((await gatewayExecFor(owner, tcp, otherAddress)).connected, false);
    }
    await allowed(destinations.first);
    await denied(destinations.replacement);
    // Raw TCP ignores HTTP(S)_PROXY. The runner connects to each exact IP as
    // an independent positive control; an unreachable address is not CNI proof.
    const direct = await gatewayExec(
      "import dns from 'node:dns/promises';import net from 'node:net';const addresses=await dns.lookup(new URL(process.argv[1]).hostname,{all:true,family:4});const results=[];for(const {address} of addresses){results.push(await new Promise(resolve=>{const s=net.connect({host:address,port:443});let done=false;function finish(connected){if(done)return;done=true;s.destroy();resolve({address,connected});}s.setTimeout(5000,()=>finish(false));s.once('connect',()=>finish(true));s.once('error',()=>finish(false));}));}console.log(JSON.stringify(results));",
      destinations.first.url,
    );
    assert.ok(direct.length > 0);
    for (const result of direct) {
      assert.equal(result.connected, false, "direct Gateway TCP bypass to " + result.address);
      const connected = await new Promise((resolve) => {
        const socket = createConnection({ host: result.address, port: 443 });
        socket.setTimeout(10000);
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("timeout", () => {
          socket.destroy();
          resolve(false);
        });
        socket.once("error", () => resolve(false));
      });
      assert.equal(connected, true, "the exact denied IP is reachable from the independent runner");
    }

    const content = `Two-cluster workspace ${randomUUID()}\n`;
    const workspace = `${agentPath}/workspace/files/USER.md`;
    await api("PUT", workspace, { content });
    assert.equal((await api("GET", workspace)).content, content);
    const harness = (await pods("execution", "agent")).find(
      (pod) => pod.metadata.labels["openclaw.dev/revision"] === first.id,
    );
    assert.ok(harness);
    assert.equal(
      await dp.kubectl(
        "exec",
        harness.metadata.name,
        "-n",
        namespaces.execution,
        "-c",
        "agent",
        "--",
        "node",
        "-e",
        'process.stdout.write(require("node:fs").readFileSync("/home/node/workspace/USER.md","utf8"))',
      ),
      content,
    );

    // Runtime status and logs read each Pod from its own cluster: the Harness from
    // the execution cluster with the execution kubeconfig, the Gateway from control.
    const runtimePath = `${agentPath}/deployments/${first.id}/runtime`;
    const runtime = await api("GET", runtimePath);
    assert.deepEqual(runtime.pods.map(({ role, cluster }) => `${role}:${cluster}`).sort(), [
      "agent:execution",
      "gateway:control",
    ]);
    const agentLogs = await api("GET", `${runtimePath}/logs?source=agent&tailLines=50`);
    assert.equal(agentLogs.stream.pod, harness.metadata.name);
    assert.ok(
      agentLogs.records.every(
        (record) => record.type !== "line" || record.contentClass === "operational",
      ),
    );
    // Without the execution tenant API grant the read fails as cluster RBAC, never
    // by falling back to control-cluster names.
    await dp.kubectl(
      "delete",
      "rolebinding",
      "execution-tenant-api-api",
      "-n",
      namespaces.execution,
    );
    await assert.rejects(
      api("GET", `${runtimePath}/logs?source=agent`),
      /: 503 RUNTIME_LOGS_CLUSTER_RBAC$/,
    );
    await dp.applyManifest(
      JSON.stringify({
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "RoleBinding",
        metadata: { name: "execution-tenant-api-api", namespace: namespaces.execution },
        subjects: [
          {
            kind: "ServiceAccount",
            name: "openclaw-enterprise-api",
            namespace: configuration.execution.systemNamespace,
          },
        ],
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "ClusterRole",
          name: `${configuration.execution.release}-execution-tenant-api`,
        },
      }),
    );
    await cp.waitFor("restored execution log grant", async () => {
      try {
        return (await api("GET", `${runtimePath}/logs?source=agent`)).cursor !== null;
      } catch {
        return false;
      }
    });

    // Inspect only delivery shape; assertion failures never expose credential bytes.
    const secrets = await dp.resources("secrets", namespaces.execution);
    const delivered = secrets.filter(
      (item) => item.metadata.labels?.["openclaw.dev/agent"] === agent.id,
    );
    assert.ok(delivered.some((item) => Object.hasOwn(item.data ?? {}, modelEnvironment)));
    assert.ok(delivered.every((item) => !Object.hasOwn(item.data ?? {}, "gateway-password")));
    assert.ok(delivered.every((item) => !Object.hasOwn(item.data ?? {}, "kubeconfig")));

    // Delete the exact observed Pod, then prove a new UID reconnects to the same
    // Gateway and serves the retained workspace through the normal OCE API.
    await dp.kubectl(
      "delete",
      "pod",
      harness.metadata.name,
      "-n",
      namespaces.execution,
      "--wait=false",
    );
    await dp.waitFor("replacement Harness Pod", async () =>
      (await pods("execution", "agent")).some(
        (pod) =>
          pod.metadata.uid !== harness.metadata.uid &&
          !pod.metadata.deletionTimestamp &&
          pod.status?.conditions?.some(
            (condition) => condition.type === "Ready" && condition.status === "True",
          ),
      ),
    );
    await cp.waitFor("workspace node reconnect", async () => {
      try {
        return (await api("GET", workspace)).content === content;
      } catch {
        return false;
      }
    });
    await api("POST", `${agentPath}/stop`);
    for (const [plane, role] of [
      ["control", "gateway"],
      ["execution", "agent"],
    ]) {
      await planes[plane].waitFor(
        `${plane} runtime stopped`,
        async () => (await pods(plane, role)).length === 0,
      );
    }
    await cp.waitFor(
      "stopped Gateway proxy cleanup",
      async () => (await proxyResources("control")).length === 0,
    );
    assert.equal((await proxyResources("execution")).length, 0);
    const resumed = await deploy();
    await assertProxyPlacement(resumed);
    const resumedResources = await proxyResources("control");
    assert.ok(
      firstProxy.every(
        (old) => !resumedResources.some((item) => item.metadata.uid === old.metadata.uid),
      ),
    );
    await allowed(destinations.first);
    assert.equal((await api("GET", workspace)).content, content);
    const modelDigest = async (pod) => {
      const environment = pod.spec.containers.find((container) => container.name === "agent").env;
      const ref = environment.find((item) => item.name === modelEnvironment).valueFrom.secretKeyRef;
      const delivery = await dp.resource("secret", ref.name, namespaces.execution);
      return createHash("sha256")
        .update(Buffer.from(delivery.data[ref.key], "base64"))
        .digest("hex");
    };
    const digest = (value) => createHash("sha256").update(value).digest("hex");
    const liveHarness = (await pods("execution", "agent")).find(
      (pod) => !pod.metadata.deletionTimestamp,
    );
    assert.equal(await modelDigest(liveHarness), digest(modelCredential));
    // A deliberately invalid key proves source updates do not silently mutate
    // the active revision, while an attempted redeploy receives the new material
    // and fails native authentication before deployment can succeed. PAT login
    // rejects an invalid token before the API-key path's model probe runs.
    const invalidKey = `${authMethod === "codex_pat" ? "at-" : ""}test-only-invalid-${randomUUID()}`;
    await api("PATCH", `${base}/secrets/${secret.id}`, { value: invalidKey });
    assert.equal(await modelDigest(liveHarness), digest(modelCredential));
    const rejected = await api("POST", `${agentPath}/deploy`);
    const expectedFailure =
      authMethod === "codex_pat"
        ? { check: "login", code: "LOGIN_FAILED" }
        : { check: "model-probe", code: "AUTHENTICATION_FAILED" };
    const rejectedHarness = await dp.waitFor(
      "replacement credential failure evidence",
      async () => {
        const pod = (await pods("execution", "agent")).find(
          (item) => item.metadata.labels["openclaw.dev/revision"] === rejected.id,
        );
        if (!pod) {
          return false;
        }
        try {
          const status = JSON.parse(
            await dp.kubectl(
              "get",
              "--request-timeout=5s",
              "--raw",
              `/api/v1/namespaces/${namespaces.execution}/pods/${pod.metadata.name}:18791/proxy/openclaw/runtime/status`,
            ),
          );
          return status.revisionId === rejected.id &&
            status.podUid === pod.metadata.uid &&
            status.runtimeFailure?.check === expectedFailure.check &&
            status.runtimeFailure?.code === expectedFailure.code
            ? pod
            : false;
        } catch {
          return false;
        }
      },
    );
    // Held startup failure evidence fails the deployment; it must never be
    // confused with a successfully activated revision.
    assert.notEqual(
      (await api("GET", `${agentPath}/deployments/${rejected.id}`)).status,
      "succeeded",
    );
    assert.equal(await modelDigest(rejectedHarness), digest(invalidKey));
    // Exclusive RWO replacement stops the predecessor. Workspace access can be
    // unavailable until valid credentials start its successor; verify retention below.
    await api("PATCH", `${base}/secrets/${secret.id}`, { value: modelCredential });
    const predecessorProxy = [...resumedResources, ...(await proxyResources("control"))];
    await api("PATCH", agentPath, { gatewayOutbound: outbound(destinations.replacement) });
    const successor = await api("POST", `${agentPath}/deploy`);
    // Exclusive RWO replacement must stop the rejected workload before the
    // Agent-owned policy selects the corrected successor.
    await dp.waitFor("exclusive successor authentication policy", async () => {
      const selected = (await authenticationPolicies()).map(
        (policy) => policy.spec.podSelector.matchLabels["openclaw.dev/revision"],
      );
      const rejectedPods = (await pods("execution", "agent")).filter(
        (pod) => pod.metadata.labels["openclaw.dev/revision"] === rejected.id,
      );
      return (
        selected.includes(successor.id) &&
        !selected.includes(rejected.id) &&
        rejectedPods.length === 0
      );
    });
    await waitForDeployment(successor);
    assert.notEqual(successor.id, first.id);
    await assertProxyPlacement(successor);
    await cp.waitFor("predecessor Gateway proxy cleanup", async () => {
      const current = await proxyResources("control");
      return predecessorProxy.every(
        (old) => !current.some((item) => item.metadata.uid === old.metadata.uid),
      );
    });
    await allowed(destinations.replacement);
    await denied(destinations.first);
    assert.equal((await api("GET", workspace)).content, content);
    await dp.waitFor("retired predecessor", async () =>
      (await pods("execution", "agent")).every(
        (pod) => pod.metadata.labels["openclaw.dev/revision"] === successor.id,
      ),
    );

    await dp.waitFor("authentication policy selects only the active revision", async () => {
      const remaining = await authenticationPolicies();
      return (
        remaining.length === 1 &&
        remaining[0].spec.podSelector.matchLabels["openclaw.dev/revision"] === successor.id
      );
    });

    // A real model must execute a shell command in the DP workspace. A successful
    // HTTP response or the model repeating a supplied marker alone is not proof.
    const marker = `OCE_TWO_CLUSTER_${randomUUID()}`;
    const toolPath = "/home/node/workspace/oce-two-cluster-tool-proof.txt";
    const prompt = `Use the shell tool to run this exact command: printf '%s' '${marker}' > ${toolPath}; cat ${toolPath}. Reply exactly with the file contents after the command succeeds.`;
    const gateway = (await pods("control", "gateway")).find(
      (pod) => !pod.metadata.deletionTimestamp,
    );
    assert.ok(gateway);
    const turn = JSON.parse(
      await cp.kubectl(
        "exec",
        gateway.metadata.name,
        "-n",
        namespaces.control,
        "-c",
        "gateway",
        "--",
        "node",
        "--input-type=module",
        "-e",
        `const url = 'http://127.0.0.1:8080/v1/chat/completions';
         const body = JSON.stringify({ model: 'openclaw', stream: false,
           messages: [{ role: 'user', content: ${JSON.stringify(prompt)} }] });
         const denied = await fetch(url, { method: 'POST', body,
           headers: { 'content-type': 'application/json' } });
         const response = await fetch(url, { method: 'POST', body,
           signal: AbortSignal.timeout(120000),
           headers: { 'content-type': 'application/json',
             authorization: 'Bearer ' + process.env.OPENCLAW_GATEWAY_PASSWORD } });
         const value = await response.json();
         console.log(JSON.stringify({ denied: denied.status, status: response.status,
           content: value.choices?.[0]?.message?.content, errorCode: value.error?.code }));`,
      ),
    );
    assert.equal(turn.denied, 401);
    assert.equal(turn.status, 200, turn.errorCode);
    assert.equal(turn.content, marker);
    const successorPod = (await pods("execution", "agent")).find(
      (pod) => pod.metadata.labels["openclaw.dev/revision"] === successor.id,
    );
    assert.ok(successorPod);
    assert.equal(
      await dp.kubectl(
        "exec",
        successorPod.metadata.name,
        "-n",
        namespaces.execution,
        "-c",
        "agent",
        "--",
        "cat",
        toolPath,
      ),
      marker,
    );

    // The exact owned k3d node is stopped, not a mock client. A failed DP read
    // must not be treated as absence or allow Agent metadata to disappear.
    let stopped = false;
    const restore = async () => {
      if (stopped) {
        await docker("start", executionContainerId);
        stopped = false;
      }
    };
    t.after(restore);
    try {
      stopped = true;
      await docker("stop", "--time", "10", executionContainerId);
      // kubectl could not reach the API server (not an API-level refusal such as Forbidden).
      await assert.rejects(dp.kubectl("get", "namespace", "kube-system", "--request-timeout=5s"), {
        code: 1,
        stderr: /Unable to connect to the server|The connection to the server \S+ was refused/,
      });
      // The execution API is genuinely unavailable. CP egress must not depend
      // on that cluster, its DNS, or the remote Harness remaining available.
      const controlProxy = await proxyResources("control");
      assert.ok(controlProxy.some((resource) => resource.kind === "Pod"));
      await allowed(destinations.replacement);
      await denied(destinations.first);
      await api("DELETE", agentPath);
      await cp.waitFor("worker observes unavailable DP during deletion", async () => {
        const output = await cp.kubectl(
          "logs",
          "deployment/openclaw-enterprise-worker",
          "-n",
          configuration.control.systemNamespace,
          "--since=60s",
        );
        return output.split("\n").some((line) => {
          try {
            const event = JSON.parse(line);
            return (
              event.agentId === agent.id &&
              event.operation === "agent.delete" &&
              event.outcome === "retry" &&
              event.code === "DEPENDENCY_UNAVAILABLE"
            );
          } catch {
            return false;
          }
        });
      });
      assert.ok(
        (await api("GET", `${base}/agents`)).some(
          (item) => item.id === agent.id && item.status === "deleting",
        ),
      );
    } finally {
      await restore();
    }
    await dp.waitFor("execution API recovery", async () => {
      try {
        return (
          (await dp.resource("namespace", "kube-system")).metadata.uid === dpIdentity.metadata.uid
        );
      } catch {
        return false;
      }
    });
    for (const plane of ["execution", "control"]) {
      await planes[plane].waitFor(
        `${plane} Agent cleanup`,
        async () =>
          (
            await planes[plane].resources(
              "pods",
              namespaces[plane],
              "-l",
              `openclaw.dev/agent=${agent.id}`,
            )
          ).length === 0,
      );
    }
    for (const plane of ["execution", "control"]) {
      await planes[plane].waitFor(
        plane + " proxy cleanup",
        async () => (await proxyResources(plane)).length === 0,
      );
    }
    await cp.waitFor("Agent metadata cleanup", async () =>
      (await api("GET", `${base}/agents`)).every((item) => item.id !== agent.id),
    );
    assert.equal(
      (await pods("control", "gateway", peer))[0].metadata.uid,
      peerGateway.metadata.uid,
    );
    await allowed(destinations.replacement, peer);
    await denied(destinations.first, peer);
    await api("DELETE", peerPath);
    await cp.waitFor("peer Agent deletion", async () =>
      (await api("GET", base + "/agents")).every((item) => item.id !== peer.id),
    );
    for (const plane of ["execution", "control"]) {
      assert.equal((await proxyResources(plane, peer)).length, 0);
    }
    await api("DELETE", `${base}/configurations/${native.id}`);
    await api("DELETE", `${base}/secrets/${secret.id}`);
    // Installations may seed default Presets into this test-owned Namespace.
    // Remove those ordinary children before requesting Namespace deletion.
    for (const preset of await api("GET", `${base}/presets`)) {
      await api("DELETE", `${base}/presets/${preset.id}`);
    }
    await api("DELETE", base);
    for (const plane of ["execution", "control"]) {
      await planes[plane].waitFor(
        `${plane} Namespace cleanup`,
        async () =>
          (
            await planes[plane].kubectl(
              "get",
              "namespace",
              namespaces[plane],
              "--ignore-not-found",
              "-o",
              "name",
            )
          ).trim() === "",
      );
    }
    t.diagnostic(
      "Real API/worker: separate placement, workspace RPC, Pod reconnect, stop/resume, credential refresh/rejection, revision replacement, model shell execution, Gateway proxy CP placement, host allow/deny, raw TCP no-bypass, replacement/stop cleanup, independent CP egress during DP outage, recovery, and two-target deletion passed.",
    );
  },
);

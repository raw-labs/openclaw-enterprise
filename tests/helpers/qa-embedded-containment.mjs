import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv, promisify } from "node:util";
import { protectedText, redactedQaTail, registerQaSecret } from "./qa-secrets.mjs";

export const embeddedContainmentTestName =
  "OpenShell embedded OpenClaw retains its normal Agent lifecycle inside one Sandbox";

/** A real HTTP destination, not a replacement Gateway, model, or policy engine. */
export async function prepareEmbeddedGatewayReceiver(context, { fixture, image }) {
  const namespace = "oce-embedded-receipt-" + randomUUID().slice(0, 8);
  const host = "gateway-receipt." + namespace + ".svc.cluster.local";
  const ports = { control: 8080, policy: 8083, observation: 8081 };
  const { kubectl, resource, applyManifest } = fixture;
  // Register the obligation before creation, including an uncertain creation response.
  context.after(() =>
    kubectl(
      "delete",
      "namespace",
      namespace,
      "--ignore-not-found=true",
      "--wait=true",
      "--timeout=120s",
    ),
  );
  await kubectl("create", "namespace", namespace);
  const program = [
    'const http = require("node:http");',
    'const instance = require("node:crypto").randomUUID();',
    "const receipts = [];",
    'const safeId = value => typeof value === "string" && /^[a-zA-Z0-9_:-]{1,256}$/.test(value) ? value : null;',
    "for (const port of [8080, 8083]) {",
    "  http.createServer(async (request, response) => {",
    '    if (request.method === "GET" && request.url === "/health") { response.end("ready"); return; }',
    '    if (request.method !== "POST" || !/^\\/receipt\\/[a-f0-9-]{36}$/.test(request.url)) { response.writeHead(404).end(); return; }',
    "    let bytes = 0; const chunks = [];",
    "    for await (const chunk of request) {",
    "      bytes += chunk.length;",
    "      if (bytes > 65536) { response.writeHead(413).end(); request.destroy(); return; }",
    "      chunks.push(chunk);",
    "    }",
    "    try {",
    "      const event = JSON.parse(Buffer.concat(chunks).toString());",
    // Never retain headers, credentials, error text, or arbitrary model output.
    "      receipts.push({ instance, receivedAt: new Date().toISOString(), port, path: request.url,",
    "        jobId: safeId(event.jobId), runAtMs: Number.isSafeInteger(event.runAtMs) ? event.runAtMs : null,",
    '        finished: event.action === "finished", succeeded: event.status === "ok",',
    '        markerMatches: event.summary === "EMBEDDED_GATEWAY_" + request.url.split("/").at(-1) });',
    "      if (receipts.length > 32) receipts.shift();",
    "      response.writeHead(204).end();",
    "    } catch { response.writeHead(400).end(); }",
    '  }).listen(port, "0.0.0.0");',
    "}",
    "http.createServer((request, response) => {",
    '  response.setHeader("content-type", "application/json");',
    "  response.end(JSON.stringify({ instance, receipts }));",
    '}).listen(8081, "127.0.0.1");',
  ].join("\n");
  await applyManifest(
    JSON.stringify({
      apiVersion: "v1",
      kind: "List",
      items: [
        {
          apiVersion: "v1",
          kind: "Pod",
          metadata: { name: "gateway-receipt", namespace, labels: { app: "gateway-receipt" } },
          spec: {
            automountServiceAccountToken: false,
            restartPolicy: "Never",
            securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000 },
            containers: [
              {
                name: "receipt",
                image,
                imagePullPolicy: "IfNotPresent",
                command: ["node", "-e", program],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
                resources: {
                  requests: { cpu: "20m", memory: "32Mi" },
                  limits: { cpu: "250m", memory: "128Mi" },
                },
                readinessProbe: { httpGet: { path: "/health", port: ports.control } },
              },
            ],
          },
        },
        {
          apiVersion: "v1",
          kind: "Service",
          metadata: { name: "gateway-receipt", namespace },
          spec: {
            selector: { app: "gateway-receipt" },
            ports: [
              { name: "control", port: ports.control, targetPort: ports.control },
              { name: "policy", port: ports.policy, targetPort: ports.policy },
            ],
          },
        },
      ],
    }),
  );
  await kubectl(
    "wait",
    "-n",
    namespace,
    "--for=condition=Ready",
    "pod/gateway-receipt",
    "--timeout=180s",
  );
  const pod = await resource("pod", "gateway-receipt", namespace);
  const execReceiver = (...args) =>
    kubectl("exec", "-n", namespace, "pod/gateway-receipt", "--", ...args);
  // Both real listeners and Service DNS must work before interpreting a Gateway failure.
  for (const port of [ports.control, ports.policy]) {
    const url = "http://" + host + ":" + port + "/health";
    assert.equal(
      await execReceiver(
        "node",
        "-e",
        "fetch(" +
          JSON.stringify(url) +
          ", { signal: AbortSignal.timeout(5000) }).then(async r => { if (!r.ok) process.exit(1); process.stdout.write(await r.text()); })",
      ),
      "ready",
    );
  }
  const read = async () =>
    JSON.parse(
      await execReceiver(
        "node",
        "-e",
        'fetch("http://127.0.0.1:8081", { signal: AbortSignal.timeout(5000) }).then(r => r.text()).then(t => process.stdout.write(t))',
      ),
    );
  const { instance } = await read();
  return { host, ports, podUid: pod.metadata.uid, instance, read };
}

/** cron webhook delivery runs in the Gateway, after its command child has exited. */
async function assertGatewayWebhookEgress({ client, topology, combined, waitFor, proof }) {
  const receiver = topology.gatewayReceiver;
  assert.ok(receiver, "the selected embedded workflow requires its real destination receiver");
  const base = "/namespaces/" + topology.namespaceId + "/agents/" + topology.agent.id;
  const policyPath = base + "/sandbox-policy/networking";
  const binary = "/usr/local/bin/node";
  const grant = {
    id: "gateway-webhook",
    binary,
    host: receiver.host,
    ports: [{ from: receiver.ports.policy, to: receiver.ports.policy }],
  };
  const evidence = {
    integration: "native Gateway cron webhook delivery",
    revisionId: topology.revision.id,
    podUid: combined.pod.metadata.uid,
    sandboxUid: combined.sandbox.metadata.uid,
    receiverPodUid: receiver.podUid,
    receiverInstance: receiver.instance,
    attempts: [],
  };
  proof.gatewayEgress = evidence;
  async function change(additions, expectedAdditions) {
    const current = await topology.request("GET", policyPath);
    assert.equal(current.status, 200);
    assert.deepEqual(
      current.data.policy.additions,
      expectedAdditions,
      "policy replacement must preserve the expected prior additions",
    );
    const saved = await topology.request("PUT", policyPath, {
      expectedVersion: current.data.policy.version,
      additions,
    });
    assert.equal(saved.status, 200);
    const queued = await topology.request("POST", policyPath + "/apply", {
      expectedVersion: saved.data.version,
      revisionId: topology.revision.id,
    });
    assert.equal(queued.status, 202);
    return await waitFor(
      "the Gateway egress policy to be loaded by OpenShell",
      async () => {
        const observed = await topology.request("GET", policyPath);
        assert.equal(observed.status, 200);
        const application = observed.data.policy.application;
        assert.notEqual(
          application?.state,
          "failed",
          "native network-policy application must succeed",
        );
        return application?.id === queued.data.application.id &&
          application.policyVersion === saved.data.version &&
          application.revisionId === topology.revision.id &&
          application.state === "applied" &&
          observed.data.policy.applied?.policyVersion === saved.data.version &&
          observed.data.policy.applied.revisionId === topology.revision.id
          ? observed.data.policy
          : undefined;
      },
      120_000,
    );
  }
  async function attempt(phase, port, allowed) {
    const nonce = randomUUID();
    const marker = "EMBEDDED_GATEWAY_" + nonce;
    const path = "/receipt/" + nonce;
    const startedAt = Date.now();
    const job = await client.request("cron.add", {
      name: "embedded-gateway-" + nonce,
      agentId: "main",
      enabled: false,
      schedule: { kind: "every", everyMs: 86_400_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      // This child only prints a nonce. It contains no URL, fetch, credential, or network code.
      // Native server-cron notifications, not the child or model, perform the HTTP POST.
      payload: {
        kind: "command",
        argv: [binary, "-e", "process.stdout.write(" + JSON.stringify(marker) + ")"],
      },
      delivery: { mode: "webhook", to: "http://" + receiver.host + ":" + port + path },
      failureAlert: false,
    });
    assert.ok(job.id);
    try {
      const accepted = await client.request("cron.run", {
        id: job.id,
        mode: "force",
        waitTimeoutMs: 5_000,
      });
      assert.equal(accepted.ok, true);
      assert.equal(accepted.enqueued, true);
      assert.ok(accepted.runId);
      const run = await waitFor(
        "native Gateway webhook run completion",
        async () => {
          const history = await client.request("cron.runs", {
            id: job.id,
            runId: accepted.runId,
            limit: 1,
          });
          return history.entries?.find((row) => row.action === "finished");
        },
        120_000,
      );
      assert.equal(run.jobId, job.id);
      assert.equal(run.runId, accepted.runId);
      assert.ok(run.summary?.includes(marker), "the local payload must execute before delivery");
      assert.equal(run.delivered, allowed);
      if (allowed) {
        assert.equal(run.status, "ok");
        assert.equal(run.deliveryStatus, "delivered");
      } else {
        assert.notEqual(run.deliveryStatus, "delivered");
      }
      const records = await waitFor(
        "matching native OpenShell network evidence",
        async () => {
          const logs = await topology.request(
            "GET",
            base +
              "/deployments/" +
              topology.revision.id +
              "/runtime/logs?source=sandbox&tailLines=1000",
          );
          assert.equal(logs.status, 200);
          const matching = logs.data.records.filter((row) => {
            const decision = row.decision;
            const time = typeof row.time === "number" ? row.time : Date.parse(row.time);
            return (
              time >= startedAt &&
              decision?.binary === binary &&
              decision.port === port &&
              decision.decision === (allowed ? "allowed" : "denied") &&
              (allowed || decision.enforcement === "blocked") &&
              (decision.host === receiver.host ||
                logs.data.records.some(
                  ({ message }) =>
                    message?.includes("Policy DNS mapped " + receiver.host + " ") &&
                    message.includes("synthetic=" + decision.host + " "),
                ))
            );
          });
          return matching.length > 0 ? matching : undefined;
        },
        30_000,
      );
      const observed = await receiver.read();
      assert.equal(
        observed.instance,
        receiver.instance,
        "receipt loss from an observer restart is not denial",
      );
      const receipts = observed.receipts.filter((row) => row.path === path);
      assert.equal(
        receipts.length,
        allowed ? 1 : 0,
        "receipt must agree with the exact native run and policy decision",
      );
      if (allowed) {
        assert.equal(receipts[0].jobId, job.id);
        assert.ok(Number.isSafeInteger(run.runAtMs));
        assert.equal(receipts[0].runAtMs, run.runAtMs);
        assert.equal(receipts[0].port, port);
        assert.equal(receipts[0].finished, true);
        assert.equal(receipts[0].succeeded, true);
        assert.equal(receipts[0].markerMatches, true);
      }
      const agent = await topology.request("GET", base);
      assert.equal(agent.status, 200);
      assert.equal(
        agent.data.activeRevisionId,
        topology.revision.id,
        "live policy changes must not replace the Gateway",
      );
      const result = {
        phase,
        jobId: job.id,
        runId: run.runId,
        port,
        deliveryStatus: run.deliveryStatus,
        receipts,
        network: records.map(({ time, decision }) => ({
          time,
          decision: decision.decision,
          enforcement: decision.enforcement,
          binary: decision.binary,
          host: decision.host,
          port: decision.port,
          policyGeneration: decision.policyGeneration,
        })),
      };
      evidence.attempts.push(result);
    } finally {
      const removed = await client.request("cron.remove", { id: job.id });
      assert.equal(removed.ok, true);
    }
  }
  // Keep the ordinary model destination and control port unchanged while one exact
  // Gateway executable/destination/port moves deny -> allow -> deny through API/worker.
  await attempt("installation-control", receiver.ports.control, true);
  await attempt("default-denied", receiver.ports.policy, false);
  assert.equal(
    (await topology.request("PATCH", policyPath + "/editing", { enabled: true })).status,
    200,
  );
  const granted = await change([grant], []);
  await attempt("agent-granted", receiver.ports.policy, true);
  const revoked = await change([], [grant]);
  await attempt("agent-revoked", receiver.ports.policy, false);
  await attempt("control-after-revocation", receiver.ports.control, true);
  evidence.grantedPolicy = granted.applied;
  evidence.revokedPolicy = revoked.applied;
  return evidence;
}

/** The QA entrypoint owns only its child; prepared infrastructure keeps its existing owner. */
export async function verifyQaEmbeddedContainment(artifacts) {
  const envFile = process.env.OCC_TEST_QA_SANDBOX_ENV;
  assert.ok(
    envFile,
    "OCC_TEST_QA_SANDBOX_ENV must select an explicitly prepared OpenShell environment",
  );
  assert.ok(process.env.OPENAI_API_KEY, "OPENAI_API_KEY is required for native embedded OpenClaw");
  assert.ok(process.env.OCC_TEST_OPENAI_MODEL, "OCC_TEST_OPENAI_MODEL is required");
  registerQaSecret(process.env.OPENAI_API_KEY);
  const prepared = parseEnv(await protectedText(envFile, "prepared OpenShell environment"));
  for (const name of [
    "OCC_TEST_KUBERNETES_KUBECONFIG",
    "OCC_TEST_KUBERNETES_CONTEXT",
    "OCC_TEST_DATABASE_URL",
    "OCC_TEST_KUBERNETES_GATEWAY_IMAGE",
    "OCC_TEST_KUBERNETES_AGENT_IMAGE",
    "OCC_TEST_OPENSHELL_GATEWAY_IMAGE",
    "OCC_TEST_OPENSHELL_SANDBOX_IMAGE",
    "OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE",
    "OCC_TEST_OPENSHELL_HELM",
    "OCC_TEST_OPENSHELL_HELM_CHART",
    "OCC_TEST_OPENSHELL_WORKSPACE_HELM_CHART",
    "OCC_TEST_OPENSHELL_RUNTIME_CLASS",
  ]) {
    assert.ok(
      prepared[name]?.trim(),
      `${name} must come from the explicitly prepared OpenShell environment`,
    );
  }
  const env = {
    ...process.env,
    ...prepared,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OCC_TEST_OPENAI_MODEL: process.env.OCC_TEST_OPENAI_MODEL,
    OCC_TEST_OPENSHELL_K3D_REAL: "1",
    OCC_TEST_OPENSHELL_HARNESS: "openclaw",
    OCC_TEST_OPENSHELL_SCENARIO: "embedded-containment",
  };
  delete env.NODE_TEST_CONTEXT;
  const args = [
    `--env-file=${resolve(envFile)}`,
    "--test",
    "--test-reporter=tap",
    `--test-name-pattern=^${embeddedContainmentTestName}$`,
    "tests/integration/sandbox-driver-openshell-k3d-real.test.mjs",
  ];
  let output;
  let failed = false;
  try {
    output = await promisify(execFile)(process.execPath, args, {
      env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 1_700_000,
      killSignal: "SIGTERM",
    });
  } catch (error) {
    output = error;
    failed = true;
  }
  const text = redactedQaTail(
    `${output.stdout ?? ""}
${output.stderr ?? ""}`,
    env,
    {
      lines: 100_000,
      lineChars: 8000,
    },
  ).join("\n");
  const evidence = resolve(artifacts, "embedded-containment-runtime.log");
  await writeFile(evidence, text, { mode: 0o600 });
  assert.equal(failed, false, `Embedded OpenShell workflow failed; see ${evidence}`);
  assert.ok(text.split("\n").includes(`ok 1 - ${embeddedContainmentTestName}`));
  assert.match(text, /# pass 1\b/);
  assert.match(text, /# fail 0\b/);
  assert.match(text, /# skipped 0\b/);
  return {
    evidence,
    outcome:
      "Gateway-owned cron webhook receipts and OpenShell allow/deny/revocation, real model and exec, retained state, replacement and cleanup",
    unverified: [
      "channel delivery",
      "selected plugin installation and third-party integrations",
      "TLS webhook delivery (the disposable receiver uses credential-free HTTP)",
      "production qualification",
    ],
  };
}

/** Exercise the real API/worker fixture; never patch provider resources to manufacture success. */
export async function assertEmbeddedContainmentWorkflow(
  context,
  { topology, fixture, controllerRequire, initialWorkspaceFiles },
) {
  const { request, placement, namespaceId, agent } = topology;
  const agentPath = `/namespaces/${namespaceId}/agents/${agent.id}`;
  const { resources, resource, kubectl, waitFor } = fixture;
  assert.equal(agent.executionMode, "embedded");
  assert.equal(topology.revision.harness.id, "openclaw");
  assert.equal(topology.revision.harness.mode, "embedded");
  const proof = {
    scenarioComplete: false,
    mode: "embedded",
    agentId: agent.id,
    model: process.env.OCC_TEST_OPENAI_MODEL,
    unverified: [
      "channel delivery",
      "selected plugin installation and third-party integrations",
      "TLS webhook delivery (the disposable receiver uses credential-free HTTP)",
      "production qualification",
    ],
  };
  context.after(() => context.diagnostic(JSON.stringify(proof)));

  async function readCombined(revision) {
    const pod = await waitFor(
      "the provider-owned combined Gateway/Harness",
      async () => {
        const pods = (await resources("pods", placement)).filter(
          ({ metadata }) => metadata.labels?.["openclaw.dev/agent"] === agent.id,
        );
        assert.equal(
          pods.some(({ metadata }) => metadata.labels?.["openclaw.dev/workload-role"] === "agent"),
          false,
          "embedded execution must not create a separate dedicated Harness Pod",
        );
        return pods.find(
          ({ metadata, status }) =>
            metadata.labels?.["openclaw.dev/workload-role"] === "gateway" &&
            metadata.labels?.["openclaw.dev/revision"] === revision.id &&
            status?.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
        );
      },
      360_000,
    );
    const owner = pod.metadata.ownerReferences?.find(
      ({ kind, controller }) => kind === "Sandbox" && controller,
    );
    assert.ok(
      owner?.name && owner.uid,
      "the real Agent Sandbox controller must own the combined Pod",
    );
    const sandbox = await resource("sandboxes.agents.x-k8s.io", owner.name, placement);
    assert.equal(sandbox.metadata.uid, owner.uid);
    assert.equal(pod.metadata.labels["openclaw.dev/network-profile"], "provider-fenced-v1");
    const deployments = (await resources("deployments", placement)).filter(
      ({ metadata }) => metadata.labels?.["openclaw.dev/agent"] === agent.id,
    );
    assert.equal(
      deployments.length,
      0,
      "Compute must not also create an uncontained Gateway or Harness Deployment",
    );
    assert.equal(
      pod.spec.containers.length,
      1,
      "Gateway and Harness must share the one provider workload",
    );
    const container = pod.spec.containers[0];
    const workspace = revision.configuration.agents.defaults.workspace;
    const mount = container.volumeMounts?.find(({ mountPath }) => mountPath === workspace);
    assert.ok(mount?.subPath, "the combined runtime must retain its exact workspace PVC subpath");
    assert.notEqual(mount.readOnly, true);
    const volume = pod.spec.volumes.find(({ name }) => name === mount.name);
    assert.ok(volume?.persistentVolumeClaim?.claimName);
    const storage = { claimName: volume.persistentVolumeClaim.claimName, subPath: mount.subPath };
    return { pod, sandbox, container: container.name, workspace, storage };
  }

  let combined = await readCombined(topology.revision);
  proof.initial = {
    revisionId: topology.revision.id,
    podUid: combined.pod.metadata.uid,
    sandboxUid: combined.sandbox.metadata.uid,
    storage: combined.storage,
    images: combined.pod.status.containerStatuses.map(({ name, imageID }) => ({ name, imageID })),
  };
  for (const [name, content] of Object.entries(initialWorkspaceFiles)) {
    const file = await request("GET", `${agentPath}/workspace/files/${name}`);
    assert.equal(file.status, 200);
    assert.equal(
      file.data.content,
      content,
      "ordinary initial workspace delivery must reach the combined runtime",
    );
  }
  const retained = `Owner edit ${randomUUID()}
`;
  assert.equal(
    (await request("PUT", `${agentPath}/workspace/files/USER.md`, { content: retained })).status,
    200,
  );
  const retainedHash = createHash("sha256").update(retained).digest("hex");
  const apiSecret = await resource(
    "secret",
    topology.gatewayApiKeySecretName,
    topology.platformNamespace,
  );
  const apiKey = Buffer.from(apiSecret.data.occ, "base64").toString();
  registerQaSecret(apiKey);
  const { GatewayClient } = await import(controllerRequire.resolve("@openclaw/gateway-client"));
  async function connectGateway() {
    const connected = Promise.withResolvers();
    const client = new GatewayClient({
      url: topology.gatewayAdminUrl,
      origin: "http://127.0.0.1",
      edgeAuthHeaders: { "x-api-key": apiKey },
      clientName: "openclaw-control-ui",
      mode: "ui",
      role: "operator",
      scopes: [],
      deviceIdentity: null,
      onHelloOk: connected.resolve,
      onConnectError: connected.reject,
    });
    context.after(() => client.stopAndWait());
    const timeout = setTimeout(
      () => connected.reject(new Error("embedded Gateway authentication timed out")),
      15_000,
    );
    client.start();
    try {
      const hello = await connected.promise;
      assert.equal(hello.auth?.role, "operator");
      assert.ok(hello.auth.scopes.includes("operator.admin"));
      return client;
    } finally {
      clearTimeout(timeout);
    }
  }
  let client = await connectGateway();
  await assertGatewayWebhookEgress({ client, topology, combined, waitFor, proof });
  const afterEgress = await readCombined(topology.revision);
  assert.equal(afterEgress.pod.metadata.uid, combined.pod.metadata.uid);
  assert.equal(afterEgress.sandbox.metadata.uid, combined.sandbox.metadata.uid);
  const { createNativePluginAssertions } = await import("./plugin-driver-real.mjs");
  const execCombined = async (_agent, args) => ({
    label: `${placement}/${combined.pod.metadata.name}`,
    stdout: await kubectl(
      "exec",
      combined.pod.metadata.name,
      "-n",
      placement,
      "-c",
      combined.container,
      "--",
      ...args,
    ),
  });
  const native = createNativePluginAssertions({
    gatewayUrl: async () => {
      throw new Error("this proof uses authenticated chat.send");
    },
    execGateway: execCombined,
    execCodex: async () => {
      throw new Error("embedded execution has no dedicated Codex Pod");
    },
    waitFor,
    proofMode: "openclaw",
  });
  const sessionKey = `agent:main:embedded-containment-${randomUUID()}`;
  const filePath = `${combined.workspace}/.embedded-containment-${randomUUID()}.json`;
  const executionPath = `${filePath}.execution`;
  const canary = randomUUID();
  const toolProofs = [];
  async function turn(first) {
    const marker = `EMBEDDED_TOOL_${randomUUID()}`;
    const program = [
      "const fs=require('node:fs');const assert=require('node:assert/strict');",
      first
        ? `fs.writeFileSync(${JSON.stringify(filePath)},JSON.stringify({canary:${JSON.stringify(canary)},hostname:require("node:os").hostname()}),{flag:"wx"});`
        : "",
      `assert.equal(JSON.parse(fs.readFileSync(${JSON.stringify(filePath)},"utf8")).canary,${JSON.stringify(canary)});`,
      `assert.equal(require("node:crypto").createHash("sha256").update(fs.readFileSync(${JSON.stringify(combined.workspace + "/USER.md")})).digest("hex"),${JSON.stringify(retainedHash)});`,
      `fs.writeFileSync(${JSON.stringify(executionPath)},require("node:os").hostname());`,
      `console.log(${JSON.stringify(marker)});`,
    ].join("");
    const command = `node -e ${JSON.stringify(program)}`;
    const codeModeCall = {
      title: "Verify embedded runtime workspace",
      code: `return await exec(${JSON.stringify({ command, awaitResults: true })});`,
      awaitResults: true,
    };
    const sent = await client.request("chat.send", {
      sessionKey,
      idempotencyKey: randomUUID(),
      message: `Call exec exactly once with ${JSON.stringify(codeModeCall)}. After it succeeds, reply with exactly ${marker}.`,
    });
    assert.ok(sent.runId);
    await waitFor(
      "the embedded model and exec run to complete",
      async () => {
        const outcome = await client.request("agent.wait", { runId: sent.runId, timeoutMs: 3000 });
        if (["pending", "timeout"].includes(outcome.status) && outcome.endedAt === undefined) {
          return undefined;
        }
        assert.equal(
          outcome.status,
          "ok",
          "the real model/tool run must succeed, not an unsupported-runtime response",
        );
        return true;
      },
      300_000,
    );
    const evidence = await native.assertSessionToolCallEvidence(agent, {
      sessionKey,
      turnMarker: marker,
      toolName: "exec",
      codeModeCall,
      resultPattern: marker,
      expectedExitCode: 0,
    });
    toolProofs.push(evidence);
    const executionHost = await execCombined(agent, [
      "node",
      "-e",
      "process.stdout.write(require('node:fs').readFileSync(process.argv[1],'utf8'))",
      executionPath,
    ]);
    assert.equal(
      executionHost.stdout,
      combined.pod.spec.hostname ?? combined.pod.metadata.name,
      "each real exec must run on the current combined Sandbox, including after replacement",
    );
    const history = await client.request("chat.history", { sessionKey, limit: 50 });
    assert.ok(history.sessionId, "the Gateway must record the native session identity");
    return history;
  }
  const firstHistory = await turn(true);
  const canaryRead = await execCombined(agent, [
    "node",
    "-e",
    "process.stdout.write(require('node:fs').readFileSync(process.argv[1],'utf8'))",
    filePath,
  ]);
  const canaryBytes = canaryRead.stdout;
  const canaryRecord = JSON.parse(canaryBytes);
  assert.equal(canaryRecord.canary, canary);
  assert.equal(
    canaryRecord.hostname,
    combined.pod.spec.hostname ?? combined.pod.metadata.name,
    "the real model's command must execute inside the combined Sandbox Pod",
  );
  await client.stopAndWait();
  const initial = combined;
  const redeployed = await request("POST", `${agentPath}/deploy`);
  assert.equal(redeployed.status, 202);
  assert.equal(
    redeployed.data.harness.mode,
    "embedded",
    "normal redeployment must not silently switch to dedicated",
  );
  assert.equal(redeployed.data.harness.id, "openclaw");
  await waitFor(
    "the replacement embedded revision to activate",
    async () => {
      const observed = await request("GET", agentPath);
      assert.equal(observed.status, 200);
      assert.equal(observed.data.executionMode, "embedded");
      return observed.data.activeRevisionId === redeployed.data.id ? true : undefined;
    },
    360_000,
  );
  combined = await readCombined(redeployed.data);
  assert.notEqual(combined.pod.metadata.uid, initial.pod.metadata.uid);
  assert.notEqual(combined.sandbox.metadata.uid, initial.sandbox.metadata.uid);
  assert.deepEqual(combined.storage, initial.storage);
  for (const [name, content] of Object.entries({ ...initialWorkspaceFiles, "USER.md": retained })) {
    const ownerFile = await request("GET", `${agentPath}/workspace/files/${name}`);
    assert.equal(ownerFile.status, 200);
    assert.equal(
      ownerFile.data.content,
      content,
      `replacement must preserve owner-maintained ${name}`,
    );
  }
  client = await connectGateway();
  const resumed = await turn(false);
  assert.equal(
    resumed.sessionId,
    firstHistory.sessionId,
    "replacement must resume the same native session, not create a fresh one",
  );
  const retainedCanary = await execCombined(agent, [
    "node",
    "-e",
    "process.stdout.write(require('node:fs').readFileSync(process.argv[1],'utf8'))",
    filePath,
  ]);
  assert.equal(retainedCanary.stdout, canaryBytes);
  await client.stopAndWait();
  await waitFor(
    "the retired combined Sandbox and Pod to disappear",
    async () => {
      const pods = await resources("pods", placement);
      const sandboxes = await resources("sandboxes.agents.x-k8s.io", placement);
      return !pods.some(({ metadata }) => metadata.uid === initial.pod.metadata.uid) &&
        !sandboxes.some(({ metadata }) => metadata.uid === initial.sandbox.metadata.uid)
        ? true
        : undefined;
    },
    180_000,
  );
  proof.replacement = {
    revisionId: redeployed.data.id,
    podUid: combined.pod.metadata.uid,
    sandboxUid: combined.sandbox.metadata.uid,
    sessionId: resumed.sessionId,
    workspacePreserved: true,
    nativeToolEvidence: toolProofs,
  };
  const stopped = await request("POST", `${agentPath}/stop`);
  assert.equal(stopped.status, 202);
  await waitFor(
    "ordinary Agent stop to clean the combined runtime",
    async () => {
      const observed = await request("GET", agentPath);
      assert.equal(observed.status, 200);
      const pods = (await resources("pods", placement)).filter(
        ({ metadata }) => metadata.labels?.["openclaw.dev/agent"] === agent.id,
      );
      const sandboxes = await resources("sandboxes.agents.x-k8s.io", placement);
      return observed.data.desiredRuntimeState === "stopped" &&
        !observed.data.activeRevisionId &&
        pods.length === 0 &&
        !sandboxes.some(({ metadata }) => metadata.uid === combined.sandbox.metadata.uid)
        ? true
        : undefined;
    },
    360_000,
  );
  const deleted = await request("DELETE", agentPath);
  assert.equal(deleted.status, 202);
  await waitFor(
    "ordinary Agent deletion to remove retained state",
    async () => {
      const observed = await request("GET", agentPath);
      assert.ok([200, 404].includes(observed.status));
      const claims = (await resources("persistentvolumeclaims", placement)).filter(
        ({ metadata }) => metadata.labels?.["openclaw.dev/agent"] === agent.id,
      );
      return observed.status === 404 && claims.length === 0 ? true : undefined;
    },
    360_000,
  );
  proof.cleanup = {
    ordinaryAgentStop: true,
    ordinaryAgentDeletion: true,
    retiredAndActiveSandboxesRemoved: true,
    retainedStateRemoved: true,
  };
  proof.scenarioComplete = true;
}

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

import type { Agent, AgentRevision, Namespace } from "../../packages/contracts/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { composePostgresDevelopment } from "../../apps/controller/src/composition/development-postgres.ts";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { validateExplicitK3dLoopbackContext } from "../helpers/kubernetes-real.mjs";
import {
  deleteNamespaces,
  hash,
  kubectl,
  kubectlRead,
  missing,
  resource,
  resources,
  waitFor,
} from "../helpers/kubernetes-compute-real.mjs";

const selected = process.env.OCC_TEST_GATEWAY_CONTAINMENT_REAL === "1";

test(
  "authenticated Agent API and OCC worker own a real contained Gateway lifecycle",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_GATEWAY_CONTAINMENT_REAL=1 with an owned real OpenShell installation.",
    timeout: 900_000,
  },
  async (t) => {
    // An explicit selection never silently skips unavailable infrastructure or credentials.
    const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
    assert.ok(databaseUrl, "OCC_TEST_DATABASE_URL is required for the selected real lifecycle");
    const database = new URL(databaseUrl);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(database.hostname));
    assert.match(database.pathname, new RegExp("^/openclaw_k8s_[a-z0-9_]+$", "u"));
    await validateExplicitK3dLoopbackContext({
      kubeconfigPath: process.env.OCC_TEST_KUBERNETES_KUBECONFIG,
      kubernetesContext: process.env.OCC_TEST_KUBERNETES_CONTEXT,
    });
    const installationFile = process.env.OCC_TEST_GATEWAY_CONTAINMENT_INSTALLATION_FILE;
    assert.ok(
      installationFile,
      "OCC_TEST_GATEWAY_CONTAINMENT_INSTALLATION_FILE must name the prepared Installation JSON",
    );
    const configuration = JSON.parse(await readFile(installationFile, "utf8"));
    assert.equal(configuration.drivers.sandbox.useForHarness, false);
    assert.equal(configuration.drivers.sandbox.configuration.kubernetes.userNamespaces, false);
    assert.match(
      configuration.drivers.compute.configuration.images.gateway,
      /@sha256:[a-f0-9]{64}$/u,
    );
    const drivers = await loadInstallationConfiguration({
      mode: "development",
      environment: {},
      startupConfiguration: { configuration, logging: { level: "info" } },
    });
    assert.ok(
      drivers?.gatewaySandboxDriver?.gateway,
      "the selected provider must expose its real Gateway capability",
    );
    assert.equal(
      drivers.sandboxDriver,
      undefined,
      "Gateway containment must not select a provider Harness",
    );
    assert.equal(drivers.credentialGatewayDriver, undefined);
    assert.equal(drivers.proxyDriver, undefined);

    const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
    const state = new PostgresPlatformState(pool);
    const namespaceIds: string[] = [];
    let app: Awaited<ReturnType<typeof composePostgresDevelopment>> | undefined;
    let worker: ReturnType<typeof createControllerWorker> | undefined;
    t.after(async () => {
      // Drain the worker before deleting only this run's physical tenant namespaces.
      try {
        await worker?.stop();
        worker = undefined;
      } finally {
        try {
          await app?.close();
          app = undefined;
        } finally {
          try {
            if (namespaceIds.length > 0) {
              await deleteNamespaces(...namespaceIds.map(kubernetesNamespaceName));
            }
          } finally {
            await pool.end();
          }
        }
      }
    });
    assert.equal(
      await state.loadInstallation(),
      undefined,
      "use a fresh disposable migrated database, not an existing Installation",
    );
    const authSecret = "contained-gateway-integration-auth-secret-32-bytes";
    const authBaseURL = "http://127.0.0.1";
    const credentials = {
      email: "contained-gateway@example.test",
      password: "contained-gateway-local-admin-password",
    };
    await ensureDevelopmentBootstrap(t, {
      databaseUrl,
      ...credentials,
      authSecret,
      authBaseURL,
      installationName: "Contained Gateway real integration",
      environment: { PATH: process.env.PATH },
    });
    namespaceIds.push(
      ...(await state.read((view) =>
        view.namespaces.listNamespaces().then((items) => items.map(({ id }) => id)),
      )),
    );
    app = await composePostgresDevelopment(
      { mode: "development", host: "127.0.0.1", databaseUrl, authSecret, authBaseURL },
      drivers,
    );
    const session = await signInToControllerApp(app, credentials);
    async function request<T>(
      method: "GET" | "POST" | "PATCH" | "DELETE",
      path: string,
      body?: unknown,
    ) {
      assert.ok(app);
      const response = await app.inject({
        method,
        url: path,
        remoteAddress: "127.0.0.1",
        headers: {
          ...authenticatedHeaders(session),
          host: "127.0.0.1",
          ...(method === "GET" ? {} : { origin: authBaseURL }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
      const envelope = response.body.length === 0 ? {} : JSON.parse(response.body);
      return {
        status: response.statusCode,
        data: envelope.data as T,
        error: envelope.error as { message: string; code: string } | undefined,
      };
    }
    worker = createControllerWorker({
      pool: new pg.Pool({ connectionString: databaseUrl, max: 6 }),
      drivers,
      pollIntervalMs: 50,
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      emit: () => {},
    });
    await worker.start();
    const createdNamespace = await request<Namespace>("POST", "/namespaces", {
      name: "Contained Gateway " + randomUUID(),
    });
    assert.equal(createdNamespace.status, 201, JSON.stringify(createdNamespace.error));
    const namespaceId = createdNamespace.data.id;
    namespaceIds.push(namespaceId);
    const placement = kubernetesNamespaceName(namespaceId);
    await waitFor("the real worker to finish tenant provisioning", async () => {
      const result = await request<Namespace>("GET", "/namespaces/" + namespaceId);
      return result.data.status === "ready" ? true : undefined;
    });
    const agentsPath = "/namespaces/" + namespaceId + "/agents";
    const model = process.env.OCC_TEST_OPENAI_MODEL ?? "gpt-6-astra";
    const values = {
      gateway: { mode: "local", controlUi: { enabled: false } },
      agents: {
        defaults: {
          skipBootstrap: true,
          model: "codex/" + model,
          models: { ["codex/" + model]: { agentRuntime: { id: "codex" } } },
        },
      },
    };
    await t.test(
      "missing dedicated Harness credentials fail closed before provider effects",
      async () => {
        const before = (await resources("sandboxes.agents.x-k8s.io", placement)).map(
          ({ metadata }: { metadata: { uid: string } }) => metadata.uid,
        );
        const refused = await request("POST", agentsPath + "/provision", {
          requestId: "req_" + randomUUID(),
          name: "No credential",
          executionMode: "dedicated",
          configuration: { kind: "agent", values },
        });
        assert.equal(refused.status, 400, JSON.stringify(refused.error));
        assert.match(refused.error?.message ?? "", /requires dedicated Harness authentication/u);
        assert.deepEqual((await request<Agent[]>("GET", agentsPath)).data, []);
        assert.deepEqual(
          (await resources("sandboxes.agents.x-k8s.io", placement)).map(
            ({ metadata }: { metadata: { uid: string } }) => metadata.uid,
          ),
          before,
        );
        assert.deepEqual(
          await resources("deployments", placement),
          [],
          "no ordinary Gateway or Harness fallback may be created",
        );
      },
    );

    await t.test(
      "pinned native Gateway becomes active, replaces, stops and deletes through the Agent API",
      async () => {
        const credentialFile = process.env.OCC_TEST_GATEWAY_CONTAINMENT_MODEL_CREDENTIAL_FILE;
        assert.ok(
          credentialFile,
          "BLOCKED: real dedicated Codex startup requires an authorized model credential file; no synthetic credential or credential-free topology substitution is allowed",
        );
        const metadata = await lstat(credentialFile);
        assert.ok(
          metadata.isFile() &&
            !metadata.isSymbolicLink() &&
            (metadata.mode & 0o077) === 0 &&
            metadata.size > 0 &&
            metadata.size <= 65_536,
          "the model credential must be a bounded owner-only regular file",
        );
        const value = (await readFile(credentialFile, "utf8")).trim();
        assert.ok(value.length > 0);
        const secret = await request<{ id: string }>(
          "POST",
          "/namespaces/" + namespaceId + "/secrets",
          { name: "Real dedicated Codex credential", value },
        );
        // Never include a credential-bearing response or request in assertion diagnostics.
        assert.equal(secret.status, 201, "real model Secret creation failed");
        const saved = await request<{ id: string }>(
          "POST",
          "/namespaces/" + namespaceId + "/configurations",
          { kind: "agent", values },
        );
        assert.equal(saved.status, 201, JSON.stringify(saved.error));
        const created = await request<Agent>("POST", agentsPath, {
          name: "Real contained Gateway",
          configurationId: saved.data.id,
          executionMode: "dedicated",
          harnessAuth: {
            method: "codex_pat",
            source: { kind: "secret", namespaceId, id: secret.data.id },
          },
        });
        assert.equal(created.status, 201, JSON.stringify(created.error));
        const agent = created.data;
        const path = agentsPath + "/" + agent.id;
        const role = await request<{ id: string }>(
          "POST",
          "/namespaces/" + namespaceId + "/iam/roles",
          {
            name: "Model Secret operation",
            permissions: [{ action: "operate", resourceKind: "secret" }],
          },
        );
        assert.equal(role.status, 201, JSON.stringify(role.error));
        const binding = await request(
          "POST",
          "/namespaces/" + namespaceId + "/iam/access-bindings",
          {
            subjectKind: "identity",
            subjectId: agent.servicePrincipalId,
            roleId: role.data.id,
            resourceKind: "secret",
            resourceId: secret.data.id,
          },
        );
        assert.equal(binding.status, 201, JSON.stringify(binding.error));
        const runtimeCredentials = await request("POST", path + "/runtime-credentials", {});
        assert.equal(runtimeCredentials.status, 200, JSON.stringify(runtimeCredentials.error));
        async function deploy() {
          const revision = await request<AgentRevision>("POST", path + "/deploy");
          assert.equal(revision.status, 202, JSON.stringify(revision.error));
          await waitFor(
            "the worker to activate the contained native Gateway",
            async () => {
              const current = await request<Agent>("GET", path);
              return current.data.activeRevisionId === revision.data.id ? true : undefined;
            },
            240_000,
          );
          return revision.data;
        }
        async function gatewayPod() {
          const pods = await resources("pods", placement);
          const candidates = pods.filter(
            ({ metadata }: { metadata: { labels?: Record<string, string> } }) =>
              metadata.labels?.["openclaw.dev/agent"] === agent.id &&
              metadata.labels?.["openclaw.dev/runtime-role"] === "gateway",
          );
          assert.equal(candidates.length, 1, "exactly one provider-contained Gateway must serve");
          return candidates[0];
        }
        const first = await deploy();
        const firstPod = await gatewayPod();
        assert.equal(firstPod.spec.runtimeClassName, "openshell-sandbox");
        assert.ok(
          firstPod.spec.containers.some(
            (container: { image: string }) =>
              container.image === configuration.drivers.compute.configuration.images.gateway,
          ),
          "provider Pod must run the selected immutable native image",
        );
        assert.equal(
          await missing("deployment", "gateway-" + hash(agent.id), placement),
          true,
          "an ordinary Gateway Deployment must never serve alongside the Sandbox",
        );
        const sandboxes = await resources("sandboxes.agents.x-k8s.io", placement);
        assert.equal(sandboxes.length, 1);
        assert.equal(sandboxes[0].metadata.labels["openclaw.dev/revision"], first.id);
        const modelRecord = await state.read((view) =>
          view.secrets.findSecret(namespaceId, secret.data.id),
        );
        assert.ok(modelRecord);
        assert.equal(
          JSON.stringify(firstPod.spec).includes(modelRecord.backendRef.name),
          false,
          "Gateway must not project the model Secret",
        );
        const harness = await resource(
          "deployment",
          "agent-" + hash(agent.id) + "-rev-" + hash(first.id),
          placement,
        );
        assert.equal(
          JSON.stringify(harness.spec).includes(modelRecord.backendRef.name),
          true,
          "ordinary dedicated Harness must retain its Agent-owned model Secret",
        );
        assert.equal(
          JSON.stringify(firstPod.spec).includes("workspace-" + hash(agent.id)),
          false,
          "Gateway must not mount Harness workspace storage",
        );
        assert.equal(
          JSON.stringify(sandboxes[0].spec).includes(value),
          false,
          "provider spec must contain no model credential bytes",
        );
        const privateClaim = await resource("pvc", "gateway-state-" + hash(agent.id), placement);
        const marker = "retained-" + randomUUID();
        await kubectl(
          "exec",
          firstPod.metadata.name,
          "--namespace",
          placement,
          "--",
          "node",
          "-e",
          "require('node:fs').writeFileSync('/tmp/oce-gateway-home/.openclaw/state/oce-lifecycle-marker', " +
            JSON.stringify(marker) +
            ")",
        );
        const second = await deploy();
        assert.notEqual(second.id, first.id);
        const replacement = await gatewayPod();
        assert.notEqual(replacement.metadata.uid, firstPod.metadata.uid);
        assert.equal(
          (await resource("pvc", privateClaim.metadata.name, placement)).metadata.uid,
          privateClaim.metadata.uid,
        );
        assert.equal(
          await kubectlRead(
            "exec",
            replacement.metadata.name,
            "--namespace",
            placement,
            "--",
            "node",
            "-e",
            "process.stdout.write(require('node:fs').readFileSync('/tmp/oce-gateway-home/.openclaw/state/oce-lifecycle-marker','utf8'))",
          ),
          marker,
        );
        const stopped = await request<Agent>("POST", path + "/stop");
        assert.equal(stopped.status, 202, JSON.stringify(stopped.error));
        await waitFor("stop to clear serving state and terminate the Sandbox", async () => {
          const current = await request<Agent>("GET", path);
          return current.data.activeRevisionId === undefined &&
            (await resources("sandboxes.agents.x-k8s.io", placement)).length === 0
            ? true
            : undefined;
        });
        assert.equal(
          (await resource("pvc", privateClaim.metadata.name, placement)).metadata.uid,
          privateClaim.metadata.uid,
        );
        await deploy();
        const deleted = await request("DELETE", path);
        assert.equal(deleted.status, 202, JSON.stringify(deleted.error));
        await waitFor("Agent deletion to confirm provider absence", async () =>
          (await request("GET", path)).status === 404 &&
          (await resources("sandboxes.agents.x-k8s.io", placement)).length === 0
            ? true
            : undefined,
        );
        t.diagnostic(
          "Real native startup/lifecycle only: this test does not issue a model turn, authenticate a channel, or establish outbound enforcement.",
        );
      },
    );
  },
);

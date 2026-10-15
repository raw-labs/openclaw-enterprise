import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isIP } from "node:net";
import { join } from "node:path";
import test, { after } from "node:test";
import { kubernetesConfigurationName } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import { createGatewayNodeEnrollment } from "../../apps/controller/src/gateway/node-enrollment-client.ts";
import {
  requiresKubernetes,
  requiresKubernetesAndPostgres,
  hash,
  kubectl,
  resource,
  resources,
  missing,
  waitFor,
  provisioningRequestBody,
  createProvisioningApiFixture,
  assertKubernetesFixtureAvailable,
  namespace,
  provisionFixtureAuth,
  revisionContext,
  revision,
  gatewayName,
  harnessWorkspaceClaimName,
  revisionName,
  assertReadyGateway,
  assertHarnessWorkspaceClaim,
  createDriver,
  createScopedController,
  createNamespaceReaper,
  workloadPod,
} from "../helpers/kubernetes-compute-real.mjs";

const { deleteNamespaces, waitForDeletedVolumes } = createNamespaceReaper();
after(waitForDeletedVolumes);

test(
  "real Kubernetes Drivers safely use and preserve an externally managed tenant namespace",
  { ...requiresKubernetes, timeout: 300_000 },
  async (context) => {
    await assertKubernetesFixtureAvailable();
    const installationId = `ins_${randomUUID()}`;
    const platformNamespace = `oce-platform-${hash(installationId)}`;
    const directory = await mkdtemp(join(tmpdir(), "openclaw-existing-namespace-"));
    const existingName = `oce-existing-${hash(randomUUID())}`;
    const cleanupName = `oce-existing-${hash(randomUUID())}`;
    const duplicateName = `oce-duplicate-${hash(randomUUID())}`;
    const unclaimedName = `oce-unclaimed-${hash(randomUUID())}`;
    const owner = {
      ...namespace("existing"),
      id: `ns_${randomUUID()}`,
      status: "provisioning",
      existingNamespace: existingName,
    };
    const cleanupOwner = {
      ...namespace("empty-existing"),
      id: `ns_${randomUUID()}`,
      status: "provisioning",
      existingNamespace: cleanupName,
    };

    await kubectl("create", "namespace", platformNamespace);
    context.after(async () => {
      await deleteNamespaces(
        platformNamespace,
        existingName,
        cleanupName,
        duplicateName,
        unclaimedName,
      );
      await rm(directory, { force: true, recursive: true });
    });
    const controller = await createScopedController(context, installationId, platformNamespace);
    const { driver, kubernetesNamespaceName } = await createDriver({
      authentication: controller.authentication,
    });
    const { KubernetesConfigurationDriver, kubernetesConfigurationName } =
      await import("../../apps/controller/src/drivers/configuration/kubernetes/index.ts");
    const configurationDriver = new KubernetesConfigurationDriver({
      authentication: controller.authentication,
    });

    // Operators prepare arbitrary names before the API generates a platform Namespace identity.
    async function createExistingNamespace(name) {
      await kubectl("create", "namespace", name);
      await kubectl(
        "label",
        "namespace",
        name,
        "app.kubernetes.io/managed-by=Helm",
        "pod-security.kubernetes.io/enforce=restricted",
        "pod-security.kubernetes.io/audit=restricted",
        "pod-security.kubernetes.io/warn=restricted",
      );
      await kubectl("annotate", "namespace", name, "openclaw.dev/namespace-lifecycle=external");
    }

    async function grantTenantAccess(name) {
      await kubectl(
        "create",
        "rolebinding",
        "openclaw-controller",
        "--namespace",
        name,
        `--clusterrole=${controller.tenantRole}`,
        `--serviceaccount=${platformNamespace}:${controller.account}`,
      );
    }

    // The reason is what the worker logs for the refusal (D521).
    async function assertPermanentlyRejected(reason, tenant = owner) {
      assert.deepEqual(await driver.ensureNamespace(tenant), {
        namespaceId: tenant.id,
        namespaceReady: false,
        failure: "permanent",
        reason,
      });
    }

    // Explicit selection never creates the requested namespace or silently falls back to a new one.
    const missingOwner = {
      ...namespace("missing-existing"),
      id: `ns_${randomUUID()}`,
      status: "provisioning",
      existingNamespace: `oce-missing-${hash(randomUUID())}`,
    };
    await assertPermanentlyRejected(
      `Existing Kubernetes namespace ${missingOwner.existingNamespace} does not exist.`,
      missingOwner,
    );
    assert.equal(await missing("namespace", missingOwner.existingNamespace), true);
    assert.equal(await missing("namespace", kubernetesNamespaceName(missingOwner.id)), true);

    // Failed provisioning may be deleted without adopting or mutating an unclaimed operator namespace.
    await createExistingNamespace(unclaimedName);
    const unclaimedOwner = {
      ...namespace("failed-existing"),
      id: `ns_${randomUUID()}`,
      status: "deleting",
      existingNamespace: unclaimedName,
    };
    const untouchedNamespace = await resource("namespace", unclaimedName);
    assert.deepEqual(await driver.deleteNamespace(unclaimedOwner), {
      namespaceId: unclaimedOwner.id,
      namespaceDeleted: true,
    });
    assert.deepEqual(await resource("namespace", unclaimedName), untouchedNamespace);

    await createExistingNamespace(existingName);
    assert.notEqual(existingName, kubernetesNamespaceName(owner.id));
    const originalNamespace = await resource("namespace", existingName);
    assert.equal(Object.hasOwn(originalNamespace.metadata.labels, "openclaw.dev/namespace"), false);
    assert.equal(
      Object.hasOwn(originalNamespace.metadata.annotations, "openclaw.dev/namespace-id"),
      false,
    );

    // Existing foreign identity, missing external consent, and unsafe Pod Security fail closed.
    // A foreign marker is named by its key only, never by its value (another tenant's ID).
    const foreignMarker = (key, kind) =>
      `Existing Kubernetes namespace ${existingName} belongs to another tenant: its ${key} ${kind} names a different Namespace.`;
    for (const [operation, key, rejectedValue, restoredValue, reason] of [
      [
        "label",
        "openclaw.dev/namespace",
        randomUUID(),
        undefined,
        foreignMarker("openclaw.dev/namespace", "label"),
      ],
      [
        "label",
        "openclaw.dev/gateway-namespace",
        randomUUID(),
        undefined,
        foreignMarker("openclaw.dev/gateway-namespace", "label"),
      ],
      [
        "annotate",
        "openclaw.dev/namespace-id",
        `ns_${randomUUID()}`,
        undefined,
        foreignMarker("openclaw.dev/namespace-id", "annotation"),
      ],
      [
        "annotate",
        "openclaw.dev/namespace-lifecycle",
        undefined,
        "external",
        `Existing Kubernetes namespace ${existingName} requires external ownership.`,
      ],
      [
        "label",
        "pod-security.kubernetes.io/enforce",
        "baseline",
        "restricted",
        `Existing Kubernetes namespace ${existingName} requires restricted Pod Security.`,
      ],
    ]) {
      await kubectl(
        operation,
        "namespace",
        existingName,
        rejectedValue === undefined ? `${key}-` : `${key}=${rejectedValue}`,
        "--overwrite",
      );
      const rejectedNamespace = await resource("namespace", existingName);
      await assertPermanentlyRejected(reason);
      assert.deepEqual(await resource("namespace", existingName), rejectedNamespace);
      await kubectl(
        operation,
        "namespace",
        existingName,
        restoredValue === undefined ? `${key}-` : `${key}=${restoredValue}`,
        "--overwrite",
      );
    }

    // Listing tenant NetworkPolicies is scoped RBAC: absent permission remains retryable and inert.
    const namespaceBeforeAuthorization = await resource("namespace", existingName);
    assert.deepEqual(await driver.ensureNamespace(owner), {
      namespaceId: owner.id,
      namespaceReady: false,
    });
    assert.deepEqual(await resource("namespace", existingName), namespaceBeforeAuthorization);
    assert.equal(await missing("resourcequota", "openclaw-quota", existingName), true);
    await grantTenantAccess(existingName);

    // An already-bound tenant cannot claim a second physical namespace through explicit selection.
    await createExistingNamespace(duplicateName);
    await kubectl("label", "namespace", duplicateName, `openclaw.dev/namespace=${owner.id}`);
    await kubectl("annotate", "namespace", duplicateName, `openclaw.dev/namespace-id=${owner.id}`);
    const namespaceBeforeDuplicateRejection = await resource("namespace", existingName);
    await assertPermanentlyRejected(
      `Another Kubernetes namespace already claims tenant ${owner.id}.`,
    );
    assert.deepEqual(await resource("namespace", existingName), namespaceBeforeDuplicateRejection);
    assert.equal(await missing("resourcequota", "openclaw-quota", existingName), true);
    await kubectl("delete", "namespace", duplicateName, "--wait=true");

    // Additive foreign allow-all policy would defeat default-deny, so reject before any OCC mutation.
    const foreignPolicyPath = join(directory, "foreign-allow-all.json");
    await writeFile(
      foreignPolicyPath,
      JSON.stringify({
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: "operator-allow-all", namespace: existingName },
        spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"], ingress: [{}], egress: [{}] },
      }),
    );
    await kubectl("create", "-f", foreignPolicyPath);
    const originalForeignPolicy = await resource(
      "networkpolicy",
      "operator-allow-all",
      existingName,
    );
    const namespaceBeforePolicyRejection = await resource("namespace", existingName);
    await assertPermanentlyRejected(
      `The existing Kubernetes namespace ${existingName} has a NetworkPolicy that this Namespace does not own.`,
    );
    assert.deepEqual(
      await resource("namespace", existingName),
      namespaceBeforePolicyRejection,
      "foreign NetworkPolicies must be rejected before binding tenant ownership metadata",
    );
    assert.deepEqual(
      await resource("networkpolicy", "operator-allow-all", existingName),
      originalForeignPolicy,
      "a foreign allow-all policy must remain entirely unchanged after rejection",
    );
    assert.equal(await missing("resourcequota", "openclaw-quota", existingName), true);
    await kubectl(
      "delete",
      "networkpolicy",
      "operator-allow-all",
      "--namespace",
      existingName,
      "--wait=true",
    );

    await driver.ensureNamespace(owner);
    await waitFor("explicitly selected existing tenant namespace to become ready", async () => {
      const observation = await driver.ensureNamespace(owner);
      assert.notEqual(observation.failure, "permanent");
      return observation.namespaceReady ? observation : undefined;
    });
    const preparedNamespace = await resource("namespace", existingName);
    assert.equal(preparedNamespace.metadata.uid, originalNamespace.metadata.uid);
    assert.deepEqual(preparedNamespace.metadata.labels, {
      ...originalNamespace.metadata.labels,
      "openclaw.dev/namespace": owner.id,
      "openclaw.dev/gateway-namespace": owner.id,
    });
    assert.deepEqual(preparedNamespace.metadata.annotations, {
      ...originalNamespace.metadata.annotations,
      "openclaw.dev/namespace-id": owner.id,
    });
    assert.equal(preparedNamespace.metadata.labels["app.kubernetes.io/managed-by"], "Helm");
    assert.equal(
      preparedNamespace.metadata.annotations["openclaw.dev/namespace-lifecycle"],
      "external",
    );
    assert.equal(await missing("namespace", kubernetesNamespaceName(owner.id)), true);
    assert.deepEqual(
      (await resources("networkpolicies", existingName))
        .map(({ metadata }) => metadata.name)
        .sort(),
      ["allow-dns", "allow-gateway-ingress", "default-deny"],
    );
    await resource("resourcequota", "openclaw-quota", existingName);
    await resource("limitrange", "openclaw-limits", existingName);
    const readyOwner = { ...owner, status: "ready" };
    await provisionFixtureAuth(readyOwner);

    // Canonical Configuration uses the exact adopted namespace alongside runtime resources.
    const configuration = {
      id: `cfg_${randomUUID()}`,
      namespaceId: owner.id,
      kind: "agent",
      generation: 1,
      values: { gateway: { controlUi: { enabled: false } }, logging: { level: "info" } },
      createdAt: new Date().toISOString(),
    };
    const reference = { id: configuration.id, namespaceId: owner.id };
    const configurationName = kubernetesConfigurationName(configuration.id);
    assert.deepEqual(await configurationDriver.create(configuration), configuration);
    assert.equal(
      (await resource("configmap", configurationName, existingName)).metadata.namespace,
      existingName,
    );
    assert.deepEqual(await configurationDriver.read(reference), configuration);
    const updatedConfiguration = {
      ...configuration,
      generation: 2,
      values: { ...configuration.values, logging: { level: "debug" } },
    };
    assert.deepEqual(await configurationDriver.update(updatedConfiguration), updatedConfiguration);
    assert.deepEqual(await configurationDriver.read(reference), updatedConfiguration);
    await configurationDriver.delete(reference);
    assert.equal(await missing("configmap", configurationName, existingName), true);

    // Dedicated workloads and the Harness workspace must remain inside the exact tenant.
    const agentId = `agt_${randomUUID()}`;
    const candidate = revision(driver, readyOwner, agentId, 1);
    await waitFor("discovered Agent gateway and immutable revision to become ready", async () => {
      const observation = await driver.prepareRevision(candidate, revisionContext(candidate));
      assert.equal(observation.namespaceId, owner.id);
      return observation.ready ? observation : undefined;
    });
    const gateway = await assertReadyGateway(existingName, agentId, owner.id, candidate);
    const workload = await resource("deployment", revisionName(candidate), existingName);
    const harnessClaim = await assertHarnessWorkspaceClaim(existingName, owner.id, agentId);
    assert.equal(
      gateway.spec.template.spec.volumes.some(
        ({ persistentVolumeClaim }) =>
          persistentVolumeClaim?.claimName === harnessClaim.metadata.name,
      ),
      false,
      "Gateway must not mount the Harness workspace claim",
    );
    assert.deepEqual(
      workload.spec.template.spec.volumes.find(({ name }) => name === "openclaw-workspace"),
      {
        name: "openclaw-workspace",
        persistentVolumeClaim: { claimName: harnessClaim.metadata.name },
      },
    );
    await driver.stopRevision(candidate);
    assert.equal(await missing("deployment", revisionName(candidate), existingName), true);
    assert.equal(await missing("deployment", gatewayName(agentId), existingName), true);
    assert.deepEqual(
      (await resources("pods", existingName)).filter(
        ({ metadata }) =>
          metadata.labels?.["openclaw.dev/agent"] === agentId &&
          metadata.labels?.["openclaw.dev/revision"] === candidate.id,
      ),
      [],
      "stop must not return while an exact revision Pod can still execute",
    );
    assert.equal(
      (await resource("persistentvolumeclaim", harnessClaim.metadata.name, existingName)).metadata
        .uid,
      harnessClaim.metadata.uid,
      "stop must preserve the Agent-owned Harness workspace claim",
    );

    // Namespace deletion is legal only for an owner with no Agents or Configurations.
    await createExistingNamespace(cleanupName);
    await grantTenantAccess(cleanupName);
    await driver.ensureNamespace(cleanupOwner);
    await waitFor("empty external tenant namespace to become ready", async () => {
      const observation = await driver.ensureNamespace(cleanupOwner);
      assert.notEqual(observation.failure, "permanent");
      return observation.namespaceReady ? observation : undefined;
    });
    const originalCleanupNamespace = await resource("namespace", cleanupName);
    const originalRoleBinding = await resource("rolebinding", "openclaw-controller", cleanupName);
    for (const kind of ["configmap", "secret"]) {
      await kubectl(
        "create",
        kind,
        ...(kind === "secret" ? ["generic"] : []),
        "operator-sentinel",
        "--namespace",
        cleanupName,
        "--from-literal=owner=operator",
      );
    }
    const originalOperatorConfigMap = await resource("configmap", "operator-sentinel", cleanupName);
    const originalOperatorSecret = await resource("secret", "operator-sentinel", cleanupName);

    // Valid deletion removes fixed OCC infrastructure without touching the operator's namespace.
    const deletingOwner = { ...cleanupOwner, status: "deleting" };
    await waitFor(
      "empty tenant infrastructure to be deleted without deleting its namespace",
      async () => {
        const observation = await driver.deleteNamespace(deletingOwner);
        assert.notEqual(observation.failure, "permanent");
        return observation.namespaceDeleted ? observation : undefined;
      },
    );
    for (const kind of ["networkpolicies", "resourcequotas", "limitranges"]) {
      assert.deepEqual(await resources(kind, cleanupName), []);
    }
    const preservedNamespace = await resource("namespace", cleanupName);
    assert.equal(preservedNamespace.metadata.uid, originalCleanupNamespace.metadata.uid);
    assert.deepEqual(preservedNamespace.metadata.labels, originalCleanupNamespace.metadata.labels);
    assert.deepEqual(
      preservedNamespace.metadata.annotations,
      originalCleanupNamespace.metadata.annotations,
    );
    assert.equal(
      (await resource("rolebinding", "openclaw-controller", cleanupName)).metadata.uid,
      originalRoleBinding.metadata.uid,
    );
    assert.equal(
      (await resource("configmap", "operator-sentinel", cleanupName)).metadata.uid,
      originalOperatorConfigMap.metadata.uid,
    );
    assert.equal(
      (await resource("secret", "operator-sentinel", cleanupName)).metadata.uid,
      originalOperatorSecret.metadata.uid,
    );
    assert.deepEqual(await driver.deleteNamespace(deletingOwner), {
      namespaceId: cleanupOwner.id,
      namespaceDeleted: true,
    });
  },
);

test(
  "provisioning API retains the first deployment outcome with real Kubernetes fixture storage",
  { ...requiresKubernetesAndPostgres, timeout: 480_000 },
  async (context) => {
    await assertKubernetesFixtureAvailable();
    const installationId = `ins_${randomUUID()}`;
    const platformNamespace = `oce-provisioning-${hash(installationId)}`;
    await kubectl("create", "namespace", platformNamespace);
    context.after(() => deleteNamespaces(platformNamespace));
    const controller = await createScopedController(context, installationId, platformNamespace);
    await kubectl(
      "patch",
      "clusterrole",
      controller.tenantRole,
      "--type=json",
      "--patch",
      JSON.stringify([
        {
          op: "add",
          path: "/rules/-",
          value: {
            apiGroups: [""],
            resources: ["secrets"],
            verbs: ["get", "list", "create", "patch", "update", "delete"],
          },
        },
        // Final deletion checks routes even when deployment failed before creating them.
        ...[
          ["gateway.networking.k8s.io", "httproutes"],
          ["gateway.envoyproxy.io", "securitypolicies"],
        ].map(([group, resource]) => ({
          op: "add",
          path: "/rules/-",
          value: { apiGroups: [group], resources: [resource], verbs: ["get", "delete"] },
        })),
      ]),
    );
    const gatewayRouting = {
      gatewayName: `oce-agent-gateways-${hash(installationId, 8)}`,
      gatewayNamespace: platformNamespace,
      envoyNamespace: platformNamespace,
    };
    const nodeEnrollment = createGatewayNodeEnrollment(
      async () => "fixture-node-enrollment-api-key",
    );
    const controllerImage = process.env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE;
    assert.match(
      controllerImage ?? "",
      /^\S+@sha256:[a-f0-9]{64}$/i,
      "provisioning requires the actual imported controller image for its Gateway proxy",
    );
    const kubernetesService = JSON.parse(
      await kubectl("get", "service", "kubernetes", "--namespace", "default", "-o", "json"),
    );
    const kubernetesEndpoints = JSON.parse(
      await kubectl("get", "endpoints", "kubernetes", "--namespace", "default", "-o", "json"),
    );
    const infrastructureAddresses = [
      ...(kubernetesService.spec.clusterIPs ?? [kubernetesService.spec.clusterIP]),
      ...(kubernetesEndpoints.subsets ?? []).flatMap(({ addresses = [] }) =>
        addresses.map(({ ip }) => ip),
      ),
    ];
    const denyCidrs = [
      ...new Set(
        infrastructureAddresses.map((address) => {
          const family = isIP(address);
          assert.notEqual(
            family,
            0,
            "the selected cluster must report literal infrastructure addresses",
          );
          return `${address}/${family === 4 ? 32 : 128}`;
        }),
      ),
    ];
    const { driver, kubernetesNamespaceName } = await createDriver(
      {
        authentication: controller.authentication,
        gatewayRouting,
        network: {
          dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
          gatewayPort: 8080,
          gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
        },
        runtime: {
          transportSecretPrefix: "transport",
          gatewayStorageClassName: "local-path",
          // The real proxy serves the admitted Slack requirements; fixture credentials
          // and the fixture runtime establish projection, not a Slack connection.
          gatewayOutbound: {
            enabled: true,
            image: controllerImage,
            denyCidrs,
          },
          gatewayNodeSelector: {
            "kubernetes.io/hostname": JSON.parse(await kubectl("get", "nodes", "-o", "json"))
              .items[0].metadata.name,
          },
        },
      },
      { nodeEnrollment },
    );
    let handoffWorkerStop;
    const fixture = await createProvisioningApiFixture(context, driver, controller.authentication, {
      emit: (event) => {
        if (event.code === "PROVISIONING_DEPLOYMENT_PENDING" && handoffWorkerStop === undefined) {
          handoffWorkerStop = fixture.stopWorker();
        }
      },
    });
    context.after(async () => {
      await Promise.all(
        fixture.bootstrapNamespaceIds.map((namespaceId) =>
          deleteNamespaces(kubernetesNamespaceName(namespaceId)),
        ),
      );
    });
    const namespaceResponse = await fixture.request("POST", "/namespaces", {
      name: `k8s-provision-${randomUUID().slice(0, 8)}`,
    });
    assert.equal(namespaceResponse.status, 201, JSON.stringify(namespaceResponse.body));
    const namespaceOwner = namespaceResponse.data;
    const placement = kubernetesNamespaceName(namespaceOwner.id);
    const gatewayPlacement = placement;
    context.after(() => deleteNamespaces(placement));

    await fixture.startWorker();
    for (const target of [placement]) {
      await waitFor(`worker to create provisioning namespace ${target}`, async () =>
        (await missing("namespace", target)) ? undefined : true,
      );
      await kubectl(
        "create",
        "rolebinding",
        "openclaw-controller",
        "--namespace",
        target,
        `--clusterrole=${controller.tenantRole}`,
        `--serviceaccount=${platformNamespace}:${controller.account}`,
      );
    }
    await waitFor("provisioning tenant Namespace to become ready", async () => {
      const observed = await fixture.request("GET", `/namespaces/${namespaceOwner.id}`);
      assert.equal(observed.status, 200, JSON.stringify(observed.body));
      return observed.data.status === "ready" ? observed.data : undefined;
    });
    await fixture.stopWorker();

    const discoveryPat = `at-kubernetes-fixture-${randomUUID()}`;
    const rotatedPat = `at-kubernetes-rotated-${randomUUID()}`;
    const modelSecret = await fixture.request("POST", `/namespaces/${namespaceOwner.id}/secrets`, {
      name: `Provisioning model key ${randomUUID().slice(0, 8)}`,
      value: discoveryPat,
    });
    assert.equal(modelSecret.status, 201, JSON.stringify(modelSecret.body));
    const slackBotSecret = await fixture.request(
      "POST",
      `/namespaces/${namespaceOwner.id}/secrets`,
      {
        name: `Provisioning Slack bot token ${randomUUID().slice(0, 8)}`,
        value: `xoxb-${randomUUID()}`,
      },
    );
    assert.equal(slackBotSecret.status, 201, JSON.stringify(slackBotSecret.body));
    const slackAppSecret = await fixture.request(
      "POST",
      `/namespaces/${namespaceOwner.id}/secrets`,
      {
        name: `Provisioning Slack app token ${randomUUID().slice(0, 8)}`,
        value: `xapp-${randomUUID()}`,
      },
    );
    assert.equal(slackAppSecret.status, 201, JSON.stringify(slackAppSecret.body));

    // Before creating the Agent, use the actual Kubernetes-backed PAT through the
    // real discovery Driver; only the external provider responses are controlled.
    const originalFetch = globalThis.fetch;
    const observedTokens = [];
    const provider = context.mock.method(globalThis, "fetch", async (url, init) => {
      const address = String(url);
      if (
        !address.startsWith("https://auth.openai.com/") &&
        !address.startsWith("https://chatgpt.com/backend-api/ps/")
      ) {
        return originalFetch(url, init);
      }
      observedTokens.push(init.headers.Authorization.slice("Bearer ".length));
      if (address.includes("/whoami")) {
        return Response.json({
          chatgpt_account_id: "fixture-account",
          chatgpt_account_is_fedramp: false,
        });
      }
      assert.equal(init.headers["ChatGPT-Account-ID"], "fixture-account");
      const plugin = {
        id: "fixture-plugin",
        name: "fixture",
        scope: "GLOBAL",
        status: "ENABLED",
        installation_policy: "AVAILABLE",
        release: {
          display_name: "Fixture",
          interface: {},
          requires_local_executor: false,
          app_ids: ["fixture-app"],
          app_manifest: null,
          skills: [],
          mcp_servers: [],
        },
      };
      if (address.includes("plugins/list")) {
        return Response.json({ plugins: [plugin], pagination: { next_page_token: null } });
      }
      if (address.includes("plugins/fixture-plugin")) {
        return Response.json(plugin);
      }
      assert.ok(address.endsWith("apps/batch"));
      return Response.json({
        apps: [{ id: "fixture-app", status: "ENABLED", tools: [{ name: "search" }] }],
      });
    });
    const discoveryPath = `/namespaces/${namespaceOwner.id}/agents/plugins`;
    const catalog = await fixture.request("POST", discoveryPath, {
      secretRef: modelSecret.data.ref,
    });
    assert.equal(catalog.status, 200);
    assert.equal(catalog.data.plugins[0].remoteId, "fixture-plugin");
    const detail = await fixture.request("POST", `${discoveryPath}/details`, {
      secretRef: modelSecret.data.ref,
      pluginId: "fixture-plugin",
    });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.tools[0].id, "fixture-app/search");
    assert.ok(observedTokens.length > 0 && observedTokens.every((token) => token === discoveryPat));
    assert.equal(
      (
        await fixture.request(
          "PATCH",
          `/namespaces/${namespaceOwner.id}/secrets/${modelSecret.data.id}`,
          { value: rotatedPat },
        )
      ).status,
      200,
    );
    observedTokens.length = 0;
    assert.equal(
      (await fixture.request("POST", discoveryPath, { secretRef: modelSecret.data.ref })).status,
      200,
    );
    assert.ok(observedTokens.length > 0 && observedTokens.every((token) => token === rotatedPat));
    assert.doesNotMatch(
      JSON.stringify([catalog.body, detail.body]),
      /at-kubernetes-(fixture|rotated)-/,
    );
    provider.mock.restore();

    const body = provisioningRequestBody({
      modelSecretRef: modelSecret.data.ref,
      slackBotSecretRef: slackBotSecret.data.ref,
      authMethod: "codex_pat",
    });
    // Socket Mode needs both saved roles; provider auth.test remains the explicit external fixture.
    body.configuration.values.channels.slack.mode = "socket";
    body.configuration.values.channels.slack.appToken = {
      source: "env",
      provider: "default",
      id: "SLACK_APP_TOKEN",
    };
    body.configuration.secretBindings.SLACK_APP_TOKEN = {
      source: slackAppSecret.data.ref,
      delivery: { type: "env" },
    };
    assert.equal(
      JSON.stringify(body).includes(rotatedPat),
      false,
      "provisioning must carry only saved Secret references, not Secret values",
    );
    assert.equal(
      JSON.stringify(body).includes("xoxb-"),
      false,
      "provisioning must carry only saved Secret references, not Slack token values",
    );
    const admitted = await fixture.request(
      "POST",
      `/namespaces/${namespaceOwner.id}/agents/provision`,
      body,
    );
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    assert.equal(admitted.data.agent, undefined);
    assert.equal(typeof admitted.data.provisioning.workId, "string");
    assert.match(admitted.data.provisioning.url, /^\/namespaces\//);
    await fixture.startWorker();
    const provisioned = await waitFor(
      "Kubernetes provisioning to queue its first deployment wait",
      async () => {
        const observed = await fixture.request("GET", admitted.data.provisioning.url);
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        assert.notEqual(observed.data.status, "failed", JSON.stringify(observed.body));
        // The handoff commits revisionId while the worker still holds the provisioning lease
        // ("running"); its deployment wait is deferred ("queued") in a later transaction.
        // Inspect the handoff only after that deferral has committed (finding 1253).
        return observed.data.revisionId !== undefined && observed.data.status === "queued"
          ? observed.data
          : undefined;
      },
    );
    // A poll can see "queued" just before the pending event stops the worker; this stop covers it.
    await handoffWorkerStop;
    await fixture.stopWorker();
    assert.equal(provisioned.status, "queued");
    assert.equal(typeof provisioned.agentId, "string");
    assert.equal(typeof provisioned.configurationId, "string");
    assert.equal(typeof provisioned.revisionId, "string");

    const revisions = await fixture.request(
      "GET",
      `/namespaces/${namespaceOwner.id}/agents/${provisioned.agentId}/revisions`,
    );
    assert.equal(revisions.status, 200, JSON.stringify(revisions.body));
    assert.equal(revisions.data.length, 1);
    assert.equal(revisions.data[0].id, provisioned.revisionId);
    // The list returns a summary; the admitted Compute placement is on the exact revision.
    const exactRevision = await fixture.request(
      "GET",
      `/namespaces/${namespaceOwner.id}/agents/${provisioned.agentId}/revisions/${provisioned.revisionId}`,
    );
    assert.equal(exactRevision.status, 200, JSON.stringify(exactRevision.body));
    assert.equal(exactRevision.data.compute.id, driver.id);
    assert.equal(exactRevision.data.compute.implementation, driver.implementation);
    assert.deepEqual(
      exactRevision.data.gatewayOutbound,
      {
        selection: { mode: "channelsOnly" },
        requirements: [
          {
            source: "slack",
            destinations: ["slack.com", "slack-edge.com", "slack-msgs.com"].map((host) => ({
              host,
              includeSubdomains: true,
            })),
          },
        ],
        denyCidrs,
      },
      "the worker must freeze automatic Slack requirements without an extra Agent policy setting",
    );

    const configuration = await resource(
      "configmap",
      kubernetesConfigurationName(revisions.data[0].configurationId),
      gatewayPlacement,
    );
    assert.equal(
      configuration.metadata.annotations["openclaw.dev/configuration-id"],
      revisions.data[0].configurationId,
    );
    assert.equal(configuration.metadata.annotations["openclaw.dev/configuration-generation"], "1");

    const provisionedSecrets = (await resources("secrets", gatewayPlacement)).filter(
      ({ metadata }) =>
        metadata.labels?.["app.kubernetes.io/managed-by"] === "openclaw-enterprise" &&
        metadata.labels?.["openclaw.dev/namespace"] === namespaceOwner.id &&
        metadata.labels?.["openclaw.dev/secret"] !== undefined,
    );
    assert.equal(
      provisionedSecrets.length,
      3,
      "Console-saved Secrets must be stored through the real Kubernetes Secret Driver",
    );
    const transportName = `transport-${hash(provisioned.agentId)}`;
    const passwordName = `gateway-password-${hash(provisioned.agentId)}`;
    const transport = await resource("secret", transportName, gatewayPlacement);
    const password = await resource("secret", passwordName, gatewayPlacement);
    assert.deepEqual(
      Object.keys(transport.data),
      ["app-server-token"],
      "the canonical app-server credential must be generated before provisioning handoff",
    );
    assert.deepEqual(
      Object.keys(password.data),
      ["gateway-password"],
      "the Gateway password must be a separate canonical credential",
    );
    const canonicalNames = [
      transportName,
      passwordName,
      ...provisionedSecrets.map(({ metadata }) => metadata.name),
    ];
    for (const name of canonicalNames) {
      await resource("secret", name, placement);
    }

    // This is the actual managed proxy process; the fixture Gateway makes no Slack connection.
    const proxyName = `gateway-outbound-${hash(provisioned.agentId)}-${hash(provisioned.revisionId)}`;
    await fixture.startWorker();
    const proxyPod = await waitFor(
      "the provisioned revision's managed proxy to become ready",
      async () =>
        (await resources("pods", gatewayPlacement)).find(
          ({ metadata, status }) =>
            metadata.labels?.["openclaw.dev/agent"] === provisioned.agentId &&
            metadata.labels?.["openclaw.dev/revision"] === provisioned.revisionId &&
            metadata.labels?.["openclaw.dev/workload-role"] === "gateway-outbound" &&
            status.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
        ),
    );
    await fixture.stopWorker();
    const proxyDeployment = await resource("deployment", proxyName, gatewayPlacement);
    const proxyService = await resource("service", proxyName, gatewayPlacement);
    const proxyConfiguration = await resource("configmap", proxyName, gatewayPlacement);
    assert.equal(proxyDeployment.spec.template.spec.containers[0].image, controllerImage);
    assert.ok(
      proxyDeployment.spec.template.spec.volumes.some(
        ({ configMap }) => configMap?.name === proxyConfiguration.metadata.name,
      ),
      "the owning proxy Deployment must consume its revision policy ConfigMap",
    );
    assert.ok(
      Object.entries(proxyService.spec.selector).every(
        ([key, value]) => proxyPod.metadata.labels[key] === value,
      ),
      "the owning Service must select the real ready proxy Pod",
    );
    const proxyPolicy = JSON.parse(proxyConfiguration.data["policy.json"]);
    assert.equal(proxyPolicy.mode, "restricted");
    assert.equal(proxyPolicy.agentId, provisioned.agentId);
    assert.equal(proxyPolicy.revisionId, provisioned.revisionId);
    assert.deepEqual(
      new Set(proxyPolicy.destinations),
      new Set([
        { host: "slack-edge.com", includeSubdomains: true },
        { host: "slack-msgs.com", includeSubdomains: true },
        { host: "slack.com", includeSubdomains: true },
      ]),
    );

    // Seed an owned pre-upgrade RWX workspace without altering any supported Agent.
    // No RWX provisioner is needed: rejection must happen before mounting the claim.
    const legacyConfiguration = await fixture.request(
      "POST",
      `/namespaces/${namespaceOwner.id}/configurations`,
      {
        kind: "agent",
        values: {
          gateway: body.configuration.values.gateway,
          agents: body.configuration.values.agents,
        },
      },
    );
    assert.equal(legacyConfiguration.status, 201, JSON.stringify(legacyConfiguration.body));
    const legacy = await fixture.request("POST", `/namespaces/${namespaceOwner.id}/agents`, {
      name: `legacy-rwx-${randomUUID()}`,
      configurationId: legacyConfiguration.data.id,
      executionMode: "dedicated",
      harnessAuth: body.harnessAuth,
    });
    assert.equal(legacy.status, 201, JSON.stringify(legacy.body));
    const legacyPath = `/namespaces/${namespaceOwner.id}/agents/${legacy.data.id}`;
    const role = await fixture.request("POST", `/namespaces/${namespaceOwner.id}/iam/roles`, {
      name: `legacy-rwx-secrets-${randomUUID()}`,
      permissions: [{ action: "operate", resourceKind: "secret" }],
    });
    assert.equal(role.status, 201, JSON.stringify(role.body));
    for (const secret of [modelSecret]) {
      const grant = await fixture.request(
        "POST",
        `/namespaces/${namespaceOwner.id}/iam/access-bindings`,
        {
          subjectKind: "identity",
          subjectId: legacy.data.servicePrincipalId,
          roleId: role.data.id,
          resourceKind: "secret",
          resourceId: secret.data.id,
        },
      );
      assert.equal(grant.status, 201, JSON.stringify(grant.body));
    }
    const credentials = await fixture.request("POST", `${legacyPath}/runtime-credentials`, {});
    assert.equal(credentials.status, 200, JSON.stringify(credentials.body));
    const workspaceName = harnessWorkspaceClaimName(legacy.data.id);
    const gatewayStateName = `gateway-state-${hash(legacy.data.id)}`;
    const claimDirectory = await mkdtemp(join(tmpdir(), "openclaw-legacy-rwx-"));
    context.after(() => rm(claimDirectory, { recursive: true, force: true }));
    for (const [name, namespace, accessMode, storage] of [
      [workspaceName, placement, "ReadWriteMany", "40Gi"],
      [gatewayStateName, gatewayPlacement, "ReadWriteOnce", "10Gi"],
    ]) {
      const claimPath = join(claimDirectory, `${name}.json`);
      await writeFile(
        claimPath,
        JSON.stringify({
          apiVersion: "v1",
          kind: "PersistentVolumeClaim",
          metadata: {
            name,
            namespace,
            labels: {
              "app.kubernetes.io/managed-by": "openclaw-enterprise",
              "openclaw.dev/namespace": namespaceOwner.id,
              "openclaw.dev/agent": legacy.data.id,
            },
            annotations: {
              "openclaw.dev/namespace-id": namespaceOwner.id,
              "openclaw.dev/agent-id": legacy.data.id,
            },
          },
          spec: {
            accessModes: [accessMode],
            volumeMode: "Filesystem",
            storageClassName: "local-path",
            resources: { requests: { storage } },
          },
        }),
        { mode: 0o600 },
      );
      await kubectl("apply", "--filename", claimPath);
    }
    const originalWorkspace = await resource("persistentvolumeclaim", workspaceName, placement);
    const originalGatewayState = await resource(
      "persistentvolumeclaim",
      gatewayStateName,
      gatewayPlacement,
    );
    // Observe the real Driver failure without replacing its Kubernetes client or behavior.
    // A generic worker failure alone could otherwise pass for an unrelated configuration error.
    const prepareRevision = driver.prepareRevision.bind(driver);
    const preparationFailures = [];
    const preparation = context.mock.method(driver, "prepareRevision", async (...args) => {
      try {
        return await prepareRevision(...args);
      } catch (error) {
        if (args[0].agentId === legacy.data.id) {
          preparationFailures.push(error.message);
        }
        throw error;
      }
    });
    const deployment = await fixture.request("POST", `${legacyPath}/deploy`);
    assert.equal(deployment.status, 202, JSON.stringify(deployment.body));
    await fixture.startWorker();
    const failedDeployment = await waitFor("legacy RWX deployment to fail", async () => {
      const work = await fixture.readWork(`agent_revision:${deployment.data.id}:reconcile`);
      return work?.state === "failed_permanent" ? work : undefined;
    });
    preparation.mock.restore();
    assert.deepEqual(
      new Set(preparationFailures),
      new Set([`Refusing invalid PersistentVolumeClaim ${workspaceName}.`]),
    );
    assert.equal(failedDeployment.reason_code, "DEPENDENCY_UNAVAILABLE");
    // Fixture images do not implement the model runtime. Its real deployment failure
    // must close the original provisioning request without creating another Agent.
    const initialFailure = await waitFor(
      "first deployment failure on provisioning status",
      async () => {
        const observed = await fixture.request("GET", admitted.data.provisioning.url);
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        return observed.data.status === "failed" ? observed.data : undefined;
      },
    );
    assert.equal(initialFailure.agentId, provisioned.agentId);
    assert.equal(initialFailure.revisionId, provisioned.revisionId);
    const initialDeployment = await fixture.request(
      "GET",
      `/namespaces/${namespaceOwner.id}/agents/${provisioned.agentId}/deployments/${provisioned.revisionId}`,
    );
    assert.equal(initialDeployment.data.status, "failed");
    assert.equal(initialFailure.error.code, initialDeployment.data.error.code);
    const undeployed = await fixture.request("GET", legacyPath);
    assert.equal(undeployed.status, 200, JSON.stringify(undeployed.body));
    assert.equal(undeployed.data.activeRevisionId, undefined);
    assert.equal(await missing("deployment", revisionName(deployment.data), placement), true);
    assert.equal(await missing("deployment", gatewayName(legacy.data.id), gatewayPlacement), true);
    assert.equal(
      (await resource("persistentvolumeclaim", gatewayStateName, gatewayPlacement)).metadata.uid,
      originalGatewayState.metadata.uid,
    );
    const beforeDelete = await resource("persistentvolumeclaim", workspaceName, placement);
    assert.equal(beforeDelete.metadata.uid, originalWorkspace.metadata.uid);
    assert.deepEqual(beforeDelete.spec, originalWorkspace.spec);

    const deleting = await fixture.request("DELETE", legacyPath);
    assert.equal(deleting.status, 202, JSON.stringify(deleting.body));
    const failedDeletion = await waitFor(
      "legacy RWX deletion to exhaust its retry budget",
      async () => {
        const work = await fixture.readWork(`agent:${legacy.data.id}:reconcile:deleted`);
        return work?.state === "failed_permanent" ? work : undefined;
      },
    );
    assert.equal(failedDeletion.reason_code, "DEPENDENCY_UNAVAILABLE");
    await fixture.stopWorker();
    const retained = await fixture.request("GET", legacyPath);
    assert.equal(retained.status, 200, JSON.stringify(retained.body));
    assert.equal(retained.data.status, "deleting");
    assert.equal(retained.data.desiredRuntimeState, "stopped");
    const rejectedWorkspace = await resource("persistentvolumeclaim", workspaceName, placement);
    assert.equal(rejectedWorkspace.metadata.uid, originalWorkspace.metadata.uid);
    assert.deepEqual(rejectedWorkspace.spec, originalWorkspace.spec);
    assert.equal(rejectedWorkspace.metadata.deletionTimestamp, undefined);
    // Final deletion removes Gateway state before Harness workspace validation.
    // This is why the legacy Agent must be discarded with a compatible release.
    assert.equal(
      await missing("persistentvolumeclaim", gatewayStateName, gatewayPlacement),
      true,
      "Gateway state is removed before final deletion rejects the RWX claim",
    );
    assert.equal(
      await missing("secret", `transport-${hash(legacy.data.id)}`, gatewayPlacement),
      true,
    );
    assert.equal(
      await missing("secret", `gateway-password-${hash(legacy.data.id)}`, gatewayPlacement),
      true,
    );
    // The unrelated Agent and its canonical credentials are not deleted.
    assert.equal(
      (
        await fixture.request(
          "GET",
          `/namespaces/${namespaceOwner.id}/agents/${provisioned.agentId}`,
        )
      ).status,
      200,
    );
    assert.equal(
      (await resource("secret", transportName, gatewayPlacement)).metadata.uid,
      transport.metadata.uid,
    );
  },
);

test(
  "trusted embedded channel opt-in projects exact Secrets through API provisioning, revisions and stop",
  { ...requiresKubernetesAndPostgres, timeout: 480_000 },
  async (context) => {
    await assertKubernetesFixtureAvailable();
    const installationId = `ins_${randomUUID()}`;
    const platformNamespace = `oce-embedded-${hash(installationId)}`;
    await kubectl("create", "namespace", platformNamespace);
    context.after(() => deleteNamespaces(platformNamespace));
    const controller = await createScopedController(context, installationId, platformNamespace);
    // Actual callback resources require installed Gateway API and Envoy CRDs.
    // This fixture proves Kubernetes lifecycle and credential projection, not native
    // Teams dispatch, provider JWT verification, public TLS or model execution.
    await kubectl(
      "get",
      "crd",
      "httproutes.gateway.networking.k8s.io",
      "securitypolicies.gateway.envoyproxy.io",
    );
    await kubectl(
      "patch",
      "clusterrole",
      controller.tenantRole,
      "--type=json",
      "--patch",
      JSON.stringify([
        {
          op: "add",
          path: "/rules/-",
          value: {
            apiGroups: [""],
            resources: ["secrets", "pods/proxy"],
            verbs: ["get", "list", "create", "patch", "update", "delete"],
          },
        },
        ...[
          ["gateway.networking.k8s.io", "httproutes"],
          ["gateway.envoyproxy.io", "securitypolicies"],
        ].map(([group, resource]) => ({
          op: "add",
          path: "/rules/-",
          value: {
            apiGroups: [group],
            resources: [resource],
            verbs: ["get", "list", "create", "patch", "update", "delete"],
          },
        })),
      ]),
    );
    const routing = {
      gatewayName: `eval-channels-${hash(installationId)}`,
      gatewayNamespace: platformNamespace,
      envoyNamespace: platformNamespace,
      channels: { hostname: "channels.example.test" },
    };
    const runtime = {
      transportSecretPrefix: "transport",
      gatewayStorageClassName: "local-path",
      gatewayOutbound: {
        enabled: true,
        image: process.env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE,
        denyCidrs: [
          "10.0.0.0/8",
          "100.64.0.0/10",
          "172.16.0.0/12",
          "192.168.0.0/16",
          "169.254.0.0/16",
        ],
      },
    };
    const network = {
      dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
      gatewayPort: 8080,
      gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
      pluginStatusProxySourceCidrs:
        process.env.OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS.split(","),
    };
    const { driver: defaultDriver, kubernetesNamespaceName } = await createDriver({
      authentication: controller.authentication,
      gatewayRouting: routing,
      network,
      runtime,
    });
    const stock = await createProvisioningApiFixture(
      context,
      defaultDriver,
      controller.authentication,
    );
    const createdNamespace = await stock.request("POST", "/namespaces", {
      name: `Embedded channels ${randomUUID().slice(0, 8)}`,
    });
    assert.equal(createdNamespace.status, 201, JSON.stringify(createdNamespace.body));
    const namespaceId = createdNamespace.data.id;
    const placement = kubernetesNamespaceName(namespaceId);
    context.after(() => deleteNamespaces(placement));
    await stock.startWorker();
    await waitFor("embedded evaluation namespace", async () =>
      (await missing("namespace", placement)) ? false : true,
    );
    await kubectl(
      "create",
      "rolebinding",
      "openclaw-controller",
      "--namespace",
      placement,
      `--clusterrole=${controller.tenantRole}`,
      `--serviceaccount=${platformNamespace}:${controller.account}`,
    );
    await waitFor(
      "embedded evaluation Namespace readiness",
      async () =>
        (await stock.request("GET", `/namespaces/${namespaceId}`)).data.status === "ready",
    );
    await stock.stopWorker();
    const savedSecrets = [];
    for (const [name, value] of [
      ["model", "sk-embedded-fixture-key"],
      ["slack-app", `xapp-${randomUUID()}`],
      ["slack-bot", `xoxb-${randomUUID()}`],
      ["teams", `teams-fixture-${randomUUID()}`],
    ]) {
      const saved = await stock.request("POST", `/namespaces/${namespaceId}/secrets`, {
        name,
        value,
      });
      assert.equal(saved.status, 201, JSON.stringify(saved.body));
      savedSecrets.push(saved.data);
    }
    const model = "openai/gpt-6-astra";
    const values = {
      agents: { defaults: { model, models: { [model]: { agentRuntime: { id: "openclaw" } } } } },
      // The existing fixture CLI supplies probe protocol responses. A supported,
      // closed provider endpoint prevents synthetic keys reaching a live provider.
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://127.0.0.1:9/v1",
            models: [{ id: "gpt-6-astra", name: "Fixture model" }],
          },
        },
      },
      channels: {
        slack: {
          enabled: true,
          mode: "socket",
          appToken: { source: "env", id: "SLACK_APP_TOKEN" },
          botToken: { source: "env", id: "SLACK_BOT_TOKEN" },
        },
        msteams: {
          enabled: true,
          appId: "00000000-0000-4000-8000-000000000001",
          tenantId: "00000000-0000-4000-8000-000000000002",
          appPassword: { source: "env", id: "MSTEAMS_APP_PASSWORD" },
        },
      },
    };
    const secretBindings = Object.fromEntries(
      ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "MSTEAMS_APP_PASSWORD"].map((name, index) => [
        name,
        { source: savedSecrets[index + 1].ref, delivery: { type: "env" } },
      ]),
    );
    const plan = {
      requestId: `req_${randomUUID()}`,
      name: "Embedded channel trial",
      executionMode: "embedded",
      configuration: { kind: "agent", values, secretBindings },
      harnessAuth: { method: "api_key", source: savedSecrets[0].ref },
    };
    const path = `/namespaces/${namespaceId}/agents/provision`;
    const refused = await stock.request("POST", path, plan);
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.match(refused.error.message, /dedicated execution/);
    // Native JSON cannot authorize trusted infrastructure or credential placement.
    const nativeFlag = await stock.request("POST", path, {
      ...plan,
      requestId: `req_${randomUUID()}`,
      configuration: {
        ...plan.configuration,
        values: { ...values, runtime: { channels: { experimentalEmbeddedChannels: true } } },
      },
    });
    assert.equal(nativeFlag.status, 400, JSON.stringify(nativeFlag.body));
    const { driver } = await createDriver({
      authentication: controller.authentication,
      gatewayRouting: routing,
      network,
      runtime: {
        ...runtime,
        channels: { experimentalEmbeddedChannels: true },
      },
    });
    const prepareDiagnostics = [];
    const optedIn = await createProvisioningApiFixture(context, driver, controller.authentication, {
      emit: (event) => {
        if (event.event === "worker.compute-prepare-failed") {
          prepareDiagnostics.push(event);
        }
      },
    });
    const missingBinding = await optedIn.request("POST", path, {
      ...plan,
      requestId: `req_${randomUUID()}`,
      configuration: { kind: "agent", values },
    });
    assert.equal(missingBinding.status, 400, JSON.stringify(missingBinding.body));
    assert.equal(missingBinding.error.code, "CHANNEL_CREDENTIAL_BINDING_REQUIRED");
    const foreign = await optedIn.request("POST", path, {
      ...plan,
      requestId: `req_${randomUUID()}`,
      configuration: {
        ...plan.configuration,
        secretBindings: {
          ...secretBindings,
          MSTEAMS_APP_PASSWORD: {
            source: { ...savedSecrets[3].ref, namespaceId: stock.bootstrapNamespaceIds[0] },
            delivery: { type: "env" },
          },
        },
      },
    });
    assert.equal(foreign.status, 400, JSON.stringify(foreign.body));
    const admitted = await optedIn.request("POST", path, plan);
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    await optedIn.startWorker();
    const provisioned = await waitFor("embedded channel provisioning to succeed", async () => {
      const observed = await optedIn.request("GET", admitted.data.provisioning.url);
      assert.equal(observed.status, 200, JSON.stringify(observed.body));
      assert.notEqual(
        observed.data.status,
        "failed",
        JSON.stringify({ response: observed.body, prepareDiagnostics }),
      );
      return observed.data.status === "succeeded" ? observed.data : undefined;
    });
    const agentPath = `/namespaces/${namespaceId}/agents/${provisioned.agentId}`;
    const gateway = gatewayName(provisioned.agentId);
    const callbackName = `${gateway}-msteams`;
    const waitForReconciledRevision = async (revisionId) => {
      // Active revision selection precedes activation and predecessor retirement.
      // Completion proves the callback cutover and old proxy withdrawal have settled.
      await waitFor(`embedded revision ${revisionId} reconciliation`, async () => {
        const work = await optedIn.readWork(`agent_revision:${revisionId}:reconcile`);
        assert.notEqual(
          work?.state,
          "failed_permanent",
          JSON.stringify({ work, prepareDiagnostics }),
        );
        return work?.state === "succeeded";
      });
    };
    const assertServing = async (revisionId) => {
      await waitForReconciledRevision(revisionId);
      const admittedRevision = await optedIn.readRevision(
        namespaceId,
        provisioned.agentId,
        revisionId,
      );
      assert.deepEqual(admittedRevision.gatewayOutbound.selection, { mode: "channelsOnly" });
      assert.deepEqual(
        admittedRevision.gatewayOutbound.requirements.map(({ source }) => source).sort(),
        ["msteams", "slack"],
      );
      const deployment = await resource("deployment", gateway, placement);
      assert.equal(deployment.metadata.annotations["openclaw.dev/agent-revision-id"], revisionId);
      const environment = deployment.spec.template.spec.containers[0].env;
      const expectedEnvironment = {};
      const canonicalSecrets = await resources("secrets", placement);
      for (const name of Object.keys(secretBindings)) {
        const ref = environment.find((entry) => entry.name === name).valueFrom.secretKeyRef;
        const source = await resource("secret", ref.name, placement);
        assert.equal(source.metadata.annotations["openclaw.dev/namespace-id"], namespaceId);
        assert.equal(source.metadata.labels["openclaw.dev/agent"], provisioned.agentId);
        assert.equal(source.metadata.labels["openclaw.dev/revision"], revisionId);
        const canonical = canonicalSecrets.find(
          ({ metadata }) =>
            metadata.annotations?.["openclaw.dev/secret-id"] === secretBindings[name].source.id,
        );
        assert.ok(
          canonical,
          "the bound Namespace Secret remains the canonical source of the immutable revision copy",
        );
        assert.equal(source.data[ref.key], canonical.data.value);
        assert.equal(ref.optional, false);
        expectedEnvironment[name] = Buffer.from(source.data[ref.key], "base64").toString("utf8");
      }
      const pod = await waitFor("the exact Gateway revision Pod to be ready", async () => {
        const current = await workloadPod(
          placement,
          `app.kubernetes.io/name=${gateway},openclaw.dev/revision=${revisionId}`,
        );
        return current?.status.containerStatuses?.some(
          ({ name, ready }) => name === "gateway" && ready,
        )
          ? current
          : undefined;
      });
      const delivered = await kubectl(
        "exec",
        pod.metadata.name,
        "--namespace",
        placement,
        "--",
        "node",
        "-e",
        `const expected = ${JSON.stringify(expectedEnvironment)}; console.log(JSON.stringify(Object.fromEntries(Object.entries(expected).map(([name, value]) => [name, process.env[name] === value]))));`,
      );
      assert.deepEqual(
        JSON.parse(delivered),
        { SLACK_APP_TOKEN: true, SLACK_BOT_TOKEN: true, MSTEAMS_APP_PASSWORD: true },
        "the real Pod receives the exact bound values without credential readback in test output",
      );
      assert.equal(
        environment.find(({ name }) => name === "HTTPS_PROXY").value,
        `http://${driver.gatewayOutboundName(await optedIn.readRevision(namespaceId, provisioned.agentId, revisionId))}.${placement}.svc:3128`,
      );
      assert.equal(environment.find(({ name }) => name === "NODE_USE_ENV_PROXY").value, "1");
      assert.ok(environment.find(({ name }) => name === "OPENAI_API_KEY").valueFrom.secretKeyRef);
      assert.ok(
        environment
          .find(({ name }) => name === "NO_PROXY")
          .value.split(",")
          .includes("127.0.0.1"),
      );
      const proxy = await resource(
        "deployment",
        driver.gatewayOutboundName(admittedRevision),
        placement,
      );
      assert.equal(
        proxy.spec.template.spec.containers[0].env?.some(
          ({ valueFrom }) => valueFrom?.secretKeyRef,
        ) ?? false,
        false,
      );
      const proxyPolicy = await resource(
        "configmap",
        driver.gatewayOutboundName(admittedRevision),
        placement,
      );
      const policy = JSON.parse(Object.values(proxyPolicy.data)[0]);
      assert.equal(policy.mode, "restricted");
      assert.deepEqual(
        policy.destinations.map(({ host }) => host).sort(),
        [
          ...new Set(
            admittedRevision.gatewayOutbound.requirements.flatMap(({ destinations }) =>
              destinations.map(({ host }) => host),
            ),
          ),
        ].sort(),
      );
      assert.equal(
        (await resources("deployments", placement)).filter(
          ({ metadata }) => metadata.labels?.["openclaw.dev/agent"] === provisioned.agentId,
        ).length,
        2,
        "embedded has one combined OpenClaw workload and a credential-free outbound proxy",
      );
      const callback = await resource("httproute", callbackName, placement);
      assert.equal(callback.metadata.annotations["openclaw.dev/agent-revision-id"], revisionId);
      const callbackService = await resource("service", callbackName, placement);
      assert.equal(callbackService.spec.selector["openclaw.dev/revision"], revisionId);
      assert.equal(callback.spec.rules[0].backendRefs[0].name, callbackService.metadata.name);
      assert.deepEqual(callback.spec.rules[0].matches, [
        { method: "POST", path: { type: "Exact", value: `${agentPath}/channels/msteams` } },
      ]);
      assert.equal(
        callback.spec.rules[0].filters[1].requestHeaderModifier.remove.includes("authorization"),
        false,
      );
    };
    await assertServing(provisioned.revisionId);
    const candidate = await optedIn.request("POST", `${agentPath}/deploy`);
    assert.equal(candidate.status, 202, JSON.stringify(candidate.body));
    await waitFor(
      "embedded revision replacement",
      async () =>
        (await optedIn.request("GET", agentPath)).data.activeRevisionId === candidate.data.id,
    );
    await assertServing(candidate.data.id);
    // An older worker cleanup cannot remove a replacement's native callback.
    const privateRevision = await optedIn.readRevision(
      namespaceId,
      provisioned.agentId,
      provisioned.revisionId,
    );
    assert.equal(privateRevision.harness.id, "openclaw");
    assert.equal(privateRevision.harness.mode, "embedded");
    await driver.stopRevision(privateRevision);
    await assertServing(candidate.data.id);
    // Disabling Teams is a normal Configuration/redeployment operation. The other
    // channel stays active while only this callback and its credentials disappear.
    const configurationPath = `/namespaces/${namespaceId}/configurations/${provisioned.configurationId}`;
    const disabled = await optedIn.request("PATCH", configurationPath, {
      values: { ...values, channels: { ...values.channels, msteams: { enabled: false } } },
      secretBindings: {
        SLACK_APP_TOKEN: secretBindings.SLACK_APP_TOKEN,
        SLACK_BOT_TOKEN: secretBindings.SLACK_BOT_TOKEN,
      },
    });
    assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
    const disabledRevision = await optedIn.request("POST", `${agentPath}/deploy`);
    assert.equal(disabledRevision.status, 202, JSON.stringify(disabledRevision.body));
    await waitFor(
      "Teams disablement cutover",
      async () =>
        (await optedIn.request("GET", agentPath)).data.activeRevisionId ===
        disabledRevision.data.id,
    );
    await waitForReconciledRevision(disabledRevision.data.id);
    // The active pointer is committed before resource reconciliation finishes.
    // Wait for actual callback withdrawal, not only the API's selected revision.
    await waitFor("disabled Teams callback resources to be withdrawn", async () =>
      (
        await Promise.all(
          ["httproute", "service", "securitypolicy", "networkpolicy"].map((kind) =>
            missing(kind, callbackName, placement),
          ),
        )
      ).every(Boolean),
    );
    const disabledGateway = await resource("deployment", gateway, placement);
    assert.equal(
      disabledGateway.spec.template.spec.containers[0].env.some(
        ({ name }) => name === "MSTEAMS_APP_PASSWORD",
      ),
      false,
    );
    const slackOnly = await optedIn.readRevision(
      namespaceId,
      provisioned.agentId,
      disabledRevision.data.id,
    );
    assert.deepEqual(
      slackOnly.gatewayOutbound.requirements.map(({ source }) => source),
      ["slack"],
    );
    const teamsOnlyValues = {
      ...values,
      channels: { ...values.channels, slack: { enabled: false } },
    };
    const teamsOnlySaved = await optedIn.request("PATCH", configurationPath, {
      values: teamsOnlyValues,
      secretBindings: { MSTEAMS_APP_PASSWORD: secretBindings.MSTEAMS_APP_PASSWORD },
    });
    assert.equal(teamsOnlySaved.status, 200, JSON.stringify(teamsOnlySaved.body));
    const teamsOnlyDeployed = await optedIn.request("POST", `${agentPath}/deploy`);
    assert.equal(teamsOnlyDeployed.status, 202, JSON.stringify(teamsOnlyDeployed.body));
    await waitFor(
      "Teams-only embedded cutover",
      async () =>
        (await optedIn.request("GET", agentPath)).data.activeRevisionId ===
        teamsOnlyDeployed.data.id,
    );
    await waitForReconciledRevision(teamsOnlyDeployed.data.id);
    const teamsOnly = await optedIn.readRevision(
      namespaceId,
      provisioned.agentId,
      teamsOnlyDeployed.data.id,
    );
    assert.deepEqual(
      teamsOnly.gatewayOutbound.requirements.map(({ source }) => source),
      ["msteams"],
    );
    const teamsGateway = await resource("deployment", gateway, placement);
    assert.equal(
      teamsGateway.spec.template.spec.containers[0].env.some(
        ({ name }) => name === "SLACK_BOT_TOKEN" || name === "SLACK_APP_TOKEN",
      ),
      false,
    );
    assert.equal(
      (await resource("httproute", callbackName, placement)).metadata.annotations[
        "openclaw.dev/agent-revision-id"
      ],
      teamsOnly.id,
    );
    assert.deepEqual(
      (
        await optedIn.readRevision(namespaceId, provisioned.agentId, provisioned.revisionId)
      ).gatewayOutbound.requirements
        .map(({ source }) => source)
        .sort(),
      ["msteams", "slack"],
    );
    const reenabled = await optedIn.request("PATCH", configurationPath, { values, secretBindings });
    assert.equal(reenabled.status, 200, JSON.stringify(reenabled.body));
    const resumed = await optedIn.request("POST", `${agentPath}/deploy`);
    assert.equal(resumed.status, 202, JSON.stringify(resumed.body));
    await waitFor(
      "Teams reenablement cutover",
      async () =>
        (await optedIn.request("GET", agentPath)).data.activeRevisionId === resumed.data.id,
    );
    await assertServing(resumed.data.id);
    // Creating a second Agent does not inherit the trial Agent's Secret grants.
    const ungranted = await optedIn.request("POST", `/namespaces/${namespaceId}/agents`, {
      name: "Ungrantable channel consumer",
      configurationId: provisioned.configurationId,
      executionMode: "embedded",
      harnessAuth: plan.harnessAuth,
    });
    assert.equal(ungranted.status, 201, JSON.stringify(ungranted.body));
    const denied = await optedIn.request(
      "POST",
      `/namespaces/${namespaceId}/agents/${ungranted.data.id}/deploy`,
    );
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(await missing("deployment", gatewayName(ungranted.data.id), placement), true);
    // Withdrawal must remain possible after the operator restores default refusal.
    await optedIn.stopWorker();
    const stopped = await stock.request("POST", `${agentPath}/stop`);
    assert.equal(stopped.status, 202, JSON.stringify(stopped.body));
    await stock.startWorker();
    await waitFor(
      "embedded channel stop",
      async () =>
        (await missing("deployment", gateway, placement)) &&
        (await missing("httproute", callbackName, placement)),
    );
    await waitFor("all embedded Agent and revision proxy workloads to stop", async () =>
      (await resources("deployments", placement)).every(
        ({ metadata }) => metadata.labels?.["openclaw.dev/agent"] !== provisioned.agentId,
      ),
    );
    for (const kind of ["service", "securitypolicy", "networkpolicy"]) {
      assert.equal(await missing(kind, callbackName, placement), true);
    }
    const deleted = await stock.request("DELETE", agentPath);
    assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
    await waitFor(
      "embedded Agent tombstone",
      async () => (await optedIn.request("GET", agentPath)).status === 404,
    );
    await stock.stopWorker();
    assert.equal(
      (await resources("secrets", placement)).filter(
        ({ metadata }) => metadata.annotations?.["openclaw.dev/secret-id"] === savedSecrets[3].id,
      ).length,
      1,
      "stopping an Agent preserves the canonical Namespace-owned Secret",
    );
  },
);

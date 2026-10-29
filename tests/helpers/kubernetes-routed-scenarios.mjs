import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SlackChannelDriver } from "../../apps/controller/src/drivers/channel/slack.ts";
import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { STOCK_GATEWAY_PROXY } from "../../apps/controller/src/drivers/egress-proxy/gateway-destinations.ts";
import { InstalledDriver } from "../../packages/occ/src/index.ts";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { conformanceKubernetesOptions } from "./kubernetes-compute.mjs";

export const tenant = {
  id: "ns_00000000-0000-4000-8000-000000000001",
  name: "Conformance tenant",
  status: "ready",
  createdAt: "2026-08-18T00:00:00.000Z",
};

export const apiKeyAuth = {
  method: "api_key",
  source: {
    kind: "secret",
    namespaceId: tenant.id,
    id: "sec_00000000-0000-4000-8000-000000000001",
  },
  secretDriverId: "kubernetes-secret",
};

export function authContext(revision, namespace = kubernetesNamespaceName(tenant.id)) {
  return {
    harnessAuth:
      revision.harnessAuth.source?.kind === "secret"
        ? {
            ...revision.harnessAuth,
            backendRef: {
              namespaceName: namespace,
              name: "occ-model-key",
              key: "value",
              uid: "model-secret-uid",
            },
          }
        : revision.harnessAuth,
  };
}

export function preparedAuth(driver, namespace, embedded = false, harnessAuth = apiKeyAuth) {
  const revision = {
    namespaceId: tenant.id,
    harness: embedded
      ? { id: "openclaw", version: "1.0.0", mode: "embedded" }
      : { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth,
    configuration: { agents: { defaults: { model: embedded ? "openai/gpt-5" : "codex/gpt-5" } } },
  };
  return driver.harnessAuthForRevision(revision, authContext(revision, namespace), {
    name: namespace,
    plane: "execution",
  });
}

export function options(overrides = {}) {
  return {
    ...conformanceKubernetesOptions({ gatewayTrustedProxyCidrs: ["10.42.0.0/16"] }),
    ...overrides,
    ...(overrides.runtime === undefined
      ? {}
      : {
          runtime: { gatewayNodeSelector: { "oce-role": "control-plane" }, ...overrides.runtime },
        }),
  };
}

export function digest(value, length = 12) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export const gatewayRouting = {
  hostname: "agents.example.internal",
  gatewayName: "oce-agent-gateways",
  gatewayNamespace: "openclaw-system",
  envoyNamespace: "envoy-gateway-system",
};

export function routedOptions(overrides = {}) {
  const configured = options();
  const { gatewayClients, ...network } = configured.network;
  return options({
    ...overrides,
    gatewayRouting: overrides.gatewayRouting ?? gatewayRouting,
    network: {
      ...network,
      ...(overrides.network ?? {}),
    },
  });
}

export function routedRevision(driver, overrides = {}) {
  const revision = {
    id: "revision-routed-1",
    executionAdmission: { version: 2, mode: "unprotected" },
    namespaceId: tenant.id,
    agentId: "agent-routed",
    revision: 1,
    configurationId: "cfg_00000000-0000-4000-8000-000000000009",
    configurationKind: "agent",
    configurationGeneration: 1,
    gatewayManagedMode: driver.options?.runtime !== undefined,
    configuration: {
      agents: { defaults: { model: "codex/gpt-5" } },
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
      },
      diagnostics: { otel: { logs: false } },
      gateway: {
        trustedProxies: ["10.42.0.0/16"],
        allowRealIpFallback: true,
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-occ-identity",
            allowUsers: ["occ-workspace-files"],
          },
          identityScopes: { "occ-workspace-files": ["operator.admin"] },
        },
      },
    },
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth: apiKeyAuth,
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-routed",
    createdAt: tenant.createdAt,
    ...overrides,
  };
  // The fixture freezes admission after its inputs are chosen. It never repairs
  // a mutated stored revision inside prepare/activate or another production call.
  return driver.gatewayProxyDriver !== undefined &&
    driver.options?.runtime !== undefined &&
    driver.options.executionCluster === undefined &&
    revision.harness.mode === "dedicated" &&
    !Object.hasOwn(overrides.compute ?? {}, "admission")
    ? admitRoutedRevision(driver, revision)
    : revision;
}

/** Real Gateway dependencies, independent of the scenario's selected Harness. */
export function createRoutedKubernetesComputeDriver(options, selection = {}) {
  const protectedOwner = selection.protectedDriver;
  const shared =
    protectedOwner?.capabilities?.includes("credential_proxy") &&
    protectedOwner.require("credential_proxy").gatewayDestinations &&
    protectedOwner.require("sandbox").gatewayProxy
      ? protectedOwner
      : undefined;
  const gatewayProxyDriver =
    selection.gatewayProxyDriver ??
    shared ??
    (options?.runtime !== undefined && options.executionCluster === undefined
      ? selectedOpenShellGatewayDriver().owner
      : undefined);
  return new KubernetesComputeDriver(options, {
    channelDrivers: [new SlackChannelDriver()],
    ...selection,
    ...(gatewayProxyDriver === undefined ? {} : { gatewayProxyDriver }),
  });
}

/** The labels an equality-only Kubernetes `labelSelector` string ("key=value,key=value") names. */
export function labelSelectorLabels(selector) {
  return Object.fromEntries(selector.split(",").map((entry) => entry.split("=")));
}

export function selectorMatches(selector, labels) {
  const labelsMatch = Object.entries(selector.matchLabels ?? {}).every(
    ([key, value]) => labels[key] === value,
  );
  const expressionsMatch = (selector.matchExpressions ?? []).every(({ key, operator, values }) => {
    if (operator === "In") {
      return labels[key] !== undefined && values.includes(labels[key]);
    }
    if (operator === "NotIn") {
      return labels[key] === undefined || !values.includes(labels[key]);
    }
    if (operator === "Exists") {
      return labels[key] !== undefined;
    }
    if (operator === "DoesNotExist") {
      return labels[key] === undefined;
    }
    assert.fail(`unsupported selector operator ${operator}`);
  });
  return labelsMatch && expressionsMatch;
}

/** Real selected capability pair; no management RPC or runtime enforcement is simulated. */
export function selectedOpenShellGatewayDriver(blockedCidrs = ["10.0.0.0/8"]) {
  const id = "openshell-gateway-fixture";
  const gatewayDestinations = {
    policyRulesPath: fileURLToPath(
      new URL("../../deploy/runtime/gateway-proxy/sandbox-policy.rego", import.meta.url),
    ),
    supervisorImage: STOCK_GATEWAY_PROXY.supervisorImage,
    relayImage: STOCK_GATEWAY_PROXY.relayImage,
    blockedCidrs,
  };
  const backend = createOpenShellBackend({
    id: "openshell-fixture-backend",
    type: "openshell",
    configuration: { serviceName: "openshell-gateway" },
    drivers: { sandbox: id, credential_proxy: id },
  });
  const sandboxOptions = {
    gateway: { workspaceMode: "operator" },
    kubernetes: {
      runtimeClassName: "openshell-sandbox",
      serviceAccount: { mode: "gatewayConfigured" },
      sandboxDataMount: { subPath: "workspace", mountPath: "/sandbox/enterprise", readOnly: false },
    },
    policy: {
      process: { runAsUser: "1000", runAsGroup: "1000" },
      networkPolicies: [
        {
          name: "inference",
          endpoints: [{ host: "api.openai.com", ports: [443] }],
          binaries: [{ path: "/usr/bin/model-client" }],
        },
      ],
    },
  };
  const sandbox = new OpenShellSandboxDriver(sandboxOptions, {
    id,
    backend,
    gatewayDestinations: { driverId: id, options: gatewayDestinations },
  });
  const proxyOptions = {
    middlewareName: "oce-authority",
    authorityScope: "execution",
    gatewayDestinations,
  };
  const proxy = new OpenShellCredentialProxyDriver(proxyOptions, { id, backend, sandbox });
  const owner = new InstalledDriver(
    {
      id,
      implementation: "openshell",
      configuration: { sandbox: sandboxOptions, credential_proxy: proxyOptions },
    },
    { capabilities: { sandbox, credential_proxy: proxy } },
  );
  return { owner, sandbox, proxy };
}

/** Snapshot actual Compute admission after the scenario has chosen all revision inputs. */
export function admitRoutedRevision(driver, revision) {
  return {
    ...revision,
    compute: { ...revision.compute, admission: driver.admitRevision(revision) },
  };
}

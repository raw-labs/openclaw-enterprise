import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";

/**
 * Construct the production Kubernetes Driver without starting clients or contacting a cluster.
 * @param {string} id
 * @param {Pick<NonNullable<ConstructorParameters<typeof KubernetesComputeDriver>[1]>,
 *   "sandboxDriver" | "credentialGatewayDriver" | "protectedDriver"> & {
 *   authentication?: import("../../apps/controller/src/drivers/compute/kubernetes/index.ts").KubernetesComputeDriverOptions["authentication"],
 *   repositoryCredentials?: boolean, gatewayRuntime?: boolean, channelRuntime?: boolean,
 *   routed?: boolean, gatewayTrustedProxyCidrs?: string[],
 *   gatewayOutbound?: NonNullable<import("../../apps/controller/src/drivers/compute/kubernetes/index.ts").KubernetesComputeDriverOptions["runtime"]>["gatewayOutbound"],
 * }} [options]
 */
export function createTestKubernetesComputeDriver(
  id,
  {
    repositoryCredentials = false,
    gatewayRuntime = false,
    // An Installation with runtime.gatewayOutbound: isolated channel credentials and a reviewed proxy.
    channelRuntime = false,
    // false: runtime storage without gateway routing or node enrollment, which dedicated Agents
    // cannot use (provisioning and deployment admission refuse them).
    routed = true,
    gatewayOutbound,
    authentication = { mode: "inCluster" },
    gatewayTrustedProxyCidrs = ["127.0.0.1/32"],
    sandboxDriver,
    credentialGatewayDriver,
    protectedDriver,
  } = {},
) {
  const resources = {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "250m", memory: "128Mi" },
  };

  // Runtime storage that dedicated Agents can use needs gateway routing, node enrollment and a
  // Gateway node selector; deployment admission refuses dedicated Agents otherwise.
  const runtime =
    repositoryCredentials || channelRuntime || gatewayRuntime || gatewayOutbound !== undefined;
  const placed = runtime && routed;
  return new KubernetesComputeDriver(
    {
      ...(placed
        ? {
            gatewayRouting: {
              hostname: "agents.example.test",
              gatewayName: "gateways",
              gatewayNamespace: "controller",
              envoyNamespace: "envoy",
            },
          }
        : {}),
      authentication,
      images: { gateway: "gateway:local", agent: "agent:local", requireImmutableDigest: false },
      resources: {
        gateway: resources,
        agent: resources,
        namespace: { quota: { pods: "10" }, containerDefaults: resources },
      },
      network: {
        dns: { namespace: "kube-system", podLabels: { app: "dns" } },
        gatewayPort: 8080,
        gatewayTrustedProxyCidrs,
        ...(placed
          ? {}
          : { gatewayClients: [{ namespace: "controller", podLabels: { app: "controller" } }] }),
        ...(repositoryCredentials
          ? {
              repositoryCredentials: {
                namespace: "controller",
                podLabels: { app: "worker" },
                port: 8443,
              },
            }
          : {}),
      },
      servicePrincipalCredentials: { mode: "disabled" },
      ...(runtime
        ? {
            runtime: {
              transportSecretPrefix: "transport",
              gatewayStorageClassName: "local-path",
              ...(placed ? { gatewayNodeSelector: { "oce-role": "control" } } : {}),
              ...(channelRuntime || gatewayOutbound !== undefined
                ? {
                    gatewayOutbound: gatewayOutbound ?? {
                      enabled: true,
                      image: "controller:local",
                      denyCidrs: ["10.0.0.0/8"],
                    },
                  }
                : {}),
            },
          }
        : {}),
    },
    {
      id,
      sandboxDriver,
      credentialGatewayDriver,
      protectedDriver,
      ...(placed ? { nodeEnrollment: {} } : {}),
    },
  );
}

// The kubeconfig selection conformance suites configure. Nothing reads the file when the
// Driver is constructed; tests that perform cluster I/O inject clients or write their own
// kubeconfig.
export const conformanceKubeconfig = Object.freeze({
  kubeconfigPath: "/tmp/openclaw-enterprise-conformance/kubeconfig",
  context: "openclaw-enterprise-local",
});

/**
 * Production-shaped Kubernetes Compute Driver options shared by the conformance suites:
 * fixture images, bounded resources and quota, kube-dns, one controller client and disabled
 * service principal credentials. Each suite states its trusted proxy range and runtime.
 */
export function conformanceKubernetesOptions({ gatewayTrustedProxyCidrs, runtime }) {
  const resources = {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "250m", memory: "128Mi" },
  };
  return {
    authentication: { mode: "kubeconfig", ...conformanceKubeconfig },
    images: {
      gateway: "openclaw-enterprise/gateway-fixture:local",
      agent: "openclaw-enterprise/agent-fixture:local",
      requireImmutableDigest: false,
    },
    resources: {
      gateway: resources,
      agent: resources,
      namespace: {
        quota: { pods: "10", "requests.cpu": "2", "requests.memory": "1Gi" },
        containerDefaults: resources,
      },
    },
    network: {
      dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
      gatewayPort: 8080,
      gatewayTrustedProxyCidrs,
      gatewayClients: [
        { namespace: "openclaw-controller", podLabels: { "app.kubernetes.io/name": "controller" } },
      ],
    },
    servicePrincipalCredentials: { mode: "disabled" },
    ...(runtime === undefined ? {} : { runtime }),
  };
}

/** Passive API storage only; the production Driver owns credential generation and admission. */
export function createKubernetesCredentialStorage() {
  const namespaces = new Map();
  const secrets = new Map();
  const notFound = () =>
    Object.assign(new Error("Fixture Kubernetes resource missing."), {
      statusCode: 404,
    });
  // Only Kubernetes transport/storage is substituted. The real Driver generates
  // credentials and validates ownership/completeness; no workload is started.
  const clients = {
    core: {
      async listNamespace({ labelSelector }) {
        const [label, value] = labelSelector.split("=");
        return {
          items: [...namespaces.values()].filter(
            ({ metadata }) => metadata.labels[label] === value,
          ),
        };
      },
      async readNamespace({ name }) {
        const value = namespaces.get(name);
        if (!value) {
          throw notFound();
        }
        return structuredClone(value);
      },
      async readNamespacedSecret({ namespace, name }) {
        const value = secrets.get(`${namespace}/${name}`);
        if (!value) {
          throw notFound();
        }
        return structuredClone(value);
      },
      async createNamespacedSecret({ namespace, body }) {
        const key = `${namespace}/${body.metadata.name}`;
        assert.equal(secrets.has(key), false);
        const { stringData, ...rest } = body;
        const saved = {
          ...structuredClone(rest),
          metadata: { ...body.metadata, uid: randomUUID() },
          data: Object.fromEntries(
            Object.entries(stringData).map(([name, value]) => [
              name,
              Buffer.from(value).toString("base64"),
            ]),
          ),
        };
        secrets.set(key, saved);
        return structuredClone(saved);
      },
    },
    apps: {
      async listNamespacedDeployment() {
        return { items: [] };
      },
    },
  };
  return { namespaces, clients };
}

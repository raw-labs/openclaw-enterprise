import { execFileSync } from "node:child_process";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";

/**
 * Construct the production Kubernetes Driver without starting clients or contacting a cluster.
 * @param {string} id
 * @param {Pick<NonNullable<ConstructorParameters<typeof KubernetesComputeDriver>[1]>,
 *   "sandboxDriver" | "credentialGatewayDriver" | "protectedDriver"> & {
 *   authentication?: import("../../apps/controller/src/drivers/compute/kubernetes/index.ts").KubernetesComputeDriverOptions["authentication"],
 *   repositoryCredentials?: boolean, gatewayRuntime?: boolean, channelRuntime?: boolean,
 *   routed?: boolean, gatewayTrustedProxyCidrs?: string[],
 * }} [options]
 */
export function createTestKubernetesComputeDriver(
  id,
  {
    repositoryCredentials = false,
    gatewayRuntime = false,
    // An Installation with runtime.channels: isolated channel credentials and a reviewed proxy.
    channelRuntime = false,
    // false: runtime storage without gateway routing or node enrollment, which dedicated Agents
    // cannot use (provisioning and deployment admission refuse them).
    routed = true,
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
  const runtime = repositoryCredentials || channelRuntime || gatewayRuntime;
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
              ...(channelRuntime ? { channels: { proxyUrl: "http://10.42.0.15:3128" } } : {}),
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

/** Fresh frozen admission input, independent of the provider's policy compiler. */
export function gatewayOutboundFixture() {
  return {
    gatewayOutbound: Object.freeze({ mode: "restricted", hosts: Object.freeze([]) }),
    gatewayOutboundAdmission: Object.freeze({
      ceiling: Object.freeze({ allowPublicHttps: false, hosts: Object.freeze([]) }),
      channelDestinations: Object.freeze([]),
    }),
  };
}

/**
 * Controlled provider dependency for Compute conformance only. Kubernetes transport and
 * provider observations are supplied; production Compute owns launch persistence,
 * routing, ownership checks and activation. This does not prove provider enforcement,
 * process startup, cluster behavior or native/model execution.
 */
export function controlledGatewayFixture({ readStatus, updateNodeBinding } = {}) {
  const calls = [];
  const launches = new Map();
  let ready = false;
  let processInstanceId = "gateway-main-1";
  const peer = {
    namespace: "openshell-system",
    podLabels: { app: "openshell-gateway" },
    address: "10.43.0.50",
    port: 8080,
  };
  const key = ({ revision, generation }) => revision.id + ":" + generation;
  const resource = ({ namespace, revision }) => ({
    namespaceName: namespace.name,
    resourceName: "controlled-gateway-" + revision.id,
    agentId: revision.agentId,
    revisionId: revision.id,
  });
  const gatewaySandbox = {
    identity: "conformance-controlled-gateway-owner-v1",
    home: "/tmp/oce-gateway-home",
    validate(requirements) {
      calls.push({ operation: "validate", requirements });
    },
    async ensureNamespace(context) {
      calls.push({ operation: "ensureNamespace", context });
    },
    async provision(context) {
      calls.push({ operation: "provision", context });
      launches.set(key(context), context);
      return resource(context);
    },
    async observe(context) {
      calls.push({ operation: "observe", context });
      return launches.has(key(context))
        ? {
            state: "present",
            resource: resource(context),
            instanceId: "gateway-instance-1",
            networkPeer: {
              namespace: context.namespace.name,
              podLabels: { "fixture.gateway-instance": "gateway-instance-1" },
            },
            ...(ready ? { mainProcessInstanceId: processInstanceId } : {}),
          }
        : { state: "absent" };
    },
    async status(context) {
      calls.push({ operation: "status", context });
      return { state: ready ? "ready" : "starting" };
    },
    async endpoint(context) {
      calls.push({ operation: "endpoint", context });
      return {
        url: "https://provider.openshell.localhost:8080/",
        authority: "tenant--gateway.openshell.localhost",
        tls: { caBundle: controlledGatewayPublicCa() },
      };
    },
    async readStatus(context, path) {
      calls.push({ operation: "readStatus", context, path });
      return readStatus === undefined
        ? { revisionId: context.revision.id, container: "gateway", podUid: "gateway-instance-1" }
        : readStatus(context, path);
    },
    async updateNodeBinding(context, binding) {
      calls.push({ operation: "updateNodeBinding", context, binding });
      await updateNodeBinding?.(context, binding);
    },
    async stop(context) {
      calls.push({ operation: "stop", context });
      launches.delete(key(context));
    },
    async cleanup(context) {
      calls.push({ operation: "cleanup", context });
      launches.delete(key(context));
    },
  };
  return {
    peer,
    calls,
    launches,
    selection: {
      gatewaySandbox,
      gatewayIngress: { keyId: "conformance-ingress", publicKeyPem: "conformance-public-key" },
      gatewayOutboundPolicyCeiling: { allowPublicHttps: false, hosts: [] },
    },
    setReady(value = true) {
      ready = value;
    },
    setProcessInstanceId(value) {
      processInstanceId = value;
    },
  };
}

let gatewayPublicCa;
function controlledGatewayPublicCa() {
  gatewayPublicCa ??= execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      "/dev/null",
      "-subj",
      "/CN=Compute provider fixture CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return gatewayPublicCa;
}

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type {
  AgentRevision,
  GatewayProxyAttachmentContext,
} from "../../packages/contracts/src/index.ts";
import {
  openShellGatewayDestinations,
  STOCK_GATEWAY_PROXY,
} from "../../apps/controller/src/drivers/egress-proxy/gateway-destinations.ts";
import { openShellGatewayProxyAttachment } from "../../apps/controller/src/drivers/sandbox/gateway-proxy-attachment.ts";
import { validateExplicitK3dLoopbackContext } from "../helpers/kubernetes-real.mjs";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const { KubeConfig, KubernetesObjectApi } = require("@kubernetes/client-node");
const execute = promisify(execFile);
const selection = {
  kubeconfigPath: process.env.OCC_TEST_KUBERNETES_KUBECONFIG,
  kubernetesContext: process.env.OCC_TEST_KUBERNETES_CONTEXT,
};
const selected = Object.values(selection).some(Boolean);

test(
  "real Kubernetes Gateway proxy preserves ingress peers and refuses altered policy",
  {
    skip: selected ? false : "Select an explicit disposable k3d kubeconfig and context.",
    timeout: 300_000,
  },
  async (t) => {
    await validateExplicitK3dLoopbackContext(selection);
    const kubeconfig = new KubeConfig();
    kubeconfig.loadFromFile(selection.kubeconfigPath);
    kubeconfig.setCurrentContext(selection.kubernetesContext);
    const api = KubernetesObjectApi.makeApiClient(kubeconfig);
    const namespaceName = "gateway-proxy-" + randomUUID().slice(0, 8);
    const kubectl = async (...args: string[]) =>
      (
        await execute(
          "kubectl",
          [
            "--kubeconfig",
            selection.kubeconfigPath!,
            "--context",
            selection.kubernetesContext!,
            ...args,
          ],
          { timeout: 90_000 },
        )
      ).stdout;
    // Own only this namespace; cleanup also runs after a failed create or policy assertion.
    t.after(async () => {
      await kubectl(
        "delete",
        "namespace",
        namespaceName,
        "--ignore-not-found=true",
        "--timeout=60s",
      );
    });
    await api.create({ apiVersion: "v1", kind: "Namespace", metadata: { name: namespaceName } });
    const namespaceId = "ns_" + randomUUID();
    const revision: AgentRevision = {
      id: "rev_" + randomUUID(),
      namespaceId,
      agentId: "agt_" + randomUUID(),
      revision: 1,
      backendId: "openshell",
      configurationId: "cfg_" + randomUUID(),
      configurationKind: "agent",
      configurationGeneration: 1,
      configuration: {},
      gatewayManagedMode: true,
      harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
      harnessAuth: {
        method: "api_key",
        source: { kind: "secret", namespaceId, id: "sec_" + randomUUID() },
        secretDriverId: "kubernetes",
      },
      executionAdmission: { version: 2, mode: "unprotected" },
      compute: { id: "kubernetes", implementation: "kubernetes-local" },
      servicePrincipalId: "principal_" + randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const options = {
      policyRulesPath: resolve("deploy/runtime/gateway-proxy/sandbox-policy.rego"),
      supervisorImage: STOCK_GATEWAY_PROXY.supervisorImage,
      relayImage: STOCK_GATEWAY_PROXY.relayImage,
      blockedCidrs: ["10.0.0.0/8"],
    };
    const plan = openShellGatewayDestinations(options, "proxy", "sandbox").admit(revision, [
      { host: "clawhub.ai", port: 443 },
    ]);
    const context: GatewayProxyAttachmentContext = {
      kubernetes: api,
      namespace: {
        id: namespaceId,
        name: namespaceName,
        status: "ready",
        createdAt: revision.createdAt,
      },
      revision,
      namespaceName,
      dnsPeer: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
      signal: AbortSignal.timeout(240_000),
    };
    const attachment = openShellGatewayProxyAttachment(options, "proxy", "sandbox");
    // Exercise the real create response and a subsequent read: the SDK must not erase ingress.from.
    // Attachment readiness is deliberately not required by this API regression; traffic is separate proof.
    await attachment.prepare(context, plan);
    const policy = JSON.parse(
      await kubectl(
        "-n",
        namespaceName,
        "get",
        "networkpolicy",
        plan.endpoint.serviceName,
        "-o",
        "json",
      ),
    );
    assert.deepEqual(policy.spec.ingress, [
      {
        from: [
          {
            namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": namespaceName } },
            podSelector: {
              matchLabels: {
                ...plan.endpoint.podLabels,
                "openclaw.dev/network-profile": "gateway-destinations-v1",
                "openclaw.dev/workload-role": "gateway",
              },
            },
          },
        ],
        ports: [{ protocol: "TCP", port: 3129 }],
      },
    ]);
    await attachment.prepare(context, plan);
    // An all-peer ingress edit must still be detected; normalizing SDK aliases must not broaden trust.
    await kubectl(
      "-n",
      namespaceName,
      "patch",
      "networkpolicy",
      plan.endpoint.serviceName,
      "--type=json",
      "-p",
      JSON.stringify([
        { op: "replace", path: "/spec/ingress/0/from", value: [{ podSelector: {} }] },
      ]),
    );
    await assert.rejects(attachment.prepare(context, plan), /Gateway proxy network policy changed/);

    const runtimeImage = process.env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE;
    if (runtimeImage === undefined) {
      t.diagnostic(
        "API round-trip and tamper proof only; select the cached Gateway image for live traffic.",
      );
      return;
    }
    // Restore the deliberately altered fixture before testing the original admitted policy.
    await kubectl(
      "-n",
      namespaceName,
      "patch",
      "networkpolicy",
      plan.endpoint.serviceName,
      "--type=json",
      "-p",
      JSON.stringify([{ op: "replace", path: "/spec/ingress", value: policy.spec.ingress }]),
    );
    let ready = false;
    for (let attempt = 0; attempt < 90 && !ready; attempt++) {
      ready = await attachment.prepare(context, plan);
      if (!ready) {
        await delay(1000);
      }
    }
    assert.equal(
      ready,
      true,
      "the exact stock proxy, private TLS directory and relay must be ready",
    );
    const gatewayLabels = policy.spec.ingress[0].from[0].podSelector.matchLabels;
    // Real native clients exercise the attachment boundary. These Pods are not a deployed Agent
    // and intentionally have no model credentials or Compute-generated Gateway egress policies.
    for (const [name, labels] of [
      ["client", gatewayLabels],
      ["foreign", { proof: "foreign" }],
    ] as const) {
      await api.create({
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name, namespace: namespaceName, labels },
        spec: {
          automountServiceAccountToken: false,
          containers: [
            {
              name: "native",
              image: runtimeImage,
              imagePullPolicy: "Never",
              command: [
                "node",
                "-e",
                "require('node:net').createServer(s=>s.end('private-control')).listen(443,'0.0.0.0')",
              ],
            },
          ],
        },
      });
      await kubectl(
        "-n",
        namespaceName,
        "wait",
        "--for=condition=Ready",
        "pod/" + name,
        "--timeout=60s",
      );
    }
    const proxy = "http://" + plan.endpoint.serviceName + "." + namespaceName + ".svc:3129";
    const request = async (pod: string, url: string, proxied: boolean) => {
      const output = await kubectl(
        "-n",
        namespaceName,
        "exec",
        pod,
        "--",
        "env",
        "HTTP_PROXY=" + (proxied ? proxy : ""),
        "HTTPS_PROXY=" + (proxied ? proxy : ""),
        "ALL_PROXY=",
        "NO_PROXY=",
        "NODE_USE_ENV_PROXY=1",
        "node",
        "--input-type=module",
        "-e",
        "try{const r=await fetch(" +
          JSON.stringify(url) +
          ",{signal:AbortSignal.timeout(5000)});console.log(JSON.stringify({status:r.status,bytes:(await r.text()).length}))}catch(e){console.log(JSON.stringify({error:e.name}))}",
      );
      return JSON.parse(output);
    };
    // Independent direct reachability controls distinguish CNI denial from an unavailable upstream.
    assert.equal((await request("foreign", "https://clawhub.ai", false)).status, 200);
    const allowed = await request("client", "https://clawhub.ai", true);
    assert.equal(allowed.status, 200);
    assert.ok(allowed.bytes > 0);
    assert.ok((await request("client", "https://example.org", true)).error);
    assert.ok((await request("foreign", "https://clawhub.ai", true)).error);
    const clients = JSON.parse(await kubectl("-n", namespaceName, "get", "pods", "-o", "json"));
    const privateAddress = clients.items.find(
      (pod: { metadata: { name: string } }) => pod.metadata.name === "foreign",
    ).status.podIP;
    const connected = await kubectl(
      "-n",
      namespaceName,
      "exec",
      "client",
      "--",
      "node",
      "-e",
      "const s=require('node:net').connect(443," +
        JSON.stringify(privateAddress) +
        ");s.setTimeout(4000);s.on('connect',()=>{console.log('connected');s.destroy()});s.on('error',()=>process.exit(2));s.on('timeout',()=>process.exit(3))",
    );
    assert.match(connected, /connected/);
    const proxyPod = clients.items.find(
      (pod: { metadata: { labels?: Record<string, string> } }) =>
        pod.metadata.labels?.["openclaw.dev/network-profile"] === "destination-proxy-v1",
    ).metadata.name;
    await assert.rejects(
      kubectl(
        "-n",
        namespaceName,
        "exec",
        proxyPod,
        "-c",
        "relay",
        "--",
        "nc",
        "-z",
        "-w",
        "4",
        privateAddress,
        "443",
      ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === 1,
    );
    let removed = false;
    for (let attempt = 0; attempt < 90 && !removed; attempt++) {
      removed = await attachment.remove(context, plan);
      if (!removed) {
        await delay(500);
      }
    }
    assert.equal(removed, true);
    assert.ok((await request("client", "https://clawhub.ai", true)).error);
    t.diagnostic(
      "Live stock attachment ready; allowed HTTPS, denied host, foreign peer, private egress and removal passed. No Agent/worker or Gateway direct-egress proof.",
    );
  },
);

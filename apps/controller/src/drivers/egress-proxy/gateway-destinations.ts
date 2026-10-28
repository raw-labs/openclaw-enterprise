import { readFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import type {
  AgentRevision,
  GatewayDestination,
  GatewayDestinationControl,
  GatewayDestinationPlan,
} from "@openclaw-enterprise/contracts";
import { immutableCopy, sha256Hex } from "@openclaw-enterprise/utils";

export const STOCK_GATEWAY_PROXY = Object.freeze({
  revision: "bdb956f2cd65a635f1294fccf1d138d263bf650f",
  attachmentVersion: 1,
  supervisorDigests: [
    "fabcd01f656e9d23df4386f82e80b4f48b90f3452d7d5c58889007643a069161",
    "07cc8b62b34a0b54a3ebeb485cebe9f223cffe10dad819af550849cf0699816f",
    "650c791fb00320561612a892e86c5d23d8cfd30a16d07dc530ee57e6bcbbbb6b",
  ],
  relayDigests: [
    "beb4a68d9e4fe6b0f21ea774a0fde6c31f580dde6368939ed70100c5385b015e",
    "2d83bdac2858b4bcfa57d478ce53ae3c18a1147a68db4f610454a2d60e5c19bc",
    "fc6a9f04d63c655e56a7fcbcf2a23b4476ec07b22390e2d4a096a940135192cd",
  ],
  policyRulesHash: "f60349dcfe8f42ff6c6957fd860cbfc1aef536c6f22740025c6771745f637c38",
  supervisorImage:
    "ghcr.io/nvidia/openshell/supervisor:0.1.5@sha256:fabcd01f656e9d23df4386f82e80b4f48b90f3452d7d5c58889007643a069161",
  relayImage:
    "alpine/socat:1.8.0.3@sha256:beb4a68d9e4fe6b0f21ea774a0fde6c31f580dde6368939ed70100c5385b015e",
});

export interface OpenShellGatewayDestinationsOptions {
  readonly policyRulesPath: string;
  readonly supervisorImage: string;
  readonly relayImage: string;
  /** Include actual cluster Service, Pod, node, control-plane and metadata ranges. */
  readonly blockedCidrs: readonly string[];
}

export function gatewayDestinationsOptions(input: unknown): OpenShellGatewayDestinationsOptions {
  const value = input as OpenShellGatewayDestinationsOptions | undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !["policyRulesPath", "supervisorImage", "relayImage", "blockedCidrs"].includes(key),
    ) ||
    typeof value.policyRulesPath !== "string" ||
    !value.policyRulesPath.startsWith("/") ||
    value.supervisorImage !== STOCK_GATEWAY_PROXY.supervisorImage ||
    value.relayImage !== STOCK_GATEWAY_PROXY.relayImage ||
    !Array.isArray(value.blockedCidrs) ||
    value.blockedCidrs.length === 0 ||
    value.blockedCidrs.some(
      (cidr) =>
        typeof cidr !== "string" ||
        !isIPv4(cidr.split("/")[0]!) ||
        !/^\d{1,3}(?:\.\d{1,3}){3}\/(?:[0-9]|[12][0-9]|3[0-2])$/.test(cidr),
    )
  ) {
    throw new Error("Invalid stock OpenShell Gateway destination proxy configuration.");
  }
  return immutableCopy(value);
}

export function gatewayProxyAssets(options: OpenShellGatewayDestinationsOptions) {
  const checked = gatewayDestinationsOptions(options);
  const rules = readFileSync(checked.policyRulesPath, "utf8");
  if (sha256Hex(rules) !== STOCK_GATEWAY_PROXY.policyRulesHash) {
    throw new Error("Gateway proxy requires the unchanged pinned stock OpenShell policy rules.");
  }
  return {
    options: checked,
    rules,
    attachmentDigest: sha256Hex(
      JSON.stringify({
        ...STOCK_GATEWAY_PROXY,
        blockedCidrs: [...checked.blockedCidrs].sort(),
        profile: "destination-proxy-v1",
        listener: "127.0.0.1:3128",
        relayPort: 3129,
      }),
    ),
  };
}

function canonicalHost(host: string): boolean {
  const dns = host.startsWith("*.") ? host.slice(2) : host;
  return (
    host.length <= 253 &&
    dns.includes(".") &&
    dns.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    !/^[0-9.]+$/.test(dns) &&
    !["localhost", "local", "internal", "test", "invalid"].some(
      (suffix) => dns === suffix || dns.endsWith("." + suffix),
    )
  );
}

/** Pure endpoint permission. It does not create a credential source or execution receipt. */
export function openShellGatewayDestinations(
  options: OpenShellGatewayDestinationsOptions,
  driverId: string,
  sandboxDriverId: string,
): GatewayDestinationControl {
  const assets = gatewayProxyAssets(options);
  return Object.freeze({
    admit(
      revision: Readonly<AgentRevision>,
      input: readonly GatewayDestination[],
    ): GatewayDestinationPlan {
      if (
        revision.sandboxDriverId !== sandboxDriverId ||
        input.length > 128 ||
        input.some((item: GatewayDestination) => item.port !== 443 || !canonicalHost(item.host))
      ) {
        throw new Error(
          "Gateway destinations require the selected Sandbox and canonical DNS hosts on TCP 443.",
        );
      }
      const destinations = [
        ...new Map(
          input.map((item) => [item.host, { host: item.host, port: 443 as const }]),
        ).values(),
      ].sort((a, b) => a.host.localeCompare(b.host));
      const policy = JSON.stringify({
        version: 1,
        network_policies: Object.fromEntries(
          destinations.map((item, index) => [
            "gateway-destination-" + index,
            {
              name: "gateway-destination-" + index,
              endpoints: [{ host: item.host, ports: [443], tls: "skip" }],
              binaries: [],
            },
          ]),
        ),
      });
      const labels = {
        "openclaw.dev/namespace": revision.namespaceId,
        "openclaw.dev/agent": revision.agentId,
        "openclaw.dev/revision": revision.id,
        "openclaw.dev/network-profile": "destination-proxy-v1",
      };
      return immutableCopy({
        version: 1,
        driverId,
        sandboxDriverId,
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        destinations,
        policy,
        policyHash: sha256Hex(policy),
        attachmentDigest: assets.attachmentDigest,
        endpoint: {
          serviceName: "gateway-proxy-" + sha256Hex(revision.id, 20),
          port: 3129,
          podLabels: labels,
        },
      });
    },
  });
}

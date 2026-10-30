import { readFileSync } from "node:fs";
import { GATEWAY_PROXY_NONPUBLIC_CIDRS } from "../kubernetes/gateway-proxy-network.ts";
import type {
  AgentRevision,
  GatewayDestination,
  GatewayDestinationControl,
  GatewayDestinationPlan,
} from "@openclaw-enterprise/contracts";
import { immutableCopy, sha256Hex } from "@openclaw-enterprise/utils";

import {
  STOCK_GATEWAY_PROXY,
  gatewayDestinationsOptions,
  type OpenShellGatewayDestinationsOptions,
} from "./gateway-destinations-configuration.ts";

export {
  STOCK_GATEWAY_PROXY,
  gatewayDestinationsOptions,
} from "./gateway-destinations-configuration.ts";
export type { OpenShellGatewayDestinationsOptions } from "./gateway-destinations-configuration.ts";

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
        input.length > 128 ||
        input.some((item: GatewayDestination) => item.port !== 443 || !canonicalHost(item.host))
      ) {
        throw new Error("Gateway destinations require canonical DNS hosts on TCP 443.");
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
        egress: {
          addressFamily: "ipv4" as const,
          excludedCidrs: [
            ...new Set([...GATEWAY_PROXY_NONPUBLIC_CIDRS, ...assets.options.blockedCidrs]),
          ].sort(),
        },
        endpoint: {
          serviceName: "gateway-proxy-" + sha256Hex(revision.id, 20),
          port: 3129,
          podLabels: labels,
        },
      });
    },
  });
}

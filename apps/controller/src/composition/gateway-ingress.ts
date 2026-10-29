import { createPrivateKey, createPublicKey } from "node:crypto";
import { lstat } from "node:fs/promises";
import type { AgentRevision } from "@openclaw-enterprise/contracts";
import type { GatewayIngressSigningTarget } from "../gateway/contained-ingress.ts";
import { readProtectedFile } from "./repository-credentials/protected-file.ts";

export interface GatewayIngressConfiguration {
  readonly keyId: string;
  readonly privateKeyPath: string;
}

/** Controller custody only. Compute and the native workload receive the public half. */
export interface GatewayIngressAuthority {
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly privateKeyPem: string;
}

export async function loadGatewayIngressAuthority(
  configuration: GatewayIngressConfiguration,
): Promise<GatewayIngressAuthority> {
  // A Secret mounted with subPath is a regular root-owned 0440 file. Its
  // container group may read it; neither group writers nor other users may.
  const input = await readProtectedFile(configuration.privateKeyPath, 16 * 1024, false);
  if (!input.ok) {
    throw new Error(
      "gatewaySandbox.ingress.privateKeyPath must identify a protected regular key file.",
    );
  }
  try {
    const metadata = await lstat(configuration.privateKeyPath);
    if ((metadata.mode & 0o007) !== 0 || metadata.isSymbolicLink()) {
      throw new Error("invalid-key-permissions");
    }
    const key = createPrivateKey(input.bytes);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error("invalid-key");
    }
    return Object.freeze({
      keyId: configuration.keyId,
      publicKeyPem: createPublicKey(key).export({ type: "spki", format: "pem" }).toString(),
      privateKeyPem: key.export({ type: "pkcs8", format: "pem" }).toString(),
    });
  } catch {
    throw new Error("gatewaySandbox.ingress.privateKeyPath must contain an Ed25519 private key.");
  } finally {
    input.bytes.fill(0);
  }
}

export function gatewayIngressTarget(
  authority: GatewayIngressAuthority | undefined,
  revision: Readonly<AgentRevision>,
  endpoint: string,
): GatewayIngressSigningTarget | undefined {
  if (revision.harness.mode === "embedded") {
    return undefined;
  }
  if (authority === undefined) {
    throw new Error("Dedicated Gateway ingress signing authority is unavailable.");
  }
  const url = new URL(endpoint);
  if (
    !["https:", "wss:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Contained Gateway ingress requires an admitted secure endpoint.");
  }
  return {
    keyId: authority.keyId,
    privateKeyPem: authority.privateKeyPem,
    audience: "urn:oce:gateway:" + revision.agentId + ":" + revision.id,
    pathPrefix: url.pathname,
  };
}

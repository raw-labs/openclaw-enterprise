import { createHash, createPrivateKey, randomUUID, sign, type KeyObject } from "node:crypto";
import type { GatewayClientOptions } from "@openclaw/gateway-client";

export const GATEWAY_INGRESS_HEADER = "x-oce-ingress";
export const GATEWAY_INGRESS_BODY_LIMIT = 25 * 1024 * 1024;

/** Controller-owned signing material. Never project this object into the Gateway. */
export interface GatewayIngressSigningTarget {
  readonly audience: string;
  readonly keyId: string;
  readonly privateKeyPem: string;
  /** Exact routing prefix removed before the native listener sees the request. */
  readonly pathPrefix: string;
}

export interface GatewayIngressRequest {
  readonly method: string;
  readonly path: string;
  readonly origin?: string | undefined;
  readonly websocketKey?: string | undefined;
  readonly clientInstanceId?: string;
  readonly body?: Uint8Array;
  readonly contentType?: string | undefined;
  readonly contentEncoding?: string | undefined;
}

const keys = new Map<string, KeyObject>();

function signingKey(pem: string): KeyObject {
  const existing = keys.get(pem);
  if (existing !== undefined) {
    return existing;
  }
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Contained Gateway ingress requires an Ed25519 signing key.");
  }
  // Key rotation must not retain unbounded private material in this process.
  if (keys.size >= 4) {
    keys.clear();
  }
  keys.set(pem, key);
  return key;
}

export function nativeIngressPath(target: GatewayIngressSigningTarget, path: string): string {
  const prefix = target.pathPrefix.endsWith("/")
    ? target.pathPrefix.slice(0, -1)
    : target.pathPrefix;
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("#")) {
    throw new Error("Invalid contained Gateway request path.");
  }
  if (prefix === "") {
    return path;
  }
  if (path === prefix || path.startsWith(prefix + "?")) {
    return "/" + path.slice(prefix.length);
  }
  if (!path.startsWith(prefix + "/")) {
    throw new Error("Contained Gateway request is outside its admitted route.");
  }
  return path.slice(prefix.length);
}

/** The fixed algorithm and signed request facts are shared with the native runtime patch. */
export function signGatewayIngress(
  target: GatewayIngressSigningTarget,
  request: GatewayIngressRequest,
): string {
  const issuedAt = Date.now();
  const body = request.body ?? new Uint8Array();
  if (body.byteLength > GATEWAY_INGRESS_BODY_LIMIT) {
    throw new Error("Contained Gateway request body exceeds its size limit.");
  }
  if (
    !target.audience ||
    !target.keyId ||
    target.audience.length > 1024 ||
    target.keyId.length > 128
  ) {
    throw new Error("Contained Gateway ingress requires an audience and signing key ID.");
  }
  if (request.websocketKey !== undefined && request.clientInstanceId !== undefined) {
    throw new Error("Contained Gateway WebSocket request has ambiguous client binding.");
  }
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      keyId: target.keyId,
      audience: target.audience,
      identity: "occ-workspace-files",
      issuedAt,
      expiresAt: issuedAt + 30_000,
      nonce: randomUUID(),
      method: request.method,
      path: nativeIngressPath(target, request.path),
      origin: request.origin ?? "",
      websocketKey: request.websocketKey ?? "",
      clientInstanceId: request.clientInstanceId ?? "",
      contentType: request.contentType ?? "",
      contentEncoding: request.contentEncoding ?? "",
      bodySha256: createHash("sha256").update(body).digest("hex"),
    }),
  ).toString("base64url");
  return (
    payload +
    "." +
    sign(null, Buffer.from(payload), signingKey(target.privateKeyPem)).toString("base64url")
  );
}

/** GatewayClient snapshots headers only when opening each socket, after beforeConnect. */
export function gatewayIngressClientOptions(
  target: GatewayIngressSigningTarget | undefined,
  url: string,
  apiKey: string,
): Pick<GatewayClientOptions, "edgeAuthHeaders" | "instanceId" | "hostDeps"> {
  const headers: Record<string, string> = { "x-api-key": apiKey };
  if (target === undefined) {
    return { edgeAuthHeaders: headers };
  }
  const instanceId = randomUUID();
  const endpoint = new URL(url);
  return {
    instanceId,
    edgeAuthHeaders: headers,
    hostDeps: {
      // Reconnects need a fresh nonce and timestamp; a static proof would replay or expire.
      beforeConnect: () => {
        headers[GATEWAY_INGRESS_HEADER] = signGatewayIngress(target, {
          method: "GET",
          path: endpoint.pathname + endpoint.search,
          clientInstanceId: instanceId,
        });
      },
    },
  };
}

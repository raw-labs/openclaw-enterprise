#!/usr/bin/env node
import { open } from "node:fs/promises";

// Runtime-delivered settings are independent of repository-controlled external.config.
// No control-plane credential may be redirected by a checkout's Crabbox configuration.
function refuse(message) {
  process.stdout.write(JSON.stringify({ protocolVersion: 1, error: message }) + "\n");
  process.exitCode = 1;
}

async function bounded(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) {
      throw new Error("Input exceeds the permitted size");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let request;
  try {
    request = JSON.parse(await bounded(process.stdin, 1024 * 1024));
  } catch {
    return refuse("Expected one bounded JSON request");
  }
  if (request?.protocolVersion !== 1 || typeof request.operation !== "string") {
    return refuse("Expected protocolVersion 1");
  }
  // TODO(RFC-0019): Add operations only with durable admission/reconciliation. Never
  // acknowledge release or cleanup until provider absence has been confirmed.
  if (request.operation !== "doctor") {
    return refuse(
      "Temporary environment lifecycle is not implemented; no resource was allocated or released",
    );
  }
  let endpoint;
  try {
    endpoint = new URL(process.env.OCC_WORKLOAD_URL);
  } catch {
    return refuse("OCC_WORKLOAD_URL is invalid");
  }
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.protocol !== "https:" &&
      !(
        endpoint.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
      ))
  ) {
    return refuse("OCC_WORKLOAD_URL requires HTTPS (HTTP is allowed only on loopback)");
  }
  const namespaceId = process.env.OCC_WORKLOAD_NAMESPACE_ID;
  const agentId = process.env.OCC_WORKLOAD_AGENT_ID;
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  if (
    !new RegExp("^ns_" + uuid + "$", "u").test(namespaceId ?? "") ||
    !new RegExp("^agt_" + uuid + "$", "u").test(agentId ?? "")
  ) {
    return refuse("Runtime Agent scope is missing or invalid");
  }
  let token;
  try {
    const file = await open(process.env.OCC_WORKLOAD_TOKEN_FILE, "r");
    try {
      if (!(await file.stat()).isFile()) {
        return refuse("Workload credential is not a regular file");
      }
      const buffer = Buffer.alloc(16385);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      token = buffer.subarray(0, bytesRead).toString("utf8").trim();
      if (bytesRead > 16384 || !/^[A-Za-z0-9._~-]+$/u.test(token)) {
        return refuse("Workload credential is invalid");
      }
    } finally {
      await file.close();
    }
  } catch {
    return refuse("Workload credential is unavailable");
  }
  endpoint.pathname =
    endpoint.pathname.replace(/\/$/u, "") +
    "/namespaces/" +
    namespaceId +
    "/agents/" +
    agentId +
    "/temporary-environments/readiness";
  let response;
  try {
    response = await fetch(endpoint, {
      headers: { authorization: "Bearer " + token },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return refuse("OCC workload readiness request failed");
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    return refuse("OCC workload readiness refused (HTTP " + response.status + ")");
  }
  let body;
  try {
    body = JSON.parse(await bounded(response.body, 65536));
  } catch {
    return refuse("Invalid OCC readiness response");
  }
  if (
    body?.data?.supported === false &&
    body.data.reason === "TEMPORARY_ENVIRONMENT_LIFECYCLE_NOT_IMPLEMENTED"
  ) {
    return refuse(
      "Agent workload authentication and authorization succeeded; temporary environment lifecycle is not implemented",
    );
  }
  return refuse("Unsupported OCC readiness response");
}

await main().catch(() => refuse("External provider request failed"));

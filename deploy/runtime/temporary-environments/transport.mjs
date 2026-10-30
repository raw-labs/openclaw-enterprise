import { constants } from "node:fs";
import { open, lstat, mkdtemp, link, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export async function bounded(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) {
      throw new Error("JSON exceeds the permitted size");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function runtime() {
  let endpoint;
  try {
    endpoint = new URL(process.env.OCC_WORKLOAD_URL);
  } catch {
    throw new Error("OCC_WORKLOAD_URL is invalid");
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
    throw new Error("OCC_WORKLOAD_URL requires HTTPS (HTTP is allowed only on loopback)");
  }
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const namespace = process.env.OCC_WORKLOAD_NAMESPACE_ID;
  const agent = process.env.OCC_WORKLOAD_AGENT_ID;
  if (
    !new RegExp("^ns_" + uuid + "$", "u").test(namespace ?? "") ||
    !new RegExp("^agt_" + uuid + "$", "u").test(agent ?? "")
  ) {
    throw new Error("Runtime Agent scope is missing or invalid");
  }
  endpoint.pathname =
    endpoint.pathname.replace(/\/$/u, "") +
    "/namespaces/" +
    namespace +
    "/agents/" +
    agent +
    "/temporary-environments";
  return {
    endpoint,
    key: process.env.OCC_WORKLOAD_SSH_KEY_FILE,
    profile: process.env.OCC_WORKLOAD_TEMPORARY_PROFILE,
  };
}

export async function request(runtime, suffix, method, body, signal) {
  let token;
  try {
    // Projected token symlinks rotate. Open afresh for every request, including polls.
    const file = await open(process.env.OCC_WORKLOAD_TOKEN_FILE, "r");
    try {
      if (!(await file.stat()).isFile()) {
        throw new Error();
      }
      const buffer = Buffer.alloc(16385);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      token = buffer.subarray(0, bytesRead).toString("utf8").trim();
      if (bytesRead > 16384 || !/^[A-Za-z0-9._~-]+$/u.test(token)) {
        throw new Error();
      }
    } finally {
      await file.close();
    }
  } catch {
    throw new Error("Workload credential is unavailable or invalid");
  }
  const endpoint = new URL(runtime.endpoint);
  endpoint.pathname += suffix;
  try {
    const response = await fetch(endpoint, {
      method,
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    if (![200, 202].includes(response.status)) {
      await response.body?.cancel();
      throw new Error("OCC request refused (HTTP " + response.status + ")");
    }
    return JSON.parse(await bounded(response.body, 1024 * 1024)).data;
  } catch (error) {
    if (error.message.startsWith("OCC request refused")) {
      throw error;
    }
    throw new Error("OCC workload request failed");
  }
}

export async function sshKey(path, create, signal) {
  if (!path || !isAbsolute(path)) {
    throw new Error("Trusted absolute SSH key path is required");
  }
  const directory = dirname(path);
  // Every parent must be a real directory, never a checkout-controlled symlink.
  let parent = directory;
  while (true) {
    const stat = await lstat(parent);
    if (!stat.isDirectory() || (stat.mode & 0o022) !== 0) {
      throw new Error("SSH key parent must be a protected directory");
    }
    if (parent === dirname(parent)) {
      break;
    }
    parent = dirname(parent);
  }
  if (create) {
    try {
      await lstat(path);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      const temporary = await mkdtemp(join(directory, ".ssh-key-"));
      try {
        const generated = join(temporary, "identity");
        await run(
          "/usr/bin/ssh-keygen",
          ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", generated],
          {
            signal,
            timeout: 15000,
            maxBuffer: 16384,
          },
        );
        // Atomic no-replace publication: concurrent invocations use the winner's key.
        try {
          await link(generated, path);
        } catch (failure) {
          if (failure.code !== "EEXIST") {
            throw failure;
          }
        }
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid() ||
      stat.size > 16384
    ) {
      throw new Error("SSH key must be an owner-only regular file");
    }
  } finally {
    await file.close();
  }
  try {
    const { stdout } = await run("/usr/bin/ssh-keygen", ["-y", "-f", path], {
      signal,
      timeout: 15000,
      maxBuffer: 16384,
    });
    const key = stdout.trim().split(/\s+/u).slice(0, 2).join(" ");
    if (!/^ssh-ed25519 [A-Za-z0-9+/]{68}$/u.test(key)) {
      throw new Error();
    }
    return key;
  } catch {
    throw new Error("SSH key must be an unencrypted Ed25519 identity");
  }
}

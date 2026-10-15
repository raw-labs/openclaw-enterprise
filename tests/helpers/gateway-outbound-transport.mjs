import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Only DNS answers and the numeric upstream connection are redirected. Policy,
// CONNECT handling, TLS and the native SDK remain real in the selected image.
export async function startControlledOutboundProxy(t, { upstreamPort, upstreamHosts, approvedHosts }) {
  const directory = await mkdtemp(join(tmpdir(), "oce-outbound-transport-"));
  const preload = join(directory, "routing.mjs");
  const policy = join(directory, "policy.json");
  await writeFile(policy, JSON.stringify({
    mode: "restricted",
    destinations: approvedHosts.map((host) => ({ host, includeSubdomains: false })),
    denyCidrs: [],
  }));
  await writeFile(preload, `import dns from "node:dns/promises";
import net from "node:net";
const hosts = new Set(${JSON.stringify(upstreamHosts)});
dns.lookup = async (host, options) => {
  if (!hosts.has(host) || options?.all !== true) throw new Error("Unexpected fixture DNS lookup");
  return [{ address: "93.184.216.34", family: 4 }];
};
const connect = net.connect;
net.connect = (options, ...args) => {
  if (options.host !== "93.184.216.34" || options.family !== 4 || options.port !== 443) {
    throw new Error("Unexpected fixture upstream connection");
  }
  return connect({ ...options, host: "127.0.0.1", port: ${upstreamPort} }, ...args);
};
`);
  const child = spawn(process.execPath, [
    "--import", preload,
    fileURLToPath(new URL("../../apps/controller/src/gateway/outbound-proxy.mjs", import.meta.url)),
  ], {
    env: { ...process.env, OCC_OUTBOUND_PROXY_POLICY_PATH: policy,
      OCC_OUTBOUND_PROXY_HOST: "127.0.0.1", OCC_OUTBOUND_PROXY_PORT: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
    await rm(directory, { recursive: true, force: true });
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  let timer;
  const port = await new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Proxy readiness timed out: ${stderr}`)), 30_000);
    child.once("error", reject);
    closed.then(() => reject(new Error(`Proxy exited before readiness: ${stderr}`)), reject);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = /"event":"outbound_proxy.listening","port":([0-9]+)/.exec(stderr);
      if (match) resolve(Number(match[1]));
    });
  }).finally(() => clearTimeout(timer));
  assert.ok(port > 0);
  return { port };
}

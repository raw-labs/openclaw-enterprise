import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { reservedPortArgs, reservePort } from "./available-port.mjs";
import { temporaryDirectory } from "./temporary-directory.mjs";

/**
 * Starts the bundled Slack proxy (apps/controller/src/gateway/outbound-proxy.mjs) as a child process and
 * resolves once it logs the port it bound. By default OCC_OUTBOUND_PROXY_PORT is 0; with
 * `fixedPort` the helper holds a free port with reservePort() until the proxy has bound it,
 * passes it, and requires the proxy to bind exactly that port. Without SO_REUSEPORT the
 * reservation holds nothing and another process can take the port first, so EADDRINUSE picks
 * again. The test's cleanup sends the proxy SIGTERM. With `upstreamPort`, the child resolves
 * each of `upstreamHosts` (default slack.com) to a public fixture address and its pinned numeric connections on
 * port 443 reach that loopback port instead; a connection to any other host throws in the child,
 * `dnsAnswers` can override responses with public/private addresses, failure or pending.
 * A test can never reach the network. Returns the child, the listening port and `stderr()`,
 * what the proxy has written so far.
 */
export async function startSlackProxy(
  t,
  {
    fixedPort = false,
    upstreamPort,
    upstreamHosts = ["slack.com"],
    dnsAnswers = {},
    destinations,
    expectStartupFailure = false,
  } = {},
) {
  const preload =
    upstreamPort === undefined
      ? []
      : ["--import", await writeDnsFixture(t, upstreamPort, upstreamHosts, dnsAnswers)];
  for (let attempt = 1; ; attempt += 1) {
    const reservation = fixedPort ? await reservePort({ host: "0.0.0.0" }) : undefined;
    const port = reservation?.port ?? 0;
    const proxy = await spawnSlackProxy(
      t,
      [...(reservation ? reservedPortArgs(reservation) : []), ...preload],
      port,
      destinations,
    ).finally(() => reservation?.release());
    if (expectStartupFailure) {
      assert.equal(proxy.port, undefined, "invalid proxy configuration must fail before listening");
      return proxy;
    }
    if (proxy.port === undefined && fixedPort && attempt < 5 && /EADDRINUSE/.test(proxy.stderr())) {
      continue;
    }
    if (proxy.port === undefined) {
      throw new Error(`Slack proxy exited before listening: ${proxy.stderr()}`);
    }
    if (fixedPort) {
      assert.equal(proxy.port, port, "the proxy listens on OCC_OUTBOUND_PROXY_PORT");
    }
    return proxy;
  }
}

async function spawnSlackProxy(t, preload, port, destinations) {
  const directory = await temporaryDirectory(t, "oce-outbound-transport-");
  const policyPath = join(directory, "policy.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      mode: "restricted",
      destinations: (destinations ?? ["slack.com", "slack-edge.com", "slack-msgs.com"]).map(
        (host) => ({
          host,
          includeSubdomains: destinations === undefined,
        }),
      ),
      denyCidrs: [],
    }),
  );
  const child = spawn(
    process.execPath,
    [...preload, "apps/controller/src/gateway/outbound-proxy.mjs"],
    {
      cwd: new URL("../../", import.meta.url),
      env: {
        ...process.env,
        OCC_OUTBOUND_PROXY_PORT: String(port),
        OCC_OUTBOUND_PROXY_POLICY_PATH: policyPath,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  t.after(() => child.kill());
  let stderr = "";
  child.stderr.setEncoding("utf8");
  let timer;
  const listening = await new Promise((resolve, reject) => {
    // Generous: a CPU-starved runner can take seconds just to load the proxy.
    timer = setTimeout(() => reject(new Error(`Slack proxy did not start: ${stderr}`)), 30_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = /"event":"outbound_proxy.listening","port":(\d+)/.exec(stderr);
      if (match !== null) {
        resolve(Number(match[1]));
      }
    });
    // Undefined: the proxy exited before it listened. "close" waits for the rest of stderr,
    // which the EADDRINUSE retry reads.
    child.once("close", () => resolve(undefined));
  }).finally(() => clearTimeout(timer));
  return { child, port: listening, stderr: () => stderr };
}

async function writeDnsFixture(t, upstreamPort, upstreamHosts, dnsAnswers) {
  const directory = await temporaryDirectory(t, "openclaw-slack-proxy-test-");
  const path = join(directory, "dns-fixture.mjs");
  await writeFile(
    path,
    `import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
const upstreamHosts = new Set(${JSON.stringify(upstreamHosts)});
const answers = ${JSON.stringify(dnsAnswers)};
const publicAddress = "93.184.216.34";
const originalLookup = dns.lookup;
dns.lookup = async (hostname, options) => {
  if (!upstreamHosts.has(hostname)) { return originalLookup(hostname, options); }
  const answer = answers[hostname];
  if (answer === "pending") { return new Promise(() => {}); }
  if (answer === "failure") { throw Object.assign(new Error("fixture DNS failure"), {code: "ENOTFOUND"}); }
  return answer ?? [{ address: publicAddress, family: 4 }];
};
syncBuiltinESMExports();
import net from "node:net";
const originalConnect = net.connect;
net.connect = (...args) => {
  if ((upstreamHosts.has(args[0]?.host) || args[0]?.host === "93.184.216.34") && args[0]?.port === 443) {
    return originalConnect({ ...args[0], host: "127.0.0.1", port: ${upstreamPort} }, ...args.slice(1));
  }
  if (typeof args[0]?.host === "string") {
    throw new Error(\`test fixture refuses a connection to \${args[0].host}:\${args[0].port}\`);
  }
  return originalConnect(...args);
};
`,
  );
  return path;
}

/** Sends `CONNECT target` to the proxy on `port` and returns its response head. */
export async function connectThroughProxy(port, target) {
  return requestThroughProxy(port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
}

/** Writes raw `request` bytes to the proxy on `port` and returns its response head. */
export async function requestThroughProxy(port, request) {
  const socket = net.connect({ host: "127.0.0.1", port });
  let response = "";
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("proxy response timeout")), 15_000);
      const finish = () => {
        clearTimeout(timeout);
        resolve();
      };
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write(request);
      });
      socket.on("data", (chunk) => {
        response += chunk;
        if (response.includes("\r\n\r\n")) {
          finish();
        }
      });
      socket.once("end", finish);
    });
    return response;
  } finally {
    socket.destroy();
  }
}

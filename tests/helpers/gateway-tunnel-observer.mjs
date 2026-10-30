import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import net from "node:net";
import tls from "node:tls";
import { join } from "node:path";
import { availablePort } from "./available-port.mjs";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const WebSocket = createRequire(require.resolve("@kubernetes/client-node"))("ws");

// Only the observer terminates TLS. The relay copies bytes through the actual
// Gateway network namespace and its projected proxy; it adds no network grants.
export async function observeGatewayTunnel(f, agent, endpoint) {
  const pod = await f.pod(agent, "gateway");
  const base = [
    "--kubeconfig",
    join(f.stateDirectory, "kubeconfig"),
    "--context",
    "k3d-" + f.cluster,
    "-n",
    pod.metadata.namespace,
  ];
  const children = [];
  let raw;
  let secure;
  let socket;
  let remotePid;
  let closedAt = null;
  let echoes = 0;
  let failure;
  let closing = false;
  let heartbeats;
  const pending = new Map();
  f.resources.after(async () => {
    closing = true;
    clearInterval(heartbeats);
    socket?.terminate();
    secure?.destroy();
    raw?.destroy();
    // A live peer still owns a relay. Kill only our marked remote process.
    let cleanupError;
    try {
      if (remotePid && children[0]?.exitCode === null) {
        await f.kubectl(
          ...base.slice(4),
          "exec",
          pod.metadata.name,
          "-c",
          "gateway",
          "--",
          "node",
          "-e",
          "const fs=require('node:fs');const p=Number(process.argv[1]);try{if(fs.readFileSync('/proc/'+p+'/cmdline','utf8').includes('GATEWAY_OBSERVER_READY'))process.kill(p,'SIGTERM')}catch{}",
          String(remotePid),
        );
      }
    } catch (error) {
      cleanupError = error;
    }
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        try {
          await exited;
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    if (cleanupError) {
      throw cleanupError;
    }
  });
  async function start(args, marker) {
    const child = spawn("kubectl", [...base, ...args], {
      env: f.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    let error;
    child.on("error", (value) => {
      error = value;
    });
    child.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-4096);
    });
    child.stderr.on("data", () => {});
    await f.waitFor(
      "Gateway observer process readiness",
      () => {
        if (error) {
          throw error;
        }
        assert.equal(child.exitCode, null, "observer subprocess exited");
        return output.includes(marker);
      },
      30_000,
      { interval: 100 },
    );
    return output;
  }
  const relay =
    "import net from 'node:net';const p=new URL(process.env.HTTPS_PROXY??process.env.HTTP_PROXY);net.createServer(c=>{const s=net.connect({host:p.hostname,port:Number(p.port)});c.pipe(s).pipe(c);s.on('error',()=>c.destroy());c.on('error',()=>s.destroy());c.on('close',()=>s.destroy());s.on('close',()=>c.destroy());}).listen(18980,'127.0.0.1',()=>console.log('GATEWAY_OBSERVER_READY:'+process.pid));";
  const ready = await start(
    ["exec", pod.metadata.name, "-c", "gateway", "--", "node", "--input-type=module", "-e", relay],
    "GATEWAY_OBSERVER_READY:",
  );
  remotePid = Number(ready.match(/GATEWAY_OBSERVER_READY:([0-9]+)/)[1]);
  const port = await availablePort();
  await start(
    ["port-forward", "--address", "127.0.0.1", "pod/" + pod.metadata.name, port + ":18980"],
    "Forwarding from",
  );
  const url = new URL(endpoint);
  raw = net.connect({ host: "127.0.0.1", port });
  raw.on("error", (error) => {
    failure = error;
  });
  await once(raw, "connect", { signal: AbortSignal.timeout(15_000) });
  const connected = new Promise((resolve, reject) => {
    let header = "";
    const timer = setTimeout(() => {
      raw.destroy();
      reject(new Error("CONNECT timeout"));
    }, 15_000);
    const data = (chunk) => {
      header += chunk;
      if (!header.includes("\r\n\r\n")) {
        return;
      }
      raw.off("data", data);
      clearTimeout(timer);
      if (header.startsWith("HTTP/1.1 200 ") || header.startsWith("HTTP/1.0 200 ")) {
        resolve();
      } else {
        reject(new Error("Gateway CONNECT refused"));
      }
    };
    raw.on("data", data);
  });
  raw.write("CONNECT " + url.hostname + ":443 HTTP/1.1\r\nHost: " + url.hostname + ":443\r\n\r\n");
  await connected;
  secure = tls.connect({ socket: raw, servername: url.hostname, rejectUnauthorized: true });
  secure.on("error", (error) => {
    failure = error;
  });
  await once(secure, "secureConnect", { signal: AbortSignal.timeout(15_000) });
  assert.equal(secure.authorized, true);
  socket = new WebSocket(endpoint, {
    createConnection: () => secure,
    handshakeTimeout: 15_000,
    perMessageDeflate: false,
  });
  socket.on("error", (error) => {
    failure = error;
  });
  socket.on("close", () => {
    closedAt = Date.now();
  });
  socket.on("message", (data) => {
    pending.get(data.toString())?.();
  });
  await once(socket, "open", { signal: AbortSignal.timeout(15_000) });
  async function echo() {
    assert.ifError(failure);
    assert.equal(closedAt, null, "upstream tunnel closed prematurely");
    const marker = "gateway-" + randomUUID();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(marker);
        reject(new Error("upstream echo timeout"));
      }, 10_000);
      pending.set(marker, () => {
        clearTimeout(timer);
        pending.delete(marker);
        echoes++;
        resolve();
      });
      socket.send(marker);
    });
  }
  // Keep real traffic flowing during long deployment/model calls. An idle-server
  // timeout must not masquerade as lifecycle withdrawal or peer disruption.
  let sending = false;
  heartbeats = setInterval(() => {
    if (closing || sending || closedAt !== null) {
      return;
    }
    sending = true;
    echo()
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        sending = false;
      });
  }, 2000);
  return {
    echo,
    get closedAt() {
      return closedAt;
    },
    get echoes() {
      return echoes;
    },
  };
}

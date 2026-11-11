import { createServer } from "node:http";
import dns from "node:dns";
import net from "node:net";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 3128;
const CONNECT_TIMEOUT_MS = 10_000;
const SHUTDOWN_DRAIN_MS = 2_000;
// How long a client may take to read what is still queued for it, and close its side, after
// the proxy has finished writing to it.
const CLIENT_DRAIN_TIMEOUT_MS = 10_000;
const ALLOWED_SUFFIXES = [".slack.com", ".slack-edge.com", ".slack-msgs.com"];
const ALLOWED_HOSTS = new Set(["slack.com", "slack-edge.com", "slack-msgs.com"]);
// Public-cloud text messaging only: no broad Microsoft or SharePoint wildcard.
const TEAMS_HOSTS = new Set([
  "login.microsoftonline.com",
  "login.botframework.com",
  "api.botframework.com",
  "smba.trafficmanager.net",
  "graph.microsoft.com",
]);
const teamsEnabled = process.env.OCC_CHANNEL_PROXY_TEAMS_ENABLED === "true";
if (
  process.env.OCC_CHANNEL_PROXY_TEAMS_ENABLED !== undefined &&
  !["true", "false"].includes(process.env.OCC_CHANNEL_PROXY_TEAMS_ENABLED)
) {
  throw new Error("OCC_CHANNEL_PROXY_TEAMS_ENABLED must be true or false.");
}
const TEAMS_FILE_HOST_SUFFIXES = [
  ".sharepoint.com",
  ".sharepoint-df.com",
  ".1drv.com",
  ".onedrive.com",
  ".blob.core.windows.net",
];
const teamsFileHosts = readTeamsFileHosts(process.env.OCC_CHANNEL_PROXY_TEAMS_FILE_HOSTS);
// Match the Helm proxy's public IPv4 egress boundary. Validate every DNS answer before
// opening a socket, then connect to that numeric address so DNS cannot change underneath it.
const blockedAddresses = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  blockedAddresses.addSubnet(address, prefix, "ipv4");
}

function readTeamsFileHosts(value) {
  if (value === undefined) {
    return new Set();
  }
  let hosts;
  try {
    hosts = JSON.parse(value);
  } catch {
    throw new Error(
      "OCC_CHANNEL_PROXY_TEAMS_FILE_HOSTS must be a JSON list of exact Microsoft storage hostnames.",
    );
  }
  if (
    !Array.isArray(hosts) ||
    hosts.length > 32 ||
    (!teamsEnabled && hosts.length > 0) ||
    hosts.some(
      (host) =>
        typeof host !== "string" ||
        host.length > 253 ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ||
        !TEAMS_FILE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)),
    )
  ) {
    throw new Error(
      "OCC_CHANNEL_PROXY_TEAMS_FILE_HOSTS requires Teams and at most 32 exact lowercase Microsoft storage hostnames.",
    );
  }
  return new Set(hosts);
}

function parsePort(value) {
  if (value === undefined || value === "") {
    return DEFAULT_PORT;
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new Error("OCC_SLACK_PROXY_PORT must be an integer TCP port.");
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("OCC_SLACK_PROXY_PORT must be between 0 and 65535.");
  }
  return port;
}

function parseConnectTarget(target) {
  const match = /^([A-Za-z0-9.-]+):([0-9]+)$/.exec(target ?? "");
  if (match === null) {
    return undefined;
  }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  return { host: match[1].toLowerCase(), port };
}

function isAllowedSlackConnectTarget(target) {
  const parsed = parseConnectTarget(target);
  if (parsed === undefined || parsed.port !== 443) {
    return false;
  }
  return (
    ALLOWED_HOSTS.has(parsed.host) ||
    (teamsEnabled && (TEAMS_HOSTS.has(parsed.host) || teamsFileHosts.has(parsed.host))) ||
    ALLOWED_SUFFIXES.some((suffix) => parsed.host.endsWith(suffix))
  );
}

function closeOnSocketError(socket) {
  let closing = false;
  socket.on("error", () => {
    if (closing) {
      return;
    }
    closing = true;
    socket.destroy();
  });
}

function reject(socket, statusCode, message) {
  socket.end(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
}

// Closes a client socket now. If bytes are still queued for it, reset the connection instead
// of sending a FIN, so the client cannot take a cut reply as whole. With nothing queued, every
// byte is already with the kernel (a shutdown may still be in flight, when a reset would fail
// and leak the handle), so a plain close is right.
function cutClient(socket) {
  if (socket.writableLength > 0) {
    socket.resetAndDestroy();
    return;
  }
  socket.destroy();
}

// Called once the proxy is done writing to the client: the upstream closed, or a CONNECT was
// refused. When the client's write side was already ended (pipe() ends it on the upstream's
// clean EOF; reject() ends it with the status line), bytes can still be queued for a slow
// client, and destroy() would drop them. Even after they are flushed, a close with unread
// client bytes (a TLS close_notify, say) makes the kernel reset the connection and drop the
// tail. So linger: discard what the client sends, keep the socket until the client has read
// everything and closed its side, and cut it at `drainTimeoutMs`. Anything else (an upstream
// close with no EOF) still closes the client now. The native admin WebSocket relay
// (gateway/native-admin-proxy.ts) has its own copy: this file runs standalone, with no imports.
function closeClientWhenDrained(clientSocket, drainTimeoutMs) {
  if (clientSocket.destroyed) {
    return;
  }
  if (!clientSocket.writableEnded) {
    cutClient(clientSocket);
    return;
  }
  clientSocket.resume();
  const timer = setTimeout(() => cutClient(clientSocket), drainTimeoutMs);
  timer.unref();
  clientSocket.once("close", () => clearTimeout(timer));
}

export function createSlackProxyServer({ clientDrainTimeoutMs = CLIENT_DRAIN_TIMEOUT_MS } = {}) {
  const server = createServer((request, response) => {
    response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    response.end("CONNECT required\n");
  });

  server.on("connect", (request, clientSocket, head) => {
    // Attach this before reject(). A refused CONNECT that resets emits
    // EPIPE or ECONNRESET while the 403 is written; without a listener
    // that error exits the process.
    closeOnSocketError(clientSocket);
    if (!isAllowedSlackConnectTarget(request.url)) {
      reject(clientSocket, 403, "Forbidden");
      closeClientWhenDrained(clientSocket, clientDrainTimeoutMs);
      return;
    }
    const target = parseConnectTarget(request.url);
    let upstream;
    let connected = false;
    let finished = false;
    // One deadline covers resolution and connection; a late resolver callback cannot
    // create an upstream after timeout, client disconnect, or process shutdown.
    const timer = setTimeout(() => fail(502, "Bad Gateway"), CONNECT_TIMEOUT_MS);
    const finish = () => {
      finished = true;
      clearTimeout(timer);
    };
    const fail = (status, message) => {
      if (finished) {
        return;
      }
      finish();
      upstream?.destroy();
      if (!clientSocket.destroyed) {
        reject(clientSocket, status, message);
        closeClientWhenDrained(clientSocket, clientDrainTimeoutMs);
      }
    };
    clientSocket.once("close", () => {
      finish();
      upstream?.destroy();
    });
    clientSocket.once("error", () => {
      finish();
      upstream?.destroy();
    });
    dns.lookup(target.host, { family: 4, all: true, verbatim: true }, (error, addresses) => {
      if (finished) {
        return;
      }
      if (error || addresses.length === 0) {
        fail(502, "Bad Gateway");
        return;
      }
      if (
        addresses.some(
          ({ address, family }) =>
            family !== 4 || net.isIP(address) !== 4 || blockedAddresses.check(address, "ipv4"),
        )
      ) {
        fail(403, "Forbidden");
        return;
      }
      upstream = net.connect({ host: addresses[0].address, family: 4, port: target.port });
      upstream.once("connect", () => {
        connected = true;
        finish();
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) {
          upstream.write(head);
        }
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.once("error", () => {
        if (connected) {
          // Before the upstream's EOF, the reply is cut: reset, so the client cannot take it as
          // whole. After it (a client byte piped into the ended upstream, say), the reply is
          // complete and the close handler lets the client drain it.
          if (!clientSocket.destroyed && !clientSocket.writableEnded) {
            clientSocket.resetAndDestroy();
          }
          return;
        }
        fail(502, "Bad Gateway");
      });
      upstream.once("close", () => {
        if (connected) {
          closeClientWhenDrained(clientSocket, clientDrainTimeoutMs);
        }
      });
    });
  });

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = parsePort(process.env.OCC_SLACK_PROXY_PORT);
  const server = createSlackProxyServer();
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  // The proxy runs as PID 1 in its Pod, where the kernel drops a SIGTERM that has no
  // handler; the Pod would then wait out its termination grace for SIGKILL. Stop
  // listening at once and give short Web API calls a moment to finish. Tunnels are
  // long-lived Socket Mode connections that never drain, so then close them: Slack
  // clients reconnect through the Service to a ready replacement.
  const shutdown = () => {
    server.close();
    const destroyAll = setTimeout(() => {
      for (const socket of sockets) {
        socket.destroy();
      }
    }, SHUTDOWN_DRAIN_MS);
    destroyAll.unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  server.listen(port, "0.0.0.0", () => {
    const address = server.address();
    const selectedPort = typeof address === "object" && address !== null ? address.port : port;
    process.stderr.write(`Slack proxy listening on ${selectedPort}\n`);
  });
}

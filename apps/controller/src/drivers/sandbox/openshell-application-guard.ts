export const APPLICATION_TRANSPORT_ENVIRONMENT = "OCE_APPLICATION_TRANSPORT_TOKEN";
export const APPLICATION_TRANSPORT_HEADER = "x-oce-application-transport";

export interface OpenShellApplicationGuardOptions {
  readonly command: readonly string[];
  readonly args: readonly string[];
  readonly environmentPath: string;
  readonly readyPath: string;
  readonly generation: string;
  readonly gatewayPort: number;
  readonly statusPort: number;
  readonly guardGatewayPort?: number;
  readonly guardStatusPort?: number;
}

/** Authenticate the private service hop before trusting the proxy identity it carries. */
export function createApplicationGuardProgram(options: OpenShellApplicationGuardOptions): string {
  const configuration = {
    ...options,
    guardGatewayPort: options.guardGatewayPort ?? options.gatewayPort + 1_000,
    guardStatusPort: options.guardStatusPort ?? options.statusPort + 1_000,
    tokenEnvironment: APPLICATION_TRANSPORT_ENVIRONMENT,
    tokenHeader: APPLICATION_TRANSPORT_HEADER,
  };
  const ports = [
    configuration.gatewayPort,
    configuration.statusPort,
    configuration.guardGatewayPort,
    configuration.guardStatusPort,
  ];
  if (
    options.command.length === 0 ||
    options.command[0]?.trim().length === 0 ||
    [...options.command, ...options.args].some(
      (part) => typeof part !== "string" || part.includes("\0"),
    ) ||
    !options.environmentPath.startsWith("/") ||
    !options.readyPath.startsWith("/") ||
    options.generation.trim().length === 0 ||
    ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535) ||
    new Set(ports).size !== ports.length
  ) {
    throw new Error("Invalid contained application ingress configuration.");
  }
  return (
    `const configuration = ${JSON.stringify(configuration)};\n` +
    String.raw`
const {readFile} = await import('node:fs/promises');
const {setTimeout: delay} = await import('node:timers/promises');
const {timingSafeEqual} = await import('node:crypto');
const {spawn} = await import('node:child_process');
const http = await import('node:http');
const sockets = new Set();
const requests = new Set();
const servers = [];
let stopping = false;
let child;
let killTimer;
const startup = new AbortController();

function closeIngress() {
  for (const server of servers) server.close();
  for (const request of requests) request.destroy();
  for (const socket of sockets) socket.destroy();
}
function stop(signal) {
  if (stopping) return;
  stopping = true;
  startup.abort();
  closeIngress();
  if (child) {
    child.kill(signal);
    killTimer = setTimeout(() => child.kill('SIGKILL'), 10000);
    killTimer.unref();
  }
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop(signal));

async function privateEnvironment() {
  const deadline = Date.now() + 120000;
  while (!stopping) {
    try {
      const readyBytes = await readFile(configuration.readyPath);
      if (readyBytes.length > 16384) throw Error('Private application marker is oversized');
      const ready = JSON.parse(readyBytes.toString('utf8'));
      if (!ready || ready.generation !== configuration.generation ||
          typeof ready.podUid !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(ready.podUid)) {
        throw Error('Private application identity is invalid');
      }
      const bytes = await readFile(configuration.environmentPath);
      if (bytes.length > 1024 * 1024) throw Error('Private application environment is oversized');
      const environment = JSON.parse(bytes.toString('utf8'));
      if (!environment || typeof environment !== 'object' || Array.isArray(environment) ||
          Object.entries(environment).some(([name, value]) =>
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string' || value.includes('\0'))) {
        throw Error('Private application environment is invalid');
      }
      environment.OPENCLAW_POD_UID = ready.podUid;
      return environment;
    } catch (error) {
      if (error.code !== 'ENOENT' || Date.now() >= deadline) throw Error('Private application environment is unavailable');
      await delay(100, undefined, {signal: startup.signal});
    }
  }
  throw Error('Application startup was stopped');
}

try {
  const environment = await privateEnvironment();
  const token = environment[configuration.tokenEnvironment];
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,512}$/.test(token)) {
    throw Error('Private application transport is unavailable');
  }
  const expected = Buffer.from(token);
  function authorized(request) {
    let count = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index].toLowerCase() === configuration.tokenHeader) count += 1;
    }
    const value = request.headers[configuration.tokenHeader];
    if (count !== 1 || typeof value !== 'string') return false;
    const received = Buffer.from(value);
    return received.length === expected.length && timingSafeEqual(received, expected);
  }
  function validPath(request) {
    return typeof request.url === 'string' && request.url.startsWith('/') && !request.url.startsWith('//');
  }
  function upstream(request, port, upgrade) {
    const headers = {...request.headers, host: '127.0.0.1:' + port};
    delete headers[configuration.tokenHeader];
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    delete headers['keep-alive'];
    delete headers['te'];
    delete headers['trailer'];
    if (!upgrade) {
      for (const name of String(request.headers.connection || '').split(',')) {
        if (name.trim()) delete headers[name.trim().toLowerCase()];
      }
      delete headers.connection;
      delete headers.upgrade;
    }
    const outgoing = http.request({
      hostname: '127.0.0.1', port, path: request.url, method: request.method,
      headers, timeout: 30000, agent: false,
    });
    requests.add(outgoing);
    outgoing.on('close', () => requests.delete(outgoing));
    outgoing.on('timeout', () => outgoing.destroy());
    return outgoing;
  }
  function track(socket) {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  }
  async function listen(port, target, allowUpgrade) {
    if (stopping) throw Error('Application startup was stopped');
    const server = http.createServer({maxHeaderSize: 16384}, (request, response) => {
      if (!authorized(request)) {
        response.writeHead(401, {connection: 'close'}).end();
        request.resume();
        return;
      }
      if (!validPath(request)) {
        response.writeHead(400, {connection: 'close'}).end();
        request.resume();
        return;
      }
      const outgoing = upstream(request, target, false);
      outgoing.on('response', incoming => {
        response.writeHead(incoming.statusCode || 502, incoming.headers);
        incoming.on('error', () => response.destroy());
        incoming.pipe(response);
      });
      outgoing.on('error', () => {
        if (!response.headersSent) response.writeHead(503);
        response.end();
      });
      request.on('aborted', () => outgoing.destroy());
      request.on('error', () => outgoing.destroy());
      response.on('close', () => outgoing.destroy());
      request.pipe(outgoing);
    });
    server.headersTimeout = 10000;
    server.requestTimeout = 120000;
    server.keepAliveTimeout = 5000;
    server.maxHeadersCount = 100;
    server.on('connection', track);
    server.on('upgrade', (request, socket, head) => {
      if (!authorized(request)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      if (!allowUpgrade || !validPath(request) || request.method !== 'GET' ||
          String(request.headers.upgrade || '').toLowerCase() !== 'websocket') {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const outgoing = upstream(request, target, true);
      socket.on('error', () => outgoing.destroy());
      socket.on('close', () => outgoing.destroy());
      outgoing.on('error', () => socket.destroy());
      outgoing.on('response', incoming => { incoming.destroy(); socket.destroy(); });
      outgoing.on('upgrade', (response, remote, remoteHead) => {
        track(remote);
        socket.setTimeout(300000, () => socket.destroy());
        remote.setTimeout(300000, () => remote.destroy());
        socket.on('error', () => remote.destroy());
        remote.on('error', () => socket.destroy());
        socket.on('close', () => remote.destroy());
        remote.on('close', () => socket.destroy());
        let headers = 'HTTP/1.1 101 Switching Protocols\r\n';
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          headers += response.rawHeaders[index] + ': ' + response.rawHeaders[index + 1] + '\r\n';
        }
        socket.write(headers + '\r\n');
        if (remoteHead.length) socket.write(remoteHead);
        if (head.length) remote.write(head);
        socket.pipe(remote).pipe(socket);
      });
      outgoing.end();
    });
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', resolve);
    });
  }
  await listen(configuration.guardGatewayPort, configuration.gatewayPort, true);
  await listen(configuration.guardStatusPort, configuration.statusPort, false);
  if (stopping) closeIngress();
  if (!stopping) {
    const inherited = {...process.env, ...environment};
    delete inherited[configuration.tokenEnvironment];
    child = spawn(configuration.command[0], [...configuration.command.slice(1), ...configuration.args], {
      env: inherited, stdio: 'inherit',
    });
    child.on('error', () => {
      closeIngress();
      process.exitCode = 1;
    });
    child.on('exit', (code, signal) => {
      clearTimeout(killTimer);
      closeIngress();
      process.exitCode = code ?? (signal ? 1 : 0);
    });
  }
} catch {
  closeIngress();
  process.exitCode = stopping ? 0 : 1;
  if (!stopping) console.error('Contained application startup failed.');
}
`
  );
}

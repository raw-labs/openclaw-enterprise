import type {
  SandboxApplicationEndpoint,
  SandboxApplicationProcess,
  SandboxApplicationRequirements,
  SandboxApplicationRole,
  SandboxApplicationVolume,
} from "@openclaw-enterprise/contracts";
import type { V1Container, V1Deployment } from "@kubernetes/client-node";

const APPLICATION_STATUS_PORT = 18_791;

type ApplicationNetworkRequirements = Pick<
  SandboxApplicationRequirements,
  "runtimePeers" | "denyCidrs" | "generatedPublicHosts"
>;

/** Preserve prepared references without handing a provider an arbitrary Pod. */
export function applicationRequirements(
  deployment: V1Deployment,
  role: SandboxApplicationRole,
  network: Partial<ApplicationNetworkRequirements> = {},
): SandboxApplicationRequirements {
  const pod = deployment.spec?.template.spec;
  const application = pod?.containers[0];
  if (
    !pod ||
    !application ||
    pod.containers.length !== 1 ||
    !application.command?.length ||
    !deployment.metadata?.namespace ||
    !pod.serviceAccountName
  ) {
    throw new Error("Application containment requires one explicitly launched application.");
  }
  const port = application.ports?.[0]?.containerPort ?? 18_789;
  if (
    port === APPLICATION_STATUS_PORT ||
    application.ports?.some(
      ({ containerPort }) => containerPort !== port && containerPort !== APPLICATION_STATUS_PORT,
    )
  ) {
    throw new Error("Application containment does not support additional application listeners.");
  }
  const process = (container: V1Container): SandboxApplicationProcess => {
    if (
      !container.image ||
      container.envFrom?.length ||
      container.env?.some(
        (entry) =>
          entry.valueFrom &&
          !entry.valueFrom.secretKeyRef &&
          (entry.name !== "OPENCLAW_POD_UID" ||
            entry.valueFrom.fieldRef?.fieldPath !== "metadata.uid"),
      )
    ) {
      throw new Error("Application containment does not support implicit environment sources.");
    }
    return {
      name: container.name,
      image: container.image,
      command: container.command ?? [],
      args: container.args ?? [],
      environment: (container.env ?? []).map((entry) => {
        if (entry.valueFrom?.fieldRef?.fieldPath === "metadata.uid") {
          return {
            name: entry.name,
            valueFrom: { fieldRef: { fieldPath: "metadata.uid" as const } },
          };
        }
        if (entry.valueFrom?.secretKeyRef) {
          const reference = entry.valueFrom.secretKeyRef;
          if (!reference.name || !reference.key || reference.optional === true) {
            throw new Error("Application containment requires exact, mandatory Secret references.");
          }
          return {
            name: entry.name,
            valueFrom: { secretKeyRef: { name: reference.name, key: reference.key } },
          };
        }
        return { name: entry.name, value: entry.value ?? "" };
      }),
      mounts: container.volumeMounts ?? [],
      ...(container.resources ? { resources: { ...container.resources } } : {}),
    };
  };
  const volumes = (pod.volumes ?? []).map((volume): SandboxApplicationVolume => {
    if (volume.persistentVolumeClaim) {
      return { name: volume.name, persistentVolumeClaim: volume.persistentVolumeClaim };
    }
    if (volume.configMap?.name) {
      return { name: volume.name, configMap: { ...volume.configMap, name: volume.configMap.name } };
    }
    if (volume.secret?.secretName) {
      return {
        name: volume.name,
        secret: { ...volume.secret, secretName: volume.secret.secretName },
      };
    }
    if (volume.emptyDir) {
      return { name: volume.name, emptyDir: volume.emptyDir };
    }
    throw new Error("Application containment refuses an unsupported volume projection.");
  });
  if (pod.automountServiceAccountToken !== false || pod.hostNetwork || pod.hostPID || pod.hostIPC) {
    throw new Error("Application containment requires an unprivileged, token-free workload.");
  }
  return {
    ...process(application),
    role,
    volumes,
    initializers: (pod.initContainers ?? []).map(process),
    port,
    namespaceName: deployment.metadata.namespace,
    serviceAccountName: pod.serviceAccountName,
    labels: deployment.spec!.template.metadata?.labels ?? {},
    ...(pod.nodeSelector ? { nodeSelector: pod.nodeSelector } : {}),
    runtimePeers: network.runtimePeers ?? [],
    denyCidrs: network.denyCidrs ?? [],
    generatedPublicHosts: network.generatedPublicHosts ?? [],
  };
}

/** Fixed private transport only: no integration, Harness, or model credentials. */
const APPLICATION_FRONTEND = String.raw`
const http = await import('node:http');
const https = await import('node:https');
const {BlockList, isIP} = await import('node:net');
const {checkServerIdentity} = await import('node:tls');
const endpoint = JSON.parse(process.env.OCE_APPLICATION_ENDPOINT);
const dial = new URL(endpoint.connectOrigin);
const hostname = dial.hostname.replace(/^\[(.*)\]$/, '$1');
const client = dial.protocol === 'https:' ? https : http;
const token = process.env.OCE_APPLICATION_TRANSPORT_TOKEN;
const trusted = new BlockList();
for (const cidr of JSON.parse(process.env.OCE_APPLICATION_TRUSTED_PROXY_CIDRS)) {
  const [address, prefix] = cidr.split('/');
  trusted.addSubnet(address, Number(prefix), isIP(address) === 4 ? 'ipv4' : 'ipv6');
}
function identitySource(request) {
  let address = request.socket.remoteAddress || '';
  if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) address = address.slice(7);
  const family = isIP(address);
  return family !== 0 && trusted.check(address, family === 4 ? 'ipv4' : 'ipv6');
}
if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,512}$/.test(token)) {
  throw Error('Application transport is unavailable');
}
const sockets = new Set();
const requests = new Set();
const servers = [];
let stopping = false;
function track(socket) {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
}
function validPath(request) {
  return typeof request.url === 'string' && request.url.startsWith('/') && !request.url.startsWith('//');
}
function outgoing(request, origin, upgrade) {
  const headers = {...request.headers, host: origin.host};
  delete headers['x-oce-application-transport'];
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  delete headers['forwarded'];
  delete headers['x-forwarded-for'];
  // The private hop must not launder node/device callers into trusted OCE proxies.
  if (!identitySource(request)) {
    delete headers['x-occ-identity'];
    delete headers['x-real-ip'];
  }
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
  headers.host = origin.host;
  headers['x-oce-application-transport'] = token;
  const upstream = client.request({
    hostname, port: dial.port || (dial.protocol === 'https:' ? 443 : 80),
    method: request.method, path: request.url, headers, agent: false, timeout: 30000,
    ...(dial.protocol === 'https:' ? {
      ...(isIP(hostname) ? {
        servername: '',
        checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate),
      } : {servername: hostname}),
      ...(endpoint.caBundle ? {ca: endpoint.caBundle} : {}),
    } : {}),
  });
  requests.add(upstream);
  upstream.on('close', () => requests.delete(upstream));
  upstream.on('timeout', () => upstream.destroy());
  return upstream;
}
async function listen(port, originValue, allowUpgrade) {
  if (stopping) throw Error('Application transport was stopped');
  const origin = new URL(originValue);
  const server = http.createServer({maxHeaderSize: 16384}, (request, response) => {
    if (!validPath(request)) {
      response.writeHead(400, {connection: 'close'}).end();
      request.resume();
      return;
    }
    const upstream = outgoing(request, origin, false);
    upstream.on('response', incoming => {
      response.writeHead(incoming.statusCode || 502, incoming.headers);
      incoming.on('error', () => response.destroy());
      incoming.pipe(response);
    });
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(503);
      response.end();
    });
    request.on('aborted', () => upstream.destroy());
    request.on('error', () => upstream.destroy());
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 120000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 100;
  server.on('connection', track);
  server.on('upgrade', (request, socket, head) => {
    if (!allowUpgrade || !validPath(request) || request.method !== 'GET' ||
        String(request.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = outgoing(request, origin, true);
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    upstream.on('response', incoming => { incoming.destroy(); socket.destroy(); });
    upstream.on('upgrade', (response, remote, remoteHead) => {
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
    upstream.end();
  });
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
}
function close() {
  stopping = true;
  for (const server of servers) server.close();
  for (const request of requests) request.destroy();
  for (const socket of sockets) socket.destroy();
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, close);
try {
  await listen(Number(process.env.OCE_APPLICATION_PORT), endpoint.origin, true);
  await listen(Number(process.env.OCE_APPLICATION_STATUS_PORT), endpoint.statusOrigin, false);
  if (stopping) close();
} catch {
  close();
  process.exitCode = 1;
}
`;

export function applicationFrontend(
  deployment: V1Deployment,
  endpoint: SandboxApplicationEndpoint,
  trustedProxyCidrs: readonly string[],
): V1Deployment {
  for (const value of [endpoint.origin, endpoint.connectOrigin, endpoint.statusOrigin]) {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw new Error("Application transport requires credential-free, fixed HTTP origins.");
    }
  }
  if (!endpoint.transportSecretRef.name.trim() || !endpoint.transportSecretRef.key.trim()) {
    throw new Error("Application transport requires an exact revision-owned Secret reference.");
  }
  const pod = deployment.spec?.template.spec;
  const application = pod?.containers[0];
  if (!pod || !application || pod.containers.length !== 1) {
    throw new Error("Application transport requires one prepared application container.");
  }
  const port = application.ports?.[0]?.containerPort;
  if (!Number.isInteger(port) || port === APPLICATION_STATUS_PORT) {
    throw new Error("Application transport requires distinct application and status ports.");
  }
  const configuration = (pod.volumes ?? []).filter((volume) => volume.configMap !== undefined);
  const names = new Set(configuration.map(({ name }) => name));
  return {
    ...deployment,
    spec: {
      ...deployment.spec!,
      template: {
        ...deployment.spec!.template,
        spec: {
          ...pod,
          volumes: configuration,
          initContainers: [],
          containers: [
            {
              ...application,
              command: ["node"],
              args: ["--input-type=module", "-e", APPLICATION_FRONTEND],
              env: [
                { name: "OCE_APPLICATION_ENDPOINT", value: JSON.stringify(endpoint) },
                { name: "OCE_APPLICATION_PORT", value: String(port) },
                { name: "OCE_APPLICATION_STATUS_PORT", value: String(APPLICATION_STATUS_PORT) },
                {
                  name: "OCE_APPLICATION_TRUSTED_PROXY_CIDRS",
                  value: JSON.stringify(trustedProxyCidrs),
                },
                {
                  name: "OCE_APPLICATION_TRANSPORT_TOKEN",
                  valueFrom: {
                    secretKeyRef: { ...endpoint.transportSecretRef, optional: false },
                  },
                },
                ...(application.env ?? []).filter(
                  ({ name }) => name === "OPENCLAW_WORKSPACE_NODE_ID",
                ),
              ],
              ports: [
                { containerPort: port!, name: "http" },
                { containerPort: APPLICATION_STATUS_PORT, name: "plugin-status" },
              ],
              volumeMounts: (application.volumeMounts ?? []).filter(({ name }) => names.has(name)),
            },
          ],
        },
      },
    },
  };
}

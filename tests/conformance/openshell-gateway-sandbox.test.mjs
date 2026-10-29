import assert from "node:assert/strict";
import { BlockList } from "node:net";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { join } from "node:path";
import { openShellGatewayNetworkPolicy } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-policy.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const grpc = require("@grpc/grpc-js");
const loader = require("@grpc/proto-loader");

function requirements(overrides = {}) {
  return {
    outboundPolicy: { mode: "restricted", hosts: ["api.github.com"] },
    outboundAdmission: {
      ceiling: { allowPublicHttps: true, hosts: ["api.github.com"] },
      channelDestinations: [
        { host: "*.slack.com", ports: [443], protocol: "wss" },
        { host: "slack.com", ports: [443], protocol: "https" },
      ],
    },
    runtimePeers: [
      { host: "codex.tenant.svc.cluster.local", addresses: ["10.42.0.13"], ports: [18790] },
    ],
    infrastructureCidrs: ["8.8.8.0/24", "2606:4700::/32"],
    ...overrides,
  };
}
function admitted(cidrs, address) {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [host, prefix] = cidr.split("/");
    list.addSubnet(host, Number(prefix), host.includes(":") ? "ipv6" : "ipv4");
  }
  return list.check(address, address.includes(":") ? "ipv6" : "ipv4");
}

test("Gateway external rules exclude private and infrastructure answers while runtime peers keep exact pins", () => {
  const rules = openShellGatewayNetworkPolicy(requirements());
  const endpoints = rules["gateway-native"].endpoints;
  for (const endpoint of endpoints.filter((x) => x.ports.includes(443))) {
    assert.equal(endpoint.tls, "NETWORK_TLS_MODE_SKIP");
    for (const address of [
      "127.0.0.1",
      "10.42.0.13",
      "100.64.0.1",
      "169.254.169.254",
      "172.16.0.2",
      "192.168.1.1",
      "198.18.0.1",
      "8.8.8.8",
      "::1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
      "2606:4700::1",
    ]) {
      assert.equal(admitted(endpoint.allowed_ips, address), false, address);
    }
    for (const address of ["1.1.1.1", "8.8.4.4", "2606:4701::1"]) {
      assert.equal(admitted(endpoint.allowed_ips, address), true, address);
    }
  }
  assert.ok(endpoints.some((x) => x.host === "**.slack.com"));
  assert.ok(endpoints.some((x) => x.host === "slack.com"));
  const peer = endpoints.find((x) => x.ports.includes(18790));
  assert.deepEqual(peer.allowed_ips, ["10.42.0.13/32"]);
  assert.equal(admitted(peer.allowed_ips, "10.42.0.14"), false);
});

test("Gateway public HTTPS is hostless positive public-only policy and refuses overlapping private 443", () => {
  const rules = openShellGatewayNetworkPolicy(
    requirements({ outboundPolicy: { mode: "publicHttps" } }),
  );
  const universal = rules["gateway-native"].endpoints.find((x) => x.host === "");
  assert.ok(universal);
  assert.equal(admitted(universal.allowed_ips, "10.42.0.13"), false);
  assert.throws(
    () =>
      openShellGatewayNetworkPolicy(
        requirements({
          outboundPolicy: { mode: "publicHttps" },
          runtimePeers: [{ host: "runtime.tenant.svc", addresses: ["10.42.0.13"], ports: [443] }],
        }),
      ),
    /cannot combine/u,
  );
});

test("Gateway status uses duplex wire framing and bounded private native HTTP", async (t) => {
  const definition = await loader.load(
    join(
      import.meta.dirname,
      "../../apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto",
    ),
    { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
  );
  const service = grpc.loadPackageDefinition(definition).openshell.v1.OpenShell;
  const server = new grpc.Server();
  const observations = [];
  const native = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ revisionId: "revision", container: "gateway", podUid: "sandbox-instance" }),
    );
  });
  native.listen(0, "127.0.0.1");
  await once(native, "listening");
  t.after(() => native.close());
  const net = await import("node:net");
  server.addService(service.service, {
    ForwardTcp(call) {
      let socket;
      call.on("error", () => {});
      call.on("data", (frame) => {
        if (frame.init) {
          observations.push(frame.init);
          assert.equal(frame.init.tcp.host, "127.0.0.1");
          assert.equal(frame.init.tcp.port, 18791);
          socket = net.connect(native.address().port, "127.0.0.1");
          socket.on("data", (data) => call.write({ data }));
          socket.on("end", () => call.end());
          call.on("cancelled", () => socket.destroy());
        } else {
          socket.write(frame.data);
        }
      });
    },
  });
  const port = await new Promise((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, p) =>
      error ? reject(error) : resolve(p),
    ),
  );
  t.after(() => server.forceShutdown());
  const client = new GrpcOpenShellGatewayClient({
    endpoint: "http://127.0.0.1:" + port,
    auth: { mode: "unauthenticated" },
  });
  t.after(() => client.close());
  const result = await client.readGatewayStatus(
    { workspace: "tenant", name: "gateway-identity", path: "/openclaw/runtime/status" },
    AbortSignal.timeout(5000),
  );
  assert.equal(result.podUid, "sandbox-instance");
  assert.equal(observations[0].sandbox, "gateway-identity");
  assert.equal(observations[0].workspace, "tenant");
  await assert.rejects(
    client.readGatewayStatus(
      { workspace: "tenant", name: "gateway-identity", path: "/private" },
      AbortSignal.timeout(5000),
    ),
    /Unsupported/u,
  );
});

test("Gateway private forwarding retains safe authentication classification without provider text", async (t) => {
  const { gatewayIdentityRefusal } =
    await import("../../apps/controller/src/drivers/sandbox/openshell-gateway-errors.ts");
  const definition = await loader.load(
    join(
      import.meta.dirname,
      "../../apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto",
    ),
    { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
  );
  const service = grpc.loadPackageDefinition(definition).openshell.v1.OpenShell;
  const server = new grpc.Server();
  server.addService(service.service, {
    ForwardTcp(call) {
      call.on("error", () => {});
      call.emit("error", {
        code: grpc.status.UNAUTHENTICATED,
        details: "private upstream message must not escape",
      });
    },
  });
  const port = await new Promise((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (e, p) =>
      e ? reject(e) : resolve(p),
    ),
  );
  t.after(() => server.forceShutdown());
  const client = new GrpcOpenShellGatewayClient({
    endpoint: "http://127.0.0.1:" + port,
    auth: { mode: "unauthenticated" },
  });
  t.after(() => client.close());
  const request = () =>
    client.readGatewayStatus(
      { workspace: "tenant", name: "gateway-exact", path: "/readyz" },
      AbortSignal.timeout(5000),
    );
  await assert.rejects(
    request(),
    (error) => error.grpcStatus === 16 && !error.message.includes("private upstream"),
  );
  await assert.rejects(
    gatewayIdentityRefusal("tenant", "Gateway status unconfirmed")(request),
    (error) => error.code === "SANDBOX_GATEWAY_UNAUTHORIZED" && error.transient === true,
  );
});

test("Gateway capability refuses insecure provider control before any provisioning or Secret access", async (t) => {
  const { OpenShellGateway } = await import("../../apps/controller/src/backends/openshell.ts");
  const { OpenShellGatewaySandboxCapability } =
    await import("../../apps/controller/src/drivers/sandbox/openshell-gateway-sandbox.ts");
  const mtls = {
    mode: "mtls",
    certificatePath: "/protected/client.crt",
    privateKeyPath: "/protected/client.key",
  };
  const cases = [
    ["plaintext mTLS", { endpoint: "http://127.0.0.1:8080", auth: mtls }],
    ["omitted authentication", { endpoint: "https://127.0.0.1:8080" }],
    [
      "explicit anonymous",
      { endpoint: "https://127.0.0.1:8080", auth: { mode: "unauthenticated" } },
    ],
    [
      "network-policy declaration",
      { endpoint: "https://127.0.0.1:8080", auth: mtls, insecureTransport: "network-policy" },
    ],
    ["implicit plaintext Service", { serviceName: "openshell-gateway", auth: mtls }],
    [
      "relative bearer file",
      { endpoint: "https://127.0.0.1:8080", auth: { mode: "bearerTokenFile", path: "relative" } },
    ],
  ];
  for (const [name, configuration] of cases) {
    await t.test(name, async () => {
      // Backend construction remains valid for the existing Harness development mode.
      const backend = {
        id: "provider",
        client: new OpenShellGateway(configuration),
        drivers: { sandbox: "sandbox" },
      };
      const capability = new OpenShellGatewaySandboxCapability(
        {
          kubernetes: { userNamespaces: false },
          gateway: { workspaceMode: "operator" },
          policy: { process: { runAsUser: "sandbox", runAsGroup: "sandbox" } },
        },
        backend,
        () => assert.fail("namespace mutation"),
        () => assert.fail("state preparation"),
        { id: "sandbox", implementation: "openshell" },
      );
      const context = {
        requirements: {},
        signal: AbortSignal.timeout(1000),
        get kubernetes() {
          return assert.fail("Secret access");
        },
      };
      assert.throws(() => capability.validate(context.requirements), /requires HTTPS/u);
      await assert.rejects(capability.provision(context), /requires HTTPS/u);
      assert.throws(() => capability.ensureNamespace(context), /requires HTTPS/u);
      backend.client.close();
    });
  }
  for (const configuration of [
    { endpoint: "https://127.0.0.1:8080", auth: mtls },
    {
      endpoint: "https://provider.example.org:8080",
      auth: { mode: "bearerTokenFile", path: "/protected/token" },
    },
    { serviceName: "openshell-gateway", scheme: "https", auth: mtls },
  ]) {
    const backend = new OpenShellGateway(configuration);
    assert.doesNotThrow(() => backend.assertAuthenticatedGatewayTransport());
    backend.close();
  }
});

test("Gateway runtime peer pins reject numeric special-address aliases but retain exact private unicast", () => {
  const peers = (address) =>
    requirements({
      runtimePeers: [{ host: "runtime.tenant.svc", addresses: [address], ports: [18790] }],
    });
  for (const address of [
    "0.0.0.0",
    "127.1.2.3",
    "169.254.169.254",
    "224.0.0.1",
    "255.255.255.255",
    "192.0.2.10",
    "::",
    "0:0:0:0:0:0:0:0",
    "::1",
    "0:0:0:0:0:0:0:1",
    "fe80::1",
    "fe80:0:0:0:0:0:0:1",
    "febf:ffff::1",
    "ff02::1",
    "::ffff:7f00:1",
    "2001:db8::1",
  ]) {
    assert.throws(
      () => openShellGatewayNetworkPolicy(peers(address)),
      /Unsupported Gateway runtime peer/u,
      address,
    );
  }
  for (const address of [
    "10.42.0.13",
    "172.16.2.3",
    "192.168.2.3",
    "fd00::13",
    "fc00:0:0:0:0:0:0:13",
  ]) {
    const endpoint = openShellGatewayNetworkPolicy(peers(address))["gateway-native"].endpoints.find(
      (x) => x.ports.includes(18790),
    );
    assert.deepEqual(endpoint.allowed_ips, [address + "/" + (address.includes(":") ? 128 : 32)]);
  }
});

test("Gateway endpoint connects the protected control origin while preserving a distinct port-free relay authority", async () => {
  const { OpenShellGateway } = await import("../../apps/controller/src/backends/openshell.ts");
  const { OpenShellGatewaySandboxCapability } =
    await import("../../apps/controller/src/drivers/sandbox/openshell-gateway-sandbox.ts");
  let stored;
  const client = {
    async getSandbox() {
      return stored;
    },
    async createSandbox(request) {
      stored = {
        name: request.name,
        workspace: request.workspace,
        id: "sandbox-instance",
        labels: request.labels,
        annotations: request.annotations,
        spec: request.spec,
        phase: 1,
      };
      return stored;
    },
    async getService() {
      return {
        sandbox: stored.name,
        name: "",
        targetPort: 18789,
        authorizationMode: 2,
        advertisedUrl: "https://relay-tenant-gateway.openshell.example.org:8443/",
        url: "https://relay-tenant-gateway.openshell.example.org:8080/",
      };
    },
    close() {},
  };
  const gateway = new OpenShellGateway(
    {
      endpoint: "https://control.tenant.svc:8080",
      auth: { mode: "bearerTokenFile", path: "/protected/token" },
    },
    { gatewayClient: client },
  );
  const capability = new OpenShellGatewaySandboxCapability(
    {
      kubernetes: { runtimeClassName: "openshell-sandbox", userNamespaces: false },
      policy: { process: { runAsUser: "sandbox", runAsGroup: "sandbox" } },
      gateway: { workspaceMode: "operator" },
    },
    { id: "provider", client: gateway, drivers: { sandbox: "sandbox" } },
    async () => {},
    async () => {},
    { id: "sandbox", implementation: "openshell" },
  );
  const mounts = [
    ["state", "state"],
    ["client", "client"],
    ["agent", "agents/main/agent"],
    ["media", "media"],
    ["worktrees", "worktrees"],
    ["worktree-sources", "worktree-sources"],
    ["sessions", "agents/main/sessions"],
  ].map(([subPath, suffix]) => ({ subPath, mountPath: "/home/node/.openclaw/" + suffix }));
  const context = {
    namespace: { id: "namespace-id", name: "tenant" },
    revision: { id: "revision-id", namespaceId: "namespace-id", agentId: "agent-id" },
    generation: "generation-one",
    signal: AbortSignal.timeout(5000),
    requirements: requirements({
      image: "runtime@sha256:" + "a".repeat(64),
      command: ["/usr/local/bin/node", "-e", "process.exit(0)"],
      configuration: {},
      environment: [],
      files: [],
      state: {
        claimName: "gateway-private",
        stateSubPath: "private-home",
        workspaceSubPath: "workspace",
        mounts,
      },
      resources: {},
      labels: {},
    }),
  };
  // Adapter conformance only: the provider transport is fixed data, not cluster/runtime proof.
  await capability.provision(context);
  const endpoint = await capability.endpoint(context);
  assert.equal(endpoint.url, "https://control.tenant.svc:8080");
  assert.equal(endpoint.authority, "relay-tenant-gateway.openshell.example.org");
  // The external runtime opens connections from its UUID-labelled supervisor,
  // not a Compute-owned Gateway Pod or the provider control Service.
  assert.deepEqual((await capability.observe(context)).networkPeer, {
    namespace: "tenant",
    podLabels: {
      "openshell.ai/sandbox-id": "sandbox-instance",
      "openshell.ai/boundary-role": "supervisor",
    },
  });
  // A provider-reported restart while reading the safe nonce must stop before
  // Secret access or any mutating exec; after-only fencing was too late.
  stored.phase = 2;
  stored.mainProcessInstanceId = "process-before";
  stored.mainProcessStartedAt = "2026-10-29T00:00:00.000Z";
  let secretAccesses = 0;
  Object.defineProperty(context, "kubernetes", {
    get() {
      secretAccesses++;
      return assert.fail("unexpected Secret access");
    },
  });
  client.readGatewayChallenge = async () => {
    stored = { ...stored, mainProcessInstanceId: stored.mainProcessInstanceId + "-restarted" };
    return "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  };
  client.execSandbox = async () => assert.fail("unexpected mutating exec");
  await assert.rejects(capability.provision(context), /process changed while reading/u);
  await assert.rejects(
    capability.updateNodeBinding(context, {
      generation: context.generation,
      nodeId: "current-node",
    }),
    /process changed while reading/u,
  );
  assert.equal(secretAccesses, 0);
  gateway.close();
});

test("Gateway owner identity fences provider changes without coupling unrelated Harness policy", async () => {
  const { OpenShellGateway } = await import("../../apps/controller/src/backends/openshell.ts");
  const { OpenShellGatewaySandboxCapability } =
    await import("../../apps/controller/src/drivers/sandbox/openshell-gateway-sandbox.ts");
  const configuration = {
    endpoint: "https://control.tenant.svc:8080",
    auth: { mode: "bearerTokenFile", path: "/protected/token" },
  };
  const options = {
    gateway: { workspaceMode: "operator", operatorNamespaceLabels: { b: "two", a: "one" } },
    kubernetes: { runtimeClassName: "openshell-sandbox", userNamespaces: false },
    policy: { process: { runAsUser: "sandbox", runAsGroup: "sandbox" }, networkPolicies: [] },
  };
  const identity = (
    config = configuration,
    selectedOptions = options,
    id = "sandbox",
    backendId = "provider",
  ) => {
    const gateway = new OpenShellGateway(config);
    const result = new OpenShellGatewaySandboxCapability(
      selectedOptions,
      { id: backendId, client: gateway, drivers: { sandbox: id } },
      async () => {},
      async () => {},
      { id, implementation: "openshell" },
    ).identity;
    gateway.close();
    return result;
  };
  const first = identity();
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.equal(
    identity(configuration, {
      ...options,
      gateway: { ...options.gateway, operatorNamespaceLabels: { a: "one", b: "two" } },
      policy: { ...options.policy, networkPolicies: [{ name: "unrelated-harness-rule" }] },
    }),
    first,
  );
  assert.notEqual(
    identity({ ...configuration, endpoint: "https://different.tenant.svc:8080" }),
    first,
  );
  assert.notEqual(
    identity({ ...configuration, auth: { mode: "bearerTokenFile", path: "/protected/new-token" } }),
    first,
  );
  assert.notEqual(
    identity(configuration, {
      ...options,
      kubernetes: { ...options.kubernetes, runtimeClassName: "other-runtime" },
    }),
    first,
  );
  assert.notEqual(identity(configuration, options, "other-driver"), first);
  assert.notEqual(identity(configuration, options, "sandbox", "other-backend"), first);
});

// Execute production scripts with isolated filesystem roots; this is protocol/script
// conformance, not proof of provider authentication, cluster restarts, or native readiness.
test("Gateway release and node binding refuse a replacement process before writing private material", async (t) => {
  const fs = await import("node:fs/promises");
  const { spawn } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { GATEWAY_RELEASE, GATEWAY_BINDING_UPDATE } =
    await import("../../apps/controller/src/drivers/sandbox/openshell-gateway-launch.ts");
  const root = await fs.mkdtemp(join(tmpdir(), "gateway-process-fence-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nonceA = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const nonceB = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  await fs.mkdir(join(root, nonceB));
  await fs.writeFile(
    join(root, "challenge.json"),
    JSON.stringify({ generation: "one", nonce: nonceB }),
  );
  const run = async (script, material) => {
    const child = spawn(process.execPath, ["-e", script.replaceAll("/tmp/oce-gateway", root)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.stdin.end(JSON.stringify(material));
    const [code] = await once(child, "exit");
    assert.equal(output, "", "private exec must not emit material");
    return code;
  };
  const material = {
    generation: "one",
    nonce: nonceA,
    environment: { GATEWAY_PRIVATE: "synthetic-only" },
    files: [],
  };
  // Same generation, different main process: the old release used to adopt B's nonce.
  assert.equal(await run(GATEWAY_RELEASE, material), 1);
  assert.deepEqual((await fs.readdir(root)).sort(), ["challenge.json", nonceB].sort());
  assert.equal(
    await run(GATEWAY_BINDING_UPDATE, {
      generation: "one",
      nonce: nonceA,
      revisionId: "revision",
      nodeId: "node-old",
    }),
    1,
  );
  assert.deepEqual(await fs.readdir(join(root, nonceB)), []);
  // The exact current challenge succeeds and produces no shared-root private file.
  assert.equal(await run(GATEWAY_RELEASE, { ...material, nonce: nonceB }), 0);
  const released = JSON.parse(await fs.readFile(join(root, nonceB, "release.json"), "utf8"));
  assert.equal(released.nonce, nonceB);
  assert.equal(released.environment.GATEWAY_PRIVATE, "synthetic-only");
  assert.equal(
    await run(GATEWAY_BINDING_UPDATE, {
      generation: "one",
      nonce: nonceB,
      revisionId: "revision",
      nodeId: "node-current",
    }),
    0,
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(join(root, nonceB, "workspace-node.json"), "utf8")),
    { revisionId: "revision", deviceId: "node-current" },
  );
  // Even when A's comparison preceded a restart, its removed process directory
  // cannot deliver a file into B's namespace. The launcher alone creates it.
  await fs.writeFile(
    join(root, "challenge.json"),
    JSON.stringify({ generation: "one", nonce: nonceA }),
  );
  assert.equal(await run(GATEWAY_RELEASE, material), 1);
  assert.equal(
    await run(GATEWAY_BINDING_UPDATE, {
      generation: "one",
      nonce: nonceA,
      revisionId: "revision",
      nodeId: "node-old",
    }),
    1,
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(join(root, nonceB, "workspace-node.json"), "utf8")),
    { revisionId: "revision", deviceId: "node-current" },
  );
});

test("Gateway challenge reads bounded nonce-only stdout over supported ExecSandbox wire", async (t) => {
  const fs = await import("node:fs/promises");
  const { spawn } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const root = await fs.mkdtemp(join(tmpdir(), "gateway-challenge-wire-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nonce = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  await fs.writeFile(join(root, "challenge.json"), JSON.stringify({ generation: "one", nonce }));
  const definition = await loader.load(
    join(
      import.meta.dirname,
      "../../apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto",
    ),
    { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
  );
  const service = grpc.loadPackageDefinition(definition).openshell.v1.OpenShell;
  const server = new grpc.Server();
  let mode = "script";
  const requests = [];
  server.addService(service.service, {
    ExecSandbox(call) {
      call.on("error", () => {});
      requests.push(call.request);
      if (mode !== "script") {
        const output = mode === "oversized" ? "a".repeat(37) : "private text must not escape";
        call.write({ stdout: { data: Buffer.from(output) } });
        call.write({ exit: { exit_code: 0 } });
        call.end();
        return;
      }
      const child = spawn(
        process.execPath,
        ["-e", call.request.command[2].replaceAll("/tmp/oce-gateway", root)],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      child.stdout.on("data", (data) => {
        // Split the safe output so the client must handle multiple stream frames.
        for (const byte of data) {
          call.write({ stdout: { data: Buffer.from([byte]) } });
        }
      });
      child.stderr.on("data", (data) => call.write({ stderr: { data } }));
      child.on("exit", (code) => {
        call.write({ exit: { exit_code: code } });
        call.end();
      });
      child.stdin.end(call.request.stdin);
    },
  });
  const port = await new Promise((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );
  t.after(() => server.forceShutdown());
  const client = new GrpcOpenShellGatewayClient({
    endpoint: "http://127.0.0.1:" + port,
    auth: { mode: "unauthenticated" },
  });
  t.after(() => client.close());
  const selection = { workspace: "tenant", name: "gateway", generation: "one" };
  assert.equal(await client.readGatewayChallenge(selection, AbortSignal.timeout(5000)), nonce);
  assert.equal(requests[0].sandbox, selection.name);
  assert.equal(requests[0].workspace_scope.workspace, selection.workspace);
  assert.deepEqual(JSON.parse(requests[0].stdin.toString()), { generation: "one" });
  await assert.rejects(
    client.readGatewayChallenge({ ...selection, generation: "other" }, AbortSignal.timeout(5000)),
    /challenge is unavailable/u,
  );
  for (mode of ["oversized", "private"]) {
    await assert.rejects(
      client.readGatewayChallenge(selection, AbortSignal.timeout(5000)),
      (error) => error.message === "Invalid Gateway process challenge.",
    );
  }
  // Generic exec still discards arbitrary output; no stdout-returning escape hatch.
  assert.equal(
    await client.execSandbox(
      {
        workspace: "tenant",
        sandbox: "gateway",
        command: ["true"],
        environment: {},
        stdin: "",
        timeoutSeconds: 1,
      },
      AbortSignal.timeout(5000),
    ),
    0,
  );
});

test("Gateway held launcher consumes nonce-scoped release and exposes the same process-local binding path", async (t) => {
  const fs = await import("node:fs/promises");
  const { spawn } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { setTimeout: delay } = await import("node:timers/promises");
  const { GATEWAY_LAUNCHER, GATEWAY_RELEASE, GATEWAY_BINDING_UPDATE } =
    await import("../../apps/controller/src/drivers/sandbox/openshell-gateway-launch.ts");
  const fixture = await fs.mkdtemp(join(tmpdir(), "gateway-held-launch-"));
  const root = join(fixture, "private");
  const state = join(fixture, "retained");
  const home = join(fixture, "home");
  const marker = join(fixture, "started.json");
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  for (const category of [
    "state",
    "client",
    "agent",
    "media",
    "worktrees",
    "worktree-sources",
    "sessions",
  ]) {
    await fs.mkdir(join(state, category), { recursive: true, mode: 0o700 });
  }
  const launcher = spawn(
    process.execPath,
    [
      "-e",
      GATEWAY_LAUNCHER.replaceAll("/tmp/oce-gateway", root).replaceAll(
        "/sandbox/gateway-state/",
        state + "/",
      ),
    ],
    { env: { ...process.env, HOME: home, OCE_GATEWAY_GENERATION: "one" }, stdio: "ignore" },
  );
  t.after(async () => {
    if (launcher.exitCode === null && launcher.signalCode === null) {
      launcher.kill("SIGTERM");
      await once(launcher, "exit");
    }
  });
  const waitForJson = async (path) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        return JSON.parse(await fs.readFile(path, "utf8"));
      } catch {
        // The launcher publishes this file asynchronously after preparing its home.
      }
      await delay(20);
    }
    assert.fail("held launcher did not reach its expected filesystem boundary");
  };
  const challenge = await waitForJson(join(root, "challenge.json"));
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  const run = async (script, material) => {
    const child = spawn(process.execPath, ["-e", script.replaceAll("/tmp/oce-gateway", root)], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.stdin.end(JSON.stringify(material));
    const [code] = await once(child, "exit");
    return code;
  };
  const nativeProbe =
    "const fs=require('node:fs');fs.writeFileSync(" +
    JSON.stringify(marker) +
    ",JSON.stringify({configuration:JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH)),bindingPath:process.env.OPENCLAW_WORKSPACE_NODE_PATH}));setInterval(()=>{},1000);";
  const material = {
    ...challenge,
    instanceId: "sandbox-instance",
    environment: { OPENCLAW_WORKSPACE_NODE_PATH: "/must-not-use-shared-binding" },
    files: [],
    configuration: { marker: "synthetic-only" },
    command: [process.execPath, "-e", nativeProbe],
  };
  // Before the exact process is released there is no native child, even though
  // the provider would already consider its held main process running.
  assert.equal(
    await run(GATEWAY_RELEASE, { ...material, nonce: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" }),
    1,
  );
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  assert.equal(await run(GATEWAY_RELEASE, material), 0);
  const started = await waitForJson(marker);
  assert.deepEqual(started.configuration, material.configuration);
  assert.equal(started.bindingPath, join(root, challenge.nonce, "workspace-node.json"));
  assert.equal(
    await run(GATEWAY_BINDING_UPDATE, {
      ...challenge,
      revisionId: "revision",
      nodeId: "current-node",
    }),
    0,
  );
  assert.deepEqual(JSON.parse(await fs.readFile(started.bindingPath, "utf8")), {
    revisionId: "revision",
    deviceId: "current-node",
  });
  assert.equal((await fs.stat(join(root, challenge.nonce))).mode & 0o777, 0o700);
  assert.equal(
    (await fs.stat(join(root, challenge.nonce, "configuration.json"))).mode & 0o777,
    0o600,
  );
});

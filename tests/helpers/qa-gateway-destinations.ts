import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import type { TestContext } from "node:test";
import { createQaInstallation } from "./qa-installation.mjs";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import { grantQaSecret, protectedText } from "./qa-secrets.mjs";
import { stopQaAgent } from "./qa-repository.mjs";
import { observeGatewayTunnel } from "./gateway-tunnel-observer.mjs";

type Installation = Omit<Awaited<ReturnType<typeof createQaInstallation>>, "agents"> & {
  agents: Agent[];
  namespace: { id: string };
  configuration: {
    drivers: {
      credential_proxy: {
        usage: string;
        configuration: { gatewayDestinations: { blockedCidrs: string[] } };
      };
    };
    backend?: { type: string }[];
  };
};
type Agent = {
  id: string;
  namespaceId: string;
  servicePrincipalId: string;
  preset: string;
  revision: { id: string };
  stopped?: boolean;
};
type Endpoint = { url: string; marker: string };
type Inputs = { first: Endpoint; peer: Endpoint; replacement: Endpoint; websocketUrl: string };

function endpoint(value: string, protocol: string) {
  const url = new URL(value);
  assert.equal(url.protocol, protocol);
  assert.ok(!url.username && !url.password && !url.hash && !url.port);
  assert.ok(!isIP(url.hostname) && /^[a-z0-9.-]+$/.test(url.hostname));
  return url;
}

async function execute(f: Installation, agent: Agent, script: string, ...args: string[]) {
  const result = await f.execRole(agent, "gateway", [
    "node",
    "--input-type=module",
    "-e",
    script,
    ...args,
  ]);
  return JSON.parse(result.stdout);
}

async function probe(f: Installation, agent: Agent, url: string) {
  return execute(
    f,
    agent,
    "try { const r=await fetch(process.argv[1],{redirect:'error',signal:AbortSignal.timeout(15000)});console.log(JSON.stringify({status:r.status,body:(await r.text()).slice(0,65536)})); } catch { console.log(JSON.stringify({denied:true})); }",
    url,
  );
}

// This scenario uses the shipped launcher and API/worker, not direct Driver calls.
// Missing optional management infrastructure must not block ordinary dedicated Codex.
export async function verifyDedicatedGatewayDestinations(context: TestContext, artifacts: string) {
  const input: Inputs = JSON.parse(
    await readFile(process.env.OCC_TEST_QA_DEDICATED_DESTINATIONS_CONFIG!, "utf8"),
  );
  for (const value of [input.first, input.peer, input.replacement]) {
    endpoint(value.url, "https:");
    assert.match(value.marker, /^[a-zA-Z0-9_-]{8,120}$/);
  }
  const socketHost = endpoint(input.websocketUrl, "wss:").hostname;
  assert.equal(
    new Set(
      [input.first, input.peer, input.replacement].map((value) => new URL(value.url).hostname),
    ).size,
    3,
  );
  assert.ok(
    ![input.first, input.peer, input.replacement].some(
      (value) => new URL(value.url).hostname === socketHost,
    ),
  );
  const credential = await protectedText(
    process.env.OCC_TEST_QA_OPENAI_KEY_FILE,
    "model credential",
  );
  assert.ok(process.env.OCC_TEST_QA_CODEX_MODEL, "explicit authorized model required");
  const f = (await createQaInstallation(context, "kubernetes", artifacts, {
    repositoryInputs: false,
    gatewayDestinations: true,
  })) as unknown as Installation;
  assert.equal(f.configuration.drivers.credential_proxy.usage, "gateway");
  assert.ok(
    !(f.configuration.backend ?? []).some(
      (backend: { type: string }) => backend.type === "openshell",
    ),
    "no OpenShell management Backend",
  );
  const prefix = "/namespaces/" + f.namespace.id;
  const values = createHarnessConfiguration("codex", process.env.OCC_TEST_QA_CODEX_MODEL);
  Object.assign(values.agents.defaults, { thinkingDefault: "low", skipBootstrap: true });
  const configuration = await f.api("POST", prefix + "/configurations", { kind: "agent", values });
  const destination = (value: Endpoint) => [
    { host: new URL(value.url).hostname, port: 443 },
    { host: socketHost, port: 443 },
  ];
  async function create(label: string, upstream: Endpoint): Promise<Agent> {
    const name = "qa-destinations-" + f.suffix + "-" + label;
    const secret = await f.api("POST", prefix + "/secrets", { name, value: credential });
    const agent = await f.api("POST", prefix + "/agents", {
      name,
      configurationId: configuration.id,
      executionMode: "dedicated",
      gatewayOutbound: { destinations: [] },
      initialWorkspaceFiles: { "AGENTS.md": "# Initialized test workspace\n" },
      harnessAuth: {
        method: "api_key",
        source: { kind: "secret", namespaceId: f.namespace.id, id: secret.id },
      },
    });
    agent.preset = "Codex";
    f.agents.push(agent);
    await grantQaSecret(f, agent, secret.id, name);
    await f.api("PATCH", prefix + "/agents/" + agent.id, {
      gatewayOutbound: { destinations: destination(upstream) },
    });
    await f.api("POST", prefix + "/agents/" + agent.id + "/runtime-credentials", {});
    await f.deployAndWait(agent);
    return agent;
  }
  async function allowed(agent: Agent, value: Endpoint) {
    const result = await probe(f, agent, value.url);
    assert.equal(result.status, 200, "approved HTTPS must reach upstream");
    assert.ok(result.body.includes(value.marker), "independent upstream marker required");
  }
  async function denied(agent: Agent, url: string) {
    assert.equal((await probe(f, agent, url)).denied, true, "unapproved destination must fail");
  }
  async function resources(agent: Agent) {
    return JSON.parse(
      await f.kubectl(
        "get",
        "pods,services,deployments,configmaps,networkpolicies",
        "-A",
        "-l",
        "openclaw.dev/agent=" + agent.id,
        "-o",
        "json",
      ),
    ).items as { kind: string; metadata: { uid: string; name: string } }[];
  }
  async function model(agent: Agent) {
    const nonce = "GATEWAY_" + randomUUID();
    const result = await execute(
      f,
      agent,
      "const r=await fetch('http://127.0.0.1:8080/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+process.env.OPENCLAW_GATEWAY_PASSWORD,'content-type':'application/json','x-openclaw-session-key':process.argv[1]},body:JSON.stringify({model:'openclaw/default',messages:[{role:'user',content:'Reply with exactly '+process.argv[1]+'. Do not call tools.'}]}),signal:AbortSignal.timeout(240000)}); const b=await r.json(); console.log(JSON.stringify({status:r.status,matched:b.choices?.[0]?.message?.content?.includes(process.argv[1])===true}));",
      nonce,
    );
    assert.equal(result.status, 200);
    assert.equal(result.matched, true, "real Harness response must contain unique nonce");
  }
  const first = await create("first", input.first);
  const peer = await create("peer", input.peer);
  const peerPod = await f.pod(peer, "gateway");
  for (const [agent, own, other] of [
    [first, input.first, input.peer],
    [peer, input.peer, input.first],
  ] as const) {
    await allowed(agent, own);
    await denied(agent, other.url);
    const wrongPort = new URL(own.url);
    wrongPort.port = "444";
    await denied(agent, wrongPort.href);
  }
  // A reachable own frontend is the control for cross-Agent TCP refusal.
  const tcpScript =
    "import net from 'node:net';const s=net.connect({host:process.argv[1],port:3129});let done=false;function finish(connected){if(done)return;done=true;s.destroy();console.log(JSON.stringify({connected}));}s.setTimeout(7000,()=>finish(false));s.once('connect',()=>finish(true));s.once('error',()=>finish(false));";
  const frontends = new Map<string, string>();
  for (const agent of [first, peer]) {
    const services = JSON.parse(
      await f.kubectl(
        "get",
        "services",
        "-A",
        "-l",
        "openclaw.dev/agent=" + agent.id,
        "-o",
        "json",
      ),
    ).items;
    const proxies = services.filter((service: { metadata: { name: string } }) =>
      service.metadata.name.startsWith("gateway-proxy-"),
    );
    assert.equal(proxies.length, 1);
    frontends.set(agent.id, proxies[0].spec.clusterIP);
    assert.equal((await execute(f, agent, tcpScript, frontends.get(agent.id)!)).connected, true);
  }
  for (const [agent, other] of [
    [first, peer],
    [peer, first],
  ] as const) {
    assert.equal(
      (await execute(f, agent, tcpScript, frontends.get(other.id)!)).connected,
      false,
      "peer proxy frontend denied",
    );
    const gateway = await f.pod(agent, "gateway");
    const harness = await f.pod(agent, "agent");
    assert.notEqual(gateway.metadata.uid, harness.metadata.uid);
    for (const [pod, expected] of [
      [gateway, false],
      [harness, true],
    ] as const) {
      assert.equal(
        JSON.stringify(pod.spec).includes(credential),
        false,
        "no literal model credential",
      );
      const refs = new Set<string>();
      for (const volume of pod.spec.volumes ?? []) {
        if (volume.secret) {
          refs.add(volume.secret.secretName);
        }
        for (const source of volume.projected?.sources ?? []) {
          if (source.secret) {
            refs.add(source.secret.name);
          }
        }
      }
      for (const container of [...pod.spec.containers, ...(pod.spec.initContainers ?? [])]) {
        for (const env of container.env ?? []) {
          if (env.valueFrom?.secretKeyRef) {
            refs.add(env.valueFrom.secretKeyRef.name);
          }
        }
        for (const env of container.envFrom ?? []) {
          if (env.secretRef) {
            refs.add(env.secretRef.name);
          }
        }
      }
      let contains = false;
      for (const name of refs) {
        const secret = await f.resource("secret", name, pod.metadata.namespace);
        contains ||= Object.values(secret.data ?? {}).some((value) =>
          Buffer.from(String(value), "base64").includes(Buffer.from(credential)),
        );
      }
      assert.equal(contains, expected, "model credential belongs only in dedicated Harness");
    }
  }
  await model(first);
  const peerTunnel = await observeGatewayTunnel(f, peer, input.websocketUrl);
  const firstTunnel = await observeGatewayTunnel(f, first, input.websocketUrl);
  await peerTunnel.echo();
  await firstTunnel.echo();
  const previous = first.revision.id;
  const oldResources = (await resources(first)).filter((resource) =>
    resource.metadata.name.startsWith("gateway-proxy-"),
  );
  assert.ok(oldResources.some((resource) => resource.kind === "Pod"));
  // Desired edits must not mutate the policy of an already admitted revision.
  await f.api("PATCH", prefix + "/agents/" + first.id, {
    gatewayOutbound: { destinations: destination(input.replacement) },
  });
  await allowed(first, input.first);
  await denied(first, input.replacement.url);
  await firstTunnel.echo();
  // Changed registration must not prevent ownership-based retirement of old resources.
  const blockedCidrs =
    f.configuration.drivers.credential_proxy.configuration.gatewayDestinations.blockedCidrs;
  assert.ok(!blockedCidrs.includes("192.0.2.0/24"));
  blockedCidrs.push("192.0.2.0/24");
  await f.saveInstallation(f.configuration);
  await peerTunnel.echo();
  const replacedAt = Date.now();
  await f.deployAndWait(first);
  assert.notEqual(first.revision.id, previous);
  await f.waitFor(
    "old upstream tunnel closes on replacement",
    () => firstTunnel.closedAt !== null,
    60_000,
  );
  assert.ok(firstTunnel.closedAt! >= replacedAt && firstTunnel.closedAt! - replacedAt < 60_000);
  const remaining = await resources(first);
  for (const old of oldResources) {
    assert.ok(
      !remaining.some((resource) => resource.metadata.uid === old.metadata.uid),
      "old proxy resource removed",
    );
  }
  await allowed(first, input.replacement);
  await denied(first, input.first.url);
  await model(first);
  await peerTunnel.echo();
  const successorTunnel = await observeGatewayTunnel(f, first, input.websocketUrl);
  await successorTunnel.echo();
  blockedCidrs.push("198.51.100.0/24");
  await f.saveInstallation(f.configuration);
  await successorTunnel.echo();
  const stoppedAt = Date.now();
  await stopQaAgent(f, first);
  await f.waitFor(
    "successor tunnel closes on stop",
    () => successorTunnel.closedAt !== null,
    60_000,
  );
  assert.ok(
    successorTunnel.closedAt! >= stoppedAt && successorTunnel.closedAt! - stoppedAt < 60_000,
  );
  assert.ok(
    !(await resources(first)).some(
      (resource) => resource.kind === "Pod" || resource.metadata.name.startsWith("gateway-proxy-"),
    ),
  );
  await peerTunnel.echo();
  assert.equal(peerTunnel.closedAt, null, "peer connection survives both lifecycle actions");
  assert.equal((await f.pod(peer, "gateway")).metadata.uid, peerPod.metadata.uid);
  await allowed(peer, input.peer);
  await model(peer);
  await f.record("dedicated-gateway-destinations", {
    agentId: first.id,
    peerId: peer.id,
    oldRevision: previous,
    replacementRevision: first.revision.id,
    replacementTunnelClosedAfterMs: firstTunnel.closedAt! - replacedAt,
    stopTunnelClosedAfterMs: successorTunnel.closedAt! - stoppedAt,
    peerPreserved: true,
    peerEchoes: peerTunnel.echoes,
    modelTurns: 3,
    model: process.env.OCC_TEST_QA_CODEX_MODEL,
    reasoning: "low",
    peerImages: peerPod.status.containerStatuses.map(
      ({ name, imageID }: { name: string; imageID: string }) => ({ name, imageID }),
    ),
    pairSelection: "gateway",
    changedBlockedCidrsBeforeReplacementAndStop: true,
  });
}

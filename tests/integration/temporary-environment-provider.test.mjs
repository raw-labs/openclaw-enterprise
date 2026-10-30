import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm, chmod, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";

test("readiness API never substitutes human authority for Agent workload identity", async (context) => {
  const fixture = await createConsoleAppFixture(context);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("workload probe");
  const agent = await fixture.createAgent(namespace.id, "probe");
  const path =
    "/namespaces/" + namespace.id + "/agents/" + agent.id + "/temporary-environments/readiness";
  assert.equal((await fixture.request("GET", path)).status, 401);
  assert.equal((await fixture.request("GET", path, { session: null })).status, 401);
  assert.equal(
    (await fixture.request("GET", path, { headers: { authorization: "Bearer invalid" } })).status,
    401,
    "an explicit workload credential must not fall back to an administrator cookie",
  );
  const raw = generateKeyPairSync("ed25519")
    .publicKey.export({ format: "der", type: "spki" })
    .subarray(-32);
  const sshPublicKey =
    "ssh-ed25519 " +
    Buffer.concat([
      Buffer.from([0, 0, 0, 11]),
      Buffer.from("ssh-ed25519"),
      Buffer.from([0, 0, 0, 32]),
      raw,
    ]).toString("base64");
  const base = path.slice(0, -"/readiness".length);
  const requestId = randomUUID();
  for (const [method, url, body] of [
    ["GET", base],
    ["GET", base + "/" + requestId],
    [
      "POST",
      base,
      { requestId, name: "lease-test", slug: "test", profileId: "small", sshPublicKey },
    ],
    ["POST", base + "/" + requestId + "/touch", {}],
    ["DELETE", base + "/" + requestId],
  ]) {
    assert.equal(
      (await fixture.request(method, url, { body })).status,
      401,
      method + " " + url + " must not accept an administrator cookie",
    );
    assert.equal((await fixture.request(method, url, { body, session: null })).status, 401);
  }
});

const provider = new URL(
  "../../deploy/runtime/temporary-environments/provider.mjs",
  import.meta.url,
);

async function invoke(input, env = {}, onSpawn) {
  const child = spawn(process.execPath, [provider.pathname], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  onSpawn?.(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const result = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  child.stdin.end(JSON.stringify(input));
  return result;
}

test("provider refuses lifecycle operations without trusted runtime settings", async () => {
  for (const operation of ["acquire", "release", "cleanup", "touch", "resolve", "list"]) {
    const result = await invoke({
      protocolVersion: 1,
      operation,
      desired: { leaseId: randomUUID(), slug: "test", name: "test" },
    });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    const response = JSON.parse(result.stdout);
    assert.equal(response.protocolVersion, 1);
    assert.match(response.error, /OCC_WORKLOAD_URL/u);
    assert.equal(response.lease, undefined);
  }
});

test("provider HTTP transport uses only runtime-delivered scope and credential and rejects redirects", async (context) => {
  // This local server proves adapter transport, not OCC authentication or Kubernetes behavior.
  const directory = await mkdtemp(join(tmpdir(), "oce-provider-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const token = randomUUID();
  const tokenFile = join(directory, "token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  const namespaceId = "ns_" + randomUUID();
  const agentId = "agt_" + randomUUID();
  let redirect = false;
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    assert.equal(
      request.url,
      "/namespaces/" + namespaceId + "/agents/" + agentId + "/temporary-environments/readiness",
    );
    assert.equal(request.headers.authorization, "Bearer " + token);
    assert.equal(request.headers["x-api-key"], undefined);
    if (redirect) {
      response.writeHead(302, { location: "/credential-sink" });
      response.end();
    } else {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: { supported: false, profiles: [] },
        }),
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const env = {
    OCC_WORKLOAD_URL: "http://127.0.0.1:" + server.address().port,
    OCC_WORKLOAD_NAMESPACE_ID: namespaceId,
    OCC_WORKLOAD_AGENT_ID: agentId,
    OCC_WORKLOAD_TOKEN_FILE: tokenFile,
  };
  const input = {
    protocolVersion: 1,
    operation: "doctor",
    config: { url: "https://attacker.example.invalid", token: "not-authority" },
  };
  const result = await invoke(input, env);
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.stdout).error, /No runtime-approved/u);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes(token), false);
  redirect = true;
  const refused = await invoke(input, env);
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.stdout).error, "OCC workload request failed");
  assert.equal(requests, 2, "the redirect is never followed with the workload credential");
});

test("provider refuses non-loopback cleartext before opening any credential", async () => {
  const result = await invoke(
    { protocolVersion: 1, operation: "doctor" },
    { OCC_WORKLOAD_URL: "http://occ.example.invalid" },
  );
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.stdout).error, /requires HTTPS/u);
});

// Scripted OCC HTTP responses exercise the shipped process and protocol. They are
// transport proof only: no provider, worker, database, or SSH server is simulated as real.
test("provider preserves raw identity, rereads tokens and waits for deletion evidence", async (context) => {
  const directory = await mkdtemp(join(process.env.HOME, ".oce-provider-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, "token");
  const keyFile = join(directory, "identity");
  const first = randomUUID();
  const rotated = randomUUID();
  await writeFile(tokenFile, first, { mode: 0o600 });
  const namespaceId = "ns_" + randomUUID();
  const agentId = "agt_" + randomUUID();
  const desired = {
    leaseId: "lease-" + randomUUID(),
    name: "crabbox-verbatim-name",
    slug: "verbatim-slug",
  };
  const base = {
    id: "tenv_" + randomUUID(),
    requestId: desired.leaseId,
    name: desired.name,
    slug: desired.slug,
    profileId: "approved",
    state: "ready",
    usable: true,
    hardExpiresAt: new Date(Date.now() + 600000).toISOString(),
    idleExpiresAt: new Date(Date.now() + 60000).toISOString(),
    ssh: { host: "127.0.0.1", port: 2222, user: "worker" },
    providerRef: "must-not-escape",
  };
  let mode = "acquire";
  let deleted = false;
  let deletes = 0;
  let key;
  let releaseObserved;
  const server = createServer(async (request, response) => {
    const suffix = request.url.replace(
      "/namespaces/" + namespaceId + "/agents/" + agentId + "/temporary-environments",
      "",
    );
    let data = base;
    if (request.method === "POST" && suffix === "") {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      const input = JSON.parse(body);
      assert.equal(input.name, desired.name);
      assert.equal(input.slug, desired.slug);
      assert.equal(input.profileId, "approved");
      assert.match(input.sshPublicKey, /^ssh-ed25519 /u);
      if (key) {
        assert.equal(input.sshPublicKey, key);
      }
      key = input.sshPublicKey;
      if (mode === "acquire") {
        assert.equal(request.headers.authorization, "Bearer " + first);
        await writeFile(tokenFile, rotated);
        data = { ...base, state: "provisioning", usable: false, ssh: undefined };
        response.statusCode = 202;
      }
    } else {
      assert.equal(request.headers.authorization, "Bearer " + rotated);
      if (mode === "missing") {
        response.writeHead(404).end();
        return;
      }
      if (request.method === "DELETE") {
        deletes += 1;
        data = { ...base, state: "deleting", usable: false, ssh: undefined };
        response.statusCode = 202;
        deleted = true;
        releaseObserved?.();
      } else if (deleted && mode !== "pending") {
        data = { ...base, state: "deleted", usable: false, ssh: undefined };
      }
      if (suffix === "") {
        data = [
          data,
          {
            ...base,
            id: "tenv_" + randomUUID(),
            requestId: "pending",
            idleExpiresAt: new Date(Date.now() + 60000).toISOString(),
            state: "provisioning",
            usable: false,
            ssh: undefined,
          },
        ];
      }
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const env = {
    OCC_WORKLOAD_URL: "http://127.0.0.1:" + server.address().port,
    OCC_WORKLOAD_NAMESPACE_ID: namespaceId,
    OCC_WORKLOAD_AGENT_ID: agentId,
    OCC_WORKLOAD_TOKEN_FILE: tokenFile,
    OCC_WORKLOAD_SSH_KEY_FILE: keyFile,
    OCC_WORKLOAD_TEMPORARY_PROFILE: "approved",
  };
  const call = async (operation, extra = {}) => {
    const result = await invoke(
      {
        protocolVersion: 1,
        operation,
        config: { profile: "unapproved", key: "/untrusted" },
        ...extra,
      },
      env,
    );
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes(first), false);
    assert.equal(result.stdout.includes(rotated), false);
    assert.equal(result.stdout.includes("must-not-escape"), false);
    return { ...result, body: JSON.parse(result.stdout) };
  };
  const acquired = await call("acquire", { desired });
  assert.equal(acquired.code, 0, acquired.stdout);
  assert.deepEqual(acquired.body.lease.ssh, {
    host: "127.0.0.1",
    port: "2222",
    user: "worker",
    key: keyFile,
  });
  assert.equal(acquired.body.lease.name, desired.name);
  assert.equal(acquired.body.lease.cloudId, base.id);
  mode = "retry";
  assert.equal((await call("acquire", { desired })).code, 0);
  // Reopening the key must reject unsafe custody rather than publish an SSH target.
  await chmod(keyFile, 0o644);
  assert.equal((await call("acquire", { desired })).code, 1);
  await chmod(keyFile, 0o600);
  const alias = join(directory, "alias");
  await symlink(keyFile, alias);
  const aliased = await invoke(
    { protocolVersion: 1, operation: "acquire", desired },
    { ...env, OCC_WORKLOAD_SSH_KEY_FILE: alias },
  );
  assert.equal(aliased.code, 1);
  assert.equal((await call("acquire", { desired, keep: true })).code, 1);
  assert.equal((await call("list")).body.leases.length, 1);
  assert.equal((await call("list", { all: true })).body.leases.length, 2);
  const target = acquired.body.lease;
  assert.equal((await call("resolve", { desired, releaseOnly: true })).body.lease.ssh, undefined);
  assert.equal((await call("touch", { lease: target })).code, 0);
  for (const expected of [
    { cloudId: "wrong" },
    { leaseId: "wrong" },
    { attemptLeaseId: "wrong" },
    { slug: "wrong" },
  ]) {
    assert.equal((await call("release", { lease: target, expected })).code, 1);
  }
  assert.equal(deletes, 0);
  assert.equal((await call("release", { lease: target, dryRun: true })).code, 0);
  assert.equal(deletes, 0);
  const released = await call("release", { lease: target });
  assert.equal(released.code, 0, released.stdout);
  assert.equal(deletes, 1);
  assert.equal((await call("release", { lease: target })).code, 0);
  assert.equal(deletes, 1, "persisted deletion receipt is idempotent");
  deleted = false;
  base.idleExpiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal((await call("cleanup", { dryRun: true })).code, 0);
  assert.equal(deletes, 1);
  assert.equal((await call("cleanup")).code, 0);
  assert.equal(deletes, 2);
  // Cancellation after a 202 must report failure, not a deletion receipt.
  deleted = false;
  mode = "pending";
  const observed = new Promise((resolve) => {
    releaseObserved = resolve;
  });
  let child;
  const pending = invoke(
    { protocolVersion: 1, operation: "release", lease: target },
    env,
    (value) => {
      child = value;
    },
  );
  await observed;
  child.kill("SIGTERM");
  const cancelled = await pending;
  assert.equal(cancelled.code, 1);
  assert.match(JSON.parse(cancelled.stdout).error, /cleanup obligation remains durable/u);
  mode = "missing";
  assert.equal((await call("release", { lease: target })).code, 1, "404 is not a deletion receipt");
});

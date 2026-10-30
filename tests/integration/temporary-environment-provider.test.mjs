import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
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
});

const provider = new URL(
  "../../deploy/runtime/temporary-environments/provider.mjs",
  import.meta.url,
);

async function invoke(input, env = {}) {
  const child = spawn(process.execPath, [provider.pathname], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
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

test("draft provider refuses allocation and deletion without reporting lease success", async () => {
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
    assert.match(response.error, /not implemented/u);
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
          data: { supported: false, reason: "TEMPORARY_ENVIRONMENT_LIFECYCLE_NOT_IMPLEMENTED" },
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
  assert.match(JSON.parse(result.stdout).error, /authentication and authorization succeeded/u);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes(token), false);
  redirect = true;
  const refused = await invoke(input, env);
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.stdout).error, "OCC workload readiness request failed");
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

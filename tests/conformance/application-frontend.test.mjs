import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { applicationFrontend } from "../../apps/controller/src/drivers/compute/kubernetes/application-workload.ts";
import { availablePort } from "../helpers/available-port.mjs";

test("application frontend cannot turn a device caller's identity headers into trusted proxy authentication", async (context) => {
  const upstream = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.headers));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  context.after(() => new Promise((resolve) => upstream.close(resolve)));
  const address = upstream.address();
  assert.equal(typeof address, "object");
  const endpoint = {
    origin: "http://gateway.application.example.test",
    statusOrigin: "http://status.application.example.test",
    connectOrigin: `http://127.0.0.1:${address.port}`,
    transportSecretRef: { name: "application-transport-fixture", key: "token" },
  };
  const token = randomBytes(32).toString("hex");

  async function frontend(trustedProxyCidrs) {
    const port = await availablePort();
    const statusPort = await availablePort();
    const deployment = applicationFrontend(
      {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: "frontend", namespace: "owned" },
        spec: {
          selector: { matchLabels: { app: "frontend" } },
          template: {
            spec: {
              containers: [
                {
                  name: "gateway",
                  image: "unused-host-component-test",
                  ports: [{ containerPort: port }],
                  command: ["node"],
                },
              ],
            },
          },
        },
      },
      endpoint,
      trustedProxyCidrs,
    );
    const container = deployment.spec.template.spec.containers[0];
    const environment = Object.fromEntries(
      container.env
        .filter((entry) => entry.value !== undefined)
        .map(({ name, value }) => [name, value]),
    );
    const child = spawn(process.execPath, container.args, {
      env: {
        ...environment,
        OCE_APPLICATION_TRANSPORT_TOKEN: token,
        OCE_APPLICATION_STATUS_PORT: String(statusPort),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let diagnostic = "";
    child.stderr.on("data", (chunk) => (diagnostic += chunk));
    context.after(async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
    });
    const origin = `http://127.0.0.1:${port}`;
    for (let attempt = 0; ; attempt++) {
      if (child.exitCode !== null) {
        throw new Error(`Frontend exited before listening: ${diagnostic}`);
      }
      try {
        const response = await fetch(origin, { signal: AbortSignal.timeout(200) });
        if (response.ok) {
          break;
        }
      } catch {
        // Wait for the actual frontend listener, not a guessed startup delay.
      }
      assert.ok(attempt < 100, "Frontend did not start");
      await delay(20);
    }
    return origin;
  }

  // Harness/device callers can reach the Gateway for enrollment, but are not OCE proxies.
  const untrusted = await frontend(["192.0.2.0/24"]);
  const headers = {
    "x-occ-identity": "occ-workspace-files",
    "x-real-ip": "192.0.2.99",
    "x-forwarded-for": "192.0.2.99",
    "x-oce-application-transport": "caller-supplied-token",
    authorization: "Bearer device-fixture",
  };
  const stripped = await (await fetch(untrusted, { headers })).json();
  assert.equal(stripped["x-occ-identity"], undefined);
  assert.equal(stripped["x-real-ip"], undefined);
  assert.equal(stripped["x-forwarded-for"], undefined);
  assert.equal(
    stripped.authorization,
    headers.authorization,
    "Device authentication remains available",
  );
  assert.equal(
    stripped["x-oce-application-transport"],
    token,
    "The caller cannot choose the private hop credential",
  );
  assert.equal(stripped.host, "gateway.application.example.test");

  // The same identity reaches the payload only from the Installation's actual trusted source.
  const trusted = await frontend(["127.0.0.1/32"]);
  const preserved = await (await fetch(trusted, { headers })).json();
  assert.equal(preserved["x-occ-identity"], headers["x-occ-identity"]);
  assert.equal(preserved["x-real-ip"], headers["x-real-ip"]);
});

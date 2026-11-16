import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import https from "node:https";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { startSlackProxy } from "../helpers/slack-proxy.mjs";

// Run inside the selected native image. Only upstream DNS/connection routing is
// simulated; the SDK guard, TLS, redirects, media storage and proxy are real.
const runtimeRequire = createRequire("/app/package.json");
const ssrfModule: unknown = await import(
  pathToFileURL(runtimeRequire.resolve("openclaw/plugin-sdk/ssrf-runtime")).href
);
const mediaModule: unknown = await import(
  pathToFileURL(runtimeRequire.resolve("openclaw/plugin-sdk/media-runtime")).href
);

// The SDK is loaded from the selected image, not the controller dependency graph.
// Check its boundary before using values returned by the runtime module.
assert.ok(ssrfModule && typeof ssrfModule === "object" && "fetchWithSsrFGuard" in ssrfModule);
assert.ok(mediaModule && typeof mediaModule === "object" && "saveResponseMedia" in mediaModule);
const fetchGuard = ssrfModule.fetchWithSsrFGuard;
const saveMedia = mediaModule.saveResponseMedia;
assert.equal(typeof fetchGuard, "function");
assert.equal(typeof saveMedia, "function");
async function fetchWithSsrFGuard(options: {
  url: string;
  init: { headers: Record<string, string> };
  requireHttps: boolean;
  policy: { hostnameAllowlist: string[] };
  retainAuthorizationRedirectHostnameAllowlist: string[];
  timeoutMs: number;
  lookupFn(): Promise<{ address: string; family: number }[]>;
}) {
  assert.ok(typeof fetchGuard === "function");
  const result: unknown = await Reflect.apply(fetchGuard, undefined, [options]);
  assert.ok(
    result &&
      typeof result === "object" &&
      "response" in result &&
      "finalUrl" in result &&
      "release" in result,
  );
  assert.ok(result.response !== null && typeof result.response === "object");
  assert.ok(typeof result.finalUrl === "string");
  assert.ok(typeof result.release === "function");
  return { response: result.response, finalUrl: result.finalUrl, release: result.release };
}
async function saveResponseMedia(
  response: object,
  options: { sourceUrl: unknown; maxBytes: number; originalFilename: string },
) {
  assert.ok(typeof saveMedia === "function");
  const result: unknown = await Reflect.apply(saveMedia, undefined, [response, options]);
  assert.ok(
    result && typeof result === "object" && "path" in result && typeof result.path === "string",
  );
  return { path: result.path };
}

test("native guarded attachment downloads use the reviewed channel proxy", async (t) => {
  const content = Buffer.from("name,value\nattachment,42\n");
  const requests: { host: string | undefined; authorization: string | undefined }[] = [];
  const server = https.createServer(
    {
      key: await readFile("/certificates/key.pem"),
      cert: await readFile("/certificates/cert.pem"),
    },
    (request, response) => {
      requests.push({ host: request.headers.host, authorization: request.headers.authorization });
      if (request.url === "/content") {
        response.writeHead(302, { location: "https://tenant.sharepoint.com/attachment.csv" });
      } else if (request.url === "/unapproved") {
        response.writeHead(302, { location: "https://neighbor.sharepoint.com/attachment.csv" });
      } else {
        response.writeHead(200, { "content-type": "text/csv" });
        response.write(content);
      }
      response.end();
    },
  );
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const proxy = await startSlackProxy(t, {
    upstreamPort: address.port,
    upstreamHosts: ["graph.microsoft.com", "tenant.sharepoint.com", "neighbor.sharepoint.com"],
    teamsEnabled: true,
    teamsFileHosts: JSON.stringify(["tenant.sharepoint.com"]),
  });
  process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;
  process.env.NO_PROXY = "";
  delete process.env.OPENCLAW_PROXY_ACTIVE;
  const options = {
    url: "https://graph.microsoft.com/content",
    init: { headers: { authorization: "Bearer synthetic-graph-attachment" } },
    requireHttps: true,
    policy: {
      hostnameAllowlist: [
        "graph.microsoft.com",
        "tenant.sharepoint.com",
        "neighbor.sharepoint.com",
      ],
    },
    retainAuthorizationRedirectHostnameAllowlist: ["graph.microsoft.com"],
    timeoutMs: 1500,
    // Strict direct transport has no route in the network-disabled container.
    lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
  };
  await assert.rejects(fetchWithSsrFGuard(options), { name: "TypeError", message: /fetch failed/ });
  assert.deepEqual(requests, [], "HTTPS_PROXY alone must not bypass strict native transport");

  // This is the declaration projected by Kubernetes Compute only for an
  // operator-approved proxy. Leave the native guard in its default strict mode.
  process.env.OPENCLAW_PROXY_ACTIVE = "1";
  const download = await fetchWithSsrFGuard(options);
  try {
    const saved = await saveResponseMedia(download.response, {
      sourceUrl: download.finalUrl,
      maxBytes: 1024,
      originalFilename: "attachment.csv",
    });
    assert.deepEqual(await readFile(saved.path), content);
  } finally {
    await download.release();
  }
  assert.deepEqual(requests, [
    { host: "graph.microsoft.com", authorization: "Bearer synthetic-graph-attachment" },
    { host: "tenant.sharepoint.com", authorization: undefined },
  ]);

  // Even a native-allowed redirect cannot escape the installation's exact list.
  await assert.rejects(
    fetchWithSsrFGuard({ ...options, url: "https://graph.microsoft.com/unapproved" }),
    { name: "TypeError", message: /fetch failed/ },
  );
  assert.equal(requests.length, 3, "the unapproved storage host never receives a TLS request");
});

import assert from "node:assert/strict";
import { readFile, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import https from "node:https";

// Use the assembled runtime's production functions, not a replacement dispatcher.
// Bundle filenames are build outputs; find the pinned functions by their exported names.
async function runtimeModule(fragment) {
  for (const file of await readdir("/app/dist")) {
    if (!file.endsWith(".mjs")) {
      continue;
    }
    const path = "/app/dist/" + file;
    if ((await readFile(path, "utf8")).includes(fragment)) {
      return import(path);
    }
  }
  throw new Error("Missing native runtime module: " + fragment);
}
function exportedFunction(module, name) {
  const value = Object.values(module).find(
    (entry) => typeof entry === "function" && entry.name === name,
  );
  assert.equal(typeof value, "function", "Missing native export " + name);
  return value;
}
const provenance = JSON.parse(await readFile("/opt/oce/runtime/provenance.json", "utf8"));
assert.equal(provenance.commit, process.env.EXPECTED_OPENCLAW_COMMIT);
const globalDispatch = await runtimeModule("function ensureGlobalUndiciEnvProxyDispatcher(");
exportedFunction(globalDispatch, "ensureGlobalUndiciEnvProxyDispatcher")();
const slackModule = await runtimeModule("resolveSlackMonitorDispatchers as");
const dispatchers = exportedFunction(slackModule, "resolveSlackMonitorDispatchers")("socket");
assert.ok(dispatchers.webApi);
assert.ok(dispatchers.socketMode);
const requireFromRuntime = createRequire(
  (await realpath("/app/dist")) + "/native-transport-proof.mjs",
);
const requireFromBolt = createRequire(requireFromRuntime.resolve("@slack/bolt/package.json"));
const requireFromSocket = createRequire(requireFromBolt.resolve("@slack/socket-mode/package.json"));
const { WebSocket } = requireFromSocket("undici/index.js");
const { WebClient } = requireFromRuntime("@slack/web-api");
const options = exportedFunction(slackModule, "resolveSlackWebClientOptions")(
  {
    retryConfig: { retries: 0 },
    timeout: 5000,
    ...(process.env.PROOF_MODE === "denied" ? { slackApiUrl: "https://example.org/api/" } : {}),
  },
  dispatchers.webApi,
);
const client = new WebClient(undefined, options);
async function nativeHttps(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 5000 }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("Native HTTPS timeout")));
  });
}
async function socketEcho(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { dispatcher: dispatchers.socketMode });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Native Socket Mode transport timeout"));
    }, 8000);
    socket.addEventListener("open", () => socket.send("oce-native-proxy-proof"), { once: true });
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        socket.close();
        resolve(event.data);
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        socket.close();
        reject(new Error("Native Socket Mode WebSocket refused"));
      },
      { once: true },
    );
  });
}
try {
  if (process.env.PROOF_MODE === "allowed") {
    assert.equal(
      (await fetch("https://example.com", { signal: AbortSignal.timeout(8000) })).status,
      200,
    );
    assert.equal(await nativeHttps("https://example.com"), 200);
    // api.test is a public Slack API method. No user credential is needed or sent.
    assert.equal((await client.api.test()).ok, true);
    // Exercise Socket Mode's actual Undici copy and the native Channel's selected dispatcher.
    // This proves WebSocket transport, not Slack app enrollment or delivery of Slack events.
    assert.equal(await socketEcho("wss://ws.postman-echo.com/raw"), "oce-native-proxy-proof");
    console.log("native fetch, HTTPS, Slack API and Socket Mode WebSocket transport passed");
  } else {
    const host = process.env.PROOF_MODE === "denied" ? "example.org" : "example.com";
    await assert.rejects(fetch("https://" + host, { signal: AbortSignal.timeout(5000) }), (error) =>
      ["TypeError", "TimeoutError"].includes(error.name),
    );
    await assert.rejects(
      nativeHttps("https://" + host),
      (error) => error instanceof Error && error.message.length > 0,
    );
    await assert.rejects(
      client.api.test(),
      (error) => error instanceof Error && error.code === "slack_webapi_request_error",
    );
    await assert.rejects(
      socketEcho(
        "wss://" +
          (process.env.PROOF_MODE === "denied" ? "example.org" : "ws.postman-echo.com") +
          "/raw",
      ),
      { message: "Native Socket Mode WebSocket refused" },
    );
    console.log("native client transports refused " + process.env.PROOF_MODE);
  }
} finally {
  await dispatchers.close();
}
process.exit(0);

#!/usr/bin/env node
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { bounded, runtime, request, sshKey } from "./transport.mjs";

const cancellation = new AbortController();
for (const event of ["SIGINT", "SIGTERM"]) {
  process.once(event, () => cancellation.abort());
}
const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(120000)]);
const valid = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
function requireIdentity(value) {
  if (!valid(value?.leaseId) || !valid(value?.name) || !valid(value?.slug)) {
    throw new Error("Exact leaseId, name and slug are required");
  }
}
function record(value) {
  if (
    !value ||
    !valid(value.requestId) ||
    !valid(value.name) ||
    !valid(value.slug) ||
    !/^tenv_[0-9a-f-]{36}$/u.test(value.id) ||
    !["reserved", "provisioning", "ready", "deleting", "deleted"].includes(value.state) ||
    !Number.isFinite(Date.parse(value.hardExpiresAt)) ||
    !Number.isFinite(Date.parse(value.idleExpiresAt))
  ) {
    throw new Error("Invalid OCC environment response");
  }
  return value;
}
function guard(value, expected) {
  if (!expected) {
    return;
  }
  for (const [key, actual] of [
    ["leaseId", value.requestId],
    ["attemptLeaseId", value.requestId],
    ["slug", value.slug],
    ["name", value.name],
    ["cloudId", value.id],
  ]) {
    if (expected[key] !== undefined && expected[key] !== "" && expected[key] !== actual) {
      throw new Error("Environment identity mismatch");
    }
  }
}
function lease(value, settings, connection = true) {
  const output = {
    leaseId: value.requestId,
    name: value.name,
    slug: value.slug,
    cloudId: value.id,
    status: value.state,
    serverType: value.profileId,
  };
  if (
    connection &&
    value.usable &&
    value.state === "ready" &&
    Date.parse(value.hardExpiresAt) > Date.now() &&
    Date.parse(value.idleExpiresAt) > Date.now()
  ) {
    const ssh = value.ssh;
    if (
      !ssh ||
      typeof ssh.host !== "string" ||
      ssh.host.length > 253 ||
      !(isIP(ssh.host) || /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/u.test(ssh.host)) ||
      !Number.isInteger(ssh.port) ||
      ssh.port < 1 ||
      ssh.port > 65535 ||
      !/^[a-z_][a-z0-9_-]{0,31}$/u.test(ssh.user)
    ) {
      throw new Error("Invalid OCC SSH endpoint");
    }
    output.ssh = { host: ssh.host, port: String(ssh.port), user: ssh.user, key: settings.key };
  }
  return output;
}
async function main(input) {
  if (input?.protocolVersion !== 1 || typeof input.operation !== "string") {
    throw new Error("Expected protocolVersion 1");
  }
  const settings = runtime();
  const call = (suffix, method = "GET", body) => request(settings, suffix, method, body, signal);
  const read = async (id) => {
    if (!valid(id)) {
      throw new Error("Invalid leaseId");
    }
    return record(await call("/" + encodeURIComponent(id)));
  };
  const list = async () => {
    const values = await call("");
    if (!Array.isArray(values) || values.length > 10000) {
      throw new Error("Invalid OCC environment list");
    }
    return values.map(record);
  };
  const poll = async (value, deleted) => {
    const identity = {
      leaseId: value.requestId,
      cloudId: value.id,
      name: value.name,
      slug: value.slug,
    };
    while (true) {
      signal.throwIfAborted();
      guard(value, identity);
      if (deleted ? value.state === "deleted" : lease(value, settings).ssh !== undefined) {
        return value;
      }
      if (!deleted && ["deleting", "deleted"].includes(value.state)) {
        throw new Error("Environment is no longer available");
      }
      await delay(250, undefined, { signal });
      value = await read(identity.leaseId);
    }
  };
  const remove = async (value) => {
    if (value.state === "deleted") {
      return;
    }
    const changed = record(await call("/" + encodeURIComponent(value.requestId), "DELETE"));
    guard(changed, {
      leaseId: value.requestId,
      cloudId: value.id,
      name: value.name,
      slug: value.slug,
    });
    await poll(changed, true);
  };
  switch (input.operation) {
    case "doctor": {
      const readiness = await call("/readiness");
      if (
        !readiness?.supported ||
        !Array.isArray(readiness.profiles) ||
        !readiness.profiles.some((profile) => profile.id === settings.profile)
      ) {
        throw new Error("No runtime-approved temporary environment profile is available");
      }
      await sshKey(settings.key, true, signal);
      return { message: "OCC temporary environment provider ready" };
    }
    case "acquire": {
      requireIdentity(input.desired);
      if (input.keep) {
        throw new Error(
          "Persistent keep is unsupported; server lifetime and idle deadlines are mandatory",
        );
      }
      if (!valid(settings.profile)) {
        throw new Error("Runtime-approved temporary environment profile is required");
      }
      const sshPublicKey = await sshKey(settings.key, true, signal);
      const value = record(
        await call("", "POST", {
          requestId: input.desired.leaseId,
          name: input.desired.name,
          slug: input.desired.slug,
          profileId: settings.profile,
          sshPublicKey,
        }),
      );
      guard(value, input.desired);
      return { lease: lease(await poll(value, false), settings) };
    }
    case "resolve": {
      let value;
      const id =
        input.desired?.leaseId ||
        input.expected?.leaseId ||
        input.expected?.attemptLeaseId ||
        input.lease?.leaseId;
      if (id) {
        value = await read(id);
      } else {
        if (!valid(input.id)) {
          throw new Error("An exact environment selector is required");
        }
        const matches = (await list()).filter(
          (item) =>
            item.state !== "deleted" &&
            [item.requestId, item.id, item.name, item.slug].includes(input.id),
        );
        if (matches.length !== 1) {
          throw new Error("Environment selector is absent or ambiguous");
        }
        value = matches[0];
      }
      guard(value, input.desired);
      guard(value, input.lease);
      guard(value, input.expected);
      if (input.releaseOnly) {
        return { lease: lease(value, settings, false) };
      }
      if (value.state === "deleted") {
        throw new Error("Environment has been deleted");
      }
      await sshKey(settings.key, false, signal);
      return { lease: lease(await poll(value, false), settings) };
    }
    case "list": {
      const values = (await list()).filter(
        (value) => value.state !== "deleted" && (input.all || value.usable),
      );
      if (values.some((value) => value.usable)) {
        await sshKey(settings.key, false, signal);
      }
      return { leases: values.map((value) => lease(value, settings)) };
    }
    case "touch": {
      requireIdentity(input.lease);
      const value = await read(input.lease.leaseId);
      guard(value, input.lease);
      guard(value, input.expected);
      await sshKey(settings.key, false, signal);
      const changed = record(
        await call("/" + encodeURIComponent(value.requestId) + "/touch", "POST", {}),
      );
      guard(changed, { ...input.lease, cloudId: value.id });
      return { lease: lease(changed, settings) };
    }
    case "release": {
      requireIdentity(input.lease);
      if (!input.lease.cloudId) {
        throw new Error("Exact cloudId is required before release");
      }
      const value = await read(input.lease.leaseId);
      guard(value, input.lease);
      guard(value, input.expected);
      if (input.dryRun) {
        return { message: "Release dry run; no resource changed" };
      }
      await remove(value);
      return { message: "Environment deletion confirmed" };
    }
    case "cleanup": {
      const candidates = (await list()).filter(
        (value) =>
          value.state === "deleting" ||
          (value.state !== "deleted" &&
            (Date.parse(value.hardExpiresAt) <= Date.now() ||
              Date.parse(value.idleExpiresAt) <= Date.now())),
      );
      if (input.dryRun) {
        return { message: "Cleanup dry run; no resource changed" };
      }
      for (const candidate of candidates) {
        await remove(candidate);
      }
      return { message: "Expired environment deletions confirmed" };
    }
    default:
      throw new Error("Unsupported provider operation");
  }
}
try {
  // Input time is bounded independently of upstream process cancellation.
  const timer = setTimeout(
    () => process.stdin.destroy(new Error("Input deadline exceeded")),
    15000,
  );
  let input;
  try {
    input = JSON.parse(await bounded(process.stdin, 1024 * 1024));
  } finally {
    clearTimeout(timer);
  }
  const result = await main(input);
  signal.throwIfAborted();
  process.stdout.write(JSON.stringify({ protocolVersion: 1, ...result }) + "\n");
} catch (error) {
  const message = signal.aborted
    ? "Provider deadline or cancellation reached; server cleanup obligation remains durable"
    : error.message;
  // Errors from filesystem/process operations may contain sensitive paths or command output.
  const safe =
    /^(Expected|Exact|Invalid|OCC[ _]|Runtime|Trusted|SSH key|Workload|No runtime|Persistent|Environment|An exact|Unsupported|Release|Provider|JSON)/u.test(
      message,
    )
      ? message
      : "External provider request failed";
  process.stdout.write(JSON.stringify({ protocolVersion: 1, error: safe }) + "\n");
  process.exitCode = 1;
}

import assert from "node:assert/strict";
import { BlockList, isIP } from "node:net";
import test from "node:test";
import {
  FORBIDDEN_IPV4,
  FORBIDDEN_IPV6,
} from "../../apps/controller/src/gateway/outbound-proxy.mjs";
import { compileOpenShellApplicationNetworkPolicy } from "../../apps/controller/src/drivers/sandbox/openshell-application-policy.ts";

function compile({ selection = { mode: "restricted", hosts: ["example.com"] }, ...input } = {}) {
  return compileOpenShellApplicationNetworkPolicy({
    revision: {
      gatewayOutbound: { selection, denyCidrs: [], requirements: [] },
    },
    denyCidrs: [],
    mandatoryDenyCidrs: [...FORBIDDEN_IPV4, ...FORBIDDEN_IPV6],
    runtimePeers: [],
    ...input,
  });
}

function grantedAddresses(policy, host = "example.com", port = 443, family = "ipv4") {
  const block = new BlockList();
  for (const rule of Object.values(policy)) {
    for (const endpoint of rule.endpoints) {
      if (endpoint.host !== host || !endpoint.ports.includes(port)) {
        continue;
      }
      for (const cidr of endpoint.allowed_ips) {
        const [address, prefix] = cidr.split("/");
        // Node normalizes IPv4-mapped IPv6 when testing a mixed BlockList. Keep
        // families separate, as OpenShell's IpNet allowlist does, for this oracle.
        if (isIP(address) === (family === "ipv4" ? 4 : 6)) {
          block.addSubnet(address, Number(prefix), family);
        }
      }
    }
  }
  return block;
}

test("contained public HTTPS excludes mandatory, admitted and current Installation addresses", () => {
  const policy = compile({
    revision: {
      gatewayOutbound: {
        selection: { mode: "restricted", hosts: ["example.com"] },
        requirements: [],
        denyCidrs: ["8.8.8.0/24", "2001:4860::/32"],
      },
    },
    denyCidrs: ["9.9.9.9/32", "11.0.0.0/8"],
  });
  const grants = grantedAddresses(policy);
  // Node's independent subnet implementation checks the positive complement;
  // private DNS answers must not turn an allowed hostname into an SSRF grant.
  for (const address of [
    "0.0.0.0",
    "0.255.255.255",
    "10.0.0.1",
    "100.100.100.200",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.9",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.0",
    "255.255.255.255",
    "8.8.8.0",
    "8.8.8.255",
    "9.9.9.9",
    "11.0.0.0",
    "11.255.255.255",
  ]) {
    assert.equal(grants.check(address, "ipv4"), false, address);
  }
  for (const address of ["1.1.1.1", "8.8.7.255", "8.8.9.0", "9.9.9.8", "9.9.9.10", "12.0.0.0"]) {
    assert.equal(grants.check(address, "ipv4"), true, address);
  }
  assert.equal(grants.check("2001:4860:4860::8888", "ipv6"), false);
});

test("overlapping exclusions preserve address boundaries and a full denial emits no grant", () => {
  const grants = grantedAddresses(
    compile({ denyCidrs: ["8.8.8.4/30", "8.8.8.5/32", "8.8.8.8/31", "8.8.8.10/32"] }),
  );
  for (let last = 0; last <= 15; last += 1) {
    assert.equal(grants.check(`8.8.8.${last}`, "ipv4"), last < 4 || last > 10, `8.8.8.${last}`);
  }
  assert.deepEqual(compile({ denyCidrs: ["0.0.0.0/0", "::/0"] }), {});
});

test("trusted subdomain requirements retain recursive DNS semantics without broadening Agent hosts", () => {
  const policy = compile({
    revision: {
      gatewayOutbound: {
        selection: { mode: "restricted", hosts: ["clawhub.ai"] },
        requirements: [
          {
            source: "slack",
            destinations: [{ host: "slack.com", includeSubdomains: true }],
          },
        ],
        denyCidrs: [],
      },
    },
  });
  const endpoints = policy["oce-application"].endpoints;
  // Native OpenShell distinguishes '*' (one label) from '**' (recursive).
  // OCE's includeSubdomains includes the apex and every descendant label depth.
  assert.deepEqual(
    endpoints.map((entry) => entry.host),
    ["clawhub.ai", "slack.com", "**.slack.com"],
  );
  for (const entry of endpoints) {
    assert.deepEqual(entry.ports, [443]);
    assert.equal(entry.protocol, "tcp");
    assert.equal(entry.tls, "NETWORK_TLS_MODE_SKIP");
    // Native TCP admission rejects L7-only enforcement settings. This is a
    // connection allowlist, not an HTTP inspection policy.
    assert.equal(Object.hasOwn(entry, "enforcement"), false);
  }
});

test("generated private runtime peers grant only their exact endpoint and never widen public grants", () => {
  const policy = compile({
    runtimePeers: [{ host: "harness.agent.svc", port: 4500, allowedIps: ["10.42.0.7/32"] }],
  });
  const runtime = grantedAddresses(policy, "harness.agent.svc", 4500);
  assert.equal(runtime.check("10.42.0.7", "ipv4"), true);
  assert.equal(runtime.check("10.42.0.8", "ipv4"), false);
  assert.equal(grantedAddresses(policy).check("10.42.0.7", "ipv4"), false);
  assert.equal(
    grantedAddresses(policy, "harness.agent.svc", 443).check("10.42.0.7", "ipv4"),
    false,
  );
});

test("unsupported authority and malformed requirements or generated peers fail closed", () => {
  for (const input of [
    { selection: { mode: "publicHttps" } },
    { selection: { mode: "restricted", hosts: ["*.example.com"] } },
    { mandatoryDenyCidrs: [] },
    { mandatoryDenyCidrs: FORBIDDEN_IPV4 },
    { mandatoryDenyCidrs: FORBIDDEN_IPV6 },
    { denyCidrs: ["8.8.8.8/33"] },
    { denyCidrs: ["::/129"] },
    {
      revision: {
        gatewayOutbound: {
          selection: { mode: "channelsOnly" },
          requirements: [
            {
              source: "bad source",
              destinations: [{ host: "example.com", includeSubdomains: false }],
            },
          ],
          denyCidrs: [],
        },
      },
    },
    { runtimePeers: [{ host: "harness.agent.svc", port: 4500, allowedIps: ["10.42.0.0/24"] }] },
    { runtimePeers: [{ host: "harness.agent.svc", port: 4500, allowedIps: ["127.0.0.1"] }] },
    { runtimePeers: [{ host: "harness.agent.svc", port: 4500, allowedIps: ["169.254.169.254"] }] },
    { runtimePeers: [{ host: "harness.agent.svc", port: 4500, allowedIps: ["::1"] }] },
    { runtimePeers: [{ host: "example.com", port: 443, allowedIps: ["10.42.0.7"] }] },
    {
      runtimePeers: [
        { host: "harness.agent.svc", port: 4500, allowedIps: ["10.42.0.7"] },
        { host: "harness.agent.svc", port: 4500, allowedIps: ["10.42.0.8"] },
      ],
    },
  ]) {
    assert.throws(() => compile(input), /OpenShell application network policy/);
  }
});

test("dual-stack public destinations admit public AAAA answers but no IPv6 special-purpose ranges", () => {
  const grants = grantedAddresses(compile(), "example.com", 443, "ipv6");
  // A native endpoint validates all DNS answers. Public A and AAAA records of
  // the same admitted host must both be eligible without admitting private IPs.
  for (const address of [
    "2606:4700:4400::ac40:9be",
    "2a06:98c1:54::ac40:9bc4",
    "2001:4860:4860::8888",
  ]) {
    assert.equal(grants.check(address, "ipv6"), true, address);
  }
  for (const address of [
    "::",
    "::1",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "64:ff9b:1::808:808",
    "100::1",
    "2001::1",
    "2001:db8::1",
    "2002:c000:201::1",
    "3fff::1",
    "fc00::1",
    "fe80::1",
    "fec0::1",
    "ff02::1",
    "1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "4000::1",
  ]) {
    assert.equal(grants.check(address, "ipv6"), false, address);
  }
});

test("admitted and current IPv6 exclusions retain exact 128-bit address boundaries", () => {
  const policy = compile({
    revision: {
      gatewayOutbound: {
        selection: { mode: "restricted", hosts: ["example.com"] },
        requirements: [],
        denyCidrs: ["2606:4700:4400::4/126", "2606:4700:4400::5/128"],
      },
    },
    denyCidrs: ["2606:4700:4400::8/127", "2606:4700:4400::a/128"],
  });
  const grants = grantedAddresses(policy, "example.com", 443, "ipv6");
  for (let last = 0; last <= 15; last += 1) {
    const address = `2606:4700:4400::${last.toString(16)}`;
    assert.equal(grants.check(address, "ipv6"), last < 4 || last > 10, address);
  }
  for (const cidr of [
    "2606:::1/64",
    "2606:4700::/129",
    "2001:db8::%eth0/64",
    "::ffff:256.0.0.1/128",
  ]) {
    assert.throws(() => compile({ denyCidrs: [cidr] }), /OpenShell application network policy/);
  }
});

test("an absent admitted snapshot grants only explicitly generated runtime peers", () => {
  assert.deepEqual(compile({ revision: {} }), {});
  const policy = compile({
    revision: {},
    runtimePeers: [{ host: "harness.agent.svc", port: 4500, allowedIps: ["10.42.0.7"] }],
  });
  assert.deepEqual(
    policy["oce-application"].endpoints.map((entry) => entry.host),
    ["harness.agent.svc"],
  );
});

test("generated embedded model endpoints remain exact public HTTPS grants", () => {
  const policy = compile({ revision: {}, generatedPublicHosts: ["api.openai.com"] });
  const endpoints = policy["oce-application"].endpoints;
  assert.deepEqual(
    endpoints.map((entry) => entry.host),
    ["api.openai.com"],
  );
  assert.deepEqual(endpoints[0].ports, [443]);
  assert.equal(grantedAddresses(policy, "api.openai.com").check("1.1.1.1", "ipv4"), true);
  assert.equal(grantedAddresses(policy, "api.openai.com").check("10.42.0.7", "ipv4"), false);
  assert.throws(
    () => compile({ generatedPublicHosts: ["https://api.openai.com/v1"] }),
    /OpenShell application network policy/,
  );
});

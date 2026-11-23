import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  CHANNEL_EGRESS_FORWARD_CLUSTER,
  CHANNEL_EGRESS_IMAGE,
  channelEgressFilterChain,
  embeddedTeamsPolicy,
} from "../../apps/controller/src/drivers/compute/kubernetes/channel-egress-policy.ts";
import { channelEgressOptions } from "../helpers/channel-egress.ts";
import { temporaryDirectory } from "../fixtures/repository-credentials/process.ts";
import { createModelProbeCertificates } from "../helpers/runtime-model-probe-certificates.ts";
import { runDocker } from "../helpers/runtime-image-docker.ts";

export async function verifyEmbeddedHttpsPolicy(t: TestContext, runtimeImage: string) {
  const directory = await temporaryDirectory(t, "oce-embedded-https-");
  const restrictedPort = 10001;
  const broadPort = 10002;
  const publicIp = "11.0.0.1";
  const installationIp = "11.0.0.2";
  const names = [
    "exact.test",
    "child.example.test",
    "deep.child.example.test",
    "example.test",
    "other.test",
    "badexample.test",
  ];
  await createModelProbeCertificates({
    directory,
    caName: "Embedded HTTPS fixture",
    dnsNames: names,
  });
  const options = { ...channelEgressOptions, excludedCidrs: [installationIp + "/32"] };
  function listener(port: number, hosts: string[]) {
    const name = "fixture-" + port;
    return {
      name,
      address: { socket_address: { address: "127.0.0.1", port_value: port } },
      default_filter_chain: channelEgressFilterChain(name, embeddedTeamsPolicy([], hosts), options),
    };
  }
  const config = join(directory, "envoy.json");
  await writeFile(
    config,
    JSON.stringify({
      static_resources: {
        listeners: [
          listener(restrictedPort, ["exact.test", "*.example.test"]),
          listener(broadPort, ["*"]),
        ],
        clusters: [CHANNEL_EGRESS_FORWARD_CLUSTER],
      },
    }),
  );
  const envoy = "oce-policy-" + randomUUID();
  const origin = envoy + "-origin";
  // All upstreams are local to a disposable network namespace with no external route.
  await runDocker([
    "run",
    "-d",
    "--rm",
    "--name",
    envoy,
    "--network",
    "none",
    ...names.flatMap((name) => ["--add-host", name + ":" + publicIp]),
    "--add-host",
    "private.example.test:127.0.0.1",
    "--add-host",
    "installation.test:" + installationIp,
    "-v",
    config + ":/fixture.json:ro",
    CHANNEL_EGRESS_IMAGE,
    "-c",
    "/fixture.json",
  ]);
  t.after(() => runDocker(["rm", "-f", envoy]));
  const network = "container:" + envoy;
  // Assign public-looking addresses to this loopback interface only, so both
  // the allowed address and the Installation exclusion have a reachable origin.
  await runDocker([
    "run",
    "--rm",
    "--network",
    network,
    "--cap-add",
    "NET_ADMIN",
    "busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662",
    "sh",
    "-ec",
    'for address do ip addr add "$address/32" dev lo; done',
    "assign",
    publicIp,
    installationIp,
  ]);
  await runDocker([
    "run",
    "-d",
    "--rm",
    "--name",
    origin,
    "--network",
    network,
    "--user",
    "0",
    "-v",
    directory + ":/fixture:ro",
    "--entrypoint",
    "openssl",
    runtimeImage,
    "s_server",
    "-quiet",
    "-accept",
    "443",
    "-key",
    "/fixture/key.pem",
    "-cert",
    "/fixture/cert.pem",
    "-www",
  ]);
  t.after(() => runDocker(["rm", "-f", origin]));
  async function probe(proxyPort: number, host: string, port = 443) {
    // curl reports both the proxy and origin status even when CONNECT or TLS fails.
    const { stdout } = await runDocker(
      [
        "exec",
        origin,
        "sh",
        "-c",
        'curl "$@" || :',
        "probe",
        "--silent",
        "--output",
        "/dev/null",
        "--write-out",
        "%{http_connect} %{http_code} %{exitcode}",
        "--max-time",
        "8",
        "--noproxy",
        "",
        "--proxy",
        "http://127.0.0.1:" + proxyPort,
        "--cacert",
        "/fixture/ca.pem",
        `https://${host}:${port}/`,
      ],
      { encoding: "utf8" },
    );
    return stdout.trim();
  }
  for (const host of ["exact.test", "child.example.test", "deep.child.example.test"]) {
    assert.equal(await probe(restrictedPort, host), "200 200 0", host);
  }
  // Warming the shared forward cluster through the wildcard must not authorize
  // the same authority on the restrictive listener, even for the suffix apex.
  for (const host of ["example.test", "badexample.test", "other.test"]) {
    assert.equal(await probe(broadPort, host), "200 200 0", host);
    assert.match(await probe(restrictedPort, host), /^403 000 /, host);
  }
  assert.match(await probe(broadPort, "other.test", 8443), /^403 000 /);
  // CONNECT permits a public IPv4 literal, but the DNS-only certificate must fail host validation.
  assert.equal(await probe(broadPort, publicIp), "200 000 60");
  for (const host of [
    "private.example.test",
    "installation.test",
    installationIp,
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "192.0.2.1",
    "240.0.0.1",
  ]) {
    assert.match(await probe(broadPort, host), /^403 000 /, host);
  }
  assert.match(await probe(restrictedPort, "private.example.test"), /^403 000 /);
}

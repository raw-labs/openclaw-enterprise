import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { createCredentialProxyInstallationConfiguration } from "./installation-driver-configuration.mjs";
import { fileTemporaryDirectory } from "./temporary-directory.mjs";

let composed;

/**
 * Real Installation admission dependencies, shared within a test process. No provider
 * connection or workload starts. Using its Compute validator proves admission only,
 * not Kubernetes enforcement, credential injection, or model execution.
 */
export function loadGatewayAdmissionFixture() {
  composed ??= composeGatewayAdmission();
  return composed;
}

async function composeGatewayAdmission() {
  const directory = fileTemporaryDirectory("oce-gateway-admission-");
  const privateKeyPath = join(directory, "ingress-private.pem");
  const pair = generateKeyPairSync("ed25519");
  await writeFile(privateKeyPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  const configuration = createCredentialProxyInstallationConfiguration();
  delete configuration.drivers.credential_gateway;
  delete configuration.drivers.credential_proxy;
  configuration.backend[0].drivers = { sandbox: configuration.drivers.sandbox.id };
  configuration.drivers.sandbox.useForHarness = false;
  configuration.gatewaySandbox = {
    driverId: configuration.drivers.sandbox.id,
    ingress: { keyId: "current", privateKeyPath },
  };
  configuration.gatewayOutboundPolicyCeiling = { allowPublicHttps: false, hosts: [] };
  const path = join(directory, "installation.json");
  await writeFile(path, JSON.stringify(configuration));
  const loaded = await loadInstallationConfiguration({
    mode: "development",
    environment: { OCC_CONFIG_PATH: path },
  });
  if (loaded === undefined) {
    throw new Error("The Gateway admission fixture requires its configured Installation.");
  }
  return loaded;
}

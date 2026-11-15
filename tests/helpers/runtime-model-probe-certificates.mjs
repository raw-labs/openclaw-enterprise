// @ts-check

import { sharedRsaPrivateKeyPem } from "../fixtures/repository-credentials/shared-keys.mjs";
import { caAndLeaf } from "./certificates.mjs";

// Callers own subprocess policy and cleanup: image tests remove the CA key,
// while the first-Agent smoke retains it. The CA and leaf keys are the process's
// shared fixture keys (shared-keys.mjs); both certificates are minted per call.
/**
 * @param {{directory: string, caName: string, dnsNames?: string[], run?: (command: string, args: string[]) => Promise<unknown>}} options
 */
export async function createModelProbeCertificates({
  directory,
  caName,
  run,
  dnsNames = ["api.openai.com"],
}) {
  /** @type {unknown} */
  const caKeyPem = sharedRsaPrivateKeyPem("model-probe-ca");
  /** @type {unknown} */
  const leafKeyPem = sharedRsaPrivateKeyPem("model-probe-leaf");
  if (typeof caKeyPem !== "string" || typeof leafKeyPem !== "string") {
    throw new Error("Model probe fixture keys must be PEM text");
  }
  await caAndLeaf(directory, {
    caName,
    commonName: dnsNames[0],
    subjectAltName: dnsNames.map((name) => `DNS:${name}`).join(","),
    caKeyPem,
    leafKeyPem,
    ...(run === undefined ? {} : { run }),
  });
}

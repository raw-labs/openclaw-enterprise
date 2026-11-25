import { sharedRsaPrivateKeyPem } from "../fixtures/repository-credentials/shared-keys.ts";
import { caAndLeaf, type OpenSslRunner } from "./certificates.ts";

interface ModelProbeCertificateOptions {
  directory: string;
  caName: string;
  dnsNames?: string[];
  run?: OpenSslRunner | undefined;
  slackStandIn?: boolean;
}

// Callers own subprocess policy and cleanup. The CA and leaf each reuse their
// own process-cached RSA key, and both certificates are minted for every call.
export async function createModelProbeCertificates({
  directory,
  caName,
  run,
  slackStandIn = false,
  dnsNames = slackStandIn ? ["api.openai.com", "slack.com", "wss-primary.slack.com"] : ["api.openai.com"],
}: ModelProbeCertificateOptions): Promise<void> {
  const caKeyPem: unknown = sharedRsaPrivateKeyPem("model-probe-ca");
  const leafKeyPem: unknown = sharedRsaPrivateKeyPem("model-probe-leaf");
  if (typeof caKeyPem !== "string" || typeof leafKeyPem !== "string") {
    throw new Error("Model probe fixture keys must be PEM text");
  }
  await caAndLeaf(directory, {
    caName,
    commonName: dnsNames[0],
    subjectAltName: dnsNames.map((name) => `DNS:${name}`).join(","),
    caKeyPem,
    leafKeyPem,
    run,
  });
}

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import type { createQaAgent, createQaInstallation } from "./qa-installation.mjs";
import { grantQaSecret, registerQaSecret } from "./qa-secrets.ts";
import { waitFor } from "./qa-wait.ts";

export async function verifyQaTeamsRejection(
  fixture: Awaited<ReturnType<typeof createQaInstallation>>,
  agent: Awaited<ReturnType<typeof createQaAgent>>,
) {
  assert.equal(fixture.controlPlane, "kubernetes");

  const base = `/namespaces/${agent.namespaceId}`;
  const agentPath = `${base}/agents/${agent.id}`;
  const configurationPath = `${base}/configurations/${agent.configurationId}`;
  const configuration = await fixture.api("GET", configurationPath);
  const previous = await fixture.api("GET", agentPath);
  const gateway = await fixture.pod(agent, "gateway");
  assert.ok(previous.activeRevisionId);

  // The non-existent app and password reach the real Microsoft OAuth service. A refusal must
  // leave the current revision serving, even though the operator saved the new draft.
  const password = randomBytes(24).toString("hex");
  registerQaSecret(password);
  const name = `${agent.name}-invalid-teams-password`;
  const secret = await fixture.api("POST", `${base}/secrets`, { name, value: password });
  await grantQaSecret(fixture, agent, secret.id, name);
  await fixture.api("PATCH", configurationPath, {
    values: {
      ...configuration.values,
      channels: {
        ...configuration.values.channels,
        msteams: {
          enabled: true,
          appId: randomUUID(),
          appPassword: { source: "env", provider: "default", id: "MSTEAMS_APP_PASSWORD" },
          dmPolicy: "disabled",
          groupPolicy: "disabled",
        },
      },
    },
    secretBindings: {
      ...configuration.secretBindings,
      MSTEAMS_APP_PASSWORD: { source: secret.ref, delivery: { type: "env" } },
    },
  });
  if (agent.preset === "OpenClaw") {
    // Saving the Agent calls Compute admission without contacting Microsoft.
    // The operator must select this exact server-owned ID before it can use Teams.
    const save = () => fixture.api("PATCH", agentPath, { configurationId: agent.configurationId });
    await assert.rejects(save(), /HTTP 400/);
    const installation = structuredClone(fixture.configuration);
    const egress = installation.drivers.compute.configuration.runtime.channelEgress;
    egress.embeddedTeams = { agentId: agent.id, httpsHosts: ["api.openai.com"] };
    await fixture.saveInstallation(installation);
    await save();
  }
  // The Helm update can finish before Envoy serves the reserved OCC listener.
  await waitFor("Microsoft OAuth to reject the Teams credential through Envoy", async () => {
    let unavailable = false;
    await assert.rejects(fixture.api("POST", `${agentPath}/deploy`), (error: Error) => {
      unavailable = error.message.endsWith("HTTP 503 (CHANNEL_CREDENTIAL_UNAVAILABLE)");
      return (
        unavailable || error.message.endsWith("HTTP 400 (CHANNEL_CREDENTIAL_CREDENTIALS_REJECTED)")
      );
    });
    return !unavailable;
  });
  const current = await fixture.api("GET", agentPath);
  assert.equal(current.activeRevisionId, previous.activeRevisionId);
  assert.equal((await fixture.pod(agent, "gateway")).metadata.uid, gateway.metadata.uid);
  await fixture.record(`${agent.preset}-teams-credential-rejection`, {
    agentId: agent.id,
    activeRevisionId: current.activeRevisionId,
    gatewayPodUid: gateway.metadata.uid,
  });
}

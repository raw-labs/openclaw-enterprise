import assert from "node:assert/strict";
import test from "node:test";

import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";

test("Agent validate and create refuse an uncontained Kubernetes Gateway without writing an Agent", async (t) => {
  // Production HTTP/OCC/IAM admission calls the real selected Compute. No provider,
  // Kubernetes client, or permissive capability hook substitutes for containment.
  // This proves admission only; it is not cluster, relay, or runtime proof.
  const options = conformanceKubernetesOptions({
    gatewayTrustedProxyCidrs: ["10.42.0.0/16"],
    runtime: undefined,
  });
  const compute = new KubernetesComputeDriver({
    ...options,
    authentication: { ...options.authentication, mode: "kubeconfig" },
    servicePrincipalCredentials: { mode: "disabled" },
  });
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Contained Gateway admission", { ready: true });
  // Namespace lifecycle uses the existing fixture. Select the unmodified Kubernetes
  // Compute only after that supported ready-namespace setup; admission must not call it.
  fixture.controller.registerDriver(compute);
  fixture.controller.selectDriver("compute", compute.id);
  const agents = `/namespaces/${namespace.id}/agents`;
  const configuration = await fixture.createConfiguration(namespace.id, {});
  const before = fixture.auditSink.events.filter(
    (event: { readonly kind: string }) => event.kind === "mutation",
  ).length;
  const checked = await fixture.request("POST", `${agents}/validate`, {
    body: { executionMode: "dedicated", configuration: { kind: "agent", values: {} } },
  });
  const created = await fixture.request("POST", agents, {
    body: {
      name: "Never uncontained",
      executionMode: "dedicated",
      configurationId: configuration.id,
    },
  });
  assert.equal(checked.status, 400, JSON.stringify(checked.body));
  assert.equal(created.status, 400, JSON.stringify(created.body));
  assert.deepEqual(created.body.error, checked.body.error);
  assert.match(created.body.error.message, /requires selected Gateway containment/);
  assert.deepEqual((await fixture.request("GET", agents)).data, []);
  assert.equal(
    fixture.auditSink.events.filter((event: { readonly kind: string }) => event.kind === "mutation")
      .length,
    before,
  );
});

import { createRequire } from "node:module";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const { KubernetesObjectApi } = require("@kubernetes/client-node");
const { ObjectSerializer } = require("@kubernetes/client-node/dist/serializer.js");

/**
 * API observations for Compute conformance scenarios whose subject is the Harness.
 * The Gateway proxy is assumed healthy. This does not execute SDK HTTP, OpenShell
 * or a CNI; dedicated proxy tests and real integrations own those claims.
 */
export function gatewayProxyApiFixture(base = {}) {
  const resources = new Map();
  const key = ({ kind, metadata }) => [kind, metadata.namespace, metadata.name].join(":");
  const absent = () => Object.assign(new Error("not found"), { statusCode: 404 });
  let version = 0;
  const save = (object) => {
    // Match ObjectApi's real write boundary, including SDK aliases such as ingress._from.
    const stored =
      object.kind === "NetworkPolicy"
        ? ObjectSerializer.serialize(object, "V1NetworkPolicy")
        : structuredClone(object);
    stored.metadata.uid ??= "fixture-" + stored.kind + "-" + stored.metadata.name;
    stored.metadata.resourceVersion ??= String(++version);
    resources.set(key(stored), stored);
    return structuredClone(stored);
  };
  const api = new KubernetesObjectApi({});
  api.read = async (object) => {
    const saved = resources.get(key(object));
    if (saved) {
      return structuredClone(saved);
    }
    if (base.read) {
      return base.read(object);
    }
    throw absent();
  };
  api.create = async (object) => {
    if (object.metadata.labels?.["openclaw.dev/network-profile"] !== "destination-proxy-v1") {
      throw new Error("The proxy API fixture accepts only destination proxy resources.");
    }
    const saved = save(object);
    if (object.kind === "Deployment") {
      const { metadata, spec } = saved;
      const replica = save({
        apiVersion: "apps/v1",
        kind: "ReplicaSet",
        metadata: {
          name: metadata.name + "-rs",
          namespace: metadata.namespace,
          labels: metadata.labels,
          ownerReferences: [
            { kind: "Deployment", name: metadata.name, uid: metadata.uid, controller: true },
          ],
        },
      });
      save({
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          ...spec.template.metadata,
          name: metadata.name + "-pod",
          namespace: metadata.namespace,
          ownerReferences: [
            {
              kind: "ReplicaSet",
              name: replica.metadata.name,
              uid: replica.metadata.uid,
              controller: true,
            },
          ],
        },
        spec: spec.template.spec,
        status: {
          phase: "Running",
          conditions: [{ type: "Ready", status: "True" }],
          containerStatuses: spec.template.spec.containers.map(({ name, image }) => ({
            name,
            image,
            imageID: image,
            ready: true,
            state: { running: {} },
          })),
        },
      });
    }
    return saved;
  };
  api.list = async (
    _version,
    kind,
    namespace,
    _pretty,
    _exact,
    _export,
    _fieldSelector,
    labelSelector,
  ) => {
    const labels = Object.fromEntries(
      (labelSelector ?? "")
        .split(",")
        .filter(Boolean)
        .map((part) => part.split("=")),
    );
    return {
      items: [...resources.values()]
        .filter(
          (object) =>
            object.kind === kind &&
            object.metadata.namespace === namespace &&
            Object.entries(labels).every(
              ([name, value]) => object.metadata.labels?.[name] === value,
            ),
        )
        .map((object) => structuredClone(object)),
    };
  };
  api.delete = async (object, _pretty, _dryRun, _grace, _orphan, _propagation, options) => {
    const saved = resources.get(key(object));
    if (!saved) {
      if (base.delete) {
        return base.delete(object, _pretty, _dryRun, _grace, _orphan, _propagation, options);
      }
      throw absent();
    }
    const preconditions = options?.preconditions;
    if (
      preconditions &&
      (preconditions.uid !== saved.metadata.uid ||
        preconditions.resourceVersion !== saved.metadata.resourceVersion)
    ) {
      throw Object.assign(new Error("changed resource"), { statusCode: 409 });
    }
    resources.delete(key(object));
    if (object.kind === "Deployment") {
      for (const [name, resource] of resources) {
        if (
          ["Pod", "ReplicaSet"].includes(resource.kind) &&
          resource.metadata.namespace === object.metadata.namespace &&
          resource.metadata.labels?.["openclaw.dev/revision"] ===
            object.metadata.labels?.["openclaw.dev/revision"]
        ) {
          resources.delete(name);
        }
      }
    }
    return { status: "Success" };
  };
  api.patch = (...args) => base.patch(...args);
  return api;
}

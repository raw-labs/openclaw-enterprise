import { asRecord } from "@openclaw-enterprise/utils";
import { isDeepStrictEqual } from "node:util";

// Adoption compares specs exactly. Sandboxes created before OCC set the policy were stored as
// NEVER (OpenShell normalizes an unset policy), and they stay adoptable for their revision.
// GetSandbox never returns UNSPECIFIED; it and an absent field are accepted defensively.
const ADOPTABLE_RESTART_POLICIES: ReadonlySet<string | number | undefined> = new Set([
  undefined,
  "SANDBOX_RESTART_POLICY_UNSPECIFIED",
  0,
  "SANDBOX_RESTART_POLICY_NEVER",
  1,
  "SANDBOX_RESTART_POLICY_ALWAYS",
  3,
]);

const PROTOBUF_VALUE_KINDS = new Set([
  "nullValue",
  "numberValue",
  "stringValue",
  "boolValue",
  "structValue",
  "listValue",
]);

function canonicalProtobufValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalProtobufValues);
  }
  const record = asRecord(value);
  if (record === undefined) {
    return value;
  }
  const discriminator = record.kind;
  return Object.fromEntries(
    Object.entries(record)
      .filter(
        ([key]) =>
          key !== "kind" ||
          typeof discriminator !== "string" ||
          !PROTOBUF_VALUE_KINDS.has(discriminator) ||
          !Object.hasOwn(record, discriminator),
      )
      .map(([key, entry]) => [key, canonicalProtobufValues(entry)]),
  );
}

/**
 * Decoding with `oneofs: true` adds a virtual `_field` property naming each set proto3
 * `optional` field, for example `_user_namespaces: "user_namespaces"`. A request never
 * carries those markers, so they are not Sandbox content.
 */
function withoutSyntheticOneofs(
  record: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(
      ([key, value]) => !(key.startsWith("_") && value === key.slice(1)),
    ),
  );
}

function canonicalPolicy(value: unknown): unknown {
  const policy = asRecord(canonicalProtobufValues(value));
  if (policy === undefined) {
    return value;
  }
  const filesystem = asRecord(policy.filesystem);
  const network = asRecord(policy.network_policies);
  const normalized = { ...policy };
  // Proto3 omits these defaults on GetSandbox. Normalize only known fields;
  // nonempty grants and include_workdir=true must remain adoption differences.
  if (network !== undefined && Object.keys(network).length === 0) {
    delete normalized.network_policies;
  }
  if (filesystem?.include_workdir === false) {
    const { include_workdir: _default, ...rest } = filesystem;
    normalized.filesystem = rest;
  }
  return normalized;
}

function canonicalSandboxSpec(spec: Readonly<Record<string, unknown>> | undefined): unknown {
  const template = asRecord(spec?.template);
  if (spec === undefined || template === undefined) {
    return spec;
  }
  // The Gateway assigns this epoch. Git continuity verifies it against the supervisor receipt.
  const { provider_attachment_epoch: _epoch, restart_policy: restartPolicy, ...rest } = spec;
  const normalized = withoutSyntheticOneofs(rest);
  if (
    asRecord(normalized.environment) !== undefined &&
    Object.keys(normalized.environment as Record<string, unknown>).length === 0
  ) {
    delete normalized.environment;
  }
  if (Array.isArray(normalized.providers) && normalized.providers.length === 0) {
    delete normalized.providers;
  }
  return {
    ...normalized,
    ...(spec.policy === undefined ? {} : { policy: canonicalPolicy(spec.policy) }),
    ...(ADOPTABLE_RESTART_POLICIES.has(restartPolicy as string | number | undefined)
      ? {}
      : { restart_policy: restartPolicy }),
    template: {
      ...withoutSyntheticOneofs(template),
      driver_config: canonicalProtobufValues(template.driver_config),
    },
  };
}

/** Compare native content without gateway-owned epochs or protobuf decoding markers. */
export function sameOpenShellSandboxSpec(
  left: Readonly<Record<string, unknown>> | undefined,
  right: Readonly<Record<string, unknown>> | undefined,
): boolean {
  return isDeepStrictEqual(canonicalSandboxSpec(left), canonicalSandboxSpec(right));
}

import { Type } from "typebox";
import { NamespaceId, AgentId, RevisionId, Timestamp } from "./common.ts";

const token = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});
const meta = Type.Object({ requestId: Type.String() }, { additionalProperties: false });
export const TemporaryEnvironmentParams = Type.Object(
  { namespaceId: NamespaceId, agentId: AgentId, requestId: token },
  { additionalProperties: false },
);
export const AcquireTemporaryEnvironmentBody = Type.Object(
  {
    requestId: token,
    name: token,
    slug: token,
    profileId: token,
    sshPublicKey: Type.String({
      minLength: 80,
      maxLength: 80,
      pattern: "^ssh-ed25519 [A-Za-z0-9+/]{68}$",
    }),
  },
  { additionalProperties: false },
);
const environment = Type.Object(
  {
    id: Type.String({ pattern: "^tenv_[0-9a-f-]{36}$" }),
    namespaceId: NamespaceId,
    agentId: AgentId,
    revisionId: RevisionId,
    requestId: token,
    name: token,
    slug: token,
    profileId: token,
    state: Type.Union([
      Type.Literal("reserved"),
      Type.Literal("provisioning"),
      Type.Literal("ready"),
      Type.Literal("deleting"),
      Type.Literal("deleted"),
    ]),
    createdAt: Timestamp,
    hardExpiresAt: Timestamp,
    idleExpiresAt: Timestamp,
    cpuMillis: Type.Integer({ minimum: 1 }),
    memoryMiB: Type.Integer({ minimum: 1 }),
    usable: Type.Boolean(),
    ssh: Type.Optional(
      Type.Object(
        {
          host: Type.String({ minLength: 1, maxLength: 253 }),
          port: Type.Integer({ minimum: 1, maximum: 65535 }),
          user: Type.String({ minLength: 1, maxLength: 64 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export const TemporaryEnvironmentResponse = Type.Object(
  { data: environment, meta },
  { additionalProperties: false },
);
export const TemporaryEnvironmentListResponse = Type.Object(
  { data: Type.Array(environment), meta },
  { additionalProperties: false },
);
export const TemporaryEnvironmentReadinessResponse = Type.Object(
  {
    data: Type.Object(
      {
        supported: Type.Boolean(),
        profiles: Type.Array(
          Type.Object(
            {
              id: token,
              cpuMillis: Type.Integer({ minimum: 1 }),
              memoryMiB: Type.Integer({ minimum: 1 }),
              lifetimeSeconds: Type.Integer({ minimum: 1, maximum: 86400 }),
              idleTimeoutSeconds: Type.Integer({ minimum: 1, maximum: 86400 }),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    meta,
  },
  { additionalProperties: false },
);

import {
  requireConfiguration,
  type ChannelCredentialReader,
  type ChannelDirectoryLookupInput,
  type ChannelDirectoryResult,
  type ChannelDriver,
  type ErrorDetail,
  type JSONSchema,
  type NetworkDestinationRule,
} from "@openclaw-enterprise/contracts";
import {
  ChannelCredentialError,
  ChannelDirectoryError,
  ResourceStateConflictError,
  secretInputReference,
} from "@openclaw-enterprise/occ";
import { asRecord, deepFreeze, readCappedBody } from "@openclaw-enterprise/utils";

import type { ChannelRequest } from "./transport.ts";

const GRAPH = "https://graph.microsoft.com";
const BOT_CONNECTOR = "https://api.botframework.com";
const REQUEST_TIMEOUT_MS = 8_000;
const DIRECTORY_HOSTS = ["login.microsoftonline.com", "graph.microsoft.com"];
const BOT_HOSTS = ["login.botframework.com", "api.botframework.com", "smba.trafficmanager.net"];
const STORAGE_HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:sharepoint(?:-df)?\.com|1drv\.com|onedrive\.com|blob\.core\.windows\.net)$/;
const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/** Teams lookups need the bot's app and tenant and the Entra group UUID of one Team. */
const TEAMS_DIRECTORY_CONTEXT_SCHEMA: JSONSchema = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: ["appId", "tenantId", "teamId"],
  properties: {
    appId: { type: "string", pattern: UUID_PATTERN },
    tenantId: { type: "string", pattern: UUID_PATTERN },
    teamId: { type: "string", pattern: UUID_PATTERN },
  },
});

function httpsDestinations(hosts: readonly string[]): NetworkDestinationRule[] {
  return hosts.map((name) => ({
    destination: { kind: "dns", name, match: "exact" },
    ports: [443],
  }));
}

export function teamsDirectoryDestinations(): readonly NetworkDestinationRule[] {
  return httpsDestinations(DIRECTORY_HOSTS);
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL = /^19:[^\s]{1,170}@thread\.(?:tacv2|skype)$/;
const MAX_PAGES = 3;

function text(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    ? value
    : undefined;
}

/** `drivers.channel[].configuration` for `teams-channel`. */
export interface TeamsChannelConfiguration {
  /** Exact storage and redirect hosts that Teams Gateways may reach for attachment downloads. */
  readonly fileHosts?: readonly string[];
}

export interface TeamsChannelDriverOptions {
  readonly request?: ChannelRequest;
  /** Production refuses provider requests when the managed OCC listener is absent. */
  readonly proxyMissing?: boolean;
}

/** Teams bot credential validation, egress destinations, and Team-scoped directory lookup. */
export class TeamsChannelDriver implements ChannelDriver {
  readonly capability = "channel" as const;
  readonly id = "teams-channel";
  readonly implementation = "occ/teams-channel";

  static readonly configurationSchema: JSONSchema = deepFreeze({
    type: "object",
    additionalProperties: false,
    properties: {
      fileHosts: {
        type: "array",
        maxItems: 32,
        items: { type: "string", minLength: 1, maxLength: 253 },
      },
    },
  });

  directoryContextSchema(): JSONSchema {
    return TEAMS_DIRECTORY_CONTEXT_SCHEMA;
  }

  static validateConfiguration(
    configuration: Readonly<TeamsChannelConfiguration>,
  ): readonly ErrorDetail[] {
    const hosts = configuration.fileHosts ?? [];
    return hosts.flatMap((host, index): ErrorDetail[] =>
      !STORAGE_HOST.test(host)
        ? [
            {
              path: `/fileHosts/${index}`,
              code: "INVALID_VALUE",
              message:
                "must be an exact lowercase subdomain of sharepoint.com, sharepoint-df.com, 1drv.com, onedrive.com or blob.core.windows.net",
            },
          ]
        : hosts.indexOf(host) !== index
          ? [{ path: `/fileHosts/${index}`, code: "INVALID_VALUE", message: "must be unique" }]
          : [],
    );
  }

  private readonly request: ChannelRequest;
  private readonly proxyMissing: boolean;
  private readonly fileHosts: readonly string[];

  constructor(
    configuration: Readonly<TeamsChannelConfiguration> = {},
    options: TeamsChannelDriverOptions = {},
  ) {
    this.fileHosts = Object.freeze([
      ...(requireConfiguration(TeamsChannelDriver, configuration).fileHosts ?? []),
    ]);
    this.request = options.request ?? globalThis.fetch;
    this.proxyMissing = options.proxyMissing === true;
  }

  enableRouting(): readonly NetworkDestinationRule[] {
    return [
      ...teamsDirectoryDestinations(),
      ...httpsDestinations([...BOT_HOSTS, ...this.fileHosts]),
    ];
  }

  async validateCredentials(
    values: Readonly<Record<string, unknown>>,
    withSecret: ChannelCredentialReader,
  ): Promise<void> {
    const teams = asRecord(asRecord(values.channels)?.msteams);
    if (teams === undefined || teams.enabled === false) {
      return;
    }
    const field = "/channels/msteams/appPassword";
    const ref = secretInputReference(teams.appPassword, values.secrets);
    if (ref === undefined || !("variable" in ref)) {
      throw new ChannelCredentialError("binding_required", field);
    }
    const appId = typeof teams.appId === "string" ? teams.appId.trim() : "";
    const tenantId = typeof teams.tenantId === "string" ? teams.tenantId.trim() : undefined;
    if (!GUID.test(appId)) {
      throw new ChannelCredentialError("credentials_rejected", "/channels/msteams/appId");
    }
    if (teams.tenantId !== undefined && (tenantId === undefined || !GUID.test(tenantId))) {
      throw new ChannelCredentialError("credentials_rejected", "/channels/msteams/tenantId");
    }
    if (this.proxyMissing || (teams.cloud !== undefined && teams.cloud !== "Public")) {
      throw new ChannelCredentialError("unavailable", field);
    }
    await withSecret(ref.variable, field, async (password) => {
      try {
        // Use the messaging scope. Directory consent is optional for a messaging-only bot.
        await this.accessToken(
          tenantId ?? "botframework.com",
          appId,
          password.trim(),
          BOT_CONNECTOR,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        );
      } catch (error) {
        throw new ChannelCredentialError(
          error instanceof ChannelDirectoryError && error.reason === "credentials_rejected"
            ? "credentials_rejected"
            : "unavailable",
          field,
        );
      }
    });
  }

  private async call(
    url: URL,
    options: Parameters<ChannelRequest>[1],
    oauth = false,
  ): Promise<Record<string, unknown>> {
    let response: Awaited<ReturnType<ChannelRequest>>;
    try {
      response = await this.request(url, { ...options, redirect: "error" });
    } catch {
      throw new ChannelDirectoryError("unavailable");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
    }
    if (response.status === 429) {
      throw new ChannelDirectoryError("rate_limited");
    }
    if (response.status === 401 || (oauth && response.status === 400)) {
      throw new ChannelDirectoryError("credentials_rejected");
    }
    if (response.status === 403) {
      throw new ChannelDirectoryError("missing_scope");
    }
    if (!response.ok) {
      throw new ChannelDirectoryError("unavailable");
    }
    // Bound consumption, not just parsing: a bad provider must not exhaust API memory.
    let body: Record<string, unknown> | undefined;
    try {
      const bytes = await readCappedBody(response.body, 2_000_000);
      body = bytes === undefined ? undefined : asRecord(JSON.parse(bytes.toString("utf8")));
    } catch {
      throw new ChannelDirectoryError("invalid_response");
    }
    if (!body) {
      throw new ChannelDirectoryError("invalid_response");
    }
    return body;
  }

  private async accessToken(
    tenant: string,
    appId: string,
    password: string,
    resource: string,
    signal: AbortSignal,
  ): Promise<string> {
    const auth = await this.call(
      new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`),
      {
        method: "POST",
        signal,
        body: new URLSearchParams({
          client_id: appId,
          client_secret: password,
          grant_type: "client_credentials",
          scope: `${resource}/.default`,
        }),
      },
      true,
    );
    if (
      typeof auth.access_token !== "string" ||
      !auth.access_token ||
      auth.access_token.length > 32_768
    ) {
      throw new ChannelDirectoryError("invalid_response");
    }
    return auth.access_token;
  }

  async lookupDirectory(
    input: ChannelDirectoryLookupInput,
    signal?: AbortSignal,
  ): Promise<ChannelDirectoryResult> {
    if (this.proxyMissing) {
      throw new ResourceStateConflictError(
        "Managed channel egress is not configured for OCC provider requests. Ask an Installation administrator to enable the channel egress fleet.",
      );
    }
    // OCC validated context against `directoryContextSchema()` before this call.
    const { appId = "", tenantId = "", teamId = "" } = input.context ?? {};
    const path = `/v1.0/teams/${teamId}/${input.kind === "users" ? "members" : "channels"}`;
    const query = (input.query ?? "").trim().toLocaleLowerCase();
    const scope = JSON.stringify([appId, tenantId, teamId, input.kind, query]);
    let skip: string | undefined;
    let offset = 0;
    if (input.cursor !== undefined) {
      try {
        const cursor = asRecord(
          JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
        );
        if (
          cursor?.scope !== scope ||
          (cursor.skip !== undefined &&
            (typeof cursor.skip !== "string" ||
              cursor.skip.length === 0 ||
              cursor.skip.length > 800)) ||
          !Number.isInteger(cursor.offset) ||
          (cursor.offset as number) < 0 ||
          (cursor.offset as number) > 1000
        ) {
          throw new Error("invalid cursor");
        }
        skip = cursor.skip as string | undefined;
        offset = cursor.offset as number;
      } catch {
        throw new ChannelDirectoryError("invalid_request");
      }
    }
    const boundedSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    // The native Teams plugin trims the password, as the deploy check does.
    const token = await this.accessToken(
      tenantId!,
      appId!,
      input.token.trim(),
      GRAPH,
      boundedSignal,
    );
    const options = {
      signal: boundedSignal,
      headers: { authorization: `Bearer ${token}` },
    };
    // Graph uses the Entra group UUID; native bot routing uses the General channel's ID.
    const primaryUrl = new URL(`/v1.0/teams/${teamId}/primaryChannel`, GRAPH);
    primaryUrl.searchParams.set("$select", "id");
    const primary = await this.call(primaryUrl, options);
    const workspaceId = text(primary.id);
    if (!workspaceId || !CHANNEL.test(workspaceId)) {
      throw new ChannelDirectoryError("invalid_response");
    }
    const candidates = new Map<string, ChannelDirectoryResult["candidates"][number]>();
    const ids = input.ids === undefined ? undefined : new Set(input.ids);
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(path, GRAPH);
      url.searchParams.set(
        "$select",
        input.kind === "users" ? "userId,displayName,email" : "id,displayName,membershipType",
      );
      if (input.kind === "users") {
        url.searchParams.set("$top", "100");
      }
      if (skip !== undefined) {
        url.searchParams.set("$skiptoken", skip);
      }
      const body = await this.call(url, options);
      if (!Array.isArray(body.value) || body.value.length > (input.kind === "users" ? 100 : 1000)) {
        throw new ChannelDirectoryError("invalid_response");
      }
      if (offset > body.value.length) {
        throw new ChannelDirectoryError("invalid_response");
      }
      for (let position = offset; position < body.value.length; position += 1) {
        const entry = asRecord(body.value[position]);
        const id = text(input.kind === "users" ? entry?.userId : entry?.id);
        const name = text(entry?.displayName);
        if (
          !id ||
          !name ||
          !(input.kind === "users" ? GUID : CHANNEL).test(id) ||
          (input.kind === "channels" && entry?.membershipType !== "standard")
        ) {
          continue;
        }
        const email = text(entry?.email);
        if (
          ids
            ? ids.has(id)
            : [id, name, email ?? ""].some((part) => part.toLocaleLowerCase().includes(query))
        ) {
          candidates.set(id, { id, name });
          if (ids === undefined && candidates.size === 100 && position + 1 < body.value.length) {
            const nextCursor = Buffer.from(
              JSON.stringify({ scope, skip, offset: position + 1 }),
            ).toString("base64url");
            return {
              workspaceId,
              candidates: [...candidates.values()],
              complete: false,
              nextCursor,
            };
          }
        }
      }
      skip = undefined;
      offset = 0;
      if (body["@odata.nextLink"] !== undefined) {
        try {
          const next = new URL(body["@odata.nextLink"] as string);
          const value = next.searchParams.get("$skiptoken");
          // Never follow a provider URL: extract a bounded token after checking the scope.
          if (
            next.origin !== GRAPH ||
            next.pathname !== path ||
            next.username ||
            next.password ||
            next.hash ||
            !value ||
            value.length > 800 ||
            [...next.searchParams.keys()].some(
              (key) => !["$skiptoken", "$select", "$top"].includes(key),
            )
          ) {
            throw new Error("invalid next link");
          }
          skip = value;
        } catch {
          throw new ChannelDirectoryError("invalid_response");
        }
      }
      if (skip === undefined || (ids !== undefined && [...ids].every((id) => candidates.has(id)))) {
        return { workspaceId, candidates: [...candidates.values()], complete: true };
      }
      if (ids === undefined && candidates.size > 0) {
        break;
      }
    }
    if (ids !== undefined) {
      // Saved-ID names are best effort: an ID outside the Team, or beyond the pages read,
      // stays an exact ID without a name.
      return { workspaceId, candidates: [...candidates.values()], complete: true };
    }
    if (candidates.size > 100) {
      // A provider batch cannot be partially consumed without losing matches on continuation.
      throw new ChannelDirectoryError("invalid_response");
    }
    return {
      workspaceId,
      candidates: [...candidates.values()],
      complete: false,
      nextCursor: Buffer.from(JSON.stringify({ scope, skip, offset: 0 })).toString("base64url"),
    };
  }
}

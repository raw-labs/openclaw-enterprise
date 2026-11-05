import type {
  ChannelDirectoryLookupInput,
  ChannelDirectoryResult,
  ChannelDriver,
} from "@openclaw-enterprise/contracts";
import { ChannelDirectoryError } from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";

import type { ChannelRequest } from "./transport.ts";

const GRAPH = "https://graph.microsoft.com";
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

/** Read-only RSC lookup: only one selected Team, never the tenant-wide directory. */
export class TeamsChannelDriver implements ChannelDriver {
  readonly capability = "channel" as const;
  readonly id = "teams-channel";
  readonly implementation = "occ/teams-channel";

  private readonly request: ChannelRequest;

  constructor(request: ChannelRequest = globalThis.fetch) {
    this.request = request;
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
    const reader = response.body?.getReader();
    if (!reader) {
      throw new ChannelDirectoryError("invalid_response");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) {
          break;
        }
        size += part.value.byteLength;
        if (size > 2_000_000) {
          await reader.cancel();
          throw new ChannelDirectoryError("invalid_response");
        }
        chunks.push(part.value);
      }
      const body = asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (body) {
        return body;
      }
    } catch {
      throw new ChannelDirectoryError("invalid_response");
    } finally {
      reader.releaseLock();
    }
    throw new ChannelDirectoryError("invalid_response");
  }

  async lookupDirectory(
    input: ChannelDirectoryLookupInput,
    signal?: AbortSignal,
  ): Promise<ChannelDirectoryResult> {
    const { appId, tenantId, teamId } = input.context ?? {};
    if (
      ![appId, tenantId, teamId].every((id) => typeof id === "string" && GUID.test(id)) ||
      Object.keys(input.context ?? {}).some((key) => !["appId", "tenantId", "teamId"].includes(key))
    ) {
      throw new ChannelDirectoryError("invalid_response");
    }
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
        throw new ChannelDirectoryError("invalid_response");
      }
    }
    const boundedSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(8_000)])
      : AbortSignal.timeout(8_000);
    const auth = await this.call(
      new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`),
      {
        method: "POST",
        signal: boundedSignal,
        body: new URLSearchParams({
          client_id: appId!,
          client_secret: input.token,
          grant_type: "client_credentials",
          scope: `${GRAPH}/.default`,
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
    const options = {
      signal: boundedSignal,
      headers: { authorization: `Bearer ${auth.access_token}` },
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
      throw new ChannelDirectoryError("unavailable");
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

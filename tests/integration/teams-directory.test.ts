import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { ChannelDirectoryLookupResponse } from "../../packages/contracts/src/api/resources.ts";
import { createChannelProviders } from "../../apps/controller/src/drivers/channel/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  teamsDirectoryProvider,
  teamsDirectoryContext,
  teamsNativeId,
  teamsMemberId,
} from "../helpers/teams-directory.ts";

test("Teams rejects an invalid bot password before the Agent deploys", async (t) => {
  const provider = await teamsDirectoryProvider(t);
  const oauth = `/${teamsDirectoryContext.tenantId}/oauth2/v2.0/token`;
  provider.routes.set(oauth, {
    status: 401,
    body: { error: "invalid_client", error_description: "private Microsoft diagnostic" },
  });
  const fixture = await createConsoleAppFixture(t, {
    channelDrivers: createChannelProviders(undefined, { teamsRequest: provider.request }),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Teams deployment", { ready: true });
  const password = await fixture.createSecret(
    namespace.id,
    "Teams bot password",
    "bad-test-password",
  );
  const agent = await fixture.createAgent(
    namespace.id,
    "Teams credential check",
    {
      channels: {
        msteams: {
          enabled: true,
          appId: teamsDirectoryContext.appId,
          tenantId: teamsDirectoryContext.tenantId,
          appPassword: { source: "env", provider: "default", id: "MSTEAMS_APP_PASSWORD" },
        },
      },
    },
    {
      executionMode: "dedicated",
      secretBindings: { MSTEAMS_APP_PASSWORD: { source: password.ref, delivery: { type: "env" } } },
    },
  );
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const rejected = await fixture.request("POST", `${path}/deploy`);
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, "CHANNEL_CREDENTIAL_CREDENTIALS_REJECTED");
  assert.doesNotMatch(
    JSON.stringify(rejected.body),
    /bad-test-password|private Microsoft diagnostic/,
  );
  assert.equal(provider.calls.length, 1);
  const form = new URLSearchParams(provider.calls[0]!.body);
  assert.equal(form.get("scope"), "https://api.botframework.com/.default");
  assert.equal(form.get("client_secret"), "bad-test-password");
  assert.equal((await fixture.request("GET", `${path}/revisions`)).body.data.length, 0);
});

test("two embedded Agents independently save Teams configurations under one Installation opt-in", async (t) => {
  const fixture = await createConsoleAppFixture(t, {
    computeImplementation: "kubernetes-local",
    channelRuntime: true,
    experimentalEmbeddedChannels: true,
    channelDrivers: createChannelProviders(),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Embedded Teams", { ready: true });
  const values = {
    agents: {
      defaults: {
        model: "openai/gpt-4.1",
        models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
      },
    },
    channels: {
      msteams: {
        enabled: true,
        appId: teamsDirectoryContext.appId,
        appPassword: { source: "env", provider: "default", id: "MSTEAMS_APP_PASSWORD" },
      },
    },
  };
  // Both ordinary Agent creates use the same Installation and distinct Configuration and Secret resources.
  const agents = [];
  for (const name of ["First Teams Agent", "Second Teams Agent"]) {
    const password = await fixture.createSecret(
      namespace.id,
      name + " password",
      "synthetic-password",
    );
    agents.push(
      await fixture.createAgent(
        namespace.id,
        name,
        { ...values, channels: { msteams: { ...values.channels.msteams, appId: randomUUID() } } },
        {
          executionMode: "embedded",
          secretBindings: {
            MSTEAMS_APP_PASSWORD: { source: password.ref, delivery: { type: "env" } },
          },
        },
      ),
    );
  }
  const [first, second] = agents;
  assert.ok(first && second);
  assert.notEqual(first.id, second.id);
  const configurations = `/namespaces/${namespace.id}/configurations`;
  const disabled = await fixture.request("PATCH", `${configurations}/${first.configurationId}`, {
    body: { values: { ...values, channels: { msteams: { enabled: false } } } },
  });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  const independent = await fixture.request("GET", `${configurations}/${second.configurationId}`);
  assert.equal(independent.status, 200);
  assert.equal(independent.body.data.values.channels.msteams.enabled, true);
});

test("Agent-scoped Teams lookup uses the authorized password and Team roster, then saves native access IDs", async (t) => {
  const provider = await teamsDirectoryProvider(t);
  const providers = createChannelProviders(undefined, { teamsRequest: provider.request });
  const fixture = await createConsoleAppFixture(t, { channelDrivers: providers });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Teams lookup", { ready: true });
  // A Secret created from a file often ends in a newline. The native Teams plugin trims the
  // password, and so do the deploy check and the lookup.
  const password = await fixture.createSecret(
    namespace.id,
    "Teams app password",
    "synthetic-teams-app-password\n",
  );
  const agent = await fixture.createAgent(namespace.id, "Teams Agent");
  const path = `/namespaces/${namespace.id}/channel-directory/lookup`;
  const body = {
    provider: "msteams",
    secretId: password.id,
    agentId: agent.id,
    context: teamsDirectoryContext,
  };
  const channels = await fixture.request("POST", path, { body: { ...body, kind: "channels" } });
  const channelsData = fixture.fixtureResponse(
    channels,
    200,
    ChannelDirectoryLookupResponse,
    "Teams directory lookup",
  ).data;
  assert.equal(channels.status, 200, JSON.stringify(channels.body));
  assert.equal(channelsData.workspaceId, teamsNativeId);
  assert.deepEqual(
    channelsData.candidates.map((candidate) => candidate.name),
    ["General", "Engineering"],
  );
  // The membership entry ID cannot be used as a bot sender allowlist ID.
  const members = await fixture.request("POST", path, {
    body: { ...body, kind: "users", query: "alex" },
  });
  const membersData = fixture.fixtureResponse(
    members,
    200,
    ChannelDirectoryLookupResponse,
    "Teams directory lookup",
  ).data;
  assert.equal(members.status, 200, JSON.stringify(members.body));
  assert.deepEqual(membersData.candidates, [{ id: teamsMemberId, name: "Alex Chen" }]);
  const oauth = provider.calls.find((call) => call.method === "POST");
  assert.ok(oauth);
  const form = new URLSearchParams(oauth.body);
  assert.equal(form.get("client_secret"), "synthetic-teams-app-password");
  assert.equal(form.get("scope"), "https://graph.microsoft.com/.default");
  assert.ok(
    provider.calls
      .filter((call) => call.method === "GET")
      .every(
        (call) =>
          call.url.pathname.startsWith(provider.path + "/") &&
          call.headers.authorization === "Bearer synthetic-graph-access-token",
      ),
  );
  assert.doesNotMatch(
    JSON.stringify([channels.body, members.body]),
    /synthetic-teams-app-password|synthetic-graph-access-token|opaque-membership-id/,
  );
  const engineering = channelsData.candidates[1];
  assert.ok(engineering);
  const configuration = await fixture.updateConfiguration(namespace.id, agent.configurationId, {
    channels: {
      msteams: {
        enabled: true,
        appId: teamsDirectoryContext.appId,
        tenantId: teamsDirectoryContext.tenantId,
        appPassword: { source: "env", provider: "default", id: "MSTEAMS_APP_PASSWORD" },
        teams: {
          [channelsData.workspaceId]: {
            channels: { [engineering.id]: { requireMention: true } },
          },
        },
        groupPolicy: "allowlist",
        groupAllowFrom: membersData.candidates.map((candidate) => candidate.id),
        dmPolicy: "disabled",
      },
    },
  });
  const values = configuration.values;
  const savedTeams = Type.Object({
    channels: Type.Object({
      msteams: Type.Object({
        groupAllowFrom: Type.Array(Type.String()),
        teams: Type.Record(Type.String(), Type.Unknown()),
      }),
    }),
  });
  assert.ok(Check(savedTeams, values));
  assert.deepEqual(values.channels.msteams.groupAllowFrom, [teamsMemberId]);
  assert.ok(values.channels.msteams.teams[teamsNativeId]);
  // A foreign Secret must be rejected before any provider credential or directory I/O.
  const other = await fixture.createNamespace("Other Team", { ready: true });
  const foreign = await fixture.createSecret(
    other.id,
    "Foreign password",
    "synthetic-foreign-password",
  );
  const before = provider.calls.length;
  const denied = await fixture.request("POST", path, {
    body: { ...body, secretId: foreign.id, kind: "users" },
  });
  assert.notEqual(denied.status, 200);
  assert.equal(provider.calls.length, before);
  // Context is Teams-owned caller input: an unknown key is refused before any Microsoft request.
  const unknownContext = await fixture.request("POST", path, {
    body: { ...body, kind: "users", context: { ...teamsDirectoryContext, tenant: "extra" } },
  });
  assert.equal(unknownContext.status, 400, JSON.stringify(unknownContext.body));
  assert.equal(unknownContext.body.error.code, "INVALID_REQUEST");
  // Slack uses no context, so a Slack lookup with Teams context never reaches Slack.
  const slackWithContext = await fixture.request("POST", path, {
    body: { ...body, provider: "slack", kind: "users" },
  });
  assert.equal(slackWithContext.status, 400, JSON.stringify(slackWithContext.body));
  // A provider without an installed Driver is unavailable, not a provider response failure.
  const uninstalled = await fixture.request("POST", path, {
    body: { ...body, provider: "discord", kind: "users" },
  });
  assert.equal(uninstalled.status, 501, JSON.stringify(uninstalled.body));
  assert.equal(provider.calls.length, before);
});

test("Teams lookup bounds pagination, rejects foreign continuations, and reports missing consent without changing access", async (t) => {
  const provider = await teamsDirectoryProvider(t);
  const providers = createChannelProviders(undefined, { teamsRequest: provider.request });
  const fixture = await createConsoleAppFixture(t, { channelDrivers: providers });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Teams directory errors", { ready: true });
  const password = await fixture.createSecret(
    namespace.id,
    "Teams app password",
    "synthetic-teams-password",
  );
  const agent = await fixture.createAgent(namespace.id, "Teams Agent");
  const path = `/namespaces/${namespace.id}/channel-directory/lookup`;
  const body = {
    provider: "msteams",
    secretId: password.id,
    configurationId: agent.configurationId,
    context: teamsDirectoryContext,
    kind: "users",
    query: "alex",
  };
  const next = (skip: string) =>
    `https://graph.microsoft.com${provider.path}/members?$skiptoken=${skip}`;
  // Three empty provider pages cannot establish absence. Continue with the same scope.
  provider.routes.set(`${provider.path}/members`, {
    body: { value: [], "@odata.nextLink": next("one") },
  });
  provider.routes.set(`${provider.path}/members?one`, {
    body: { value: [], "@odata.nextLink": next("two") },
  });
  provider.routes.set(`${provider.path}/members?two`, {
    body: { value: [], "@odata.nextLink": next("three") },
  });
  provider.routes.set(`${provider.path}/members?three`, {
    body: { value: [{ id: "membership", userId: teamsMemberId, displayName: "Alex Chen" }] },
  });
  const first = await fixture.request("POST", path, { body });
  const firstData = fixture.fixtureResponse(
    first,
    200,
    ChannelDirectoryLookupResponse,
    "Teams directory lookup",
  ).data;
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(firstData.complete, false);
  const continued = await fixture.request("POST", path, {
    body: { ...body, cursor: firstData.nextCursor },
  });
  const continuedData = fixture.fixtureResponse(
    continued,
    200,
    ChannelDirectoryLookupResponse,
    "Teams directory lookup",
  ).data;
  assert.deepEqual(continuedData.candidates, [{ id: teamsMemberId, name: "Alex Chen" }]);
  // Saved IDs can name people outside the Team. When the bounded pages do not find an ID, the
  // lookup still answers: that ID stays an exact ID without a name, not a directory failure.
  const { query: _query, ...hydrationBody } = body;
  const outsider = "77777777-7777-4777-8777-777777777777";
  const hydrated = await fixture.request("POST", path, {
    body: { ...hydrationBody, ids: [outsider] },
  });
  const hydratedData = fixture.fixtureResponse(
    hydrated,
    200,
    ChannelDirectoryLookupResponse,
    "Teams saved-ID lookup",
  ).data;
  assert.deepEqual(hydratedData, {
    workspaceId: hydratedData.workspaceId,
    candidates: [],
    complete: true,
  });
  // Graph can return more channels than one API result page; continuation must lose none.
  const roster = Array.from({ length: 120 }, (_, index) => ({
    id: `19:channel-${index}@thread.tacv2`,
    displayName: `Channel ${index}`,
    membershipType: "standard",
  }));
  provider.routes.set(`${provider.path}/channels`, { body: { value: roster } });
  const channelBody = { ...body, kind: "channels", query: "" };
  const channelPage = await fixture.request("POST", path, { body: channelBody });
  const channelPageData = fixture.fixtureResponse(
    channelPage,
    200,
    ChannelDirectoryLookupResponse,
    "Teams directory lookup",
  ).data;
  assert.equal(channelPage.status, 200, JSON.stringify(channelPage.body));
  assert.equal(channelPageData.candidates.length, 100);
  const channelRemainder = await fixture.request("POST", path, {
    body: { ...channelBody, cursor: channelPageData.nextCursor },
  });
  const channelRemainderData = fixture.fixtureResponse(
    channelRemainder,
    200,
    ChannelDirectoryLookupResponse,
    "Teams directory lookup",
  ).data;
  assert.equal(channelRemainder.status, 200, JSON.stringify(channelRemainder.body));
  assert.equal(channelRemainderData.complete, true);
  assert.deepEqual(
    [...channelPageData.candidates, ...channelRemainderData.candidates].map(
      (candidate) => candidate.id,
    ),
    roster.map((channel) => channel.id),
  );
  const before = provider.calls.length;
  const changed = await fixture.request("POST", path, {
    body: {
      ...body,
      context: { ...teamsDirectoryContext, teamId: "55555555-5555-4555-8555-555555555555" },
      cursor: firstData.nextCursor,
    },
  });
  // A continuation cursor belongs to one Team; reusing it for another is caller error.
  assert.equal(changed.status, 400, JSON.stringify(changed.body));
  assert.equal(provider.calls.length, before);
  provider.routes.set(`${provider.path}/members`, {
    body: { value: [], "@odata.nextLink": "https://example.com/steal?$skiptoken=one" },
  });
  const foreign = await fixture.request("POST", path, { body });
  assert.equal(foreign.body.error.code, "CHANNEL_DIRECTORY_INVALID_RESPONSE");
  provider.routes.set(`${provider.path}/members`, {
    status: 403,
    body: { error: { message: "synthetic-provider-detail" } },
  });
  const missing = await fixture.request("POST", path, { body });
  assert.equal(missing.body.error.code, "CHANNEL_DIRECTORY_MISSING_SCOPE");
  assert.doesNotMatch(
    JSON.stringify(missing.body),
    /synthetic-provider-detail|synthetic-teams-password/,
  );
  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(configuration.data.generation, 1);
});

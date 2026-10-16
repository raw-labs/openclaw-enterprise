import assert from "node:assert/strict";
import test from "node:test";
import { BundledChannelDriver } from "../../apps/controller/src/drivers/channel/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  teamsDirectoryProvider,
  teamsDirectoryContext,
  teamsNativeId,
  teamsMemberId,
} from "../helpers/teams-directory.mjs";

test("Agent-scoped Teams lookup uses the authorized password and Team roster, then saves native access IDs", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Teams lookup", { ready: true });
  const provider = await teamsDirectoryProvider(t);
  const driver = new BundledChannelDriver(provider.request);
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("channel", driver.id);
  const password = await fixture.createSecret(
    namespace.id,
    "Teams app password",
    "synthetic-teams-app-password",
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
  assert.equal(channels.status, 200, JSON.stringify(channels.body));
  assert.equal(channels.data.workspaceId, teamsNativeId);
  assert.deepEqual(
    channels.data.candidates.map((candidate) => candidate.name),
    ["General", "Engineering"],
  );
  // The membership entry ID cannot be used as a bot sender allowlist ID.
  const members = await fixture.request("POST", path, {
    body: { ...body, kind: "users", query: "alex" },
  });
  assert.equal(members.status, 200, JSON.stringify(members.body));
  assert.deepEqual(members.data.candidates, [{ id: teamsMemberId, name: "Alex Chen" }]);
  const oauth = provider.calls.find((call) => call.method === "POST");
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
  const configuration = await fixture.updateConfiguration(namespace.id, agent.configurationId, {
    channels: {
      msteams: {
        enabled: true,
        appId: teamsDirectoryContext.appId,
        tenantId: teamsDirectoryContext.tenantId,
        appPassword: { source: "env", provider: "default", id: "MSTEAMS_APP_PASSWORD" },
        teams: {
          [channels.data.workspaceId]: {
            channels: { [channels.data.candidates[1].id]: { requireMention: true } },
          },
        },
        groupPolicy: "allowlist",
        groupAllowFrom: members.data.candidates.map((candidate) => candidate.id),
        dmPolicy: "disabled",
      },
    },
  });
  assert.deepEqual(configuration.values.channels.msteams.groupAllowFrom, [teamsMemberId]);
  assert.ok(configuration.values.channels.msteams.teams[teamsNativeId]);
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
});

test("Teams lookup bounds pagination, rejects foreign continuations, and reports missing consent without changing access", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Teams directory errors", { ready: true });
  const provider = await teamsDirectoryProvider(t);
  const driver = new BundledChannelDriver(provider.request);
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("channel", driver.id);
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
  const next = (skip) => `https://graph.microsoft.com${provider.path}/members?$skiptoken=${skip}`;
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
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.data.complete, false);
  const continued = await fixture.request("POST", path, {
    body: { ...body, cursor: first.data.nextCursor },
  });
  assert.deepEqual(continued.data.candidates, [{ id: teamsMemberId, name: "Alex Chen" }]);
  // Graph can return more channels than one API result page; continuation must lose none.
  const roster = Array.from({ length: 120 }, (_, index) => ({
    id: `19:channel-${index}@thread.tacv2`,
    displayName: `Channel ${index}`,
    membershipType: "standard",
  }));
  provider.routes.set(`${provider.path}/channels`, { body: { value: roster } });
  const channelBody = { ...body, kind: "channels", query: "" };
  const channelPage = await fixture.request("POST", path, { body: channelBody });
  assert.equal(channelPage.status, 200, JSON.stringify(channelPage.body));
  assert.equal(channelPage.data.candidates.length, 100);
  const channelRemainder = await fixture.request("POST", path, {
    body: { ...channelBody, cursor: channelPage.data.nextCursor },
  });
  assert.equal(channelRemainder.status, 200, JSON.stringify(channelRemainder.body));
  assert.equal(channelRemainder.data.complete, true);
  assert.deepEqual(
    [...channelPage.data.candidates, ...channelRemainder.data.candidates].map(
      (candidate) => candidate.id,
    ),
    roster.map((channel) => channel.id),
  );
  const before = provider.calls.length;
  const changed = await fixture.request("POST", path, {
    body: {
      ...body,
      context: { ...teamsDirectoryContext, teamId: "55555555-5555-4555-8555-555555555555" },
      cursor: first.data.nextCursor,
    },
  });
  assert.equal(changed.status, 503);
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

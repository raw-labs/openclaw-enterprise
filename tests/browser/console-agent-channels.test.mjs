import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { chromium, webkit } from "playwright";

import { BundledChannelDriver } from "../../apps/controller/src/drivers/channel/index.ts";
import {
  teamsDirectoryProvider,
  teamsDirectoryContext,
  teamsLink,
  teamsMemberId,
} from "../helpers/teams-directory.mjs";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  accessBindingPostRequests,
  apiRequests,
  detailUrl,
  expectNoText,
  fileBrowser,
  login,
  nativeValues,
  newPage,
  nonAuthWriteRequests,
  revealNativeConfiguration,
  secretOptionLabel,
  selectSecret,
  setSlackSelection,
  slackSelectionValue,
  statusTone,
  waitForInputValue,
} from "./console-agents-browser-helpers.mjs";

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();

// A bootstrapped Console with one ready Namespace.
async function readyNamespace(t, name) {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  return { fixture, namespace: await fixture.createNamespace(name, { ready: true }) };
}

// A dedicated Codex Agent whose socket-mode Slack channel reads both tokens from env SecretRefs.
// `slack` adds Slack settings; other options go to createAgent over executionMode "dedicated".
// Returns the Agent and the exact Slack values it was created with.
async function createSlackAgent(fixture, namespace, { name, slug, slack: extra, ...options }) {
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    ...extra,
  };
  const agent = await fixture.createAgent(
    namespace.id,
    name,
    nativeValues(slug, { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated", ...options },
  );
  return { agent, slack };
}

// Signs in at the Agent's draft `tab` and waits for its `heading`.
async function openDraft(page, fixture, agent, heading, tab = "channels") {
  await login(page, fixture, detailUrl(fixture, agent.namespaceId, agent.id, "draft", tab));
  await page.getByRole("heading", { name: heading }).waitFor();
}

// Answers `method` requests to `pattern` with an API error; other requests reach the API.
async function failMethod(page, pattern, method, { status, error, requestId }) {
  await page.route(pattern, async (route, request) => {
    if (request.method() !== method) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify({ error, meta: { requestId } }),
    });
  });
}

// Every case builds its own Console and browser context, so cases run a few at a time.
describe("Agent channels", { concurrency: 3 }, () => {
  test("Channel drawer saves channel edits without exposing Secret values or dropping unrelated draft state", async (t) => {
    const secretValue = "super-secret-channel-value";
    const slackAppSecretValue = "super-secret-slack-app-value";
    const slackBotSecretValue = "super-secret-slack-bot-value";
    const { fixture, namespace } = await readyNamespace(t, "Channel state");
    const secret = await fixture.createSecret(namespace.id, "OpenAI API key", secretValue);
    const slackAppSecret = await fixture.createSecret(
      namespace.id,
      "Slack app token",
      slackAppSecretValue,
    );
    const slackBotSecret = await fixture.createSecret(
      namespace.id,
      "Slack bot token",
      slackBotSecretValue,
    );
    const secretBindings = {
      EXTERNAL_API_TOKEN: {
        source: secret.ref,
        delivery: { type: "env" },
      },
      SLACK_APP_TOKEN: {
        source: slackAppSecret.ref,
        delivery: { type: "env" },
      },
      SLACK_BOT_TOKEN: {
        source: slackBotSecret.ref,
        delivery: { type: "env" },
      },
    };
    const agent = await fixture.createAgent(
      namespace.id,
      "Channel Agent",
      nativeValues("channels", {
        harnessId: "codex",
        providerModel: "gpt-5.1",
        channels: {
          slack: {
            enabled: true,
            mode: "socket",
            replyToMode: "off",
            replyToModeByChatType: { direct: "first", channel: "off" },
            appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
            botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
            dmPolicy: "allowlist",
            allowFrom: ["UOLD123"],
            channels: {
              COLD123: {
                requireMention: true,
                users: ["UOLD123"],
              },
            },
          },
          msteams: {
            enabled: false,
            appId: "00000000-0000-4000-8000-000000000000",
            tenantId: "11111111-1111-4111-8111-111111111111",
            appPassword: { source: "env", provider: "default", id: "MSTEAMS_APP_PASSWORD" },
            requireMention: true,
          },
        },
      }),
      { executionMode: "dedicated", secretBindings },
    );
    const { page, artifacts } = await newPage(t, fixture, { browser });

    await openDraft(page, fixture, agent, "Channel Agent");
    await page.getByRole("tab", { name: "Channels" }).click();
    for (const value of [secretValue, slackAppSecretValue, slackBotSecretValue]) {
      await expectNoText(page, value);
    }

    await page.getByRole("button", { name: "Edit Slack" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Slack" });
    // The drawer's standing notice is info, not a warning (finding 2006).
    assert.deepEqual(
      await statusTone(dialog.getByText(/^New version\. Changes affect future deployments/)),
      { className: "status", tone: "info", role: "status" },
    );
    const appSecretPath = `/namespaces/${namespace.id}/secrets/${slackAppSecret.id}`;
    const botSecretPath = `/namespaces/${namespace.id}/secrets/${slackBotSecret.id}`;
    const appSecretLink = dialog.getByRole("link", {
      name: "View app token Secret metadata (opens in new tab)",
    });
    const botSecretLink = dialog.getByRole("link", {
      name: "View bot token Secret metadata (opens in new tab)",
    });
    assert.equal(await appSecretLink.getAttribute("href"), appSecretPath);
    assert.equal(await appSecretLink.getAttribute("target"), "_blank");
    assert.equal(await appSecretLink.getAttribute("rel"), "noopener");
    assert.equal(await botSecretLink.getAttribute("href"), botSecretPath);
    await dialog.getByText("Secret menu changes are saved with these channel settings.").waitFor();

    const channelIds = page.getByRole("combobox", { name: "Channels", exact: true });
    const allowedUsers = page.getByRole("combobox", {
      name: "Allowed people in these channels",
      exact: true,
    });
    const allowEveryone = page.getByLabel("Who can use the agent in these channels?");
    assert.equal(await slackSelectionValue(allowedUsers), "UOLD123");
    assert.equal(await allowedUsers.isDisabled(), false);
    assert.equal(await allowEveryone.inputValue(), "selected");
    await setSlackSelection(channelIds, "COLD123, CNEW123");
    await setSlackSelection(allowedUsers, "UNEW123");
    assert.equal(await allowEveryone.inputValue(), "selected");
    await setSlackSelection(allowedUsers, "");
    assert.equal(await allowEveryone.isEnabled(), true);
    await allowEveryone.selectOption("everyone");
    assert.equal(await allowedUsers.isVisible(), false);
    await allowEveryone.selectOption("selected");
    assert.equal(await allowedUsers.isEnabled(), true);
    await setSlackSelection(allowedUsers, "UNEW123");
    assert.equal(await allowEveryone.inputValue(), "selected");
    assert.equal(
      await dialog.getByRole("link", { name: "Open Agent Credentials (opens in new tab)" }).count(),
      0,
    );
    await dialog
      .getByText("Choose existing Slack token Secrets or create them here.")
      .scrollIntoViewIfNeeded();
    await dialog.screenshot({
      path: join(artifacts, "agent-channel-drawer-links.png"),
    });

    const appSecretPopupPromise = page.waitForEvent("popup");
    await appSecretLink.click();
    const appSecretPopup = await appSecretPopupPromise;
    await appSecretPopup.waitForLoadState("domcontentloaded");
    assert.equal(new URL(appSecretPopup.url()).pathname, appSecretPath);
    await appSecretPopup.getByText("Slack app token").waitFor();
    const secretMetadataText = await appSecretPopup.locator("body").textContent();
    assert.match(secretMetadataText, new RegExp(slackAppSecret.id));
    assert.doesNotMatch(secretMetadataText, new RegExp(slackAppSecretValue));
    await appSecretPopup.close();

    assert.equal(await slackSelectionValue(channelIds), "COLD123, CNEW123");
    assert.equal(await slackSelectionValue(allowedUsers), "UNEW123");

    await page.getByRole("button", { name: "Save configuration" }).click();
    await page.getByText(/Configuration .*generation 2/).waitFor();
    for (const value of [secretValue, slackAppSecretValue, slackBotSecretValue]) {
      await expectNoText(page, value);
    }
    await page.getByRole("button", { name: "Edit Microsoft Teams", exact: true }).waitFor();

    const configuration = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    );
    assert.equal(configuration.status, 200);
    assert.deepEqual(configuration.data.secretBindings, secretBindings);
    assert.deepEqual(configuration.data.values.channels.slack.appToken, {
      source: "env",
      provider: "default",
      id: "SLACK_APP_TOKEN",
    });
    assert.deepEqual(configuration.data.values.channels.slack.botToken, {
      source: "env",
      provider: "default",
      id: "SLACK_BOT_TOKEN",
    });
    assert.deepEqual(configuration.data.values.channels.slack.channels, {
      COLD123: { requireMention: true, users: ["UNEW123"] },
      CNEW123: { requireMention: true, users: ["UNEW123"] },
    });
    assert.equal(configuration.data.values.channels.slack.replyToMode, "off");
    assert.deepEqual(configuration.data.values.channels.slack.replyToModeByChatType, {
      direct: "first",
      channel: "off",
    });
    assert.equal(configuration.data.values.channels.slack.dmPolicy, "allowlist");
    assert.deepEqual(configuration.data.values.channels.slack.allowFrom, ["UOLD123"]);
    assert.equal(
      configuration.data.values.channels.msteams.appId,
      "00000000-0000-4000-8000-000000000000",
    );
    assert.equal(
      configuration.data.values.channels.msteams.tenantId,
      "11111111-1111-4111-8111-111111111111",
    );
    assert.deepEqual(configuration.data.values.channels.msteams.appPassword, {
      source: "env",
      provider: "default",
      id: "MSTEAMS_APP_PASSWORD",
    });
    assert.equal(configuration.data.values.plugins.entries.knowledge.config.marker, "channels");
    assert.deepEqual(
      configuration.data.values.plugins.entries.knowledge.config.thresholds,
      [1, 2, 3],
    );
    assert.equal(configuration.data.values.agents.defaults.model, "codex/gpt-5.1");

    await page.screenshot({ path: join(artifacts, "agent-channels.png"), fullPage: true });
  });

  for (const [name, channels, reason] of [
    [
      "wildcard channel map",
      { "*": { requireMention: true, users: ["*"] } },
      "Slack wildcard channels must be edited in native Configuration JSON.",
    ],
    [
      "mixed channel sender lists",
      {
        CMIXED123: { requireMention: true, users: ["UONE123"] },
        CMIXED456: { requireMention: true, users: ["UTWO456"] },
      },
      "Existing Slack channels use different allowed channel users. Edit native Configuration JSON to preserve those restrictions.",
    ],
    [
      "comma channel sender ID",
      { CCOMMA123: { requireMention: true, users: ["UONE123,UTWO456"] } },
      "Slack channel users or Require mention values use an unsupported native shape.",
    ],
    [
      "newline channel sender ID",
      { CNEWLINE123: { requireMention: true, users: ["UONE123\nUTWO456"] } },
      "Slack channel users or Require mention values use an unsupported native shape.",
    ],
  ]) {
    test(`Channel drawer keeps Slack ${name} in native JSON`, async (t) => {
      const { fixture, namespace } = await readyNamespace(t, "Unsupported Slack native");
      const { agent, slack } = await createSlackAgent(fixture, namespace, {
        name: `Unsupported Slack ${name}`,
        slug: `unsupported-slack-${name}`,
        slack: { channels },
      });
      const { page } = await newPage(t, fixture, { browser });
      const requests = apiRequests(page, fixture.origin);

      await openDraft(page, fixture, agent, `Unsupported Slack ${name}`);
      await page.getByText(reason).waitFor();
      assert.equal(await page.getByRole("button", { name: "Edit Slack" }).isDisabled(), true);
      await revealNativeConfiguration(page, "Slack native configuration");
      const nativeJson = JSON.parse(await page.locator(".channel-native pre").textContent());
      assert.deepEqual(nativeJson, slack);
      assert.deepEqual(nonAuthWriteRequests(requests), []);
    });
  }

  // Every deployment needs a model authentication source. An Agent with its API key bound was
  // still told to configure model credentials "before first deploy" (finding 2063).
  test("Channel drawer asks for model credentials only while the Agent has none", async (t) => {
    const { fixture, namespace } = await readyNamespace(t, "notice");
    const NOTICE = "New version. Changes affect future deployments using this Configuration.";
    const { agent: keyed } = await createSlackAgent(fixture, namespace, {
      name: "Keyed Agent",
      slug: "keyed",
    });
    assert.equal(keyed.harnessAuth?.method, "api_key");
    const { agent: unkeyed } = await createSlackAgent(fixture, namespace, {
      name: "Unkeyed Agent",
      slug: "unkeyed",
      harnessAuth: null,
    });
    const { page } = await newPage(t, fixture, { browser });
    await login(
      page,
      fixture,
      detailUrl(fixture, keyed.namespaceId, keyed.id, "draft", "channels"),
    );
    const notice = async (agent, heading) => {
      await page.goto(detailUrl(fixture, agent.namespaceId, agent.id, "draft", "channels").href);
      await page.getByRole("heading", { name: heading }).waitFor();
      await page.getByRole("button", { name: "Edit Slack" }).click();
      const dialog = page.getByRole("dialog", { name: "Edit Slack" });
      const text = await dialog.locator(".status").first().textContent();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      return text;
    };
    assert.equal(await notice(keyed, "Keyed Agent"), NOTICE);
    assert.equal(
      await notice(unkeyed, "Unkeyed Agent"),
      `${NOTICE} Configure model credentials in the Credentials tab before deploying.`,
    );
  });

  test("Channel drawer binds existing Slack Secrets without dropping unsaved channel edits", async (t) => {
    const { fixture, namespace } = await readyNamespace(t, "Unbound Slack credentials");
    const slackAppSecretValue = "never-visible-menu-app-token";
    const slackBotSecretValue = "never-visible-menu-bot-token";
    const slackAppSecret = await fixture.createSecret(
      namespace.id,
      "Existing menu Slack app token",
      slackAppSecretValue,
    );
    const slackBotSecret = await fixture.createSecret(
      namespace.id,
      "Existing menu Slack bot token",
      slackBotSecretValue,
    );
    const { agent } = await createSlackAgent(fixture, namespace, {
      name: "Unbound Slack Agent",
      slug: "unbound-slack",
      slack: { channels: { CUNBOUND123: { requireMention: true } } },
    });
    const { page } = await newPage(t, fixture, { browser });
    const requests = apiRequests(page, fixture.origin);

    await openDraft(page, fixture, agent, "Unbound Slack Agent");
    // Establish a same-document history entry before opening the modal.
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    await page.getByRole("tab", { name: "Channels", exact: true }).click();
    await page.getByRole("button", { name: "Edit Slack" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Slack" });
    assert.equal(await dialog.getByRole("link", { name: /Secret metadata/ }).count(), 0);
    const channelIds = dialog.getByRole("combobox", { name: "Channels", exact: true });
    await setSlackSelection(channelIds, "CDISCARD123");
    await selectSecret(dialog, "Slack app token", slackAppSecret);

    // Panel clicks and drags ending outside keep edits; a backdrop click discards them.
    const bounds = await dialog.boundingBox();
    assert.ok(bounds);
    await page.mouse.click(bounds.x + 8, bounds.y + 8);
    assert.equal(await dialog.isVisible(), true);
    await page.mouse.move(bounds.x + 8, bounds.y + 8);
    await page.mouse.down();
    await page.mouse.move(bounds.x / 2, bounds.y + 8);
    await page.mouse.up();
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await slackSelectionValue(channelIds), "CDISCARD123");
    await page.mouse.click(bounds.x / 2, bounds.y + 8);
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(nonAuthWriteRequests(requests), []);
    await page.getByRole("button", { name: "Edit Slack" }).click();
    assert.equal(await slackSelectionValue(channelIds), "CUNBOUND123");
    assert.equal(await dialog.getByLabel("Slack app token").inputValue(), "");

    await setSlackSelection(channelIds, "CUNBOUND123, CBOUND456");
    await selectSecret(dialog, "Slack app token", slackAppSecret);
    await dialog.getByText("Secret binding staged. Save changes to apply it.").waitFor();
    await selectSecret(dialog, "Slack bot token", slackBotSecret);
    await dialog.getByText("Secret binding staged. Save changes to apply it.").nth(1).waitFor();
    assert.equal(await slackSelectionValue(channelIds), "CUNBOUND123, CBOUND456");
    assert.equal(
      await dialog.getByRole("link", { name: "Open Agent Credentials (opens in new tab)" }).count(),
      0,
    );
    await dialog.getByText("Choose existing Slack token Secrets or create them here.").waitFor();
    await page.goBack();
    await page.getByRole("button", { name: "Edit Configuration" }).waitFor();
    await page.goForward();
    await dialog.waitFor();
    assert.equal(await slackSelectionValue(channelIds), "CUNBOUND123, CBOUND456");
    assert.equal(
      await dialog.getByLabel("Slack app token").inputValue(),
      secretOptionLabel(slackAppSecret),
    );
    assert.equal(
      await dialog.getByLabel("Slack bot token").inputValue(),
      secretOptionLabel(slackBotSecret),
    );
    const beforeSave = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    );
    assert.equal(beforeSave.data.generation, 1);
    const saveReached = Promise.withResolvers();
    const saveRelease = Promise.withResolvers();
    t.after(() => saveRelease.resolve());
    // Hold the real save response so dismissal cannot hide an in-flight mutation.
    await page.route(
      `${fixture.origin}/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
      async (route) => {
        if (route.request().method() !== "PATCH") {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        saveReached.resolve();
        await saveRelease.promise;
        await route.fulfill({ response });
      },
    );
    await page.getByRole("button", { name: "Save configuration" }).click();
    await saveReached.promise;
    await page.mouse.click(bounds.x / 2, bounds.y + 8);
    assert.equal(await dialog.isVisible(), true);
    assert.equal(
      await dialog.getByRole("button", { name: "Save configuration" }).isDisabled(),
      true,
    );
    saveRelease.resolve();
    await page.getByText(/Configuration .*generation 2/).waitFor();
    const configuration = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    );
    assert.deepEqual(configuration.data.secretBindings, {
      SLACK_APP_TOKEN: { source: slackAppSecret.ref, delivery: { type: "env" } },
      SLACK_BOT_TOKEN: { source: slackBotSecret.ref, delivery: { type: "env" } },
    });
    assert.deepEqual(configuration.data.values.channels.slack.channels, {
      CUNBOUND123: { requireMention: true, users: ["*"] },
      CBOUND456: { requireMention: true, users: ["*"] },
    });
    const pageText = await page.locator("body").textContent();
    assert.equal(pageText.includes(slackAppSecretValue), false);
    assert.equal(pageText.includes(slackBotSecretValue), false);
  });

  test("Channel drawer grants only the final selected Slack Secret", async (t) => {
    const { fixture, namespace } = await readyNamespace(t, "Final Slack grant");
    const firstSecret = await fixture.createSecret(
      namespace.id,
      "First Slack app token",
      "hidden-a",
    );
    const finalSecret = await fixture.createSecret(
      namespace.id,
      "Final Slack app token",
      "hidden-b",
    );
    const { agent } = await createSlackAgent(fixture, namespace, {
      name: "Final Slack Grant Agent",
      slug: "final-slack-grant",
      slack: { channels: { CFINAL123: { requireMention: true } } },
    });
    const { page } = await newPage(t, fixture, { browser });
    const requests = apiRequests(page, fixture.origin);
    const grantStarted = Promise.withResolvers();
    const releaseGrant = Promise.withResolvers();
    t.after(() => releaseGrant.resolve());
    await page.route(
      `**/namespaces/${namespace.id}/iam/access-bindings`,
      async (route, request) => {
        if (request.method() !== "POST") {
          await route.continue();
          return;
        }
        grantStarted.resolve();
        await releaseGrant.promise;
        await route.continue();
      },
    );

    await openDraft(page, fixture, agent, "Final Slack Grant Agent");
    requests.length = 0;
    await page.getByRole("button", { name: "Edit Slack" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Slack" });
    await selectSecret(dialog, "Slack app token", firstSecret);
    await selectSecret(dialog, "Slack app token", finalSecret);
    await page.getByRole("button", { name: "Save configuration" }).click();
    await grantStarted.promise;
    // Configuration is already saved, but the Agent's Secret grant is still in flight.
    try {
      assert.equal(
        await page.getByRole("button", { name: "Deploy new version" }).isDisabled(),
        true,
      );
      assert.equal(
        await page.getByRole("tab", { name: "Credentials", exact: true }).isDisabled(),
        true,
      );
    } finally {
      releaseGrant.resolve();
    }
    await page.getByText(/Configuration .*generation 2/).waitFor();

    const configuration = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    );
    assert.deepEqual(configuration.data.secretBindings.SLACK_APP_TOKEN, {
      source: finalSecret.ref,
      delivery: { type: "env" },
    });
    assert.deepEqual(
      accessBindingPostRequests(requests, namespace.id).map((request) => request.body.resourceId),
      [finalSecret.id],
    );
  });

  test("Channel drawer does not grant when Slack Secret selection returns to original", async (t) => {
    const { fixture, namespace } = await readyNamespace(t, "Original Slack grant");
    const originalSecret = await fixture.createSecret(
      namespace.id,
      "Original Slack app token",
      "hidden-original",
    );
    const temporarySecret = await fixture.createSecret(
      namespace.id,
      "Temporary Slack app token",
      "hidden-temporary",
    );
    const secretBindings = {
      SLACK_APP_TOKEN: { source: originalSecret.ref, delivery: { type: "env" } },
    };
    const { agent } = await createSlackAgent(fixture, namespace, {
      name: "Original Slack Grant Agent",
      slug: "original-slack-grant",
      slack: { channels: { CORIG123: { requireMention: true } } },
      secretBindings,
    });
    const { page } = await newPage(t, fixture, { browser });
    const requests = apiRequests(page, fixture.origin);

    await openDraft(page, fixture, agent, "Original Slack Grant Agent");
    requests.length = 0;
    await page.getByRole("button", { name: "Edit Slack" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Slack" });
    await selectSecret(dialog, "Slack app token", temporarySecret);
    await selectSecret(dialog, "Slack app token", originalSecret);
    await page.getByRole("button", { name: "Save configuration" }).click();
    await page.getByText(/Configuration .*generation 2/).waitFor();

    const configuration = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    );
    assert.deepEqual(configuration.data.secretBindings, secretBindings);
    assert.deepEqual(accessBindingPostRequests(requests, namespace.id), []);
  });

  test("Channel drawer does not grant Slack Secret access when Configuration save is rejected", async (t) => {
    const { fixture, namespace } = await readyNamespace(t, "Rejected Slack save");
    const slackAppSecret = await fixture.createSecret(
      namespace.id,
      "Rejected save Slack app token",
      "hidden-rejected-save",
    );
    const { agent } = await createSlackAgent(fixture, namespace, {
      name: "Rejected Slack Save Agent",
      slug: "rejected-slack-save",
      slack: { channels: { CREJECT123: { requireMention: true } } },
    });
    const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
    const { page } = await newPage(t, fixture, { browser });
    const requests = apiRequests(page, fixture.origin);
    await failMethod(page, `**${configurationPath}`, "PATCH", {
      status: 403,
      error: { code: "ACCESS_DENIED", message: "masked Configuration denial" },
      requestId: "req_00000000-0000-4000-8000-000000000403",
    });

    await openDraft(page, fixture, agent, "Rejected Slack Save Agent");
    requests.length = 0;
    await page.getByRole("button", { name: "Edit Slack" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Slack" });
    const allowedUsers = dialog.getByRole("combobox", {
      name: "Allowed people in these channels",
      exact: true,
    });
    const allowEveryone = dialog.getByLabel("Who can use the agent in these channels?");
    assert.equal(await allowEveryone.inputValue(), "everyone");
    assert.equal(await allowedUsers.isVisible(), false);
    await selectSecret(dialog, "Slack app token", slackAppSecret);
    await page.getByRole("button", { name: "Save configuration" }).click();
    await dialog.getByText(/Access denied|permission/i).waitFor();
    assert.equal(await allowEveryone.inputValue(), "everyone");
    assert.equal(await allowEveryone.isEnabled(), true);
    assert.equal(await allowedUsers.isVisible(), false);

    const configuration = await fixture.request("GET", configurationPath);
    assert.equal(configuration.status, 200);
    assert.deepEqual(configuration.data.secretBindings ?? {}, {});
    assert.deepEqual(accessBindingPostRequests(requests, namespace.id), []);
  });

  test("Channel drawer round trips existing Slack everyone channel access", async (t) => {
    const { fixture, namespace } = await readyNamespace(t, "Slack everyone access");
    const { agent, slack } = await createSlackAgent(fixture, namespace, {
      name: "Slack Everyone Agent",
      slug: "slack-everyone",
      slack: {
        dmPolicy: "allowlist",
        groupPolicy: "allowlist",
        allowFrom: ["UDM123"],
        channels: { CEVERY123: { requireMention: true, users: ["*"], allowBots: "mentions" } },
      },
    });
    const { page } = await newPage(t, fixture, { browser });

    await openDraft(page, fixture, agent, "Slack Everyone Agent");
    await page.getByRole("button", { name: "Edit Slack" }).click();
    let dialog = page.getByRole("dialog", { name: "Edit Slack" });
    await setSlackSelection(
      dialog.getByRole("combobox", { name: "Channels", exact: true }),
      "CEVERY123, CSECOND123",
    );
    const allowedUsers = dialog.getByRole("combobox", {
      name: "Allowed people in these channels",
      exact: true,
    });
    const allowEveryone = dialog.getByLabel("Who can use the agent in these channels?");
    assert.equal(await allowEveryone.inputValue(), "everyone");
    assert.equal(await allowedUsers.isVisible(), false);
    await dialog.getByLabel("Require a mention", { exact: true }).uncheck();
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/configurations/${agent.configurationId}`),
    );
    await page.getByRole("button", { name: "Save configuration", exact: true }).click();
    assert.equal((await saved).status(), 200);

    const configuration = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    );
    assert.deepEqual(configuration.data.values.channels.slack, {
      ...slack,
      channels: {
        CEVERY123: { requireMention: false, users: ["*"], allowBots: "mentions" },
        CSECOND123: { requireMention: false, users: ["*"] },
      },
    });

    await page.getByRole("button", { name: "Edit Slack" }).click();
    dialog = page.getByRole("dialog", { name: "Edit Slack" });
    assert.equal(
      await dialog.getByLabel("Who can use the agent in these channels?").inputValue(),
      "everyone",
    );
    assert.equal(
      await dialog
        .getByRole("combobox", { name: "Allowed people in these channels", exact: true })
        .isVisible(),
      false,
    );
    assert.equal(await dialog.getByLabel("Require a mention", { exact: true }).isChecked(), false);
  });

  test("Channel drawer refuses to keep a channel enabled for an Embedded Agent", async (t) => {
    const { fixture, namespace } = await readyNamespace(t, "Embedded Slack");
    // An Embedded OpenClaw Agent whose Configuration was then given an enabled Slack channel: the
    // Configuration API accepts it, while the Agent cannot serve it (Agent save and deploy refuse).
    const values = nativeValues("embedded-slack");
    const agent = await fixture.createAgent(namespace.id, "Embedded Slack Agent", values);
    assert.equal(agent.executionMode, "embedded");
    await fixture.updateConfiguration(namespace.id, agent.configurationId, {
      ...values,
      channels: {
        slack: {
          enabled: true,
          mode: "socket",
          appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
          botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
        },
      },
    });
    const { page } = await newPage(t, fixture, { browser });
    const requests = apiRequests(page, fixture.origin);

    await openDraft(page, fixture, agent, "Embedded Slack Agent");
    await page.getByRole("button", { name: "Edit Slack" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Slack" });
    await dialog.getByRole("button", { name: "Save configuration", exact: true }).click();
    // A refusal is a danger alert (finding 2006), and nothing is written.
    const refusal = dialog.getByText("Channels require Dedicated execution.", { exact: true });
    await refusal.waitFor();
    assert.deepEqual(await statusTone(refusal), {
      className: "status",
      tone: "danger",
      role: "alert",
    });
    assert.deepEqual(nonAuthWriteRequests(requests), []);
  });

  test("Channel drawer reports partial save when post-PATCH Secret grant is rejected", async (t) => {
    const { fixture, namespace } = await readyNamespace(t, "Partial Slack grant");
    const slackAppSecret = await fixture.createSecret(
      namespace.id,
      "Partial save Slack app token",
      "hidden-partial-save",
    );
    const { agent } = await createSlackAgent(fixture, namespace, {
      name: "Partial Slack Grant Agent",
      slug: "partial-slack-grant",
      slack: { channels: { CPARTIAL123: { requireMention: true } } },
    });
    const { page } = await newPage(t, fixture, { browser });
    const requests = apiRequests(page, fixture.origin);
    await failMethod(page, `**/namespaces/${namespace.id}/iam/access-bindings`, "POST", {
      status: 403,
      error: { code: "ACCESS_DENIED", message: "masked IAM denial" },
      requestId: "req_00000000-0000-4000-8000-000000000433",
    });

    await openDraft(page, fixture, agent, "Partial Slack Grant Agent");
    requests.length = 0;
    await page.getByRole("button", { name: "Edit Slack" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Slack" });
    await selectSecret(dialog, "Slack app token", slackAppSecret);
    await page.getByRole("button", { name: "Save configuration" }).click();
    await page
      .getByText(
        "Configuration saved, but Secret access grants could not be confirmed. Reload the draft, inspect saved bindings in Agent Credentials, then ask a Namespace administrator to grant this Agent access to the saved Secret.",
      )
      .waitFor();
    assert.equal(await page.getByRole("button", { name: "Edit Slack" }).isDisabled(), true);

    const configuration = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    );
    assert.equal(configuration.status, 200);
    assert.equal(configuration.data.generation, 2);
    assert.deepEqual(configuration.data.secretBindings.SLACK_APP_TOKEN, {
      source: slackAppSecret.ref,
      delivery: { type: "env" },
    });
    assert.deepEqual(
      accessBindingPostRequests(requests, namespace.id).map((request) => request.body.resourceId),
      [slackAppSecret.id],
    );

    assert.equal(
      await page.getByRole("tab", { name: "Credentials", exact: true }).isDisabled(),
      true,
    );
    await page.getByRole("button", { name: "Reload draft" }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByText(/Configuration .*generation 2/).waitFor();
    await page.getByRole("tab", { name: "Credentials", exact: true }).click();
    const appToken = page.getByLabel("Slack app token");
    await appToken.waitFor();
    assert.equal(await appToken.evaluate((node) => node.tagName), "INPUT");
    await waitForInputValue(appToken, secretOptionLabel(slackAppSecret));
    assert.equal(
      await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(),
      true,
    );
  });

  test("Agent credentials retry outstanding Slack Secret grants after changing one token", async (t) => {
    const { fixture, namespace } = await readyNamespace(t, "Runtime Slack retained grant");
    const modelSecret = await fixture.createSecret(
      namespace.id,
      "Retained grant model credential",
      "hidden-retained-model",
    );
    const firstAppSecret = await fixture.createSecret(
      namespace.id,
      "First retained Slack app token",
      "hidden-retained-first-app",
    );
    const secondAppSecret = await fixture.createSecret(
      namespace.id,
      "Second retained Slack app token",
      "hidden-retained-second-app",
    );
    const botSecret = await fixture.createSecret(
      namespace.id,
      "Retained Slack bot token",
      "hidden-retained-bot",
    );
    const { agent } = await createSlackAgent(fixture, namespace, {
      name: "Runtime Slack Retained Grant Agent",
      slug: "runtime-slack-retained-grant",
      slack: { channels: { CRETRYGRANT123: { requireMention: true } } },
      harnessAuth: { method: "api_key", source: modelSecret.ref },
    });
    const { page } = await newPage(t, fixture, { browser });
    const requests = apiRequests(page, fixture.origin);
    let denyGrant = true;
    let rejectNextConfigurationPatch = false;
    const reservation =
      "The Configuration is reserved for provisioning and is not available for this operation.";
    await page.route(
      `**/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
      async (route, request) => {
        if (request.method() === "PATCH" && rejectNextConfigurationPatch) {
          rejectNextConfigurationPatch = false;
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              error: { code: "RESOURCE_CONFLICT", message: reservation },
              meta: { requestId: "req_00000000-0000-4000-8000-000000000834" },
            }),
          });
          return;
        }
        await route.continue();
      },
    );
    await page.route(
      `**/namespaces/${namespace.id}/iam/access-bindings`,
      async (route, request) => {
        if (request.method() !== "POST" || !denyGrant) {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "ACCESS_DENIED", message: "masked IAM denial" },
            meta: { requestId: "req_00000000-0000-4000-8000-000000000833" },
          }),
        });
      },
    );

    await openDraft(page, fixture, agent, "Runtime Slack Retained Grant Agent", "credentials");
    requests.length = 0;
    await selectSecret(page, "Slack app token", firstAppSecret);
    await selectSecret(page, "Slack bot token", botSecret);
    await page.getByRole("button", { name: "Save channel Secrets" }).click();
    await page.getByText("Resolve the saved Secret access grant before deploying.").waitFor();
    assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);

    const firstConfiguration = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    );
    assert.deepEqual(firstConfiguration.data.secretBindings, {
      SLACK_APP_TOKEN: { source: firstAppSecret.ref, delivery: { type: "env" } },
      SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } },
    });

    denyGrant = false;
    rejectNextConfigurationPatch = true;
    await selectSecret(page, "Slack app token", secondAppSecret);
    await page.getByText("Resolve the saved Secret access grant before deploying.").waitFor();
    requests.length = 0;
    await page.getByRole("button", { name: "Save channel Secrets" }).click();
    // This write was refused; only the earlier saved binding has an outstanding access grant.
    const outcome = page.locator(".channel-secrets [role=alert]");
    await outcome.filter({ hasText: reservation }).waitFor({ timeout: 5_000 });
    const message = await outcome.innerText();
    assert.match(message, /Access to a previously saved Secret is still unconfirmed/);
    assert.doesNotMatch(message, /Configuration saved/i);
    await waitForInputValue(page.getByLabel("Slack app token"), secretOptionLabel(secondAppSecret));
    assert.deepEqual(
      requests.filter((request) => request.method !== "GET").map((request) => request.method),
      ["PATCH"],
    );
    assert.equal(await page.getByRole("button", { name: "Reload draft" }).count(), 0);
    await page.getByText("Resolve the saved Secret access grant before deploying.").waitFor();
    assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);

    // Saving again here is an explicit user action with the still-selected second app token.
    requests.length = 0;
    await page.getByRole("button", { name: "Save channel Secrets" }).click();
    await page
      .getByText("Channel Secret bindings saved. Deploy the new version to deliver them.")
      .waitFor();

    const finalConfiguration = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    );
    assert.deepEqual(finalConfiguration.data.secretBindings, {
      SLACK_APP_TOKEN: { source: secondAppSecret.ref, delivery: { type: "env" } },
      SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } },
    });
    assert.deepEqual(
      accessBindingPostRequests(requests, namespace.id)
        .map((request) => request.body.resourceId)
        .sort(),
      [botSecret.id, secondAppSecret.id].sort(),
    );
    assert.equal(
      await page.getByRole("button", { name: "Deploy new version" }).isDisabled(),
      false,
    );
  });

  // The feedback line takes its tone before its text, so a refusal's text arrives in an alert
  // and a later Secret choice turns it back to a warning before clearing it (finding 2015).
  test("Agent credentials set the channel Secrets feedback tone before its text", async (t) => {
    const { fixture, namespace } = await readyNamespace(t, "Runtime Slack tone order");
    const botSecret = await fixture.createSecret(
      namespace.id,
      "Tone order Slack bot token",
      "hidden-tone-order-bot",
    );
    const appSecret = await fixture.createSecret(
      namespace.id,
      "Tone order Slack app token",
      "hidden-tone-order-app",
    );
    const otherAppSecret = await fixture.createSecret(
      namespace.id,
      "Other tone order Slack app token",
      "hidden-tone-order-other-app",
    );
    const { agent } = await createSlackAgent(fixture, namespace, {
      name: "Runtime Slack Tone Order Agent",
      slug: "runtime-slack-tone-order",
      slack: { channels: { CTONEORDER123: { requireMention: true } } },
      secretBindings: {
        SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } },
      },
    });
    const { page } = await newPage(t, fixture, { browser });
    const configurationPath = `**/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
    await failMethod(page, configurationPath, "PATCH", {
      status: 403,
      error: { code: "ACCESS_DENIED", message: "masked Configuration denial" },
      requestId: "req_00000000-0000-4000-8000-000000002015",
    });
    await openDraft(page, fixture, agent, "Runtime Slack Tone Order Agent", "credentials");
    await selectSecret(page, "Slack app token", appSecret);
    const feedback = page.locator(".channel-secrets > p.status[role=alert]").first();
    // Records, in order, each change to the feedback line's tone and text.
    const watchFeedback = () =>
      feedback.evaluate((line) => {
        const changes = [];
        globalThis.feedbackChanges = changes;
        new globalThis.MutationObserver((records) => {
          for (const record of records) {
            changes.push(record.type === "attributes" ? record.attributeName : "text");
          }
        }).observe(line, {
          attributes: true,
          attributeFilter: ["data-tone", "role"],
          childList: true,
          characterData: true,
          subtree: true,
        });
      });
    const feedbackChanges = () => page.evaluate(() => globalThis.feedbackChanges);

    await watchFeedback();
    await page.getByRole("button", { name: "Save channel Secrets" }).click();
    const refusal = page.locator(".channel-secrets > p.status[role=alert][data-tone=danger]");
    await refusal.filter({ hasText: /\S/ }).waitFor();
    assert.deepEqual(await feedbackChanges(), ["data-tone", "text"]);

    await watchFeedback();
    await selectSecret(page, "Slack app token", otherAppSecret);
    // Without an outstanding grant the warning is empty, so the line is attached but not visible.
    await page
      .locator(".channel-secrets > p.status[role=alert][data-tone=warning]")
      .waitFor({ state: "attached" });
    assert.deepEqual(await feedbackChanges(), ["data-tone", "text"]);
  });

  // Every grant failure keeps the saved binding blocked. An unavailable IAM API (503) still leaves a
  // known saved Configuration, not an unknown outcome. Retryable failures (429, 503) retry the
  // pending grant on its own; 403 keeps it pending for the channel-edit check below.
  const grantErrorCodes = {
    403: "ACCESS_DENIED",
    429: "TOO_MANY_REQUESTS",
    503: "DEPENDENCY_UNAVAILABLE",
  };
  for (const grantStatus of [403, 429, 503]) {
    test(`Agent credentials report partial Slack Secret grant failure (${grantStatus})`, async (t) => {
      const { fixture, namespace } = await readyNamespace(t, "Runtime Slack grant failure");
      const originalBotSecret = await fixture.createSecret(
        namespace.id,
        "Existing runtime Slack bot token",
        "hidden-existing-runtime-bot",
      );
      const replacementAppSecret = await fixture.createSecret(
        namespace.id,
        "Denied runtime Slack app token",
        "hidden-denied-runtime-app",
      );
      const secretBindings = {
        SLACK_BOT_TOKEN: { source: originalBotSecret.ref, delivery: { type: "env" } },
      };
      const { agent } = await createSlackAgent(fixture, namespace, {
        name: "Runtime Slack Grant Failure Agent",
        slug: "runtime-slack-grant-failure",
        slack: { channels: { CRUNTIMEFAIL123: { requireMention: true } } },
        secretBindings,
      });
      const { page } = await newPage(t, fixture, { browser });
      const requests = apiRequests(page, fixture.origin);
      await failMethod(page, `**/namespaces/${namespace.id}/iam/access-bindings`, "POST", {
        status: grantStatus,
        error: { code: grantErrorCodes[grantStatus], message: "masked IAM failure" },
        requestId: "req_00000000-0000-4000-8000-000000000733",
      });

      await openDraft(page, fixture, agent, "Runtime Slack Grant Failure Agent", "credentials");
      requests.length = 0;
      await selectSecret(page, "Slack app token", replacementAppSecret);
      await page.getByRole("button", { name: "Save channel Secrets" }).click();
      const grantWarning = page.getByText(
        "Configuration saved, but Secret access grants could not be confirmed. Ask a Namespace administrator to grant this Agent access to the saved Secret.",
      );
      await grantWarning.waitFor();
      // The Configuration saved, so the unconfirmed grant is a warning from the start, not a
      // refusal that turns into one when another Secret is picked (finding 2003).
      assert.equal(await grantWarning.getAttribute("data-tone"), "warning");
      assert.equal(
        await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(),
        false,
      );
      await page.getByText("Resolve the saved Secret access grant before deploying.").waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Deploy new version" }).isDisabled(),
        true,
      );

      const configuration = await fixture.request(
        "GET",
        `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
      );
      assert.deepEqual(configuration.data.secretBindings, {
        SLACK_APP_TOKEN: { source: replacementAppSecret.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: originalBotSecret.ref, delivery: { type: "env" } },
      });
      assert.deepEqual(
        accessBindingPostRequests(requests, namespace.id).map((request) => request.body.resourceId),
        [replacementAppSecret.id],
      );
      if (grantStatus !== 403) {
        // The pending grant is retried on its own once IAM answers again.
        await page.unroute(`**/namespaces/${namespace.id}/iam/access-bindings`);
        await page.getByRole("button", { name: "Save channel Secrets" }).click();
        await page
          .getByText("Channel Secret bindings saved. Deploy the new version to deliver them.")
          .waitFor();
        assert.deepEqual(
          accessBindingPostRequests(requests, namespace.id).map(
            (request) => request.body.resourceId,
          ),
          [replacementAppSecret.id, replacementAppSecret.id],
        );
        assert.equal(
          await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(),
          true,
        );
        assert.equal(
          await page
            .getByText("Configuration saved, but Secret access grants could not be confirmed.", {
              exact: false,
            })
            .count(),
          0,
        );
      }
      if (grantStatus === 403) {
        await page.getByRole("tab", { name: "Channels", exact: true }).click();
        await page.getByRole("button", { name: "Edit Slack", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Edit Slack" });
        await setSlackSelection(
          dialog.getByRole("combobox", { name: "Channels", exact: true }),
          "CRUNTIMEFAIL123, CRETAINREFS123",
        );
        await dialog.getByRole("button", { name: "Save configuration", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        const afterChannelEdit = await fixture.request(
          "GET",
          `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
        );
        assert.deepEqual(afterChannelEdit.data.secretBindings, {
          SLACK_APP_TOKEN: { source: replacementAppSecret.ref, delivery: { type: "env" } },
          SLACK_BOT_TOKEN: { source: originalBotSecret.ref, delivery: { type: "env" } },
        });
        assert.deepEqual(Object.keys(afterChannelEdit.data.values.channels.slack.channels).sort(), [
          "CRETAINREFS123",
          "CRUNTIMEFAIL123",
        ]);
      }
    });
  }
});

for (const [name, access] of [
  ["explicit", { groupPolicy: "allowlist", groupAllowFrom: [teamsMemberId], teams: {} }],
  ["inherited from personal access", { allowFrom: [teamsMemberId] }],
]) {
  test(`Teams editor preserves ${name} native sender-only access without a Team map`, async (t) => {
    const { fixture, namespace } = await readyNamespace(t, "Native Teams sender access");
    const teams = {
      enabled: true,
      appId: teamsDirectoryContext.appId,
      tenantId: teamsDirectoryContext.tenantId,
      appPassword: { source: "env", provider: "default", id: "MSTEAMS_APP_PASSWORD" },
      dmPolicy: "allowlist",
      ...access,
    };
    const agent = await fixture.createAgent(
      namespace.id,
      "Native Teams Agent",
      nativeValues("native-teams-senders", { harnessId: "codex", channels: { msteams: teams } }),
      { executionMode: "dedicated" },
    );
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    await openDraft(page, fixture, agent, "Native Teams Agent");

    // Native sender allowlists work without channel IDs. The limited editor cannot
    // represent that policy and must not offer a save that disables group access.
    const edit = page.getByRole("button", { name: "Edit Microsoft Teams", exact: true });
    await edit.waitFor();
    assert.equal(await edit.isDisabled(), true);
    await revealNativeConfiguration(page, "Microsoft Teams native configuration");
    assert.deepEqual(JSON.parse(await page.locator(".channel-native pre").textContent()), teams);
    assert.deepEqual(nonAuthWriteRequests(requests), []);
    const saved = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    );
    assert.equal(saved.data.generation, 1);
    assert.deepEqual(saved.data.values.channels.msteams, teams);
  });
}

test("Teams editor persists separate personal and channel access with an authorized password Secret binding", async (t) => {
  const { fixture, namespace } = await readyNamespace(t, "Teams channels");
  const password = await fixture.createSecret(
    namespace.id,
    "Teams app password",
    "synthetic-teams-password",
  );
  const agent = await fixture.createAgent(
    namespace.id,
    "Teams Agent",
    nativeValues("teams", { harnessId: "codex" }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  await openDraft(page, fixture, agent, "Teams Agent");
  await page.getByRole("button", { name: "Configure Microsoft Teams" }).click();
  const dialog = page.getByRole("dialog", { name: "Configure Microsoft Teams" });
  await dialog.getByLabel("App ID", { exact: true }).fill("11111111-1111-4111-8111-111111111111");
  await dialog
    .getByLabel("Tenant ID", { exact: true })
    .fill("22222222-2222-4222-8222-222222222222");
  const siteId =
    "example.sharepoint.com,55555555-5555-4555-8555-555555555555,66666666-6666-4666-8666-666666666666";
  await dialog.getByLabel("SharePoint site ID", { exact: true }).fill(`  ${siteId}  `);
  await selectSecret(dialog, "Teams app password", password);
  await dialog.getByLabel("Team ID or link", { exact: true }).fill("19:general@thread.tacv2");
  await dialog.getByLabel("Channels — exact IDs", { exact: true }).fill("19:general@thread.tacv2");
  await dialog.locator("#msteams-channel-access").selectOption("everyone");
  await dialog.locator("#msteams-dm-policy").selectOption("allowlist");
  await dialog.locator("#msteams-dm-users").fill("44444444-4444-4444-8444-444444444444");
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  await page.getByText(/Configuration .*generation 2/).waitFor();
  const saved = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(saved.status, 200);
  assert.equal(saved.data.values.channels.msteams.sharePointSiteId, siteId);
  assert.equal(saved.data.values.channels.msteams.dmPolicy, "allowlist");
  assert.deepEqual(saved.data.values.channels.msteams.allowFrom, [
    "44444444-4444-4444-8444-444444444444",
  ]);
  assert.equal(saved.data.values.channels.msteams.groupPolicy, "allowlist");
  assert.deepEqual(saved.data.values.channels.msteams.groupAllowFrom, ["*"]);
  assert.deepEqual(saved.data.values.channels.msteams.teams, {
    "19:general@thread.tacv2": {
      channels: { "19:general@thread.tacv2": { requireMention: true } },
    },
  });
  assert.deepEqual(saved.data.secretBindings.MSTEAMS_APP_PASSWORD, {
    source: password.ref,
    delivery: { type: "env" },
  });
  assert.equal(saved.data.values.plugins.entries.msteams.enabled, true);
  await expectNoText(page, "synthetic-teams-password");
  // The ordinary save workflow grants the Agent access to the selected Secret.
  const bindings = await fixture.request("GET", `/namespaces/${namespace.id}/iam/access-bindings`);
  assert.equal(bindings.status, 200);
  assert.ok(
    bindings.data.some(
      (binding) =>
        binding.subjectId === agent.servicePrincipalId && binding.resourceId === password.id,
    ),
  );
  // Disabling channel conversations and clearing file storage must retain
  // the independent personal allowlist across editor saves.
  await page.getByRole("button", { name: "Edit Microsoft Teams", exact: true }).click();
  let edit = page.getByRole("dialog", { name: "Edit Microsoft Teams", exact: true });
  assert.equal(await edit.getByLabel("SharePoint site ID", { exact: true }).inputValue(), siteId);
  await edit.getByLabel("Enable channel conversations", { exact: true }).uncheck();
  await edit.getByRole("button", { name: "Save configuration", exact: true }).click();
  await edit.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Edit Microsoft Teams", exact: true }).click();
  edit = page.getByRole("dialog", { name: "Edit Microsoft Teams", exact: true });
  assert.equal(await edit.getByLabel("SharePoint site ID", { exact: true }).inputValue(), siteId);
  await edit.getByLabel("SharePoint site ID", { exact: true }).fill("");
  assert.equal(
    await edit.getByLabel("Enable channel conversations", { exact: true }).isChecked(),
    false,
  );
  await edit.getByRole("button", { name: "Save configuration", exact: true }).click();
  await edit.waitFor({ state: "hidden" });
  const personalOnly = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(Object.hasOwn(personalOnly.data.values.channels.msteams, "sharePointSiteId"), false);
  assert.equal(personalOnly.data.values.channels.msteams.groupPolicy, "disabled");
  assert.equal(personalOnly.data.values.channels.msteams.dmPolicy, "allowlist");
  assert.deepEqual(
    personalOnly.data.values.channels.msteams.allowFrom,
    saved.data.values.channels.msteams.allowFrom,
  );
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  await page.getByLabel("Teams app password", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Deploy new version" }).waitFor();
});

// Real Console/Fastify/OCC/Drivers and HTTP Microsoft protocol fixture: not live RSC proof.
async function teamsDirectorySelection(t, browserType) {
  const { fixture, namespace } = await readyNamespace(t, "Teams directory UI");
  const provider = await teamsDirectoryProvider(t);
  // More than one bounded lookup is needed to reach Engineering; Load more must stay clickable.
  const channelPages = [
    ["general", "General"],
    ["design", "Design"],
    ["marketing", "Marketing"],
    ["engineering", "Engineering"],
  ];
  for (const [index, [id, name]] of channelPages.entries()) {
    provider.routes.set(`${provider.path}/channels${index ? `?page-${index}` : ""}`, {
      body: {
        value: [{ id: `19:${id}@thread.tacv2`, displayName: name, membershipType: "standard" }],
        ...(index + 1 < channelPages.length
          ? {
              "@odata.nextLink": `https://graph.microsoft.com${provider.path}/channels?$skiptoken=page-${index + 1}`,
            }
          : {}),
      },
    });
  }
  const driver = new BundledChannelDriver(provider.request);
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("channel", driver.id);
  const password = await fixture.createSecret(
    namespace.id,
    "Teams password",
    "synthetic-teams-password",
  );
  const agent = await fixture.createAgent(
    namespace.id,
    "Teams directory Agent",
    nativeValues("teams-directory", { harnessId: "codex" }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture, { browserType });
  assert.equal(page.context().browser().browserType().name(), browserType.name());
  await openDraft(page, fixture, agent, "Teams directory Agent");
  await page.getByRole("button", { name: "Configure Microsoft Teams" }).click();
  const dialog = page.getByRole("dialog", { name: "Configure Microsoft Teams" });
  await dialog.getByLabel("App ID", { exact: true }).fill(teamsDirectoryContext.appId);
  await dialog.getByLabel("Tenant ID", { exact: true }).fill(teamsDirectoryContext.tenantId);
  await selectSecret(dialog, "Teams app password", password);
  // A group UUID must be resolved to the bot's native Team ID before saving.
  await dialog.getByLabel("Team ID or link", { exact: true }).fill(teamsDirectoryContext.teamId);
  const channels = dialog.getByLabel("Channels", { exact: true });
  const channelIds = dialog.locator("#msteams-channel-ids");
  await channels.fill("general");
  await dialog.getByRole("option", { name: /General/ }).click();
  assert.equal(await channelIds.inputValue(), "19:general@thread.tacv2");
  assert.deepEqual(
    await channelIds.locator("..").locator(".slack-directory-chip").allTextContents(),
    ["General"],
  );
  await dialog.getByLabel("Channels", { exact: true }).fill("engineering");
  await dialog.getByRole("button", { name: "Load more", exact: true }).click();
  await dialog.getByRole("option", { name: /Engineering/ }).click();
  const selectedChannels = "19:general@thread.tacv2, 19:engineering@thread.tacv2";
  assert.equal(await channelIds.inputValue(), selectedChannels);
  await dialog.getByLabel("Allowed people in these channels", { exact: true }).fill("alex");
  await dialog.getByRole("option", { name: /Alex Chen/ }).click();
  assert.equal(await dialog.locator("#msteams-group-users").inputValue(), teamsMemberId);
  await dialog.locator("#msteams-dm-policy").selectOption("allowlist");
  await dialog.getByLabel("Allowed people in personal messages", { exact: true }).fill("alex");
  await dialog.getByRole("option", { name: /Alex Chen/ }).click();
  assert.equal(await dialog.locator("#msteams-dm-users").inputValue(), teamsMemberId);
  // Pointer focus retention must preserve keyboard activation and ordinary dismissal.
  for (const action of ["Enter", "ArrowDown", "Escape", "outside"]) {
    await channels.fill("general");
    await dialog.getByRole("option", { name: /General/ }).waitFor();
    if (action === "outside") {
      await dialog.getByLabel("App ID", { exact: true }).click();
    } else {
      if (action === "Escape") {
        await channels.press("ArrowDown");
        await page.keyboard.press("Escape");
      } else {
        await channels.press(action);
      }
      if (action === "ArrowDown") {
        await page.keyboard.press("Enter");
      }
    }
    assert.equal(await dialog.locator("#msteams-channel-ids-results").isHidden(), true);
    assert.equal(await channelIds.inputValue(), selectedChannels);
  }
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  await dialog.waitFor({ state: "hidden" }).catch(async (error) => {
    throw new Error(`${error.message} ${await dialog.getByRole("alert").allTextContents()}`);
  });
  const saved = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(saved.data.values.channels.msteams.teams, {
    "19:general@thread.tacv2": {
      channels: {
        "19:general@thread.tacv2": { requireMention: true },
        "19:engineering@thread.tacv2": { requireMention: true },
      },
    },
  });
  assert.deepEqual(saved.data.values.channels.msteams.groupAllowFrom, [teamsMemberId]);
  assert.deepEqual(saved.data.values.channels.msteams.allowFrom, [teamsMemberId]);
  assert.doesNotMatch(
    JSON.stringify(saved.body),
    /opaque-membership-id|synthetic-graph-access-token|synthetic-teams-password/,
  );
  // A real delayed provider response from the old scope must not survive a Team change.
  await page.getByRole("button", { name: "Edit Microsoft Teams", exact: true }).click();
  const staleEdit = page.getByRole("dialog", { name: "Edit Microsoft Teams", exact: true });
  assert.equal(await staleEdit.locator("#msteams-channel-ids").inputValue(), selectedChannels);
  assert.equal(await staleEdit.locator("#msteams-group-users").inputValue(), teamsMemberId);
  assert.equal(await staleEdit.locator("#msteams-dm-users").inputValue(), teamsMemberId);
  await staleEdit.getByLabel("Team ID or link", { exact: true }).fill(teamsLink);
  let release;
  let started;
  let completed;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const received = new Promise((resolve) => {
    started = resolve;
  });
  const finished = new Promise((resolve) => {
    completed = resolve;
  });
  provider.routes.set(`${provider.path}/members`, {
    body: {
      value: [{ id: "old-membership", userId: teamsMemberId, displayName: "Former Team person" }],
    },
    wait,
    started,
    completed,
  });
  await staleEdit.getByLabel("Allowed people in these channels", { exact: true }).fill("former");
  await received;
  await staleEdit.getByLabel("Team ID or link", { exact: true }).fill("19:another@thread.tacv2");
  release();
  await finished;
  await expectNoText(staleEdit, "Former Team person");
  assert.equal(await staleEdit.locator("#msteams-group-users").inputValue(), teamsMemberId);
  assert.equal(
    await staleEdit.getByLabel("Allowed people in these channels", { exact: true }).isDisabled(),
    true,
  );
  await staleEdit.getByRole("button", { name: "Cancel", exact: true }).click();
  // Consent loss cannot erase IDs or force tenant-wide directory permission.
  provider.routes.set(`${provider.path}/members`, {
    status: 403,
    body: { error: { code: "Forbidden" } },
  });
  await page.getByRole("button", { name: "Edit Microsoft Teams", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit Microsoft Teams", exact: true });
  await edit.getByLabel("Team ID or link", { exact: true }).fill(teamsLink);
  await edit.getByLabel("Allowed people in these channels", { exact: true }).fill("alex");
  await edit
    .getByText(/Directory consent is missing/)
    .first()
    .waitFor();
  assert.equal(await edit.locator("#msteams-group-users").inputValue(), teamsMemberId);
  await edit.locator("#msteams-dm-users").fill("29:manual-external-person");
  await edit.getByRole("button", { name: "Save configuration" }).click();
  await edit.waitFor({ state: "hidden" });
  const manual = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(manual.data.values.channels.msteams.allowFrom, ["29:manual-external-person"]);
}

for (const browserType of [chromium, webkit]) {
  test(`Teams directory selects names, saves native IDs and preserves manual entry after consent denial (${browserType.name()})`, (t) =>
    teamsDirectorySelection(t, browserType));
}

// Reloading a conflict must not restore channel or sender access another editor revoked.
test("Teams conflict recovery preserves concurrent channel and sender revocations", async (t) => {
  const { fixture, namespace } = await readyNamespace(t, "Teams concurrent access");
  const team = "19:team@thread.tacv2";
  const channel = (name) => `19:${name}@thread.tacv2`;
  const user = (digit) =>
    `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
  const teams = {
    enabled: true,
    appId: teamsDirectoryContext.appId,
    tenantId: teamsDirectoryContext.tenantId,
    appPassword: { source: "env", provider: "default", id: "MSTEAMS_APP_PASSWORD" },
    dmPolicy: "allowlist",
    allowFrom: [user("1"), user("2")],
    groupPolicy: "allowlist",
    groupAllowFrom: [user("1"), user("2")],
    requireMention: true,
    teams: {
      [team]: {
        channels: {
          [channel("keep")]: { requireMention: true },
          [channel("revoke")]: { requireMention: true },
        },
      },
    },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Concurrent Teams Agent",
    nativeValues("teams-conflict", { harnessId: "codex", channels: { msteams: teams } }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  await openDraft(page, fixture, agent, "Concurrent Teams Agent");
  await page.getByRole("button", { name: "Edit Microsoft Teams", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Microsoft Teams", exact: true });
  await dialog
    .locator("#msteams-channel-ids")
    .fill([channel("keep"), channel("revoke"), channel("add")].join(", "));
  for (const id of ["msteams-group-users", "msteams-dm-users"]) {
    await dialog.locator(`#${id}`).fill([user("1"), user("2"), user("3")].join(", "));
  }
  const siteId =
    "example.sharepoint.com,55555555-5555-4555-8555-555555555555,66666666-6666-4666-8666-666666666666";
  await dialog.getByLabel("SharePoint site ID", { exact: true }).fill(siteId);
  const path = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const current = (await fixture.request("GET", path)).data;
  const elsewhere = structuredClone(current.values);
  elsewhere.channels.msteams.allowFrom = [user("1")];
  elsewhere.channels.msteams.groupAllowFrom = [user("1")];
  delete elsewhere.channels.msteams.teams[team].channels[channel("revoke")];
  assert.equal(
    (
      await fixture.request("PATCH", path, {
        body: { values: elsewhere, expectedGeneration: current.generation },
      })
    ).status,
    200,
  );
  await dialog.getByRole("button", { name: "Save configuration", exact: true }).click();
  await page.getByRole("button", { name: "Reload draft", exact: true }).click();
  await dialog
    .getByRole("status")
    .filter({ hasText: "Your edits are applied over the reloaded settings:" })
    .waitFor();
  await dialog.getByRole("button", { name: "Save configuration", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Channels saved." }).waitFor();
  const saved = (await fixture.request("GET", path)).data.values.channels.msteams;
  assert.deepEqual(Object.keys(saved.teams[team].channels).sort(), [
    channel("add"),
    channel("keep"),
  ]);
  assert.deepEqual(saved.groupAllowFrom, [user("1"), user("3")]);
  assert.deepEqual(saved.allowFrom, [user("1"), user("3")]);
  assert.equal(saved.sharePointSiteId, siteId);
});

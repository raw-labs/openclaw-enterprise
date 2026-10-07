import { createTeamsDirectoryField, teamsReference } from "../agents/teams-directory.mjs";
import { element } from "../dom.mjs";
import { TEAMS_SECRET_BINDINGS, secretIdForBinding } from "../agents/credentials.mjs";
import { createSecretReferenceField, secretBinding } from "../agents/secret-picker.mjs";
import {
  isRecord,
  refsEqual,
  providerConfig,
  withProvider,
  field,
  input,
  checkbox,
  uniqueList,
  arrayOfStrings,
} from "./shared-ui.mjs";

const PASSWORD_REF = { source: "env", provider: "default", id: "MSTEAMS_APP_PASSWORD" };
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const teamReferences = new WeakMap();
const DM_POLICIES = ["disabled", "allowlist", "open", "pairing"];

function support(values) {
  const config = providerConfig(values, "msteams");
  if (config === undefined) {
    return { supported: true, config: { dmPolicy: "disabled" } };
  }
  const entries = Object.entries(config?.teams ?? {});
  const mentions = entries.flatMap(([, team]) =>
    Object.values(team?.channels ?? {}).map(
      (channel) => channel?.requireMention ?? team?.requireMention ?? config.requireMention ?? true,
    ),
  );
  const supported =
    isRecord(config) &&
    (config.appPassword === undefined || refsEqual(config.appPassword, PASSWORD_REF)) &&
    (config.cloud === undefined || config.cloud === "Public") &&
    (config.authType === undefined || config.authType === "secret") &&
    !config.useManagedIdentity &&
    !config.certificatePath &&
    (config.webhook === undefined ||
      (isRecord(config.webhook) &&
        (config.webhook.path === undefined || config.webhook.path === "/api/messages"))) &&
    (config.legacyWebhook === undefined || config.legacyWebhook === false) &&
    (config.groupPolicy === undefined || ["allowlist", "disabled"].includes(config.groupPolicy)) &&
    (config.dmPolicy === undefined || DM_POLICIES.includes(config.dmPolicy)) &&
    (config.allowFrom === undefined || arrayOfStrings(config.allowFrom)) &&
    (config.groupAllowFrom === undefined || arrayOfStrings(config.groupAllowFrom)) &&
    (config.teams === undefined || isRecord(config.teams)) &&
    entries.length <= 1 &&
    new Set(mentions).size <= 1 &&
    entries.every(
      ([id, team]) =>
        id !== "*" &&
        isRecord(team) &&
        isRecord(team.channels) &&
        Object.entries(team.channels).every(
          ([channelId, channel]) => channelId !== "*" && isRecord(channel),
        ),
    );
  return {
    supported,
    config,
    reason:
      "This Teams configuration uses advanced native settings. Edit it through the Configuration API to preserve its access rules.",
  };
}

function select(id, options, value) {
  return element(
    "select",
    { id, className: "channel-select" },
    ...options.map(([key, label]) =>
      element("option", { value: key, ...(key === value ? { selected: "" } : {}) }, label),
    ),
  );
}

function appendFields(body, config, context) {
  const [teamId, team] = Object.entries(config.teams ?? {})[0] ?? ["", {}];
  const appId = input("msteams-app-id", config.appId);
  const tenantId = input("msteams-tenant-id", config.tenantId);
  const teamInput = input("msteams-team-id", teamId);
  const directoryFields = [];
  const getLookup = () => {
    const source = (context.draftSecretBindings ?? context.secretBindings)?.MSTEAMS_APP_PASSWORD
      ?.source;
    const reference = teamsReference(teamInput.value);
    return source?.kind === "secret" &&
      source.namespaceId === context.namespaceId &&
      reference?.groupId &&
      GUID.test(appId.value.trim()) &&
      GUID.test(tenantId.value.trim())
      ? {
          secretId: source.id,
          context: {
            appId: appId.value.trim(),
            tenantId: tenantId.value.trim(),
            teamId: reference.groupId,
          },
        }
      : null;
  };
  let resolved;
  teamReferences.set(body, () => {
    const reference = teamsReference(teamInput.value);
    return (
      reference?.nativeId ??
      (resolved?.scope === JSON.stringify(getLookup()) ? resolved.nativeId : undefined)
    );
  });
  const refresh = () => directoryFields.forEach((field) => field.refreshValue());
  for (const control of [appId, tenantId, teamInput]) {
    control.addEventListener("input", refresh);
  }
  const directory = (kind, control, label) => {
    const field = createTeamsDirectoryField({
      context,
      kind,
      control,
      label,
      getLookup,
      onWorkspace(nativeId) {
        const reference = teamsReference(teamInput.value);
        if (reference?.nativeId && reference.nativeId !== nativeId) {
          return false;
        }
        resolved = { scope: JSON.stringify(getLookup()), nativeId };
        return true;
      },
    });
    directoryFields.push(field);
    return field;
  };
  const channelField = directory(
    "channels",
    input("msteams-channel-ids", Object.keys(team.channels ?? {}).join(", ")),
    "Channels",
  );
  const groupField = directory(
    "users",
    input(
      "msteams-group-users",
      (config.groupAllowFrom ?? []).filter((id) => id !== "*").join(", "),
    ),
    "Allowed people in these channels",
  );
  const personalField = directory(
    "users",
    input("msteams-dm-users", (config.allowFrom ?? []).filter((id) => id !== "*").join(", ")),
    "Allowed people in personal messages",
  );
  const channelAccess = select(
    "msteams-channel-access",
    [
      ["selected", "Selected people"],
      ["everyone", "Everyone in these channels"],
    ],
    config.groupAllowFrom?.includes("*") ? "everyone" : "selected",
  );
  const dmPolicy = select(
    "msteams-dm-policy",
    DM_POLICIES.map((policy) => [policy, policy[0].toUpperCase() + policy.slice(1)]),
    config.dmPolicy ?? "pairing",
  );
  const updateAccess = () => {
    groupField.hidden = channelAccess.value === "everyone";
    groupField.querySelector("#msteams-group-users").disabled = groupField.hidden;
    personalField.hidden = dmPolicy.value !== "allowlist" && dmPolicy.value !== "pairing";
    personalField.querySelector("#msteams-dm-users").disabled = personalField.hidden;
    refresh();
  };
  channelAccess.addEventListener("change", updateAccess);
  dmPolicy.addEventListener("change", updateAccess);
  updateAccess();
  const binding = TEAMS_SECRET_BINDINGS[0];
  const picker = createSecretReferenceField({
    context,
    id: "msteams-secret-app-password",
    label: binding.label,
    getCurrentSource: () =>
      (context.draftSecretBindings ?? context.secretBindings)?.[binding.key]?.source,
    onSecretSelected(secret) {
      context.draftSecretBindings = {
        ...(context.draftSecretBindings ?? context.secretBindings),
        [binding.key]: secretBinding(secret),
      };
      context.draftChangedSecrets = { ...context.draftChangedSecrets, [binding.key]: secret };
      refresh();
    },
    createSecretName: () =>
      `${typeof context.agentName === "function" ? context.agentName() : (context.agentName ?? "Teams")} ${binding.secretName}`,
    createDialogTitle: "Create Teams app password Secret",
    createFixedKey: {
      label: "Binding key",
      value: binding.key,
      hint: "Delivered only to this Agent's Gateway.",
    },
    fieldClassName: "channel-field channel-reference",
    selectClassName: "channel-select",
  });
  body.append(
    element("h2", {}, "Microsoft app"),
    field("App ID", appId),
    field("Tenant ID", tenantId),
    picker.field,
    element(
      "p",
      { className: "hint" },
      "Register the callback URL from the Teams integration guide in Azure Bot, enable the Teams channel, and install the Teams app. Your operator must enable public channel routing and Microsoft proxy egress before deployment.",
    ),
    element("h2", {}, "Channel access"),
    checkbox(
      "msteams-channels-enabled",
      "Enable channel conversations",
      config.groupPolicy !== "disabled",
    ),
    field(
      "Team ID or link",
      teamInput,
      "Paste a Teams Team link or its Entra group UUID for name lookup. Native Team IDs also work for manual setup. Only native IDs are saved; paste the link again when reopening to browse names.",
    ),
    channelField,
    field("Who can use the agent in these channels?", channelAccess),
    groupField,
    checkbox(
      "msteams-require-mention",
      "Require a mention",
      (Object.values(team.channels ?? {})[0]?.requireMention ??
        team.requireMention ??
        config.requireMention) !== false,
    ),
    element("h2", {}, "Personal messages"),
    field("Personal-message policy", dmPolicy),
    personalField,
    element(
      "p",
      { className: "hint" },
      "Directory search lists only members of the selected Team. For other people, enter exact Microsoft Entra object IDs or Teams user IDs. Personal access is separate from channel access; pairing requires native approval for new senders.",
    ),
  );
}

export const teams = {
  id: "msteams",
  name: "Microsoft Teams",
  plugin: "msteams",
  description: "Personal messages and mentions in selected Teams channels.",
  setup:
    "Requires an Azure Bot app, an app password Secret, and operator-configured public callback routing.",
  secretBindings: TEAMS_SECRET_BINDINGS,
  support,
  appendFields,
  validate(body) {
    if (!body.querySelector("#msteams-enabled").checked) {
      return null;
    }
    if (
      !["app-id", "tenant-id"].every((key) =>
        GUID.test(body.querySelector(`#msteams-${key}`).value.trim()),
      )
    ) {
      return "Enter valid Microsoft app and tenant UUIDs.";
    }
    const ids = uniqueList(body.querySelector("#msteams-channel-ids").value.split(","));
    const team = body.querySelector("#msteams-team-id").value.trim();
    if (ids.includes("*") || team === "*") {
      return "Use exact team and channel IDs; wildcard access requires native Configuration JSON.";
    }
    if (team && !teamsReference(team)) {
      return "Enter a native Team ID, a group UUID, or a Teams Team link.";
    }
    if (ids.length && !teamReferences.get(body)?.()) {
      return "Search this Team to resolve its native ID, or paste its Team link or native ID before saving.";
    }
    if (Boolean(ids.length) && !team) {
      return "Provide both a team ID and at least one channel ID, or leave both empty for personal messages only.";
    }
    const users = uniqueList(body.querySelector("#msteams-group-users").value.split(","));
    if (users.includes("*")) {
      return "Choose Everyone in these channels instead of entering a wildcard user ID.";
    }
    if (
      ids.length &&
      body.querySelector("#msteams-channels-enabled").checked &&
      body.querySelector("#msteams-channel-access").value === "selected" &&
      !users.length
    ) {
      return "Choose allowed channel users or Everyone in these channels.";
    }
    const dmUsers = uniqueList(body.querySelector("#msteams-dm-users").value.split(","));
    if (dmUsers.includes("*")) {
      return "Choose Open personal messages instead of entering a wildcard user ID.";
    }
    if (body.querySelector("#msteams-dm-policy").value === "allowlist" && !dmUsers.length) {
      return "Choose allowed personal-message users.";
    }
    return null;
  },
  updatedValues(values, body) {
    const config = structuredClone(support(values).config ?? {});
    config.enabled = body.querySelector("#msteams-enabled").checked;
    config.appId = body.querySelector("#msteams-app-id").value.trim();
    config.tenantId = body.querySelector("#msteams-tenant-id").value.trim();
    config.appPassword = PASSWORD_REF;
    config.legacyWebhook = false;
    const teamId = teamReferences.get(body)?.() ?? "";
    const ids = uniqueList(body.querySelector("#msteams-channel-ids").value.split(","));
    const oldTeam = config.teams?.[teamId] ?? {};
    const mention = body.querySelector("#msteams-require-mention").checked;
    config.teams =
      teamId && ids.length
        ? {
            [teamId]: {
              ...oldTeam,
              channels: Object.fromEntries(
                ids.map((id) => [id, { ...oldTeam.channels?.[id], requireMention: mention }]),
              ),
            },
          }
        : {};
    config.groupPolicy =
      body.querySelector("#msteams-channels-enabled").checked && ids.length
        ? "allowlist"
        : "disabled";
    config.groupAllowFrom =
      body.querySelector("#msteams-channel-access").value === "everyone"
        ? ["*"]
        : uniqueList(body.querySelector("#msteams-group-users").value.split(","));
    config.requireMention = mention;
    config.dmPolicy = body.querySelector("#msteams-dm-policy").value;
    config.allowFrom =
      config.dmPolicy === "open"
        ? ["*"]
        : uniqueList(body.querySelector("#msteams-dm-users").value.split(","));
    return withProvider(values, "msteams", config);
  },
  updatedSecretBindings(context) {
    if (context.draftSecretBindings === undefined) {
      return undefined;
    }
    const secret = context.draftChangedSecrets?.MSTEAMS_APP_PASSWORD;
    return {
      secretBindings: context.draftSecretBindings,
      changedSecrets:
        secret && secretIdForBinding(context.draftSecretBindings.MSTEAMS_APP_PASSWORD) === secret.id
          ? [secret]
          : [],
    };
  },
  summary(config) {
    const count = Object.values(config.teams ?? {}).reduce(
      (total, team) => total + Object.keys(team.channels ?? {}).length,
      0,
    );
    return `${count} selected channels · Personal messages: ${config.dmPolicy ?? "pairing"}`;
  },
};

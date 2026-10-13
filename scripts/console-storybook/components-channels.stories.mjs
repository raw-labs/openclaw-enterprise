import { story } from "./story.mjs";

export default { title: "Components/Channels" };

export const Slack = { ...story("slack"), name: "Slack configured" };
export const SlackDmPolicy = { ...story("slackDmPolicy") };
export const SlackEnterpriseDm = { ...story("slackEnterpriseDm") };
export const SlackThreadedDefault = { ...story("slackThreadedDefault") };
export const SlackReplyOverride = { ...story("slackReplyOverride") };
export const SlackDrawer = { ...story("slackDrawer"), name: "Slack editor" };
export const SlackDirectoryChannels = story("slackDirectoryChannels");
export const SlackDirectorySavedNames = story("slackDirectorySavedNames");
export const SlackDirectoryQualifiedNames = story("slackDirectoryQualifiedNames");
export const SlackDirectoryUsers = story("slackDirectoryUsers");
export const SlackDirectoryDenied = story("slackDirectoryDenied");
export const SlackDirectoryLoading = story("slackDirectoryLoading");
export const SlackDirectorySearchRace = story("slackDirectorySearchRace");
export const SlackDirectoryMissingSecret = story("slackDirectoryMissingSecret");
export const SlackEveryone = { ...story("slackEveryone"), name: "Slack everyone in channels" };
export const SlackRestrictedUsers = {
  ...story("slackRestrictedUsers"),
  name: "Slack restricted channel users",
};
export const SlackChannelAccessIncomplete = {
  ...story("slackChannelAccessIncomplete"),
  name: "Slack sender access incomplete",
};
export const SlackSecretMenu = { ...story("slackSecretMenu"), name: "Slack Secret menu" };
export const SlackSecretNameCollision = story("slackSecretNameCollision");
export const SlackCreateSecretModal = {
  ...story("slackCreateSecretModal"),
  name: "Slack create Secret modal",
};
export const SlackDuplicateSecret = story("slackDuplicateSecret");
export const SlackSecretStaged = {
  ...story("slackSecretStaged"),
  name: "Slack staged Secret binding",
};
export const SlackOpen = { ...story("slackOpen"), name: "Slack open policy" };
export const SlackDisabled = { ...story("slackDisabled"), name: "Slack disabled policy" };
export const SlackUnsupported = { ...story("slackUnsupported"), name: "Slack unsupported shape" };
export const SlackMixedUsersUnsupported = {
  ...story("slackMixedUsersUnsupported"),
  name: "Slack mixed sender lists",
};
export const SlackWildcardUnsupported = {
  ...story("slackWildcardUnsupported"),
  name: "Slack wildcard channel map",
};
export const SlackChannelAccessFlow = {
  ...story("slackChannelAccessFlow"),
  name: "Change Slack channel senders",
};
export const ChannelsEmpty = { ...story("channelsEmpty"), name: "Not configured" };
export const ChannelsReadOnly = { ...story("channelsReadOnly"), name: "Revision read only" };
export const ChannelConflict = { ...story("channelConflict"), name: "Save conflict" };
export const ChannelSavePending = { ...story("channelSavePending"), name: "Channel save pending" };
export const ChannelSaveUnknown = {
  ...story("channelSaveUnknown"),
  name: "Channel save outcome unknown",
};

export const SlackNavigation = story("slackNavigation");

export const RevisionSecretsDenied = story("revisionSecretsDenied");
export const RevisionSecretsMissing = story("revisionSecretsMissing");
export const RevisionSecretsLoading = story("revisionSecretsLoading");
export const RevisionSecretsAbsent = story("revisionSecretsAbsent");

export const Teams = story("teams");
export const TeamsEditor = story("teamsEditor");
export const TeamsMissingSecret = story("teamsMissingSecret");
export const TeamsUnsupported = story("teamsUnsupported");
export const TeamsReadOnly = story("teamsReadOnly");
export const TeamsSecretsLoading = story("teamsSecretsLoading");
export const TeamsSaveDenied = story("teamsSaveDenied");
export const TeamsSavePending = story("teamsSavePending");

export const TeamsDirectoryChannels = story("teamsDirectoryChannels");
export const TeamsDirectoryMembers = story("teamsDirectoryMembers");
export const TeamsDirectoryDenied = story("teamsDirectoryDenied");
export const TeamsDirectoryLoading = story("teamsDirectoryLoading");
export const TeamsDirectoryEmpty = story("teamsDirectoryEmpty");
export const TeamsDirectoryMissingSecret = story("teamsDirectoryMissingSecret");

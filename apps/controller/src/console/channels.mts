import { teams } from "./channels/teams.mjs";
import { slack } from "./channels/slack.mjs";
import { renderChannelSection } from "./channels/shared-ui.mjs";

export function renderChannels(options: Parameters<typeof renderChannelSection>[0]) {
  return renderChannelSection(options, [slack, teams]);
}

import type {
  ChannelDirectoryLookupInput,
  ChannelDriver,
  ChannelCredentialReader,
  GatewayOutboundRequirement,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";
import { ChannelDirectoryError } from "@openclaw-enterprise/occ";
import { SlackChannelDriver } from "./slack.ts";
import { TeamsChannelDriver } from "./teams.ts";
import { channelRequest, type ChannelRequest } from "./transport.ts";

/** One selected primitive, with provider-specific discovery behind the Driver boundary. */
export class BundledChannelDriver implements ChannelDriver {
  readonly capability = "channel" as const;
  readonly id = "bundled-channel";
  readonly implementation = "occ/bundled-channel";
  private readonly slack: SlackChannelDriver;
  private readonly teams: TeamsChannelDriver;

  constructor(
    request: ChannelRequest = globalThis.fetch,
    proxyUrl?: string,
    options: { readonly managedProxyHosts?: readonly string[] } = {},
  ) {
    const transport = channelRequest(request, proxyUrl, options);
    this.slack = new SlackChannelDriver(transport);
    this.teams = new TeamsChannelDriver(transport);
  }

  validateCredentials(
    values: Readonly<Record<string, unknown>>,
    withSecret: ChannelCredentialReader,
  ): Promise<void> {
    // Optional Graph consent is never a prerequisite for deploying the Teams bot.
    return this.slack.validateCredentials(values, withSecret);
  }

  gatewayNetworkRequirements(configuration: Readonly<OpenClawConfigurationDocument>): readonly GatewayOutboundRequirement[] {
    return [...this.slack.gatewayNetworkRequirements(configuration), ...this.teams.gatewayNetworkRequirements(configuration)];
  }

  controlPlaneNetworkRequirements(): readonly GatewayOutboundRequirement[] {
    return [...this.slack.controlPlaneNetworkRequirements(), ...this.teams.controlPlaneNetworkRequirements()];
  }

  lookupDirectory(input: ChannelDirectoryLookupInput, signal?: AbortSignal) {
    const providers: Readonly<Record<string, ChannelDriver>> = {
      slack: this.slack,
      msteams: this.teams,
    };
    const provider = Object.hasOwn(providers, input.provider)
      ? providers[input.provider]
      : undefined;
    if (!provider) {
      throw new ChannelDirectoryError("invalid_response");
    }
    return provider.lookupDirectory(input, signal);
  }
}

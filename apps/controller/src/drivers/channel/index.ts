import type {
  ChannelDirectoryLookupInput,
  ChannelDriver,
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
  readonly validateCredentials?: NonNullable<ChannelDriver["validateCredentials"]>;
  private readonly slack: SlackChannelDriver;
  private readonly teams: TeamsChannelDriver;

  constructor(
    request: ChannelRequest = globalThis.fetch,
    proxyUrl?: string,
    options: {
      readonly managedProxyHosts?: readonly string[];
      readonly purpose?: "management" | "revisionAdmission";
    } = {},
  ) {
    const transport = channelRequest(request, proxyUrl, options);
    this.slack = new SlackChannelDriver(transport);
    this.teams = new TeamsChannelDriver(transport);
    // The API validates provider credentials before queuing provisioning. Worker
    // handoff freezes requirements inside a transaction and must perform no provider I/O.
    if (options.purpose !== "revisionAdmission") {
      this.validateCredentials = (values, withSecret) =>
        this.slack.validateCredentials(values, withSecret);
    }
  }

  gatewayNetworkRequirements(
    configuration: Readonly<OpenClawConfigurationDocument>,
  ): readonly GatewayOutboundRequirement[] {
    return [
      ...this.slack.gatewayNetworkRequirements(configuration),
      ...this.teams.gatewayNetworkRequirements(configuration),
    ];
  }

  controlPlaneNetworkRequirements(): readonly GatewayOutboundRequirement[] {
    return [
      ...this.slack.controlPlaneNetworkRequirements(),
      ...this.teams.controlPlaneNetworkRequirements(),
    ];
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

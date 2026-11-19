import type {
  ChannelCredentialReader,
  ChannelDirectoryLookupInput,
  ChannelDriver,
} from "@openclaw-enterprise/contracts";
import { ChannelDirectoryError } from "@openclaw-enterprise/occ";
import type { ChannelProviderDriver } from "./routing.ts";
import { SlackChannelDriver } from "./slack.ts";
import { TeamsChannelDriver } from "./teams.ts";
import { channelRequest, type ChannelRequest } from "./transport.ts";

export function bundledChannelProviders(
  options: {
    readonly proxyUrl?: string;
    readonly managedProxyHosts?: readonly string[];
    readonly expectProxy?: boolean;
    readonly teamsFileHosts?: readonly string[];
    readonly teamsRequest?: ChannelRequest;
  } = {},
): readonly ChannelProviderDriver[] {
  return [
    {
      provider: "slack",
      driver: new SlackChannelDriver(globalThis.fetch, options.proxyUrl, options),
    },
    {
      provider: "msteams",
      driver: new TeamsChannelDriver(
        channelRequest(options.teamsRequest, options.proxyUrl, options),
        options.teamsFileHosts,
        options.expectProxy === true && options.proxyUrl === undefined,
      ),
    },
  ];
}

/** Select a provider for OCC directory requests and channel credential validation. */
export class BundledChannelDriver implements ChannelDriver {
  readonly capability = "channel" as const;
  readonly id = "bundled-channel";
  readonly implementation = "occ/bundled-channel";

  private readonly providers: readonly ChannelProviderDriver[];

  constructor(providers: readonly ChannelProviderDriver[]) {
    this.providers = providers;
  }

  enableRouting() {
    return this.providers.flatMap(({ driver }) => driver.enableRouting());
  }

  async validateCredentials(
    values: Readonly<Record<string, unknown>>,
    withSecret: ChannelCredentialReader,
  ): Promise<void> {
    for (const { driver } of this.providers) {
      await driver.validateCredentials?.(values, withSecret);
    }
  }

  lookupDirectory(input: ChannelDirectoryLookupInput, signal?: AbortSignal) {
    const provider = this.providers.find(
      ({ provider }) => provider === (input.provider ?? "slack"),
    );
    if (!provider) {
      throw new ChannelDirectoryError("invalid_response");
    }
    return provider.driver.lookupDirectory(input, signal);
  }
}

import { BundledChannelDriver } from "../drivers/channel/index.ts";

/** Shared selection for API provider calls and their Installation-local network policy. */
export function createBundledChannelDriver(
  options: {
    readonly proxyUrl?: string;
    readonly managedProxyHost?: string;
  } = {},
) {
  return new BundledChannelDriver(globalThis.fetch, options.proxyUrl, {
    managedProxyHosts: options.managedProxyHost === undefined ? [] : [options.managedProxyHost],
  });
}

import { isIP } from "node:net";
import { fetch as undiciFetch, ProxyAgent } from "undici";

const PROXY_ENDPOINT =
  /^https?:\/\/((?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}):([1-9][0-9]{0,4})$/;
const MANAGED_SERVICE_PROXY_ENDPOINT =
  /^https?:\/\/([a-z]([-a-z0-9]*[a-z0-9])?\.[a-z0-9]([-a-z0-9]*[a-z0-9])?\.svc):([1-9][0-9]{0,4})$/;

export type ChannelRequest = (
  url: URL | string,
  options: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: URLSearchParams;
    readonly signal?: AbortSignal;
    readonly redirect?: "error";
  },
) => Promise<
  Pick<Response, "status" | "ok" | "text"> & {
    readonly body: {
      getReader(): {
        read(): Promise<ReadableStreamReadResult<Uint8Array>>;
        cancel(): Promise<void>;
        releaseLock(): void;
      };
    } | null;
  }
>;

/** Preserve the operator-selected, bounded egress endpoint for every channel provider. */
export function channelRequest(
  request: ChannelRequest = globalThis.fetch,
  proxyUrl?: string,
  options: { readonly managedProxyHosts?: readonly string[] } = {},
): ChannelRequest {
  if (proxyUrl === undefined) {
    return request;
  }
  const endpoint = PROXY_ENDPOINT.exec(proxyUrl);
  const managedEndpoint = MANAGED_SERVICE_PROXY_ENDPOINT.exec(proxyUrl);
  const address = endpoint?.[1];
  const managedHost = managedEndpoint?.[1];
  const managedService =
    managedHost !== undefined && (options.managedProxyHosts ?? []).includes(managedHost);
  const port = endpoint?.[2] ?? managedEndpoint?.[4];
  if (
    port === undefined ||
    Number(port) > 65535 ||
    (!managedService && (address === undefined || isIP(address) !== 4))
  ) {
    throw new Error(
      "Channel directory proxy must be an HTTP(S) literal IPv4 endpoint or the exact managed Kubernetes Service endpoint with an explicit port.",
    );
  }
  const proxy = new ProxyAgent(proxyUrl);
  return (url, init) => undiciFetch(url, { ...init, dispatcher: proxy });
}

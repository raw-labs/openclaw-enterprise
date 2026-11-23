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
      cancel(): Promise<void>;
      getReader(): {
        read(): Promise<ReadableStreamReadResult<Uint8Array>>;
        cancel(): Promise<void>;
        releaseLock(): void;
      };
    } | null;
  }
>;

/** Admit only a literal IPv4 proxy or the exact managed OCC egress Service, with a port. */
export function channelProxyAgent(
  proxyUrl: string,
  options: { readonly managedProxyHosts?: readonly string[]; readonly label: string },
): ProxyAgent {
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
      `${options.label} must be an HTTP(S) literal IPv4 endpoint or the exact managed Kubernetes Service endpoint with an explicit port.`,
    );
  }
  // The unspecified address cannot identify a managed listener.
  if (address === "0.0.0.0") {
    throw new Error(`${options.label} must not use host 0.0.0.0, which names no proxy address.`);
  }
  return new ProxyAgent(proxyUrl);
}

/** Route a provider request through the operator-selected OCC egress listener. */
export function channelRequest(
  request: ChannelRequest = globalThis.fetch,
  proxyUrl?: string,
  options: { readonly managedProxyHosts?: readonly string[] } = {},
): ChannelRequest {
  if (proxyUrl === undefined) {
    return request;
  }
  const proxy = channelProxyAgent(proxyUrl, { ...options, label: "Teams directory proxy" });
  return (url, init) => undiciFetch(url, { ...init, dispatcher: proxy });
}

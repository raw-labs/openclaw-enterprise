/** Non-secret native channel destinations; a wildcard does not include its apex. */
export interface ChannelGatewayDestination {
  readonly host: string;
  readonly ports: readonly number[];
  readonly protocol: "https" | "wss";
}

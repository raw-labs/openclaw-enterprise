# Evaluate temporary embedded channels

Use a disposable Installation to evaluate native OpenClaw with Slack or Teams.
This exception is temporary, experimental and unsupported for production. The
Installation administrator must explicitly accept that channel and model credentials
share the Agent's execution workload. Every Agent still owns its own Gateway.

## Enable the trusted option

For the [installation renderer](../deploy/installation-profiles.md#render-files),
add the opt-in to the existing trusted site-input JSON:

```json
{
  "channels": {
    "experimentalEmbeddedChannels": true
  },
  "gatewayOutbound": {
    "enabled": true,
    "denyCidrs": ["10.0.0.0/8"]
  }
}
```

Render with `--profile openclaw`; the option also works with `codex` when selecting
embedded OpenClaw Agents. It requires managed `gatewayOutbound.enabled: true` and actual infrastructure
exclusions; replace the example CIDR for your Installation. Omit the option or set it to false to keep the default
refusal. Preflight warns about the shared-credential risk when enabled. Apply the
paired startup YAML and Helm values in the guide's order so API and worker load
the same configuration. The option does not configure Teams ingress or broaden
the proxy's allowed destinations.

For a directly authored Installation, set the selected Kubernetes Compute Driver's
configuration:

```yaml
runtime:
  transportSecretPrefix: transport
  gatewayStorageClassName: local-path
  channels:
    experimentalEmbeddedChannels: true
  gatewayOutbound:
    enabled: true
    image: "registry.example.test/oce/controller@sha256:<reviewed-digest>"
    denyCidrs: ["10.0.0.0/8", "100.64.0.0/10", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"]
```

Use the reviewed controller image for the per-revision outbound proxy and include
all Installation infrastructure CIDRs in its exclusions. Load the same trusted
configuration into API and worker. Native OpenClaw JSON cannot enable the option.
The old `runtime.channels.proxyUrl` and shared channel proxy are unsupported;
[Gateway outbound](../../reference/gateway-outbound.md) owns the current proxy setup.

The default refuses embedded channels. This trusted opt-in permits ordinary Agent
creation/deployment and provisioning with `executionMode: embedded` and the
OpenClaw Harness. Bind every channel credential through Configuration `secretBindings`
and exact Namespace Secret grants. Model credentials continue through the Agent's
Harness authentication binding. The baseline supports OpenAI and Anthropic API keys;
all model selections must retain the primary provider. No live provider qualification
is implied. Other native providers remain unsupported by Compute authentication.

Use [Slack setup](slack.md) or the [fresh Teams trial](teams.md) for provider inputs.
Teams additionally needs its public listener, certificate, application registration
and exact callback endpoint. Embedded provisioning uses the API; the console continues to provision dedicated
Agents. Existing Slack and Teams configuration editors remain available.

## Verify networking and credentials

Channel admission freezes the enabled Slack and Teams requirements into each
revision. Its credential-free proxy allows their combined destinations; disabling
a channel removes its requirements from the next revision. Embedded evaluation
accepts only `gatewayOutbound.mode: channelsOnly`; additional restricted/public
Gateway modes still require dedicated execution.

Compute sets `HTTPS_PROXY`, `NODE_USE_ENV_PROXY=1` and `NO_PROXY` for the combined
process. Internal endpoints and the selected embedded model provider's endpoint
bypass the channel proxy, retaining existing embedded model egress. Default OpenAI
and Anthropic endpoints and explicit provider/model `baseUrl` hosts are covered.
This routing preserves model transport; it does not qualify live model execution
or arbitrary native plugins. Other destinations honoring the proxy remain denied
unless declared by the selected Channel Driver.

The proxy is not a per-Agent credential or identity authority. Embedded tool/process
execution can bypass proxy environment settings and retains the existing public
egress grant. Native tool profiles, sender policies or disabling exec do not prove
credential containment: Gateway callbacks, plugins, files and other tools share
the combined execution boundary. Do not treat this as dedicated-workload separation.

Inspect the exact serving Deployment revision and Secret projections. Only the
Agent's authorized Secrets should appear. The channel password and selected model
credential are deliberately available to that combined workload. Check callback
replacement and removal for Teams. See the [runtime flow](../../flows/agent-channel-runtime.md)
and [fixture proof limits](../../testing/kubernetes.md).

The pinned upstream extensions do not include Connections/Composio; an approved
installation path is a separate prerequisite. Installed native plugins can use
their normal Gateway callbacks when networking
and credentials permit. This does not provide package installation, a broader
managed PluginDriver catalog or persistence for native UI edits. Connections and
ClawHub behavior must be verified independently; this experiment does not change
their management contract.

## End the trial

Stop the trial Agents, remove `experimentalEmbeddedChannels` or set it to false,
and load the default configuration into both processes. Disabling the option
prevents future channel admission/preparation/activation; it does not retroactively
withdraw credentials from an already running Pod. Stop/delete remain available.
Stop removes revision credential copies but retains private Gateway state;
canonical Namespace Secrets remain separate resources. Delete the trial Agent to
remove its retained state, and revoke or rotate provider credentials. Do not treat
stop as a provider-token revocation or a wipe of plugin-maintained caches.

The removal condition is a supported dedicated native path supplying the required
models and integrations. The [proposed RFC](../../../specs/rfcs/0025-temporary-embedded-channel-trial.md)
records the risk and owner decision; it does not claim maintainer acceptance.

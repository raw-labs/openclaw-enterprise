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
  "proxy": {
    "bundled": true,
    "allowedHosts": [
      "slack.com",
      "*.slack.com",
      "slack-edge.com",
      "*.slack-edge.com",
      "slack-msgs.com",
      "*.slack-msgs.com"
    ]
  }
}
```

Render with `--profile openclaw`; the option also works with `codex` when selecting
embedded OpenClaw Agents. It requires a selected bundled or external proxy.
Omit the option or set it to false to keep the default
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
  proxy:
    proxyUrl: "http://192.0.2.20:3128"
```

Replace the example with a reachable external proxy, or use the renderer for
bundled Service wiring. Load the same trusted configuration into API and worker.
Native OpenClaw JSON cannot enable the option.
[Gateway proxy setup](gateway-proxy.md) owns routing and host policy.

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

The Installation operator selects one proxy and its host policy. Enabling or
disabling a channel does not change that policy. Add Slack, Teams, model-provider
and other required destinations explicitly; the bundled default allows Slack only.
Compute renders native Gateway-only proxy routing. Dedicated Harnesses and nodes
do not inherit it. Check embedded model connectivity through the selected proxy;
previous environment-variable bypass behavior is not retained.

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
models and integrations. The [proposed RFC](../../../specs/rfcs/0031-temporary-embedded-channel-trial.md)
records the risk and owner decision; it does not claim maintainer acceptance.

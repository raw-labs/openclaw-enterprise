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
    "denyCidrs": ["10.42.0.0/16", "10.43.0.0/16", "192.0.2.20/32"]
  }
}
```

Render with `--profile openclaw`; the option also works with `codex` when selecting
embedded OpenClaw Agents. It requires `gatewayOutbound.enabled: true` and the
actual infrastructure exclusions described in [Gateway outbound](../../reference/gateway-outbound.md). Omit the option or set it to false to keep the default
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
    image: "registry.example.com/controller@sha256:<approved-digest>"
    denyCidrs: ["10.42.0.0/16", "10.43.0.0/16", "192.0.2.20/32"]
```

Replace the image and CIDRs with approved values for the Installation. Compute
creates the revision-owned proxy; no external channel proxy URL is accepted.
Load the same trusted configuration into API and worker. Record the administrator's
trust decision with the Installation configuration change. Adding the flag to
native OpenClaw JSON grants no authority.

The default refuses embedded channels. This trusted opt-in permits ordinary Agent
creation/deployment and provisioning with `executionMode: embedded` and the
OpenClaw Harness. Bind every channel credential through Configuration `secretBindings`
and exact Namespace Secret grants. Model credentials continue through the Agent's
Harness authentication binding. The baseline supports OpenAI and Anthropic API keys;
all model selections must retain the primary provider. No live provider qualification
is implied. Other native providers remain unsupported by Compute authentication.

Use [Slack setup](slack.md) or the [fresh Teams trial](teams.md) for provider inputs.
Teams additionally needs its public listener, certificate, application registration
and exact callback endpoint. This branch uses API/native Configuration JSON for
Teams; it adds no console editor. Shared Teams prerequisites are independently
reviewable from the embedded exception.

## Verify networking and credentials

Compute supplies the managed proxy environment and native guarded-fetch trust
marker to the channel-enabled Gateway. Its revision policy contains only enabled
Channel Driver destinations. Additional approved hosts remain dedicated-only.
Caller proxy and trust-marker overrides are refused.

Embedded model endpoints use their existing model egress grant and bypass the
channel proxy through exact `NO_PROXY` hosts. Startup authentication alone does
not prove ordinary model or provider traffic; run the selected native runtime proof.

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
prevents future channel admission/preparation/activation and withdraws its managed
route during revision access maintenance. It does not revoke provider tokens or
erase retained Gateway state. Stop/delete remain available.
Stop removes revision credential copies but retains private Gateway state;
canonical Namespace Secrets remain separate resources. Delete the trial Agent to
remove its retained state, and revoke or rotate provider credentials. Do not treat
stop as a provider-token revocation or a wipe of plugin-maintained caches.

The removal condition is a supported dedicated native path supplying the required
models and integrations. The [proposed RFC](../../../specs/rfcs/0025-temporary-embedded-channel-trial.md)
records the risk and owner decision; it does not claim maintainer acceptance.

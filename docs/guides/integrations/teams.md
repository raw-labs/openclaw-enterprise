# Trial Microsoft Teams callbacks

Use this evaluation branch to trial Microsoft Public cloud Teams with an
Agent's native OpenClaw Gateway. This path is experimental and has not been
qualified for production. Slack uses Socket Mode; Teams additionally needs a
public HTTPS callback. The embedded-channel exception is a separate opt-in and
does not establish ordinary Teams support.

## Prepare the Installation

Build the branch's runtime image: it retains the existing OpenClaw source pin
and packages the upstream `msteams` plugin and its locked dependencies alongside
Slack and Codex. Existing released images that prune Teams cannot run this path.
Do not change a protected Installation for this trial.

The Installation administrator must configure Kubernetes Compute with
`runtime.channels.proxyUrl` and `gatewayRouting.channels.hostname`. An external
approved proxy may supply the required destination policy. With the chart-managed
proxy, explicitly set `slackProxy.teamsEnabled: true`; its default remains Slack
only. This permits public-cloud token discovery, Bot Framework, Graph and
`smba.trafficmanager.net` on TCP/443. Sovereign clouds, arbitrary attachments,
delegated OAuth and SSO are outside this initial trial.

Provision a dedicated public DNS name and certificate, then set these Helm values:

```yaml
gatewayRouting:
  enabled: true
  channels:
    enabled: true
    hostname: channels.example.com
    tlsSecretName: teams-public-tls
    listenerPort: 8444
    ingressPeers:
      - ipBlock:
          cidr: 0.0.0.0/0
```

Keep the listener separate from administrative HTTPS and expose only this listener
through the external HTTPS endpoint. The certificate Secret belongs in the release
namespace. Public DNS, certificate issuance/renewal and external port translation
remain operator responsibilities; the chart references the existing certificate.
Match the hostname in the trusted Compute configuration. The chart does not rewrite
that Installation document. See [gateway isolation](../../reference/drivers/kubernetes-compute/networking-and-isolation.md).

## Configure and deploy an Agent

Create a Microsoft application and Azure Bot with the Teams channel enabled.
Store its app password as an OCE Secret in the Agent's exact Namespace. Use native
Configuration JSON, preserving the existing model and Harness authentication:

```json
{
  "channels": {
    "msteams": {
      "enabled": true,
      "cloud": "Public",
      "appId": "00000000-0000-4000-8000-000000000001",
      "tenantId": "00000000-0000-4000-8000-000000000002",
      "appPassword": { "source": "env", "id": "MSTEAMS_APP_PASSWORD" },
      "webhook": { "path": "/api/messages" },
      "legacyWebhook": false,
      "dmPolicy": "disabled",
      "groupPolicy": "allowlist"
    }
  }
}
```

Bind `MSTEAMS_APP_PASSWORD` in Configuration `secretBindings` to that Secret with
environment delivery, and grant the Agent exact Secret access through the normal
IAM workflow. Grant native Teams access only to the intended Team/channel/member
IDs before enabling messaging. The placeholders above are not provider accounts.
The trial has no Teams console editor or directory lookup.

Deploy the Agent, then set the Azure Bot messaging endpoint to
`https://channels.example.com/namespaces/<namespace-id>/agents/<agent-id>/channels/msteams`.
Compute publishes only the exact POST route to native `/api/messages`, preserves
Microsoft's Authorization header, and strips OCE administrative identity headers.
The native Microsoft SDK validates callbacks; the public route does not run OCE
user-session IAM. OCE still authorizes configuration, Secrets and lifecycle operations.

## Verify and recover

Check the exact serving Deployment revision, its `-msteams` HTTPRoute,
SecurityPolicy and NetworkPolicy. Candidate preparation must retain the serving
revision's callback. Redeployment updates it; disabling Teams removes it after
activation. Stop/delete remove the serving callback before workload teardown.

A proxy `403` means a destination was refused. The stock channel proxy does not
permit ClawHub, Composio or model endpoints. Opening direct public TCP/443 does not
override a process-wide HTTPS proxy. Use an approved external proxy with the exact
needed destinations and verify real requests before claiming native plugin/model
parity. This branch does not implement native plugin installation management.

Real provider delivery, runtime image startup and enforcing-cluster routing remain
qualification requirements. Do not send trial messages without scoped recipient
authorization. See the [channel runtime flow](../../flows/agent-channel-runtime.md)
and [Kubernetes testing guide](../../testing/kubernetes.md).

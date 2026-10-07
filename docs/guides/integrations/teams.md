# Connect an Agent to Microsoft Teams

Use a Dedicated Agent with the Kubernetes Compute Driver and a runtime image
that bundles `msteams`. The console supports one selected Team, channel and member name lookup, exact
IDs, channel sender restrictions, mentions, and separate personal-message
policies. The native Teams plugin handles messages and replies.

This integration currently targets Microsoft Public cloud with an app password.
Live channel delivery, attachments, SSO, federated
credentials, sovereign clouds, and Teams approval workflows are not qualified.
See [Teams verification](../../testing/teams.md) before using it beyond testing.

## Prepare the operator prerequisites

Register an [Azure Bot and Teams app](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/create-a-bot-for-teams).
Enable the Microsoft Teams channel on the bot. Keep its application ID, tenant
ID, and client secret available; the client secret becomes an OCE Namespace
Secret. Install the Teams app in the personal or team scopes you intend to use.

Configure a separate public HTTPS origin for callbacks. Its certificate must be
trusted by Microsoft. Forward public TCP/443 to the **channels** listener only;
the private gateway administrative listener must retain its private access.
Set these Helm values, replacing the hostname, Secret, and ingress selectors:

```yaml
gatewayRouting:
  enabled: true
  channels:
    enabled: true
    hostname: teams.example.com
    tlsSecretName: teams-public-tls
    listenerPort: 8444
    ingressPeers:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: public-ingress
        podSelector:
          matchLabels:
            app: public-ingress
slackProxy:
  enabled: true
  teamsEnabled: true
```

Keep the existing private gateway settings. In the Installation's selected
Compute Driver configuration, set `gatewayRouting.channels.hostname` to the
same hostname and configure `runtime.channels.proxyUrl` and `managedProxy`
for the chart-managed proxy as described in the [Slack proxy setup](slack.md#configure-both-slack-proxies).
An external reviewed proxy can replace it. Allow TCP/443 CONNECT to
`login.microsoftonline.com`, `login.botframework.com`, `api.botframework.com`,
`smba.trafficmanager.net`, and `graph.microsoft.com`.
The chart-managed proxy admits those exact Microsoft hosts only when
`teamsEnabled` is true; it does not allow arbitrary Microsoft domains.

## Configure and deploy the Agent

1. Open the Dedicated Agent's **Channels** tab and select **Configure Microsoft
   Teams**. Enter the app and tenant UUIDs. Select or create an **app password**
   Secret; OCE binds it to `MSTEAMS_APP_PASSWORD` and grants the Agent access.
2. Paste a Team link in **Team ID or link** and search its standard channels
   and members by name, or enter native Team/channel IDs manually. Name lookup
   requires the optional [Team-scoped directory consent](#enable-team-scoped-name-lookup).
   Choose selected people or everyone in those channels, and keep **Require a mention** enabled. Personal messages
   have a separate Disabled, Allowlist, Open, or Pairing policy. Leave both team
   and channel IDs empty for personal messages only. Pairing requires the native
   approval workflow for new senders; the console does not approve pairings.
3. Save the configuration. The **Credentials** tab identifies a missing app
   password binding. Stored credentials do not prove Microsoft has accepted
   them. Deploy a new version to apply settings and deliver the password only
   to this Agent's Gateway.
4. Set the Azure Bot messaging endpoint to
   `https://teams.example.com/namespaces/<namespace-id>/agents/<agent-id>/channels/msteams`.
   Use OCE resource IDs, not Kubernetes namespace names. Send a permitted
   personal message or channel mention and verify the reply in Teams.

The callback accepts only POST at that exact Agent path and rewrites it to the
native `/api/messages` handler. The Teams SDK validates Microsoft's bearer
token. The route removes OCE identity, scope, API-key, and cookie headers. It
does not require an OCE session or admit gateway administrative paths.
Callback ownership follows the serving revision. A failed candidate cannot
remove its predecessor's callback; stopping or deleting the serving revision
removes the route and its authentication-policy override.

Advanced native configurations remain inspectable and can be disabled in the
console. Unsupported editor shapes require the Configuration API; the editor
does not flatten multiple teams or wildcard access rules. Custom webhook paths
and legacy webhook listeners fail deployment preparation.

## Enable Team-scoped name lookup

Update the Teams app package, using manifest v1.12 or later. Set
`webApplicationInfo.id` to the same Entra application ID as the bot, retain the
app's resource URI, and add these application permissions to
`authorization.permissions.resourceSpecific`:

```json
[
  { "name": "ChannelSettings.Read.Group", "type": "Application" },
  { "name": "TeamMember.Read.Group", "type": "Application" }
]
```

Keep the bot's `team` installation scope enabled. Upload the revised package,
then have an authorized Team owner install it in the selected Team and consent
to those permissions, subject to your tenant's app and RSC policies. A personal
installation alone does not grant access to a Team. See Microsoft's
[RSC installation instructions](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/grant-resource-specific-consent).
No tenant-wide user or Team read grant is required, and these permissions do
not allow reading channel messages. OCE does not grant Microsoft permissions.

In the editor, enter app and tenant IDs and select the existing app-password
Secret. In Teams, use **Get link to team**, then paste that link in **Team ID or
link**. Search **Channels** and the appropriate **Allowed people** field and
select a result. For people outside that Team, enter exact Entra object IDs or
Teams user IDs. A group UUID also enables lookup; resolve it through a successful
search before saving channel access. OCE saves native IDs only, so paste the
Team link again when reopening to browse names. See the
[directory reference](../../reference/drivers/teams-channel.md) for bounds and
visibility limits.

The production API needs its channel directory proxy to permit
`login.microsoftonline.com:443` and `graph.microsoft.com:443`. With the managed
proxy, enable both `slackProxy.enabled` and `slackProxy.teamsEnabled`. This is
separate from the Agent's runtime proxy. Missing directory consent or egress
leaves exact-ID entry available and does not make Graph access a deployment
prerequisite.

## Diagnose a missing reply

- A callback 404 usually means the hostname, exact Agent path, or serving route
  is missing. Check the Agent's `HTTPRoute` and its accepted listener.
- A 401 or 403 means SDK authentication rejected the request. Check the Azure
  Bot registration, app password, tenant ID, and Microsoft token issuer.
- A callback can authenticate while the native access policy rejects its
  sender. Check personal-message rules, team/channel IDs, and mention policy.
- Token or reply timeouts can indicate denied proxy egress. Check the proxy
  host policy and the Gateway's NetworkPolicy; do not grant blanket Gateway
  internet access to bypass a missing endpoint.

See [credential ownership](../../reference/drivers/kubernetes-compute/storage-and-credentials.md)
and the [callback flow](../../flows/agent-channel-ingress.md).

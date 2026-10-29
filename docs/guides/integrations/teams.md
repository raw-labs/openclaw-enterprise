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
```

Keep the existing private gateway settings. In the Installation's selected
Compute Driver configuration, set `gatewayRouting.channels.hostname` to the
same hostname and enable `runtime.gatewayOutbound`. Configure its image and
infrastructure exclusions as described in [managed Gateway outbound](../../reference/gateway-outbound.md).
The bundled Channel Driver declares the exact Microsoft Public cloud messaging
destinations for each Agent revision. Slack and Teams can run together.
The [embedded trial](embedded-channel-trial.md) requires a separate, default-off
opt-in and permits only channel-derived destinations.

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
removes its HTTPRoute, Service, SecurityPolicy and NetworkPolicy.

Advanced native configurations remain inspectable and can be disabled in the
console. Unsupported editor shapes require the Configuration API; the editor
does not flatten multiple teams or wildcard access rules. Deployment refuses
custom webhook paths and legacy webhook listeners before stopping the serving
Agent. Correct the setting named in the refusal, then deploy again.

## Configure outgoing channel files

To let the Agent send documents into channels or group chats, enter the optional
**SharePoint site ID** under **Files sent by the Agent**. Use the canonical Graph
ID, such as `example.sharepoint.com,site-collection-UUID,site-UUID`, not a Team ID
or a site URL. OCE saves this as native `channels.msteams.sharePointSiteId`;
the Configuration API and `occ configuration update` use the same setting.
Clearing the field removes it. Existing advanced settings remain intact.

The pinned native plugin uploads to `OpenClawShared` in that site's default
document library, independently of the selected Team/channel. The app needs
Microsoft Graph permission and a write grant for the destination; prefer
`Sites.Selected` with a grant to the intended site rather than tenant-wide access.
A write grant alone does not prove the complete upload and sharing operation
will succeed. Group-chat sharing also needs a supported chat-member read grant.
OCE does not grant these permissions, discover a destination automatically, or
open network destinations when this field is saved.

For channel files, the native plugin creates organization-scoped view links:
people signed into the organization who obtain the link can access the file,
including people outside the Team. Group chats use links for the resolved chat
members; existing site/library permissions still apply. These are native
[upload and sharing semantics](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/extensions/msteams/src/graph-upload.ts),
not additional restrictions enforced by the editor.

Leave the destination empty when channel/group document sending is unnecessary.
Text messaging and personal-chat file consent do not require it; channel/group
images can use the native inline path when no site is configured. Incoming
attachment downloads use message references and have separate permissions and
network requirements. Live outgoing file delivery remains unqualified.

## Prepare attachment downloads

Attachments remain unqualified for live Teams use. For a controlled trial on a
Dedicated Agent, review the attachment URL and every redirect hostname without
copying signed URLs into logs. Add only the required exact storage hosts through
that Agent's [managed outbound policy](../../reference/gateway-outbound.md).
Each redirect must pass that policy independently. Additional hosts are
Dedicated-only; the embedded trial accepts only channel-derived destinations.

The revision-owned proxy checks destination names and resolved addresses, denies
private, reserved and Installation infrastructure addresses, and connects to the
validated numeric address. Compute supplies the proxy environment and
`OPENCLAW_PROXY_ACTIVE=1` only to the Gateway using that admitted transport.
Native URL, redirect, token and TLS checks remain active. The Dedicated Harness
receives neither channel credentials nor this trust marker. Agent configuration
cannot override proxy environment or the trust marker.

Native `channels.msteams.mediaAllowHosts` may also need an exact destination
that its defaults do not admit. This is separate from proxy admission and
`channels.msteams.mediaAuthAllowHosts`: a signed storage URL does not justify forwarding Microsoft's
bearer token to that host. Preserve the native authentication-host restrictions.

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

The production API needs an approved route to
`login.microsoftonline.com:443` and `graph.microsoft.com:443`. Enable the API-only
`outboundProxy` and configure its infrastructure exclusions; the bundled Driver
supplies both Teams management destinations. This proxy is separate from each
Agent revision's runtime proxy. Missing directory consent or egress
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
- A missing attachment can indicate native media-host rejection, a denied
  storage or redirect host, or absent guarded-proxy trust. Check the native
  download error and proxy destination policy before changing either allowlist.

See [credential ownership](../../reference/drivers/kubernetes-compute/storage-and-credentials.md)
and the [callback flow](../../flows/agent-channel-ingress.md).

# Bundled Teams Channel Driver

## Overview

The bundled `TeamsChannelDriver` reads standard channels and members from one
selected Team for the console name picker. The bundled Channel Driver routes
`provider: "msteams"` lookups to this adapter. Message delivery remains the
native `msteams` plugin's responsibility.

## Interface

Lookup uses the [ChannelDriver contract](channel.md), with `context` containing
`appId`, `tenantId` and `teamId` UUIDs. `teamId` is the Entra group ID used by
Graph; returned `workspaceId` is the native Team ID used for bot routing.
`kind` selects `channels` or `users`. Searches match names, IDs and available
member email addresses. Hydration resolves up to twenty selected IDs.

## Authentication and authorization

OCC requires the exact edit permission and `operate` on the same-Namespace
app-password Secret, rechecking both after the Secret read. The adapter exchanges
that password through the tenant-specific OAuth client-credentials endpoint
for a Graph token with `https://graph.microsoft.com/.default`. Both credentials
remain in process and are not returned to the console.

The app needs application resource-specific consent (RSC) for
`ChannelSettings.Read.Group` and `TeamMember.Read.Group` in the selected Team.
These grants are part of Teams app installation, not an OCE access binding.
See [directory setup](../../guides/integrations/teams.md#enable-team-scoped-name-lookup).
Directory consent is optional for bot deployment and does not read messages.

## Provider calls

The adapter calls Graph `GET /teams/{group-id}/primaryChannel` to obtain the
native Team ID, then [`/channels`](https://learn.microsoft.com/en-us/graph/api/channel-list?view=graph-rest-1.0)
or [`/members`](https://learn.microsoft.com/en-us/graph/api/team-list-members?view=graph-rest-1.0).
People use the member's `userId`, not its opaque membership-entry ID. The
adapter does not enumerate tenant-wide Teams or users.

Each lookup has an eight-second budget, reads at most three provider pages,
and returns at most 100 candidates. Provider bodies are bounded to two MB;
member pages request 100 entries and channel responses permit up to 1,000.
An opaque cursor binds continuation to the app, tenant, Team, kind and query.
Only a checked Graph skip token and local page offset can continue lookup;
provider-supplied URLs are never followed. Redirects are rejected.

## Lifecycle

Lookup does not change Configuration or Microsoft permissions. Search text and
names remain transient. The regular console save writes native Team/channel IDs
and Entra user IDs to native Teams access settings. A Team link contains the
Graph group UUID and native Team ID; a bare group UUID requires successful
lookup before saving channel access. Only native IDs persist: paste a Team link
again when reopening the editor to browse names. Changed lookup context discards
obsolete browser results.

## Limits

This adapter supports Microsoft Public cloud with an app password. It lists
standard channels and the selected Team's roster; private/shared channel
discovery and organization-wide directory search are outside this scope.
Known IDs outside the roster remain available through exact-ID entry. A label
does not prove bot installation, message visibility, consent in another Team,
or successful posting. Incomplete search requires continuation. Hydration fails
if its page budget ends before determining the requested IDs.

## Troubleshooting

Credential rejection, missing consent, rate limiting, malformed responses and
unavailable providers return sanitized `CHANNEL_DIRECTORY_*` errors. Missing
consent requires updating and installing the app in the selected Team; broader
tenant permissions are unnecessary. Production lookup needs the API directory
proxy to reach `login.microsoftonline.com:443` and `graph.microsoft.com:443`.
Exact-ID entry remains available during lookup failures.

## Related

- [Teams operator setup](../../guides/integrations/teams.md)
- [Channel directory execution flow](../../flows/agent-channel-directory.md)
- [Verification and live-consent limits](../../testing/teams.md)

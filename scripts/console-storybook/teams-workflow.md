# Teams channel editor workflow

Use **Components / Channels / Teams Editor** to inspect app and tenant IDs,
the app-password Secret picker, channel mentions, and personal-message policy.
Change the personal policy to Allowlist, enter an exact user ID, save, reopen,
and inspect native Configuration. Channel access must retain its separate rules.

Also inspect **Teams**, **Teams Missing Secret**, **Teams Unsupported**, and
**Teams Read Only**, **Teams Secrets Loading**, **Teams Save Denied**, and
**Teams Save Pending**. Missing credentials prevent deployment; advanced native
settings remain inspectable and cannot be flattened by the editor. Deployed
versions have no mutable editor. The shared channel transaction provides loading,
error, permission, and outcome-unknown states; Teams uses the same transaction.

Inspect **Teams Directory Channels**, **Teams Directory Members**, **Teams
Directory Denied**, **Teams Directory Loading**, **Teams Directory Empty** and
**Teams Directory Missing Secret**. Paste a Team link, search Engineering, select
it, choose selected people, search Sam and select that member. Set personal
messages to Allowlist and choose Alex. Save and reopen: native IDs persist;
paste the Team link again to resolve names. Check exact-ID entry after the
missing-consent error. Check that changing Team, app, tenant or Secret prevents
old search results from becoming selections.

These are simulated UI fixtures. They do not prove Microsoft credentials,
persistence, deployment, callback authentication, or actual Teams replies.
See [Teams verification](../../docs/testing/teams.md) for integration checks.

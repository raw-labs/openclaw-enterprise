# Draft Agent workload temporary environments

This RFC-0019 draft connects workload-authorized HTTP operations to PostgreSQL
reservations, the regular controller worker and Kubernetes allocation/cleanup.
It remains opt-in and **not deployment-qualified**. Runtime image recipes,
namespace-scoped RBAC, TLS/egress configuration and the Crabbox adapter are wired,
but image builds and live acceptance remain unverified.

## Request and authority

The workload-only base path is
`/namespaces/:namespaceId/agents/:agentId/temporary-environments`.

| Method and suffix      | Operation                                                                        |
| ---------------------- | -------------------------------------------------------------------------------- |
| GET /readiness         | Discover approved profiles; no allocation                                        |
| POST base path         | Acquire with requestId, name, slug, profileId and canonical Ed25519 sshPublicKey |
| GET base path          | List this active revision's reservations                                         |
| GET /:requestId        | Read exact-request state                                                         |
| POST /:requestId/touch | Renew idle lifetime, never the hard deadline                                     |
| DELETE /:requestId     | Request cleanup; HTTP 202 is not confirmed deletion                              |

Send the executing Agent's projected token as a Bearer credential. Cookies and
service API keys, including mixed credentials, are refused. Other OCC routes
still reject workload bearer authentication. Paths must match verified workload
ownership; knowing resource IDs grants no access.

OCC checks the current Namespace, Agent, running state, revision, ServicePrincipal
and selected Compute identity. The selected IAM Driver must grant `operate` on
that exact Agent. Mutations recheck authority under Namespace/Agent locks. Profile
selection must also match the operator's Namespace allowlist. Stop, revision
replacement and revoked grants refuse further workload operations.

Readiness returns `supported` and the allowed profiles. Acquisition stores its
immutable request and deadline, quota usage, work and attributable audit together.
An identical retry returns the same record; changed name, slug, key or profile parameters conflict.
Only `usable: true` responses include SSH host/port/user. Internal receipts and private
keys are never returned. Removed profiles and expired deadlines suppress SSH metadata.
Denials use the existing audit path.

## Worker and cleanup

The existing durable work queue owns allocation, readiness checks and expiry.
A single-winner allocation-start transition precedes Driver I/O. Recovery observes
rather than blindly recreating after an uncertain effect. Stop, revision cutover
and Namespace teardown wake cleanup through the same queue.

Release returns `deleting` until the selected owning Driver confirms every owned
resource absent. Only then do quota counters decrease and live owner references
detach; historical identity remains. Uncertain partial effects retain work and
quota, potentially indefinitely. A missing receipt plus a 404 is not sufficient
release evidence. See [repository semantics](../platform-repositories.md#draft-temporary-environment-reservations).

## Kubernetes opt-in and limits

Trusted Compute configuration supplies `temporaryEnvironmentApiUrl` and projected
ServicePrincipal credentials with an OCC-specific audience. An exact translated
`temporaryEnvironmentApiEgress: {cidr, port}` grants Agent-only TCP access; optional
`temporaryEnvironmentApiCaBundle` adds trusted PEM certificates without disabling
TLS. Helm `temporaryEnvironments.enabled` adds tenant-worker Pod create/delete
and API-only TokenReview permission. Existing `api.clients` ingress must also
approve the Agent route. Verification requires
TokenReview Pod name/UID evidence plus the exact live managed Pod. Unbound
ServiceAccount tokens do not suffice; Kubernetes administrators remain trusted.

Optional `temporaryEnvironments` contains a shared quota and explicit profiles with
Namespace allowlists, digest-pinned SSH images, CPU/memory, hard/idle limits and
exact TCP /32 egress rules. Ordinary restricted Pods only: Sandbox, two-cluster and
nested-cluster execution is unsupported. The Driver owns Pod, private Service and two
NetworkPolicies. SSH access is restricted to the owning Agent revision; no API token,
host socket, host network, privilege escalation or writable root filesystem is supplied.
The [Kubernetes testing guide](../../testing/kubernetes.md#temporary-environment-workload-probe)
records the unbundled image contract and real proof requirements.

The Agent image recipe packages unmodified Crabbox and its skills at the RFC pin.
Select an approved profile through the existing Agent edit API:

```http
PATCH /namespaces/{namespaceId}/agents/{agentId}
Content-Type: application/json

{"configurationId":"cfg_00000000-0000-4000-8000-000000000001","temporaryEnvironments":{"profileId":"tests-small"}}
```

This is OCE Agent metadata, not a key inside the strict Harness configuration.
An absent selection disables the capability; send `temporaryEnvironments: null`
to remove it. Edits take effect on the next deployment, which freezes the selection
in the admitted AgentRevision. Operator-approved profiles alone do not enable Agents.
Readiness and acquisition expose only that revision's selected profile, and renewal
fails if the profile is removed. Exact-Agent IAM `operate` remains independently required.
Only an enabled Agent receives provider configuration, key setup and skill discovery. The separate Gateway receives
no adapter credentials. Private keys remain owner-only inside the Agent; every
HTTP call rereads its projected credential and refuses redirects.

`occ-crabbox-provider` implements acquire, resolve, list, touch, release, cleanup
and doctor. Release validates the raw lease/name/slug/cloud identity and waits
for the exact persisted `deleted` receipt. Neither HTTP 202 nor 404 is successful
cleanup. Cancellation retains the server-owned obligation. `keep: true` is
explicitly unsupported; hard and idle deadlines cannot be bypassed.

The temporary SSH image has a separate source recipe under
`deploy/runtime/temporary-environments/`; an operator must build, qualify and
select its immutable digest. Its nonroot SSH server disables passwords, forwarding
and TTY and independently enforces hard expiry. Idle expiry remains worker-owned.
Image builds, actual Crabbox execution and network enforcement are still unverified.

## Related

- [Source-backed flow](../../flows/temporary-environment-readiness.md)
- [Implementation plan](../../../specs/plans/0019-temporary-test-environments.md)

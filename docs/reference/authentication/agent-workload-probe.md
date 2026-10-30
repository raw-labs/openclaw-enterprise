# Draft Agent workload probe

This RFC-0019 draft implements authentication for a temporary-environment
readiness probe, not temporary environments. Do not deploy it as a remote test
service. Allocation, durable leases, quota, SSH, expiry, cleanup and nested k3d
are absent. Other Compute Drivers do not implement workload verification.

## Request and authority

The only workload-authenticated route is

`GET /namespaces/:namespaceId/agents/:agentId/temporary-environments/readiness`

Send the executing Agent's projected token as a Bearer credential. Cookies and
service API keys are refused, including mixed credentials. This does not enable
bearer authentication on other OCC routes. The Namespace and Agent in the path
must match the verified workload; knowing their IDs grants nothing.

OCC checks current Namespace readiness, Agent state, desired running state,
active revision, ServicePrincipal and Compute identity. The selected IAM Driver
must resolve that Agent-owned ServicePrincipal and grant it `operate` on the
exact Agent. No implicit grant or human impersonation is added. Stop, revision
replacement and removed grants refuse subsequent requests.

An authorized response is HTTP 200 with `supported: false` and reason
`TEMPORARY_ENVIRONMENT_LIFECYCLE_NOT_IMPLEMENTED`. It is not an allocation
success. Unsupported Drivers return 501; failed verification dependencies return
503 with provider details removed. Identity/lifecycle or permission refusals
return 403; missing or mixed credentials return 401. Denials use existing audit
handling. No environment mutation takes place.

## Kubernetes opt-in

The trusted Compute configuration can set `temporaryEnvironmentApiUrl` to an HTTPS
OCC base URL without embedded credentials, query or fragment. It also requires
`servicePrincipalCredentials.mode: projectedServiceAccountToken` with an OCC-specific audience.
The API's selected Kubernetes identity needs TokenReview create permission and
existing managed-Pod read/discovery access in the execution cluster. Grant only
those operations; this draft adds no Helm RBAC or network permissions.

Verification requires Kubernetes's Pod name/UID TokenReview evidence and a live
managed Pod with matching UID, ServiceAccount, owner and revision metadata.
Unbound ServiceAccount tokens do not suffice. Kubernetes workload administrators
remain trusted: Pod metadata is not an isolation boundary against them.

The Driver supplies `OCC_WORKLOAD_URL`, `OCC_WORKLOAD_NAMESPACE_ID`, `OCC_WORKLOAD_AGENT_ID` and `OCC_WORKLOAD_TOKEN_FILE` to the token-bearing Harness or embedded
workload. The image packages `occ-crabbox-provider`. Its doctor operation reads the
projected token file, uses a 15-second deadline and refuses redirects. Other
operations fail before reading credentials and never report successful release.
The adapter ignores external-provider config as an authority source.

Unmodified Crabbox CLI/skill installation, operator network setup and genuine
in-Agent invocation remain unfinished. The adapter's JSON envelope targets the
pinned protocol v1 in RFC-0019; it is not coordinator compatibility.

## Verification and implementation

- [Source-backed flow](../../flows/temporary-environment-readiness.md)
- [Required real-runtime tests](../../testing/kubernetes.md#temporary-environment-workload-probe)
- [Remaining implementation](../../../specs/plans/0019-temporary-test-environments.md)

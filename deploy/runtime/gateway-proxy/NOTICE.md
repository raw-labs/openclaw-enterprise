# Gateway proxy runtime assets

`sandbox-policy.rego` is an unchanged copy from NVIDIA OpenShell 0.1.5,
source commit `bdb956f2cd65a635f1294fccf1d138d263bf650f`, path
`crates/openshell-supervisor-network/data/sandbox-policy.rego`.
Its original copyright and Apache-2.0 SPDX notices remain intact.
The accompanying `LICENSE-OpenShell` contains the Apache License 2.0.

`assets.json` records the source, policy hash, and immutable supervisor and
socat image references. The controller validates policy bytes before admission.
Runtime images retain their own upstream licensing and notices.

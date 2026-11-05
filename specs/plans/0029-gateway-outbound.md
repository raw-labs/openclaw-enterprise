---
rfc: ../rfcs/0029-gateway-outbound.md
---

# Implementation plan: managed Gateway outbound HTTPS

- **ID:** RFC-0029
- **Delivery status:** In progress
- **Authority:** [RFC-0029](../rfcs/0029-gateway-outbound.md)
- **RFC review:** [#3520](https://github.com/openclaw/openclaw-enterprise/pull/3520)
- **Original source baseline:** `d3ccc54781d0d50b40e9aeb814f0573d38c0a585`
- **Current refresh target:** upstream `main` at `b891554203643c769f19d71860d03382bb9717bc`

## Outcome and scope

Keep this branch as a draft implementation for reference and experimentation.
Architectural discussion takes place in the separate RFC review linked above;
prototype evidence does not establish design acceptance or release qualification.
Preserve dedicated execution and existing credential owners. Supply automatic Slack
requirements, explicitly approved restricted/public integration HTTPS, isolated
revision proxies and a separately restricted control-plane transport. Teams
implementation, embedded networking and remote plugin hosting are excluded.
Harness egress and Credential Proxy mediation remain separate. Credential Proxy
RFC-0023 is on main; its implementation PR #2487 is not a dependency. Protected
compositions remain unqualified.

## Implementation

1. Extend shared Agent/revision, Compute capability/admission and Channel network
   requirement contracts. Add exact authorization, API schema, immutable
   snapshots, PostgreSQL constraints and in-memory equivalent behavior.
2. Replace vendor-specific proxy policy with validated generic CONNECT policy,
   vetted DNS/IP connection and bounded lifecycle/diagnostics. Compose Slack
   management transport independently of Agent lifecycle.
3. Integrate revision proxy preparation, readiness, exact peers, runtime
   environment and teardown with Kubernetes Compute. Preserve Harness networking
   and model-credential placement. Freeze admitted address exclusions and reconcile
   tightened Installation ceilings on existing proxies; prove old tunnels close
   before the replacement policy is applied and loosening cannot broaden a revision.
   Use pure `revisionAccessStatus` before Compute effects and persist `withdrawn`
   before invoking removal-only `withdrawRevisionAccess`, so a revision
   with both Gateway and public GitHub reader access closes both. Reader withdrawal
   removes its policy and terminates the admitted Harness before terminal failure,
   preserving existing failure evidence and required retirement across restart.
4. Expose Agent controls and draft/admitted state in Console, updating
   Storybook scenarios and capturing screenshots plus a short walkthrough.
5. Update architecture, living reference, operator procedures and source-backed
   flows; regenerate API references and update affected cheat sheets.
6. Run proportional integration and native-runtime proof, clean the diff and
   complete independent review. Keep the PR draft for missing required evidence.

## Current refresh verification (2026-11-05)

The refresh retains current upstream model-provider, Gateway managed-mode, worker
recovery and moved Driver/Console owners. Migration `0067_gateway_outbound` follows
upstream 0066 without changing published migration bytes. The proposal is still
Proposed; source delivery does not approve its trust model or qualify production use.

- Actual proxy, Compute, memory, Slack transport and API checks: 479 passed of
  480 on the broad run; the remaining tunnel mock-restoration failure was fixed
  and its full affected file passed 8/8 without skips. Public certificate-verified
  HTTPS was explicitly selected and passed.
- Real PostgreSQL: state 13/14, with the missing-Go browsing case passing 1/1
  after installing required Go 1.27.3; migration compatibility 191/192, with the
  affected restore/upgrade case passing 1/1 after recording actual catalog aliases.
  Worker health and withdrawal/restart recovery passed 29/29. No selected skips.
- Actual K3d/PostgreSQL provisioning passed 2/2 with the real revision proxy
  image. The lane's older Node default failed the Dockerfile version guard; the
  successful retry selected official immutable Node 24.22.1; the newly image-building
  lane now pins that verified image. This proves fixture
  projection/readiness, not native plugin transport or a model turn.
- Real Console/API browser checks passed 3/3: tabs, keyboard/overflow, Network
  save/reload and navigation held until an in-flight save completes.
- Types, full lint, workspace boundary, generated OpenAPI/examples and CI
  inventory passed. Documentation validated 320 pages, 5,181 links and 107 specs.
- Rebuilt Storybook: nine Network states, tablet/phone saves and a 21.04-second
  four-action recording inspected. [Screenshots and recording](https://gist.github.com/miguelbranco80/f49a2c9525105015abb899b36b22ab99)
  use simulated API/runtime state. Before comparison uses exact pinned-upstream
  detail/navigation owners with candidate fixtures, not a complete baseline build.
- Profile/renderer/generated-reference checks passed 129 cases; its eight
  unselected Collector cases then ran in the selected native suite, which passed
  11/11 without skips. Committed-head Helm packaging passed 108/108; CI
  preparation contracts passed 116/116. Workflow actionlint passed. Final format
  and eight standalone flow structures passed; the Configuration persistence
  companion retains its parent flow structure.
- Preserved merge commit: `5db345c0b969187a966b6886bf7bc2df2290475d`.
  Independent Codex review of the complete refreshed diff at
  `51fcf47620874598e18dcbab5a8599cf98157c7c` completed three passes with no
  actionable P0–P2 findings. The initial oversized request failed before assessment;
  the successful retry preserved all input in smaller batches. Subsequent changes
  record this review result only.

Required acceptance gaps remain open: native installed Gateway/plugin and
model execution, both image architectures, full Helm-installed/Envoy paths,
DNS mixed-answer/rebinding runtime proof, live providers, protected Harness and
Credential Proxy composition, maintainer trust/design acceptance and final CI.
No authorized native model selector/key was available for that qualification.

## Original verification (historical source)

| Outcome                                      | Required proof                                                                             | Current result                                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorized save/deploy and denied widening   | Actual API/controller integration                                                          | 11 Console/API workflow cases passed; exact Agent authorization and deploy admission exercised                                                      |
| Persisted selection and immutable revision   | PostgreSQL integration with migrated disposable database                                   | Feature case passed with limited application role; all 148 migration-history cases passed                                                           |
| DNS/IP denial and pinned CONNECT transport   | Real local proxy request integration                                                       | Nine real proxy cases passed, including the explicitly selected public-HTTPS lane; mixed-answer/rebinding fixture proof remains pending             |
| Gateway HTTPS, Agent isolation and lifecycle | Enforcing disposable Kubernetes cluster with actual native runtime                         | Four real-cluster fixture cases passed without skips; native case in progress; 577 Compute conformance cases passed with one existing platform skip |
| Slack management/runtime coexistence         | Actual Driver transport and native Slack client; live provider requires authorized Secrets | 80 Driver/profile and 121 real Helm packaging/parity cases passed; live Slack, Teams and Composio provider proof not run                            |
| Console workflow                             | Rebuilt Storybook, screenshots and walkthrough; real API behavior checked separately       | Nine Network stories inspected; native GitHub screenshot and 18-second captured-frame walkthrough attachments uploaded for the PR                   |

## Original delivery record

Implementation commit `27562ebf5` starts from the original source baseline above.
The [implementation PR](https://github.com/openclaw/openclaw-enterprise/pull/2518)
includes this RFC and its implementation. RFC status remains Proposed pending human
review. Verification counts below describe the earlier source; the refreshed base
and composed revision-access withdrawal require new qualification.

TypeScript, lint, workspace, OpenAPI, format, documentation/link and specification
checks passed. Console captures use simulated API/runtime fixtures on macOS arm64
at 1400 × 900; they establish the visible workflow only. Backend and native
networking proof are separate. Required final-head CI, both native image
architectures and full Helm-installed production proof remain merge requirements.
Independent P2 reviews found abandoned proxy authority after deployer revocation
and a lost runtime retirement obligation during withdrawal. Both fixes preserve
durable removal-only work, failure evidence and required cleanup across retries,
restart and lease recovery. Five focused PostgreSQL cases and the existing
candidate cleanup case passed without skips; final refinement review and native
proof remain in progress. The native finalizer regression also found a proxy Pod
selector mismatch that allowed premature finalization; the corrected wait uses
the actual revision ownership labels. The broad local conformance attempt also encountered host
prerequisite failures; targeted passing suites do not imply all local suites passed.

## Changelog

- 2026-10-14: Created the agreed combined RFC/implementation delivery plan from
  upstream `d3ccc54781d0d50b40e9aeb814f0573d38c0a585`.
- 2026-10-16: Renumbered to RFC-0021 after upstream allocated RFC-0020; refreshed
  against current main and composed Gateway/reader withdrawal through Compute.
- 2026-10-19: Renumbered to RFC-0023 after upstream allocated RFC-0021 and RFC-0022;
  integrated Sandbox policies while retaining the separate Gateway transport boundary.

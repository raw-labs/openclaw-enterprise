import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { KubernetesObjectApi } from "@kubernetes/client-node";
import { asRecord } from "@openclaw-enterprise/utils";
import type {
  Backend,
  GatewaySandboxCapability,
  GatewaySandboxContext,
  GatewaySandboxRequirements,
  GatewaySandboxEndpoint,
  GatewaySandboxStatus,
  GatewaySandboxObservation,
  GatewaySandboxNodeBinding,
  SandboxNamespaceContext,
  SandboxResourceRef,
} from "@openclaw-enterprise/contracts";
import { openShellWorkspaceName } from "../../backends/openshell.ts";
import { RUNTIME_READINESS_PATH } from "../compute/kubernetes/runtime-entrypoints.ts";
import type { OpenShellGateway } from "../../backends/openshell.ts";
import type { OpenShellSandboxDriverOptions } from "./openshell.ts";
import { toProtobufStruct, gatewayIdentityRefusal } from "./openshell-gateway-client.ts";
import type {
  OpenShellSandboxResponse,
  OpenShellSandboxCreateRequest,
} from "./openshell-gateway-client.ts";
import { openShellGatewayNetworkPolicy } from "./openshell-gateway-policy.ts";
import {
  GATEWAY_LAUNCHER,
  GATEWAY_PRIVATE_ROOT,
  GATEWAY_RELEASE,
  GATEWAY_BINDING_UPDATE,
} from "./openshell-gateway-launch.ts";

const OWNER = "openclaw.dev/";
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  const record = asRecord(value);
  if (!record) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(record)
      .filter(
        ([key, v]) =>
          key !== "provider_attachment_epoch" &&
          !(key.startsWith("_") && v === key.slice(1)) &&
          !(key === "kind" && typeof v === "string" && Object.hasOwn(record, v)),
      )
      .map(([key, v]) => [key, canonical(v)]),
  );
}
function fail(): never {
  throw new Error("OpenShell Gateway containment ownership or configuration is invalid.");
}
function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function requestUuid(value: unknown) {
  const h = digest(value);
  return (
    h.slice(0, 8) +
    "-" +
    h.slice(8, 12) +
    "-5" +
    h.slice(13, 16) +
    "-a" +
    h.slice(17, 20) +
    "-" +
    h.slice(20, 32)
  );
}
function safePath(value: string) {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    value.split("/").every((x) => x !== ".." && x !== "." && x.length > 0)
  );
}

export class OpenShellGatewaySandboxCapability implements GatewaySandboxCapability {
  readonly home = "/tmp/oce-gateway-home";
  readonly identity: string;
  private readonly options: OpenShellSandboxDriverOptions;
  private readonly backend: Backend<OpenShellGateway>;
  private readonly prepare: (context: SandboxNamespaceContext) => Promise<void>;
  private readonly prepareState: (
    context: GatewaySandboxContext,
    sandbox: SandboxResourceRef,
  ) => Promise<void>;

  constructor(
    options: OpenShellSandboxDriverOptions,
    backend: Backend<OpenShellGateway>,
    prepare: (context: SandboxNamespaceContext) => Promise<void>,
    prepareState: (context: GatewaySandboxContext, sandbox: SandboxResourceRef) => Promise<void>,
    owner: { readonly id: string; readonly implementation: string },
  ) {
    this.identity = digest({
      version: "openshell-gateway/v1",
      driver: owner,
      backendId: backend.id,
      control: backend.client.gatewayOwnerSelection(),
      runtime: {
        runtimeClassName: options.kubernetes.runtimeClassName,
        userNamespaces: options.kubernetes.userNamespaces,
        process: {
          user: options.policy.process.runAsUser,
          group: options.policy.process.runAsGroup,
        },
        workspaceMode: options.gateway.workspaceMode,
        namespaceLabels: Object.entries(options.gateway.operatorNamespaceLabels ?? {}).sort(
          ([a], [b]) => a.localeCompare(b),
        ),
      },
    });
    this.options = options;
    this.backend = backend;
    this.prepare = prepare;
    this.prepareState = prepareState;
  }

  validate(requirements: GatewaySandboxRequirements): void {
    this.backend.client.assertAuthenticatedGatewayTransport();
    if (this.options.kubernetes.userNamespaces !== false) {
      throw new Error("Gateway private-state preparation requires OpenShell userNamespaces:false.");
    }
    if (
      !requirements.image ||
      requirements.command.length === 0 ||
      requirements.command.some((x) => !x || x.includes("\0")) ||
      requirements.files.length > 32 ||
      requirements.environment.length > 128 ||
      Buffer.byteLength(JSON.stringify(requirements.configuration)) > 262_144 ||
      !safePath(requirements.state.stateSubPath) ||
      !safePath(requirements.state.workspaceSubPath) ||
      requirements.state.stateSubPath === requirements.state.workspaceSubPath ||
      !requirements.state.claimName
    ) {
      fail();
    }
    if (
      requirements.state.stateSubPath.startsWith(requirements.state.workspaceSubPath + "/") ||
      requirements.state.workspaceSubPath.startsWith(requirements.state.stateSubPath + "/")
    ) {
      fail();
    }
    const categories: Record<string, string> = {
      state: "/home/node/.openclaw/state",
      client: "/home/node/.openclaw/client",
      agent: "/home/node/.openclaw/agents/main/agent",
      media: "/home/node/.openclaw/media",
      worktrees: "/home/node/.openclaw/worktrees",
      "worktree-sources": "/home/node/.openclaw/worktree-sources",
      sessions: "/home/node/.openclaw/agents/main/sessions",
    };
    if (
      !requirements.state.mounts ||
      requirements.state.mounts.length !== Object.keys(categories).length ||
      requirements.state.mounts.some((mount) => categories[mount.subPath] !== mount.mountPath) ||
      new Set(requirements.state.mounts.map((mount) => mount.subPath)).size !==
        requirements.state.mounts.length
    ) {
      fail();
    }
    if (Object.keys(requirements.resources).some((key) => key !== "requests" && key !== "limits")) {
      fail();
    }
    for (const entry of requirements.environment) {
      if (
        !/^[A-Z_][A-Z0-9_]*$/u.test(entry.name) ||
        (entry.value === undefined) === (entry.secretKeyRef === undefined) ||
        /^(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED)$/iu.test(
          entry.name,
        ) ||
        /(?:MODEL_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|CODEX_API_KEY)/u.test(entry.name)
      ) {
        fail();
      }
    }
    if (
      new Set(requirements.environment.map((x) => x.name)).size !== requirements.environment.length
    ) {
      fail();
    }
    if (new Set(requirements.files.map((file) => file.path)).size !== requirements.files.length) {
      fail();
    }
    for (const file of requirements.files) {
      if (
        !file.path.startsWith(GATEWAY_PRIVATE_ROOT + "/") ||
        file.path.includes("..") ||
        file.path.includes("\0") ||
        file.path.includes("//") ||
        [
          "challenge.json",
          "release.json",
          "release.staged",
          "accepted.json",
          "configuration.json",
          "workspace-node.json",
          "workspace-node.staged",
        ].includes(file.path.slice(GATEWAY_PRIVATE_ROOT.length + 1))
      ) {
        fail();
      }
    }
    openShellGatewayNetworkPolicy(requirements);
  }

  ensureNamespace(context: SandboxNamespaceContext): Promise<void> {
    this.backend.client.assertAuthenticatedGatewayTransport();
    return this.prepare(context);
  }
  private client(context: GatewaySandboxContext) {
    this.backend.client.assertAuthenticatedGatewayTransport();
    return this.backend.client.clientForNamespace(context.namespace.name);
  }
  private ref(context: GatewaySandboxContext): SandboxResourceRef {
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(context.generation)) {
      fail();
    }
    return {
      namespaceName: context.namespace.name,
      resourceName:
        "gateway-" +
        digest([context.revision.agentId, context.revision.id, context.generation]).slice(0, 24),
      agentId: context.revision.agentId,
      revisionId: context.revision.id,
    };
  }
  private selection(context: GatewaySandboxContext) {
    return {
      workspace: openShellWorkspaceName(context.namespace),
      name: this.ref(context).resourceName,
    };
  }
  private request(context: GatewaySandboxContext): OpenShellSandboxCreateRequest {
    this.validate(context.requirements);
    const r = context.requirements;
    const ref = this.ref(context);
    const ownership = {
      "app.kubernetes.io/managed-by": "openclaw-enterprise",
      [OWNER + "namespace-id"]: context.revision.namespaceId,
      [OWNER + "agent"]: context.revision.agentId,
      [OWNER + "revision"]: context.revision.id,
      [OWNER + "runtime-role"]: "gateway",
    };
    const driverConfig = {
      kubernetes: {
        pod: {
          runtime_class_name: this.options.kubernetes.runtimeClassName,
          ...(r.nodeSelector ? { node_selector: { ...r.nodeSelector } } : {}),
        },
        containers: {
          agent: {
            resources: { ...r.resources },
            volume_mounts: [
              ...r.state.mounts!.map((mount) => ({
                name: "gateway-state",
                mount_path: "/sandbox/gateway-state/" + mount.subPath,
                sub_path: mount.subPath,
                read_only: false,
              })),
            ],
          },
        },
        volumes: [
          {
            name: "gateway-state",
            persistent_volume_claim: { claim_name: r.state.claimName, read_only: false },
          },
        ],
      },
    };
    const spec = {
      log_level: this.options.logLevel ?? "info",
      environment: {
        OCE_GATEWAY_GENERATION: context.generation,
        HOME: this.home,
        TMPDIR: "/tmp",
      },
      template: {
        image: r.image,
        runtime_class_name: this.options.kubernetes.runtimeClassName,
        labels: { ...r.labels, ...ownership },
        driver_config: { fields: toProtobufStruct(driverConfig) },
        ...(this.options.kubernetes.userNamespaces === undefined
          ? {}
          : { user_namespaces: this.options.kubernetes.userNamespaces }),
      },
      policy: {
        version: 1,
        filesystem: {
          include_workdir: true,
          read_only: ["/bin", "/usr", "/lib", "/proc", "/dev/urandom", "/etc", "/app", "/opt"],
          read_write: ["/tmp", "/dev/null", "/sandbox/gateway-state"],
        },
        landlock: { compatibility: "hard_requirement" },
        process: {
          run_as_user: this.options.policy.process.runAsUser,
          run_as_group: this.options.policy.process.runAsGroup,
        },
        network_policies: openShellGatewayNetworkPolicy(r),
      },
      command: ["/usr/bin/tini", "-s", "--", "/usr/local/bin/node", "-e", GATEWAY_LAUNCHER],
      restart_policy: "SANDBOX_RESTART_POLICY_ALWAYS",
    };
    return {
      name: ref.resourceName,
      workspace: openShellWorkspaceName(context.namespace),
      requestId: requestUuid([ref.resourceName, digest(spec)]),
      labels: ownership,
      annotations: {
        [OWNER + "gateway-generation"]: context.generation,
        [OWNER + "gateway-owner"]: this.identity,
        [OWNER + "gateway-spec"]: digest(spec),
      },
      spec,
      serviceExposures: [
        { service: "", targetPort: 18789, authorizationMode: "bearer_passthrough" },
      ],
    };
  }
  private verifyOwnership(
    context: GatewaySandboxContext,
    observed: OpenShellSandboxResponse,
  ): void {
    const expected = {
      "app.kubernetes.io/managed-by": "openclaw-enterprise",
      [OWNER + "namespace-id"]: context.revision.namespaceId,
      [OWNER + "agent"]: context.revision.agentId,
      [OWNER + "revision"]: context.revision.id,
      [OWNER + "runtime-role"]: "gateway",
    };
    if (
      observed.name !== this.ref(context).resourceName ||
      observed.workspace !== openShellWorkspaceName(context.namespace) ||
      Object.entries(expected).some(([k, v]) => observed.labels[k] !== v) ||
      observed.annotations[OWNER + "gateway-generation"] !== context.generation ||
      observed.annotations[OWNER + "gateway-owner"] !== this.identity ||
      !observed.id
    ) {
      fail();
    }
  }
  private verify(context: GatewaySandboxContext, observed: OpenShellSandboxResponse): void {
    this.verifyOwnership(context, observed);
    const request = this.request(context);
    if (
      observed.annotations[OWNER + "gateway-spec"] !==
        request.annotations[OWNER + "gateway-spec"] ||
      !observed.spec ||
      !isDeepStrictEqual(canonical(observed.spec), canonical(request.spec))
    ) {
      fail();
    }
  }
  private async current(
    context: GatewaySandboxContext,
  ): Promise<OpenShellSandboxResponse | undefined> {
    const value = await this.client(context).getSandbox(this.selection(context), context.signal);
    if (value) {
      this.verify(context, value);
    }
    return value;
  }
  async provision(context: GatewaySandboxContext): Promise<SandboxResourceRef> {
    const request = this.request(context);
    const client = this.client(context);
    let observed = await this.current(context);
    if (!observed) {
      await this.prepareState(context, this.ref(context));
      try {
        observed = await client.createSandbox(request, context.signal);
      } catch (error) {
        observed = await this.current(context);
        if (!observed) {
          throw error;
        }
      }
      this.verify(context, observed);
    }
    if (
      (observed.phase === 2 || observed.phase === "SANDBOX_PHASE_READY") &&
      observed.mainProcessInstanceId &&
      observed.mainProcessStartedAt
    ) {
      const nonce = await this.processChallenge(context, observed);
      const material = { ...(await this.material(context, observed)), nonce };
      const exit = await client.execSandbox(
        {
          workspace: request.workspace,
          sandbox: request.name,
          command: ["/usr/local/bin/node", "-e", GATEWAY_RELEASE],
          environment: {},
          stdin: JSON.stringify(material),
          timeoutSeconds: 15,
        },
        context.signal,
      );
      if (exit !== 0) {
        throw new Error("Gateway private launch is not ready for material delivery.");
      }
      const after = await this.current(context);
      if (
        !after ||
        after.id !== observed.id ||
        after.mainProcessInstanceId !== observed.mainProcessInstanceId ||
        after.mainProcessStartedAt !== observed.mainProcessStartedAt
      ) {
        throw new Error("Gateway process changed during private material delivery.");
      }
    }
    return this.ref(context);
  }
  private async processChallenge(
    context: GatewaySandboxContext,
    before: OpenShellSandboxResponse,
  ): Promise<string> {
    const client = this.client(context);
    if (!client.readGatewayChallenge) {
      throw new Error("Gateway process challenge is unavailable.");
    }
    const nonce = await client.readGatewayChallenge(
      { ...this.selection(context), generation: context.generation },
      context.signal,
    );
    const after = await this.current(context);
    if (
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(nonce) ||
      !after ||
      after.id !== before.id ||
      after.mainProcessInstanceId !== before.mainProcessInstanceId ||
      after.mainProcessStartedAt !== before.mainProcessStartedAt
    ) {
      throw new Error("Gateway process changed while reading its private challenge.");
    }
    return nonce;
  }

  private async material(context: GatewaySandboxContext, observed: OpenShellSandboxResponse) {
    const api = context.kubernetes;
    if (!(api instanceof KubernetesObjectApi)) {
      fail();
    }
    const readSecret = async (ref: { readonly name: string; readonly key: string }) => {
      if (!ref.name || !ref.key) {
        fail();
      }
      const secret = await api.read({
        apiVersion: "v1",
        kind: "Secret",
        metadata: { namespace: context.namespace.name, name: ref.name },
      });
      const metadata = asRecord(secret.metadata);
      const labels = asRecord(metadata?.labels);
      const encoded = asRecord(asRecord(secret)?.data)?.[ref.key];
      if (
        metadata?.namespace !== context.namespace.name ||
        labels?.[OWNER + "namespace"] !== context.revision.namespaceId ||
        labels?.[OWNER + "agent"] !== context.revision.agentId ||
        typeof encoded !== "string" ||
        encoded.length > 180_000
      ) {
        fail();
      }
      const value = Buffer.from(encoded, "base64").toString("utf8");
      if (
        Buffer.from(value).toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "")
      ) {
        fail();
      }
      return value;
    };
    const environment: Record<string, string> = {};
    for (const entry of context.requirements.environment) {
      environment[entry.name] = entry.secretKeyRef
        ? await readSecret(entry.secretKeyRef)
        : entry.value!;
    }
    environment.HOME = this.home;
    environment.OPENCLAW_STATE_DIR = this.home + "/.openclaw";
    environment.OPENCLAW_AGENT_REVISION_ID = context.revision.id;
    environment.OPENCLAW_RUNTIME_STATUS_CONTAINER = "gateway";
    environment.OPENCLAW_RUNTIME_STATUS_PORT = "18791";
    const files = [];
    for (const file of context.requirements.files) {
      files.push({ path: file.path, content: await readSecret(file.secretKeyRef) });
    }
    const material = {
      generation: context.generation,
      instanceId: observed.id,
      mainProcessInstanceId: observed.mainProcessInstanceId,
      command: context.requirements.command,
      configuration: context.requirements.configuration,
      environment,
      files,
    };
    if (Buffer.byteLength(JSON.stringify(material)) > 380_000) {
      fail();
    }
    return material;
  }
  async endpoint(context: GatewaySandboxContext): Promise<GatewaySandboxEndpoint> {
    const observed = await this.current(context);
    if (!observed) {
      fail();
    }
    const service = await this.client(context).getService(
      openShellWorkspaceName(context.namespace),
      observed.name,
      "",
      context.signal,
    );
    if (
      !service ||
      service.targetPort !== 18789 ||
      !["SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH", 2].includes(service.authorizationMode)
    ) {
      fail();
    }
    const advertised = new URL(service.advertisedUrl);
    const endpoint = new URL(this.backend.client.gatewayControlOrigin(context.namespace.name));
    if (
      !advertised.hostname ||
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password
    ) {
      fail();
    }
    const caBundle = this.backend.client.publicRootCertificate();
    return {
      url: endpoint.origin,
      authority: advertised.hostname,
      ...(caBundle ? { tls: { caBundle } } : {}),
    };
  }
  async readStatus(
    context: GatewaySandboxContext,
    path: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    const before = await this.current(context);
    const client = this.client(context);
    if (
      !before?.id ||
      !before.mainProcessInstanceId ||
      !before.mainProcessStartedAt ||
      !client.readGatewayStatus
    ) {
      throw new Error("Gateway private status is not available.");
    }
    const status = await gatewayIdentityRefusal(
      openShellWorkspaceName(context.namespace),
      "private Gateway status cannot be confirmed",
    )(() => client.readGatewayStatus!({ ...this.selection(context), path }, context.signal));
    const after = await this.current(context);
    if (
      !after ||
      after.id !== before.id ||
      after.mainProcessInstanceId !== before.mainProcessInstanceId ||
      after.mainProcessStartedAt !== before.mainProcessStartedAt
    ) {
      throw new Error("Gateway private status process fencing failed.");
    }
    if (
      path !== "/openclaw/runtime/image" &&
      path !== "/readyz" &&
      (status.revisionId !== context.revision.id ||
        status.container !== "gateway" ||
        status.podUid !== before.id)
    ) {
      throw new Error("Gateway private status identity mismatch.");
    }
    return status;
  }
  async status(context: GatewaySandboxContext): Promise<GatewaySandboxStatus> {
    const observed = await this.current(context);
    if (!observed) {
      return { state: "starting" };
    }
    if (
      observed.exitCode !== undefined ||
      ["SANDBOX_PHASE_ERROR", "SANDBOX_PHASE_STOPPED", "SANDBOX_PHASE_DELETING", 3, 4, 7].includes(
        observed.phase ?? "",
      )
    ) {
      return { state: "failed", reason: "Gateway main process is not running." };
    }
    if (!observed.mainProcessInstanceId || !observed.mainProcessStartedAt) {
      return { state: "starting" };
    }
    const status = await this.readStatus(context, "/openclaw/runtime/status");
    if (status.runtimeFailure !== undefined) {
      return { state: "failed", reason: "Native Gateway startup failed." };
    }
    const readiness = await this.readStatus(context, RUNTIME_READINESS_PATH);
    return readiness.ready === true ? { state: "ready" } : { state: "starting" };
  }
  async updateNodeBinding(
    context: GatewaySandboxContext,
    binding: GatewaySandboxNodeBinding,
  ): Promise<void> {
    if (
      binding.generation !== context.generation ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(binding.nodeId) ||
      Buffer.byteLength(JSON.stringify(binding)) > 4096
    ) {
      fail();
    }
    const before = await this.current(context);
    if (!before?.id || !before.mainProcessInstanceId || !before.mainProcessStartedAt) {
      fail();
    }
    const nonce = await this.processChallenge(context, before);
    const exit = await this.client(context).execSandbox(
      {
        workspace: openShellWorkspaceName(context.namespace),
        sandbox: before.name,
        command: ["/usr/local/bin/node", "-e", GATEWAY_BINDING_UPDATE],
        environment: {},
        stdin: JSON.stringify({
          generation: binding.generation,
          nonce,
          revisionId: context.revision.id,
          nodeId: binding.nodeId,
        }),
        timeoutSeconds: 10,
      },
      context.signal,
    );
    const after = await this.current(context);
    if (
      exit !== 0 ||
      !after ||
      after.id !== before.id ||
      after.mainProcessInstanceId !== before.mainProcessInstanceId ||
      after.mainProcessStartedAt !== before.mainProcessStartedAt
    ) {
      throw new Error("Gateway node binding was not delivered to the exact process.");
    }
  }
  async observe(context: GatewaySandboxContext): Promise<GatewaySandboxObservation> {
    const observed = await this.current(context);
    if (observed && !/^[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/u.test(observed.id!)) {
      fail();
    }
    return observed
      ? {
          state: "present",
          // Pinned OpenShell supervisor control_labels derive from its minted Sandbox ID.
          networkPeer: {
            namespace: context.namespace.name,
            podLabels: {
              "openshell.ai/sandbox-id": observed.id!,
              "openshell.ai/boundary-role": "supervisor",
            },
          },
          resource: this.ref(context),
          ...(observed.id ? { instanceId: observed.id } : {}),
          ...(observed.mainProcessInstanceId
            ? { mainProcessInstanceId: observed.mainProcessInstanceId }
            : {}),
        }
      : { state: "absent" };
  }
  stop(context: GatewaySandboxContext): Promise<void> {
    return this.cleanup(context);
  }
  async cleanup(context: GatewaySandboxContext): Promise<void> {
    const client = this.client(context);
    const observed = await client.getSandbox(this.selection(context), context.signal);
    if (observed) {
      this.verifyOwnership(context, observed);
      await client.deleteSandbox(this.selection(context), context.signal);
    }
    // NOT_FOUND can hide an unauthorized Sandbox. Require workspace visibility and
    // two exact absent reads, including after a worker restart. Never touch the PVC.
    for (let i = 0; i < 2; i++) {
      const workspace = await client.getWorkspace(
        openShellWorkspaceName(context.namespace),
        context.signal,
      );
      if (
        !workspace ||
        workspace.name !== openShellWorkspaceName(context.namespace) ||
        workspace.labels["app.kubernetes.io/managed-by"] !== "openclaw-enterprise" ||
        workspace.labels[OWNER + "namespace-id"] !== context.namespace.id ||
        (await client.getSandbox(this.selection(context), context.signal))
      ) {
        throw new Error("Gateway Sandbox absence cannot be confirmed.");
      }
    }
  }
}

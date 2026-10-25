import type {
  AgentRevision,
  SandboxApplicationContext,
  SandboxApplicationProvider,
  SandboxNamespaceContext,
} from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError } from "@openclaw-enterprise/occ";
import { asRecord, numericErrorStatus, sha256Hex } from "@openclaw-enterprise/utils";
import {
  KubernetesObjectApi,
  PatchStrategy,
  type KubernetesObject,
  type V1Deployment,
  type V1Pod,
  type V1Secret,
} from "@kubernetes/client-node";
import { randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { OpenShellGateway } from "../../backends/openshell.ts";
import { openShellWorkspaceName } from "../../backends/openshell.ts";
import { FORBIDDEN_IPV4, FORBIDDEN_IPV6 } from "../../gateway/outbound-proxy.mjs";
import { APPLICATION_TRANSPORT_ENVIRONMENT } from "./openshell-application-guard.ts";
import {
  buildApplicationProjection,
  type ApplicationProjection,
} from "./openshell-application-projection.ts";
import { compileOpenShellApplicationNetworkPolicy } from "./openshell-application-policy.ts";
import {
  confirmSandboxAbsent,
  gatewayIdentityRefusal,
  toProtobufStruct,
  type OpenShellSandboxResponse,
  type OpenShellServiceResponse,
} from "./openshell-gateway-client.ts";
import { sameOpenShellSandboxSpec } from "./openshell-sandbox-spec.ts";
import type { OpenShellSandboxDriverOptions } from "./openshell.ts";

export interface OpenShellApplicationOptions {
  /** The shared OpenShell service listener; operator configuration, never Agent input. */
  readonly servicePeer: {
    readonly namespace: string;
    readonly podLabels: Readonly<Record<string, string>>;
    readonly port: number;
  };
  readonly developmentOnly: true;
}

type RevisionContext = SandboxNamespaceContext & { readonly revision: Readonly<AgentRevision> };
const OWNER = "openclaw-enterprise-application";
const GENERATION = "openclaw.dev/application-generation";
const BOOTSTRAP = "openclaw.dev/application-bootstrap";
const ROLE = "openclaw.dev/application-role";
const NODE = "openclaw.dev/application-node";
const PHASE = "openclaw.dev/application-projection-phase";
const STATUS_PORT = 18_791;
const GUARD_STATUS_PORT = STATUS_PORT + 1_000;
const STATUS_PATHS = new Set([
  "/openclaw/plugin-runtime/status",
  "/openclaw/runtime/status",
  "/readyz",
  "/openclaw/runtime/diagnostics",
  "/openclaw/runtime/image",
  "/openclaw/plugin-runtime/remote-status",
]);

function api(context: SandboxNamespaceContext): KubernetesObjectApi {
  if (!(context.kubernetes instanceof KubernetesObjectApi)) {
    throw new Error("Application containment requires the selected Kubernetes object API.");
  }
  return context.kubernetes;
}

function ownership(revision: Readonly<AgentRevision>): Record<string, string> {
  return {
    "openclaw.dev/namespace-id": revision.namespaceId,
    "openclaw.dev/agent-id": revision.agentId,
    "openclaw.dev/revision-id": revision.id,
  };
}

function owned(object: KubernetesObject, revision: Readonly<AgentRevision>): void {
  if (
    Object.entries(ownership(revision)).some(
      ([key, value]) => object.metadata?.annotations?.[key] !== value,
    )
  ) {
    throw new Error("Application containment refuses a resource without exact revision ownership.");
  }
}

async function read<T extends KubernetesObject>(
  context: SandboxNamespaceContext,
  kind: string,
  name: string,
  apiVersion = "v1",
): Promise<T | undefined> {
  context.signal.throwIfAborted();
  try {
    return (await api(context).read({
      apiVersion,
      kind,
      metadata: { name, namespace: context.namespace.name },
    })) as T;
  } catch (error) {
    if (numericErrorStatus(error) === 404) {
      return undefined;
    }
    throw error;
  }
}

async function privateSecret(
  context: SandboxNamespaceContext,
  name: string,
): Promise<V1Secret | undefined> {
  try {
    return await read<V1Secret>(context, "Secret", name);
  } catch {
    context.signal.throwIfAborted();
    // Do not expose Kubernetes error objects at a private credential boundary.
    throw new DependencyUnavailableError("An admitted application credential is unavailable.");
  }
}

async function apply<T extends KubernetesObject>(
  context: RevisionContext,
  object: T,
): Promise<void> {
  const existing = await read(context, object.kind!, object.metadata!.name!, object.apiVersion);
  if (existing) {
    owned(existing, context.revision);
    if (existing.metadata?.deletionTimestamp) {
      throw new DependencyUnavailableError("Application private resources are still terminating.");
    }
  }
  context.signal.throwIfAborted();
  await api(context).patch(
    object,
    undefined,
    undefined,
    OWNER,
    false,
    PatchStrategy.ServerSideApply,
  );
}

function names(revision: Readonly<AgentRevision>, generation?: string) {
  const role = revision.harness.mode === "embedded" ? "embedded" : "gateway";
  return {
    role,
    sandbox: `oa-${sha256Hex(`${revision.id}/${role}`, 16)}`,
    token: `application-transport-${sha256Hex(`${revision.id}/${generation ?? ""}`, 24)}`,
  };
}

function validGeneration(value: string | undefined): value is string {
  return typeof value === "string" && /^[a-f0-9]{24}$/.test(value);
}

async function listedPods(context: RevisionContext, selector: string): Promise<V1Pod[]> {
  context.signal.throwIfAborted();
  const response = await api(context).list(
    "v1",
    "Pod",
    context.namespace.name,
    undefined,
    undefined,
    undefined,
    undefined,
    selector,
  );
  if (!Array.isArray(response.items)) {
    throw new DependencyUnavailableError("Application Pod identity is unavailable.");
  }
  return response.items as V1Pod[];
}

async function nativePods(
  context: RevisionContext,
  sandbox?: OpenShellSandboxResponse,
): Promise<V1Pod[]> {
  if (sandbox && !sandbox.id) {
    throw new Error("Application Sandbox has no native identity.");
  }
  // The revision labels survive deletion of the native Sandbox record. Cleanup
  // must still wait for orphaned or terminating workload Pods in that case.
  return listedPods(
    context,
    [
      `openclaw.dev/contained-agent=${context.revision.agentId}`,
      `openclaw.dev/contained-revision=${context.revision.id}`,
      "openshell.ai/boundary-role=workload",
      ...(sandbox ? [`openshell.ai/boundary-pair=${sandbox.id}`] : []),
    ].join(","),
  );
}

function containerId(pod: V1Pod): string | undefined {
  return pod.status?.containerStatuses?.find(({ name }) => name === "agent")?.containerID;
}

function sameRunningPod(before: V1Pod, after: readonly V1Pod[]): boolean {
  return (
    after.length === 1 &&
    after[0]?.metadata?.uid === before.metadata?.uid &&
    !after[0]?.metadata?.deletionTimestamp &&
    after[0]?.status?.phase === "Running" &&
    containerId(before) !== undefined &&
    containerId(after[0]) === containerId(before)
  );
}

async function deploymentReady(
  context: RevisionContext,
  desired: V1Deployment,
): Promise<V1Pod | undefined> {
  await apply(context, desired);
  const observed = await read<V1Deployment>(
    context,
    "Deployment",
    desired.metadata!.name!,
    "apps/v1",
  );
  if (
    !observed ||
    (observed.status?.observedGeneration ?? 0) < (observed.metadata?.generation ?? 1) ||
    observed.status?.replicas !== 1 ||
    observed.status.readyReplicas !== 1 ||
    observed.status.updatedReplicas !== 1
  ) {
    return undefined;
  }
  const selector = Object.entries(desired.spec!.selector.matchLabels!)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  const pods = (await listedPods(context, selector)).filter(
    (pod) =>
      !pod.metadata?.deletionTimestamp &&
      pod.metadata?.annotations?.[PHASE] === desired.metadata?.annotations?.[PHASE] &&
      pod.status?.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
  );
  for (const pod of pods) {
    owned(pod, context.revision);
  }
  return pods.length === 1 ? pods[0] : undefined;
}

async function remove(context: RevisionContext, object: KubernetesObject): Promise<void> {
  owned(object, context.revision);
  if (object.metadata?.deletionTimestamp) {
    return;
  }
  if (!object.metadata?.uid || !object.metadata.name || !object.apiVersion || !object.kind) {
    throw new Error("Application cleanup requires an exact Kubernetes resource identity.");
  }
  context.signal.throwIfAborted();
  try {
    await api(context).delete(
      {
        apiVersion: object.apiVersion,
        kind: object.kind,
        metadata: {
          name: object.metadata.name,
          namespace: context.namespace.name,
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { preconditions: { uid: object.metadata.uid }, propagationPolicy: "Foreground" },
    );
  } catch (error) {
    if (numericErrorStatus(error) !== 404) {
      throw error;
    }
  }
}

/** Stock native workload placement. No ordinary Gateway grants select its payload. */
export class OpenShellApplicationProvider implements SandboxApplicationProvider {
  readonly ingress = "authenticated-loopback" as const;
  readonly embedded = true;
  private readonly backend: OpenShellGateway;
  private readonly options: OpenShellSandboxDriverOptions;
  private readonly selection: OpenShellApplicationOptions;

  constructor(
    backend: OpenShellGateway,
    options: OpenShellSandboxDriverOptions,
    selection: OpenShellApplicationOptions,
  ) {
    this.backend = backend;
    this.options = options;
    this.selection = selection;
    if (
      selection.developmentOnly !== true ||
      options.kubernetes.userNamespaces !== false ||
      options.policy.networkPolicies.length !== 0 ||
      options.providers?.length ||
      options.egress
    ) {
      throw new Error(
        "Application containment requires its explicit development profile, userNamespaces:false, and no Harness/provider network policy.",
      );
    }
    const peer = selection.servicePeer;
    if (
      !peer.namespace ||
      !peer.podLabels ||
      Object.keys(peer.podLabels).length === 0 ||
      !Number.isInteger(peer.port) ||
      peer.port < 1 ||
      peer.port > 65_535
    ) {
      throw new Error("Application containment requires an exact OpenShell service peer.");
    }
  }

  private client(context: SandboxNamespaceContext) {
    return this.backend.clientForNamespace(context.namespace.name);
  }

  private async selectedSandbox(
    context: RevisionContext,
  ): Promise<OpenShellSandboxResponse | undefined> {
    const expected = names(context.revision);
    const workspace = openShellWorkspaceName(context.namespace);
    const client = this.client(context);
    const refused = gatewayIdentityRefusal(
      workspace,
      "application Sandbox absence cannot be confirmed",
    );
    const reread = () => client.getSandbox({ name: expected.sandbox, workspace }, context.signal);
    return (
      (await refused(reread)) ??
      (await confirmSandboxAbsent(
        client,
        workspace,
        context.signal,
        refused,
        () =>
          new DependencyUnavailableError("Application Sandbox Workspace identity is unavailable."),
        reread,
      ))
    );
  }

  private verify(sandbox: OpenShellSandboxResponse, context: RevisionContext): string {
    const expected = names(context.revision);
    const generation = sandbox.labels[GENERATION];
    if (
      sandbox.name !== expected.sandbox ||
      sandbox.workspace !== openShellWorkspaceName(context.namespace) ||
      sandbox.labels[ROLE] !== expected.role ||
      !validGeneration(generation) ||
      Object.entries(ownership(context.revision)).some(
        ([key, value]) => sandbox.annotations[key] !== value,
      )
    ) {
      throw new Error(
        "Application Sandbox identity does not match its admitted role and revision.",
      );
    }
    return generation;
  }

  private async token(
    context: RevisionContext,
    generation: string,
    create = false,
  ): Promise<string> {
    const name = names(context.revision, generation).token;
    let secret = await privateSecret(context, name);
    if (!secret && create) {
      try {
        await api(context).create({
          apiVersion: "v1",
          kind: "Secret",
          metadata: {
            name,
            namespace: context.namespace.name,
            annotations: ownership(context.revision),
            labels: { "app.kubernetes.io/managed-by": OWNER },
          },
          immutable: true,
          type: "Opaque",
          data: { token: Buffer.from(randomBytes(32).toString("hex")).toString("base64") },
        } as V1Secret);
      } catch {
        context.signal.throwIfAborted();
        throw new DependencyUnavailableError(
          "Application transport credential delivery is unavailable.",
        );
      }
      secret = await privateSecret(context, name);
    }
    if (
      !secret ||
      secret.metadata?.deletionTimestamp ||
      secret.immutable !== true ||
      !secret.data?.token
    ) {
      throw new DependencyUnavailableError("Application transport credential is unavailable.");
    }
    owned(secret, context.revision);
    const value = Buffer.from(secret.data.token, "base64").toString("utf8");
    if (!/^[a-f0-9]{64}$/.test(value)) {
      throw new Error("Application transport credential is invalid.");
    }
    return value;
  }

  private async generation(context: SandboxApplicationContext): Promise<string> {
    const sources: unknown[] = [];
    for (const volume of context.requirements.volumes) {
      const reference =
        "configMap" in volume
          ? ["ConfigMap", volume.configMap.name]
          : "secret" in volume
            ? ["Secret", volume.secret.secretName]
            : undefined;
      if (!reference) {
        continue;
      }
      const object =
        reference[0] === "Secret"
          ? await privateSecret(context, reference[1]!)
          : await read(context, reference[0]!, reference[1]!);
      if (!object) {
        if (
          ("configMap" in volume && volume.configMap.optional) ||
          ("secret" in volume && volume.secret.optional)
        ) {
          sources.push([reference, "absent"]);
          continue;
        }
        throw new DependencyUnavailableError("Application configuration source is unavailable.");
      }
      if (
        object.metadata?.deletionTimestamp ||
        !object.metadata?.uid ||
        !object.metadata.resourceVersion
      ) {
        throw new DependencyUnavailableError(
          "Application configuration source identity is unavailable.",
        );
      }
      sources.push([reference, object.metadata.uid, object.metadata.resourceVersion]);
    }
    for (const entry of context.requirements.environment) {
      if (!("valueFrom" in entry) || !("secretKeyRef" in entry.valueFrom)) {
        continue;
      }
      const object = await privateSecret(context, entry.valueFrom.secretKeyRef.name);
      if (
        !object?.data?.[entry.valueFrom.secretKeyRef.key] ||
        object.metadata?.deletionTimestamp ||
        !object.metadata?.uid ||
        !object.metadata.resourceVersion
      ) {
        throw new DependencyUnavailableError("An admitted application credential is unavailable.");
      }
      sources.push([
        entry.valueFrom.secretKeyRef.name,
        object.metadata.uid,
        object.metadata.resourceVersion,
      ]);
    }
    return sha256Hex(JSON.stringify({ requirements: context.requirements, sources }), 24);
  }

  private async preparationNode(
    context: SandboxApplicationContext,
    projection: ApplicationProjection,
    projectionOptions: Parameters<typeof buildApplicationProjection>[0],
  ): Promise<string | undefined> {
    const previous = await read<V1Deployment>(
      context,
      "Deployment",
      projection.claim.metadata!.name!,
      "apps/v1",
    );
    if (previous) {
      owned(previous, context.revision);
    }
    const phase = previous?.metadata?.annotations?.[PHASE];
    if (phase !== undefined && phase !== "prepare" && phase !== "initialize") {
      throw new Error("Application private preparation has an unsupported phase.");
    }
    let nodeName = previous?.spec?.template.spec?.nodeName;
    if (phase !== "initialize") {
      const prepared = await deploymentReady(context, projection.preparationDeployment);
      if (!prepared?.spec?.nodeName) {
        return undefined;
      }
      nodeName = prepared.spec.nodeName;
    }
    if (!nodeName) {
      throw new Error("Application private initialization lost its selected node.");
    }
    const initialized = await deploymentReady(
      context,
      buildApplicationProjection({ ...projectionOptions, nodeName }).statePreparationDeployment,
    );
    return initialized?.spec?.nodeName;
  }

  private async stopPreparers(context: RevisionContext): Promise<boolean> {
    const selector = [
      `openclaw.dev/contained-agent=${context.revision.agentId}`,
      `openclaw.dev/contained-revision=${context.revision.id}`,
      BOOTSTRAP,
    ].join(",");
    const deployments = await api(context).list(
      "apps/v1",
      "Deployment",
      context.namespace.name,
      undefined,
      undefined,
      undefined,
      undefined,
      selector,
    );
    for (const deployment of deployments.items) {
      await remove(context, { ...deployment, apiVersion: "apps/v1", kind: "Deployment" });
    }
    const pods = await listedPods(context, selector);
    for (const pod of pods) {
      owned(pod, context.revision);
    }
    return deployments.items.length === 0 && pods.length === 0;
  }

  private nativeIdentity(pod: V1Pod, uid: number, nodeName: string, image: string): boolean {
    const spec = pod.spec;
    const security = spec?.securityContext;
    const application = spec?.containers.find(({ name }) => name === "agent");
    const process = application?.securityContext;
    return (
      spec?.nodeName === nodeName &&
      application?.image === image &&
      security?.runAsUser === uid &&
      security.runAsGroup === uid &&
      security.fsGroup === uid &&
      process?.runAsUser === uid &&
      process.runAsGroup === uid &&
      process.runAsNonRoot === true &&
      process.allowPrivilegeEscalation === false &&
      process.privileged !== true &&
      process.capabilities?.drop?.includes("ALL") === true &&
      !process.capabilities.add?.length &&
      spec?.automountServiceAccountToken === false &&
      spec.hostNetwork !== true &&
      spec.hostPID !== true &&
      spec.hostIPC !== true &&
      spec.shareProcessNamespace !== true &&
      !spec.volumes?.some(
        (volume) =>
          volume.hostPath ||
          volume.projected?.sources?.some((source) => source.serviceAccountToken),
      )
    );
  }

  private async environment(
    context: SandboxApplicationContext,
    podUid: string,
    token: string,
  ): Promise<Record<string, string>> {
    const environment: Record<string, string> = {};
    for (const entry of context.requirements.environment) {
      if (
        Object.hasOwn(environment, entry.name) ||
        entry.name === APPLICATION_TRANSPORT_ENVIRONMENT
      ) {
        throw new Error("Application environment has a duplicate or reserved binding.");
      }
      if ("value" in entry) {
        environment[entry.name] = entry.value;
      } else if ("secretKeyRef" in entry.valueFrom) {
        const reference = entry.valueFrom.secretKeyRef;
        const secret = await privateSecret(context, reference.name);
        const encoded = secret?.data?.[reference.key];
        if (!encoded || secret.metadata?.deletionTimestamp) {
          throw new DependencyUnavailableError(
            "An admitted application credential is unavailable.",
          );
        }
        environment[entry.name] = Buffer.from(encoded, "base64").toString("utf8");
      } else if (
        entry.name === "OPENCLAW_POD_UID" &&
        entry.valueFrom.fieldRef.fieldPath === "metadata.uid"
      ) {
        environment[entry.name] = podUid;
      } else {
        throw new Error("Application environment has an unsupported identity projection.");
      }
      if (environment[entry.name]!.includes("\0")) {
        throw new Error("An application environment binding is invalid.");
      }
    }
    environment[APPLICATION_TRANSPORT_ENVIRONMENT] = token;
    return environment;
  }

  private async service(
    context: RevisionContext,
    sandbox: string,
    name: string,
    port: number,
  ): Promise<OpenShellServiceResponse | undefined> {
    const service = await this.client(context).getService(
      openShellWorkspaceName(context.namespace),
      sandbox,
      name,
      context.signal,
    );
    if (!service) {
      return undefined;
    }
    if (
      service.targetPort !== port ||
      (service.authorizationMode !== "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH" &&
        service.authorizationMode !== 2)
    ) {
      throw new Error(
        "Application service exposure differs from its authenticated ingress contract.",
      );
    }
    return service;
  }

  async provision(context: SandboxApplicationContext) {
    const { revision, requirements } = context;
    if (
      (revision.harness.mode === "dedicated" && revision.harness.id !== "codex") ||
      requirements.role !== names(revision).role ||
      requirements.namespaceName !== context.namespace.name ||
      !Number.isInteger(requirements.port) ||
      requirements.port < 1 ||
      requirements.port > 64_535
    ) {
      throw new Error(
        "Application containment supports only embedded OpenClaw or a dedicated Codex Gateway in its exact namespace.",
      );
    }
    const placement = this.backend.placement(context.namespace.name);
    const connectOrigin = this.backend.serviceConnectOrigin(context.namespace.name);
    if (
      !placement ||
      placement.namespace !== this.selection.servicePeer.namespace ||
      Number(new URL(connectOrigin).port || (connectOrigin.startsWith("https:") ? 443 : 80)) !==
        this.selection.servicePeer.port
    ) {
      throw new Error("Application service peer must match the selected OpenShell Backend.");
    }
    const controlHost = new URL(connectOrigin).hostname.replace(/^\[(.*)\]$/, "$1");
    const controlHosts = new Set([
      controlHost,
      placement.service,
      `${placement.service}.${placement.namespace}`,
      `${placement.service}.${placement.namespace}.svc`,
      `${placement.service}.${placement.namespace}.svc.cluster.local`,
    ]);
    if (
      requirements.runtimePeers.some(
        (peer) =>
          controlHosts.has(peer.host) ||
          (isIP(controlHost) === 4 &&
            peer.allowedIps.some((address) => address.replace(/\/32$/u, "") === controlHost)),
      )
    ) {
      throw new Error(
        "Contained application peers cannot grant access to the OpenShell management listener.",
      );
    }
    const generation = await this.generation(context);
    const expected = names(revision, generation);
    const bootstrap = `application-${sha256Hex(revision.id, 12)}-${generation}`;
    const request = {
      name: expected.sandbox,
      workspace: openShellWorkspaceName(context.namespace),
    };
    let sandbox = await this.selectedSandbox(context);
    if (sandbox && this.verify(sandbox, context) !== generation) {
      await this.cleanup(context);
      return { state: "pending" as const };
    }
    const namespace = await api(context).read({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: context.namespace.name },
    });
    const range = namespace.metadata?.annotations?.["openshift.io/sa.scc.uid-range"];
    const uid = range ? Number(range.split(",")[0]!.split("/")[0]) : 10_001;
    if (!Number.isSafeInteger(uid) || uid < 1) {
      throw new Error("Application containment requires a valid native namespace identity.");
    }
    const projectionOptions = {
      requirements,
      ownership: {
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
      },
      name: bootstrap,
      uid,
      gid: uid,
      generation,
    };
    const projection = buildApplicationProjection(projectionOptions);
    const network = compileOpenShellApplicationNetworkPolicy({
      revision,
      denyCidrs: requirements.denyCidrs,
      mandatoryDenyCidrs: [...FORBIDDEN_IPV4, ...FORBIDDEN_IPV6],
      runtimePeers: requirements.runtimePeers,
      generatedPublicHosts: requirements.generatedPublicHosts,
    });
    let nodeName = sandbox?.annotations[NODE];
    if (!sandbox) {
      if ((await nativePods(context)).length !== 0) {
        return { state: "pending" as const };
      }
      // A changed optional configuration source must not leave another generation
      // preparing the same Agent-owned state concurrently.
      const stages = await api(context).list(
        "apps/v1",
        "Deployment",
        context.namespace.name,
        undefined,
        undefined,
        undefined,
        undefined,
        `openclaw.dev/contained-agent=${revision.agentId},openclaw.dev/contained-revision=${revision.id},${BOOTSTRAP}`,
      );
      if (stages.items.some((stage) => stage.metadata?.annotations?.[GENERATION] !== generation)) {
        await this.cleanup(context);
        return { state: "pending" as const };
      }
      await apply(context, projection.claim);
      await apply(context, projection.environmentClaim);
      await apply(context, projection.denyPolicy);
      nodeName = await this.preparationNode(context, projection, projectionOptions);
      if (!nodeName) {
        return { state: "pending" as const };
      }
    }
    if (!nodeName || !/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(nodeName)) {
      throw new Error("Application Sandbox lost its admitted native node placement.");
    }
    const mounts = projection.nativeMounts;
    const spec = {
      template: {
        image: requirements.image,
        runtime_class_name: this.options.kubernetes.runtimeClassName,
        user_namespaces: false,
        labels: {
          "openclaw.dev/contained-agent": revision.agentId,
          "openclaw.dev/contained-revision": revision.id,
        },
        driver_config: {
          fields: toProtobufStruct({
            kubernetes: {
              pod: {
                runtime_class_name: this.options.kubernetes.runtimeClassName,
                node_selector: { ...requirements.nodeSelector, "kubernetes.io/hostname": nodeName },
              },
              containers: {
                agent: {
                  resources: requirements.resources ?? this.options.kubernetes.agentResources ?? {},
                  volume_mounts: mounts,
                },
              },
              volumes: projection.nativeVolumes,
            },
          }),
        },
      },
      environment: {},
      providers: [],
      log_level: this.options.logLevel ?? "info",
      command: projection.command,
      policy: {
        version: 1,
        filesystem: {
          include_workdir: false,
          read_only: [
            ...new Set([
              "/app",
              "/usr",
              "/bin",
              "/lib",
              "/lib64",
              "/dev/urandom",
              "/opt/oce/runtime",
              "/etc",
              "/proc",
              "/sys",
              ...(this.options.policy.filesystem?.readOnly ?? []),
              ...mounts.filter((mount) => mount.read_only).map((mount) => mount.mount_path),
            ]),
          ],
          read_write: [
            ...new Set([
              "/dev/null",
              ...mounts.filter((mount) => !mount.read_only).map((mount) => mount.mount_path),
              ...(this.options.policy.filesystem?.readWrite ?? []),
            ]),
          ],
        },
        landlock: { compatibility: "hard_requirement" },
        process: {
          run_as_user: this.options.policy.process.runAsUser,
          run_as_group: this.options.policy.process.runAsGroup,
        },
        network_policies: network,
      },
      restart_policy: "SANDBOX_RESTART_POLICY_ALWAYS",
    };
    if (!sandbox) {
      if ((await this.generation(context)) !== generation) {
        await this.cleanup(context);
        return { state: "pending" as const };
      }
      sandbox = await this.client(context).createSandbox(
        {
          ...request,
          requestId: randomUUID(),
          labels: { [ROLE]: expected.role, [GENERATION]: generation },
          annotations: { ...ownership(revision), [BOOTSTRAP]: bootstrap, [NODE]: nodeName },
          spec,
          serviceExposures: [
            {
              service: "gateway",
              targetPort: requirements.port + 1_000,
              authorizationMode: "bearer_passthrough",
            },
            {
              service: "status",
              targetPort: GUARD_STATUS_PORT,
              authorizationMode: "bearer_passthrough",
            },
          ],
        },
        context.signal,
      );
      this.verify(sandbox, context);
    }
    if (!sameOpenShellSandboxSpec(sandbox.spec, spec)) {
      throw new Error("Application Sandbox no longer matches its admitted configuration.");
    }
    const pods = (await nativePods(context, sandbox)).filter(
      (pod) => !pod.metadata?.deletionTimestamp,
    );
    if (
      pods.length !== 1 ||
      !pods[0]?.metadata?.uid ||
      pods[0].status?.phase !== "Running" ||
      !containerId(pods[0])
    ) {
      return { state: "pending" as const };
    }
    const pod = pods[0];
    if (!this.nativeIdentity(pod, uid, nodeName, requirements.image)) {
      await this.cleanup(context);
      throw new Error(
        "Native application identity or token isolation differs from the qualified profile.",
      );
    }
    if (!(await this.stopPreparers(context))) {
      return { state: "pending" as const };
    }
    const gateway = await this.service(context, request.name, "gateway", requirements.port + 1_000);
    const statusService = await this.service(context, request.name, "status", GUARD_STATUS_PORT);
    if (!gateway || !statusService) {
      return { state: "pending" as const };
    }
    await this.network(context, sandbox);
    const transportToken = await this.token(context, generation, true);
    const environment = await this.environment(context, pod.metadata!.uid!, transportToken);
    if ((await this.generation(context)) !== generation) {
      await this.cleanup(context);
      return { state: "pending" as const };
    }
    const delivery = buildApplicationProjection({
      ...projectionOptions,
      podUid: pod.metadata!.uid!,
      nodeName,
    });
    let delivered: number;
    try {
      delivered = await this.client(context).execSandbox(
        {
          workspace: request.workspace,
          sandbox: request.name,
          command: delivery.environmentDeliveryCommand,
          environment: {},
          stdin: JSON.stringify({ generation, podUid: pod.metadata!.uid!, environment }),
          timeoutSeconds: 30,
        },
        context.signal,
      );
    } catch {
      context.signal.throwIfAborted();
      throw new DependencyUnavailableError(
        "Private application environment delivery is unavailable.",
      );
    }
    if (delivered !== 0) {
      // A replacement native Pod must receive fresh private storage, never an
      // in-place rewrite of material published for its predecessor's identity.
      await this.cleanup(context);
      throw new DependencyUnavailableError(
        "Private application environment requires a fresh runtime.",
      );
    }
    if (
      !sameRunningPod(pod, await nativePods(context, sandbox)) ||
      (await this.generation(context)) !== generation
    ) {
      await this.cleanup(context);
      return { state: "pending" as const };
    }
    const status = await this.readStatus(context, "/openclaw/runtime/status");
    if (!status || status.podUid !== pod.metadata!.uid) {
      return { state: "pending" as const };
    }
    const caBundle = this.backend.publicRootCertificate();
    return {
      state: "ready" as const,
      endpoint: {
        origin: gateway.url,
        statusOrigin: statusService.url,
        connectOrigin,
        transportSecretRef: { name: expected.token, key: "token" },
        ...(caBundle ? { caBundle } : {}),
      },
    };
  }

  private async network(
    context: SandboxApplicationContext,
    sandbox: OpenShellSandboxResponse,
  ): Promise<void> {
    const revision = context.revision;
    const metadata = (name: string) => ({
      name,
      namespace: context.namespace.name,
      annotations: ownership(revision),
      labels: { "app.kubernetes.io/managed-by": OWNER },
    });
    const peer = this.selection.servicePeer;
    await apply(context, {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: metadata(`application-frontend-${sha256Hex(revision.id, 16)}`),
      spec: {
        podSelector: {
          matchLabels: {
            "openclaw.dev/agent": revision.agentId,
            "openclaw.dev/workload-role": "gateway",
          },
        },
        policyTypes: ["Egress"],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": peer.namespace },
                },
                podSelector: { matchLabels: peer.podLabels },
              },
            ],
            ports: [{ protocol: "TCP", port: peer.port }],
          },
        ],
      },
    });
    if (revision.harness.mode === "dedicated") {
      await apply(context, {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: metadata(`application-harness-${sha256Hex(revision.id, 16)}`),
        spec: {
          podSelector: {
            matchLabels: {
              "openclaw.dev/agent": revision.agentId,
              "openclaw.dev/revision": revision.id,
              "openclaw.dev/workload-role": "agent",
            },
          },
          policyTypes: ["Ingress"],
          ingress: [
            {
              from: [
                {
                  podSelector: {
                    matchLabels: {
                      "openshell.ai/sandbox-id": sandbox.id!,
                      "openshell.ai/boundary-role": "supervisor",
                    },
                  },
                },
              ],
              ports: [
                { protocol: "TCP", port: 18_790 },
                { protocol: "TCP", port: STATUS_PORT },
              ],
            },
          ],
        },
      });
    }
  }

  async readStatus(context: RevisionContext, path: string) {
    if (!STATUS_PATHS.has(path)) {
      throw new Error("Application status path is outside the private read contract.");
    }
    const expected = names(context.revision);
    const sandbox = await this.client(context).getSandbox(
      { name: expected.sandbox, workspace: openShellWorkspaceName(context.namespace) },
      context.signal,
    );
    if (!sandbox) {
      return undefined;
    }
    const generation = this.verify(sandbox, context);
    const candidates = (await nativePods(context, sandbox)).filter(
      (pod) => !pod.metadata?.deletionTimestamp && pod.status?.phase === "Running",
    );
    if (candidates.length !== 1 || !candidates[0]?.metadata?.uid || !containerId(candidates[0])) {
      return undefined;
    }
    const pod = candidates[0];
    const service = await this.service(context, expected.sandbox, "status", GUARD_STATUS_PORT);
    if (!service) {
      return undefined;
    }
    const response = await this.client(context).getServiceDocument(
      service.url,
      path,
      "application-status",
      context.signal,
      await this.token(context, generation),
    );
    const latest = await nativePods(context, sandbox);
    const status = asRecord(response.json);
    if (
      response.status !== 200 ||
      !sameRunningPod(pod, latest) ||
      status === undefined ||
      (!["/openclaw/runtime/image", "/readyz"].includes(path) &&
        (status.podUid !== pod.metadata?.uid ||
          status.revisionId !== context.revision.id ||
          status.container !== "gateway"))
    ) {
      return undefined;
    }
    return { status: response.json, podUid: pod.metadata!.uid!, containerId: containerId(pod)! };
  }

  async cleanup(context: RevisionContext): Promise<void> {
    const expected = names(context.revision);
    const request = {
      name: expected.sandbox,
      workspace: openShellWorkspaceName(context.namespace),
    };
    const sandbox = await this.selectedSandbox(context);
    if (sandbox) {
      this.verify(sandbox, context);
      await this.client(context).deleteSandbox(request, context.signal);
      if (await this.selectedSandbox(context)) {
        throw new DependencyUnavailableError("Application Sandbox removal is still pending.");
      }
    }
    if ((await nativePods(context)).length !== 0) {
      throw new DependencyUnavailableError(
        "Application cleanup is waiting for native payload termination.",
      );
    }
    if (!(await this.stopPreparers(context))) {
      throw new DependencyUnavailableError(
        "Application cleanup is waiting for private preparation termination.",
      );
    }
    // Never select Agent-owned persistent state: only this revision's explicit
    // private projection labels or this provider's managed resources qualify.
    const kinds = [
      ["networking.k8s.io/v1", "NetworkPolicy"],
      ["v1", "PersistentVolumeClaim"],
      ["v1", "Secret"],
    ] as const;
    let remaining = false;
    for (const [apiVersion, kind] of kinds) {
      const resources = await api(context).list(apiVersion, kind, context.namespace.name);
      for (const resource of resources.items) {
        if (
          Object.entries(ownership(context.revision)).some(
            ([key, value]) => resource.metadata?.annotations?.[key] !== value,
          )
        ) {
          continue;
        }
        const labels = resource.metadata?.labels ?? {};
        if (!labels[BOOTSTRAP] && labels["app.kubernetes.io/managed-by"] !== OWNER) {
          continue;
        }
        remaining = true;
        await remove(context, { ...resource, apiVersion, kind });
      }
    }
    if (remaining) {
      throw new DependencyUnavailableError("Application private resources are still terminating.");
    }
  }
}

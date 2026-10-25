import type {
  SandboxApplicationMount,
  SandboxApplicationProcess,
  SandboxApplicationRequirements,
  SandboxApplicationVolume,
} from "@openclaw-enterprise/contracts";
import type {
  V1Container,
  V1Deployment,
  V1EnvVar,
  V1NetworkPolicy,
  V1PersistentVolumeClaim,
  V1ResourceRequirements,
  V1Volume,
} from "@kubernetes/client-node";
import {
  APPLICATION_TRANSPORT_ENVIRONMENT,
  createApplicationGuardProgram,
} from "./openshell-application-guard.ts";

const BOOTSTRAP_VOLUME = "oce-application-bootstrap";
const BOOTSTRAP_ROOT = "/oce-application-bootstrap";
const SOURCE_ROOT = "/oce-application-sources";
const ENVIRONMENT_VOLUME = "oce-application-environment";
const ENVIRONMENT_MOUNT_ROOT = "/oce-application-environment";
const ENVIRONMENT_ROOT = `${ENVIRONMENT_MOUNT_ROOT}/private`;

/** The released Kubernetes adapter reserves /run, including OCE's node-binding path. */
function applicationPath(value: string): string {
  return value.startsWith("/run/") ? `/oce-application-run/${value.slice(5)}` : value;
}

export interface ApplicationProjectionOwnership {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
}

export interface ApplicationProjectionOptions {
  readonly requirements: SandboxApplicationRequirements;
  readonly ownership: ApplicationProjectionOwnership;
  /** A controller-owned generation name, never reused after payload replacement. */
  readonly name: string;
  readonly uid: number;
  readonly gid: number;
  /** Obtained from the native Pod, not the bootstrap Pod's downward API. */
  readonly podUid?: string;
  /** Place the stager beside the payload for exact ReadWriteOnce-volume attachment. */
  readonly nodeName?: string;
  readonly guardGatewayPort?: number;
  readonly guardStatusPort?: number;
  readonly generation: string;
}

export interface ApplicationNativeVolume {
  readonly name: string;
  readonly persistent_volume_claim: {
    readonly claim_name: string;
    readonly read_only: boolean;
  };
}

export interface ApplicationNativeMount {
  readonly name: string;
  readonly mount_path: string;
  readonly sub_path?: string;
  readonly read_only: boolean;
}

export interface ApplicationProjection {
  readonly claim: V1PersistentVolumeClaim;
  /** Private runtime environment storage, mounted by the native payload Pod only. */
  readonly environmentClaim: V1PersistentVolumeClaim;
  /** Prepare new bootstrap storage before native subpath mounts can be admitted. */
  readonly preparationDeployment: V1Deployment;
  /** Complete private-state initialization before native PVC subpaths are mounted. */
  readonly statePreparationDeployment: V1Deployment;
  readonly denyPolicy: V1NetworkPolicy;
  readonly nativeVolumes: readonly ApplicationNativeVolume[];
  readonly nativeMounts: readonly ApplicationNativeMount[];
  readonly command: readonly string[];
  /** Receives resolved private environment ONLY on native in-Pod exec stdin. */
  readonly environmentDeliveryCommand: readonly string[];
  readonly environmentRoot: string;
  readonly readyPath: string;
  readonly annotations: Readonly<Record<string, string>>;
}

function safeSubPath(value: string): string {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Application containment refuses an unsafe volume subpath.");
  }
  return value;
}

function sourceVolume(volume: SandboxApplicationVolume): V1Volume {
  if ("persistentVolumeClaim" in volume) {
    return { name: volume.name, persistentVolumeClaim: { ...volume.persistentVolumeClaim } };
  }
  if ("configMap" in volume) {
    return {
      name: volume.name,
      configMap: {
        name: volume.configMap.name,
        ...(volume.configMap.defaultMode === undefined
          ? {}
          : { defaultMode: volume.configMap.defaultMode }),
        ...(volume.configMap.optional === undefined ? {} : { optional: volume.configMap.optional }),
        ...(volume.configMap.items
          ? { items: volume.configMap.items.map((item) => ({ ...item })) }
          : {}),
      },
    };
  }
  if ("secret" in volume) {
    return {
      name: volume.name,
      secret: {
        secretName: volume.secret.secretName,
        ...(volume.secret.defaultMode === undefined
          ? {}
          : { defaultMode: volume.secret.defaultMode }),
        ...(volume.secret.optional === undefined ? {} : { optional: volume.secret.optional }),
        ...(volume.secret.items ? { items: volume.secret.items.map((item) => ({ ...item })) } : {}),
      },
    };
  }
  return { name: volume.name, emptyDir: { ...volume.emptyDir } };
}

function initializerEnvironment(process: SandboxApplicationProcess): V1EnvVar[] {
  return process.environment.map((entry) => {
    if (!("value" in entry)) {
      throw new Error(
        "Application initialization cannot receive private or implicit environment references.",
      );
    }
    return { name: entry.name, value: entry.value };
  });
}

const CONTAINER_SECURITY = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ["ALL"] },
};

function initializer(
  process: SandboxApplicationProcess,
  volumeMap: ReadonlyMap<string, SandboxApplicationVolume>,
): V1Container {
  return {
    name: process.name,
    image: process.image,
    imagePullPolicy: "IfNotPresent",
    command: [...process.command],
    args: [...process.args],
    env: initializerEnvironment(process),
    volumeMounts: process.mounts.map((mount) => {
      const volume = volumeMap.get(mount.name);
      if (!volume) {
        throw new Error("Application initializer references an unavailable volume.");
      }
      const native = nativeMount(mount, volume);
      return {
        name: native.name,
        mountPath: mount.mountPath,
        ...(native.sub_path === undefined ? {} : { subPath: native.sub_path }),
        readOnly: native.read_only,
      };
    }),
    ...(process.resources ? { resources: process.resources as V1ResourceRequirements } : {}),
    securityContext: CONTAINER_SECURITY,
  };
}

/** The check never changes ownership on state created by another runtime identity. */
const CHECK_STATE_OWNERSHIP = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const configuration = JSON.parse(process.argv[1]);
let remaining = 100000;
function visit(target, root) {
  if (--remaining < 0) throw Error('Application state ownership check exceeded its bound');
  const stat = fs.lstatSync(target);
  if (!root && stat.uid !== configuration.uid) throw Error('Application state has an incompatible owner');
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) visit(path.join(target, name), false);
  }
}
try {
  for (const target of configuration.paths) visit(target, true);
} catch {
  console.error('Application state cannot be used by the selected native runtime identity');
  process.exit(1);
}
`;

const COPY_APPLICATION_VOLUME = String.raw`
function copy(source, destination, projected) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    if (!projected) {
      fs.symlinkSync(fs.readlinkSync(source), destination);
      return;
    }
    const resolved = fs.realpathSync(source);
    if (!resolved.startsWith(configuration.sources + '/')) throw Error('Unsafe projected file link');
    copy(resolved, destination, projected);
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(source)) {
      if (projected && name.startsWith('..')) continue;
      copy(path.join(source, name), path.join(destination, name), projected);
    }
    fs.chmodSync(destination, projected ? 0o700 : stat.mode & 0o777);
    return;
  }
  if (!stat.isFile()) throw Error('Unsupported application volume entry');
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, projected ? ((stat.mode & 0o111) ? 0o700 : 0o600) : stat.mode & 0o777);
}
`;

/** The native process receives resolved credentials through stdin, never a separate Pod. */
const DELIVER_APPLICATION_ENVIRONMENT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const configuration = JSON.parse(process.argv[1]);
function publish(name, value) {
  const destination = path.join(configuration.root, name);
  const temporary = destination + '.pending';
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, value); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, destination);
}
try {
  let size = 0;
  const chunks = [];
  const buffer = Buffer.alloc(16384);
  for (;;) {
    const count = fs.readSync(0, buffer, 0, buffer.length, null);
    if (!count) break;
    size += count;
    if (size > 400000) throw Error('Private environment input exceeds its bound');
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  const material = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (material.generation !== configuration.generation ||
      typeof material.podUid !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(material.podUid) ||
      (configuration.podUid !== undefined && material.podUid !== configuration.podUid) ||
      !material.environment || typeof material.environment !== 'object' || Array.isArray(material.environment)) {
    throw Error('Invalid private environment identity');
  }
  const names = Object.keys(material.environment).sort();
  if (JSON.stringify(names) !== JSON.stringify(configuration.environment) ||
      names.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof material.environment[name] !== 'string' || material.environment[name].includes('\0')) ||
      (material.environment.OPENCLAW_POD_UID !== undefined && material.environment.OPENCLAW_POD_UID !== material.podUid)) {
    throw Error('Invalid private environment projection');
  }
  for (const name of ['prepared.json', 'initialized.json']) {
    if (JSON.parse(fs.readFileSync(path.join(configuration.bootstrapRoot, name), 'utf8')).generation !== configuration.generation) {
      throw Error('Application private storage is not initialized');
    }
  }
  // This native-only volume is never mounted by an ordinary projection Pod.
  try { fs.mkdirSync(configuration.root, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const privateDirectory = fs.lstatSync(configuration.root);
  if (!privateDirectory.isDirectory() || privateDirectory.uid !== process.getuid() || (privateDirectory.mode & 0o777) !== 0o700) {
    throw Error('Private environment directory has an incompatible owner or mode');
  }
  const environment = JSON.stringify(Object.fromEntries(names.map(name => [name, configuration.environmentOverrides[name] ?? material.environment[name]])));
  const environmentSha256 = crypto.createHash('sha256').update(environment).digest('hex');
  const marker = { generation: configuration.generation, podUid: material.podUid, environmentSha256 };
  const readyPath = path.join(configuration.root, 'ready.json');
  if (fs.existsSync(readyPath)) {
    if (JSON.stringify(JSON.parse(fs.readFileSync(readyPath, 'utf8'))) !== JSON.stringify(marker) ||
        fs.readFileSync(path.join(configuration.root, 'environment.json'), 'utf8') !== environment) {
      throw Error('An active private environment cannot be replaced');
    }
  } else {
    const environmentPath = path.join(configuration.root, 'environment.json');
    if (fs.existsSync(environmentPath)) {
      if (fs.readFileSync(environmentPath, 'utf8') !== environment) throw Error('Private environment publication differs');
    } else publish('environment.json', environment);
    publish('ready.json', JSON.stringify(marker));
  }
} catch {
  console.error('Application private environment delivery failed');
  process.exit(1);
}
`;

const PREPARE_APPLICATION = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const configuration = JSON.parse(process.argv[1]);
${COPY_APPLICATION_VOLUME}
try {
  const marker = path.join(configuration.root, 'prepared.json');
  if (fs.existsSync(marker)) {
    if (JSON.parse(fs.readFileSync(marker, 'utf8')).generation !== configuration.generation) {
      throw Error('Private bootstrap generation differs');
    }
  } else {
    fs.mkdirSync(path.join(configuration.root, 'volumes'), { recursive: true, mode: 0o700 });
    for (const volume of configuration.volumes) {
      copy(path.join(configuration.sources, volume.name), path.join(configuration.root, 'volumes', volume.name), true);
    }
    for (const directory of configuration.directories) fs.mkdirSync(path.join(configuration.root, directory), { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker + '.pending', JSON.stringify({ generation: configuration.generation }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(marker + '.pending', marker);
  }
} catch {
  console.error('Application private volume preparation failed');
  process.exit(1);
}
setInterval(() => {}, 60000);
`;

const PREPARE_STATE_MARKER = String.raw`
const fs = require('node:fs');
const configuration = JSON.parse(process.argv[1]);
try {
  const marker = configuration.root + '/initialized.json';
  if (fs.existsSync(marker)) {
    if (JSON.parse(fs.readFileSync(marker, 'utf8')).generation !== configuration.generation) throw Error('Wrong state preparation generation');
  } else {
    fs.writeFileSync(marker + '.pending', JSON.stringify({ generation: configuration.generation }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(marker + '.pending', marker);
  }
} catch {
  console.error('Application state preparation failed');
  process.exit(1);
}
setInterval(() => {}, 60000);
`;

function nativeMount(
  mount: SandboxApplicationMount,
  volume: SandboxApplicationVolume,
): ApplicationNativeMount {
  const subPath = mount.subPath === undefined ? undefined : safeSubPath(mount.subPath);
  if ("persistentVolumeClaim" in volume) {
    return {
      name: volume.name,
      mount_path: applicationPath(mount.mountPath),
      ...(subPath === undefined ? {} : { sub_path: subPath }),
      read_only: mount.readOnly === true || volume.persistentVolumeClaim.readOnly === true,
    };
  }
  return {
    name: BOOTSTRAP_VOLUME,
    mount_path: applicationPath(mount.mountPath),
    sub_path: `volumes/${volume.name}${subPath === undefined ? "" : `/${subPath}`}`,
    read_only: mount.readOnly === true || "configMap" in volume || "secret" in volume,
  };
}

/** Translate prepared references to the stock OpenShell release's PVC-only projection contract. */
export function buildApplicationProjection(
  options: ApplicationProjectionOptions,
): ApplicationProjection {
  const { requirements, ownership, name, uid, gid, podUid, nodeName, generation } = options;
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) {
    throw new Error("Application containment requires an explicit non-root runtime identity.");
  }
  if (!/^[a-z0-9]([-a-z0-9]{0,57}[a-z0-9])?$/.test(name) || !generation) {
    throw new Error("Application containment requires a safe private bootstrap generation.");
  }
  if (requirements.initializers.some((process) => process.name !== "prepare-private-state")) {
    // TODO: Run workspace setup inside the native boundary before admitting that capability.
    throw new Error("Application containment supports only private-state initialization.");
  }
  if (requirements.environment.some((entry) => entry.name === APPLICATION_TRANSPORT_ENVIRONMENT)) {
    throw new Error(
      "Application containment requires a private, provider-owned transport credential.",
    );
  }
  if (requirements.volumes.some((volume) => "secret" in volume)) {
    // TODO: Deliver private file projections through native in-boundary exec before supporting them.
    throw new Error("Application containment does not support private file volume projection.");
  }
  if (
    requirements.volumes.some(
      (volume) => volume.name === BOOTSTRAP_VOLUME || volume.name === ENVIRONMENT_VOLUME,
    )
  ) {
    throw new Error("Application volume collides with the private bootstrap mount.");
  }
  for (const process of [requirements, ...requirements.initializers]) {
    for (const mount of process.mounts) {
      if (
        !mount.mountPath.startsWith("/") ||
        mount.mountPath === BOOTSTRAP_ROOT ||
        mount.mountPath.startsWith(`${BOOTSTRAP_ROOT}/`) ||
        mount.mountPath === SOURCE_ROOT ||
        mount.mountPath.startsWith(`${SOURCE_ROOT}/`) ||
        mount.mountPath === ENVIRONMENT_MOUNT_ROOT ||
        mount.mountPath.startsWith(`${ENVIRONMENT_MOUNT_ROOT}/`)
      ) {
        throw new Error("Application volume collides with a reserved bootstrap path.");
      }
      if (mount.subPath !== undefined) {
        safeSubPath(mount.subPath);
      }
    }
  }
  const annotations = {
    "openclaw.dev/namespace-id": ownership.namespaceId,
    "openclaw.dev/agent-id": ownership.agentId,
    "openclaw.dev/revision-id": ownership.revisionId,
    "openclaw.dev/application-generation": generation,
    ...(podUid === undefined ? {} : { "openclaw.dev/application-pod-uid": podUid }),
  };
  const labels = {
    "app.kubernetes.io/managed-by": "openclaw-enterprise",
    "openclaw.dev/namespace": ownership.namespaceId,
    "openclaw.dev/contained-agent": ownership.agentId,
    "openclaw.dev/contained-revision": ownership.revisionId,
    "openclaw.dev/application-bootstrap": name,
  };
  const selector = { "openclaw.dev/application-bootstrap": name };
  const metadata = { name, namespace: requirements.namespaceName, labels, annotations };
  const claim: V1PersistentVolumeClaim = {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      ...metadata,
      annotations: { ...annotations, "openclaw.dev/application-pod-uid": "" },
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      volumeMode: "Filesystem",
      resources: { requests: { storage: "256Mi" } },
    },
  };
  const environmentClaim: V1PersistentVolumeClaim = {
    ...claim,
    metadata: { ...claim.metadata, name: `${name}-env` },
    spec: {
      accessModes: ["ReadWriteOnce"],
      volumeMode: "Filesystem",
      resources: { requests: { storage: "16Mi" } },
    },
  };
  const nativeVolumes: ApplicationNativeVolume[] = [
    { name: BOOTSTRAP_VOLUME, persistent_volume_claim: { claim_name: name, read_only: false } },
    {
      name: ENVIRONMENT_VOLUME,
      persistent_volume_claim: { claim_name: `${name}-env`, read_only: false },
    },
    ...requirements.volumes.flatMap((volume) =>
      "persistentVolumeClaim" in volume
        ? [
            {
              name: volume.name,
              persistent_volume_claim: {
                claim_name: volume.persistentVolumeClaim.claimName,
                read_only: volume.persistentVolumeClaim.readOnly === true,
              },
            },
          ]
        : [],
    ),
  ];
  const volumeMap = new Map(requirements.volumes.map((volume) => [volume.name, volume]));
  const nativeMounts = requirements.mounts.map((mount) => {
    const volume = volumeMap.get(mount.name);
    if (!volume) {
      throw new Error("Application mount references an unavailable volume.");
    }
    return nativeMount(mount, volume);
  });
  nativeMounts.push(
    { name: BOOTSTRAP_VOLUME, mount_path: BOOTSTRAP_ROOT, read_only: true },
    {
      name: ENVIRONMENT_VOLUME,
      mount_path: ENVIRONMENT_MOUNT_ROOT,
      read_only: false,
    },
  );
  const command = [
    "node",
    "--input-type=module",
    "-e",
    createApplicationGuardProgram({
      command: requirements.command,
      args: requirements.args,
      environmentPath: `${ENVIRONMENT_ROOT}/environment.json`,
      readyPath: `${ENVIRONMENT_ROOT}/ready.json`,
      generation,
      gatewayPort: requirements.port,
      statusPort: 18791,
      guardGatewayPort: options.guardGatewayPort ?? requirements.port + 1000,
      guardStatusPort: options.guardStatusPort ?? 19791,
    }),
  ];
  const projected = requirements.volumes.filter((volume) => "configMap" in volume);
  const preparationDeployment: V1Deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      ...metadata,
      annotations: { ...annotations, "openclaw.dev/application-projection-phase": "prepare" },
    },
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: selector },
      template: {
        metadata: {
          labels,
          annotations: { ...annotations, "openclaw.dev/application-projection-phase": "prepare" },
        },
        spec: {
          automountServiceAccountToken: false,
          serviceAccountName: requirements.serviceAccountName,
          ...(requirements.nodeSelector ? { nodeSelector: { ...requirements.nodeSelector } } : {}),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: uid,
            runAsGroup: gid,
            // This phase mounts only a NEW private PVC, never existing Agent state.
            fsGroup: gid,
            fsGroupChangePolicy: "OnRootMismatch",
            seccompProfile: { type: "RuntimeDefault" },
          },
          volumes: [
            ...projected.map(sourceVolume),
            { name: BOOTSTRAP_VOLUME, persistentVolumeClaim: { claimName: name } },
          ],
          containers: [
            {
              name: "prepare-private-volume",
              image: requirements.image,
              imagePullPolicy: "IfNotPresent",
              command: ["node", "-e"],
              args: [
                PREPARE_APPLICATION,
                JSON.stringify({
                  root: BOOTSTRAP_ROOT,
                  sources: SOURCE_ROOT,
                  generation,
                  volumes: projected.map((volume) => ({ name: volume.name })),
                  directories: [
                    ...requirements.volumes.flatMap((volume) => {
                      if (!("emptyDir" in volume)) {
                        return [];
                      }
                      return [
                        `volumes/${volume.name}`,
                        ...requirements.mounts
                          .filter(
                            (mount) => mount.name === volume.name && mount.subPath !== undefined,
                          )
                          .map((mount) => `volumes/${volume.name}/${safeSubPath(mount.subPath!)}`),
                      ];
                    }),
                  ],
                }),
              ],
              volumeMounts: [
                ...projected.map((volume) => ({
                  name: volume.name,
                  mountPath: `${SOURCE_ROOT}/${volume.name}`,
                  readOnly: true,
                })),
                { name: BOOTSTRAP_VOLUME, mountPath: BOOTSTRAP_ROOT },
              ],
              securityContext: CONTAINER_SECURITY,
              resources: {
                requests: { cpu: "10m", memory: "32Mi" },
                limits: { cpu: "250m", memory: "128Mi" },
              },
              readinessProbe: {
                exec: {
                  command: [
                    "node",
                    "-e",
                    `require('node:fs').accessSync('${BOOTSTRAP_ROOT}/prepared.json')`,
                  ],
                },
                periodSeconds: 2,
              },
            },
          ],
        },
      },
    },
  };
  const persistent = requirements.volumes.filter((volume) => "persistentVolumeClaim" in volume);
  const sources = persistent.map((volume) => ({
    name: volume.name,
    mountPath: `${SOURCE_ROOT}/${volume.name}`,
    readOnly: true,
  }));
  const preflight: V1Container = {
    name: "verify-native-state-owner",
    image: requirements.image,
    imagePullPolicy: "IfNotPresent",
    command: ["node", "-e"],
    args: [
      CHECK_STATE_OWNERSHIP,
      JSON.stringify({
        uid,
        paths: persistent.map((volume) => `${SOURCE_ROOT}/${volume.name}`),
      }),
    ],
    volumeMounts: sources.filter((mount) =>
      persistent.some((volume) => volume.name === mount.name),
    ),
    securityContext: CONTAINER_SECURITY,
  };
  const statePreparationDeployment: V1Deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      ...metadata,
      annotations: { ...annotations, "openclaw.dev/application-projection-phase": "initialize" },
    },
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: selector },
      template: {
        metadata: {
          labels,
          annotations: {
            ...annotations,
            "openclaw.dev/application-projection-phase": "initialize",
          },
        },
        spec: {
          automountServiceAccountToken: false,
          serviceAccountName: requirements.serviceAccountName,
          ...(nodeName === undefined ? {} : { nodeName }),
          ...(requirements.nodeSelector ? { nodeSelector: { ...requirements.nodeSelector } } : {}),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: uid,
            runAsGroup: gid,
            seccompProfile: { type: "RuntimeDefault" },
          },
          volumes: [
            ...persistent.map(sourceVolume),
            { name: BOOTSTRAP_VOLUME, persistentVolumeClaim: { claimName: name } },
          ],
          initContainers: [
            preflight,
            ...requirements.initializers.map((process) => initializer(process, volumeMap)),
          ],
          containers: [
            {
              name: "mark-private-state-prepared",
              image: requirements.image,
              imagePullPolicy: "IfNotPresent",
              command: ["node", "-e"],
              args: [PREPARE_STATE_MARKER, JSON.stringify({ root: BOOTSTRAP_ROOT, generation })],
              volumeMounts: [{ name: BOOTSTRAP_VOLUME, mountPath: BOOTSTRAP_ROOT }],
              securityContext: CONTAINER_SECURITY,
              resources: {
                requests: { cpu: "10m", memory: "32Mi" },
                limits: { cpu: "250m", memory: "128Mi" },
              },
              readinessProbe: {
                exec: {
                  command: [
                    "node",
                    "-e",
                    `require('node:fs').accessSync('${BOOTSTRAP_ROOT}/initialized.json')`,
                  ],
                },
                periodSeconds: 2,
              },
            },
          ],
        },
      },
    },
  };
  const environmentDeliveryCommand = [
    "node",
    "-e",
    DELIVER_APPLICATION_ENVIRONMENT,
    JSON.stringify({
      root: ENVIRONMENT_ROOT,
      bootstrapRoot: BOOTSTRAP_ROOT,
      generation,
      ...(podUid === undefined ? {} : { podUid }),
      environment: [
        ...new Set([
          ...requirements.environment.map((entry) => entry.name),
          APPLICATION_TRANSPORT_ENVIRONMENT,
        ]),
      ].sort(),
      environmentOverrides: Object.fromEntries(
        requirements.environment.flatMap((entry) =>
          "value" in entry &&
          entry.name === "OPENCLAW_WORKSPACE_NODE_PATH" &&
          entry.value.startsWith("/run/")
            ? [[entry.name, applicationPath(entry.value)]]
            : [],
        ),
      ),
    }),
  ];
  return {
    claim,
    environmentClaim,
    preparationDeployment,
    statePreparationDeployment,
    denyPolicy: {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata,
      spec: {
        podSelector: { matchLabels: selector },
        policyTypes: ["Ingress", "Egress"],
        ingress: [],
        egress: [],
      },
    },
    nativeVolumes,
    nativeMounts,
    command,
    environmentDeliveryCommand,
    environmentRoot: ENVIRONMENT_ROOT,
    readyPath: `${ENVIRONMENT_ROOT}/ready.json`,
    annotations,
  };
}

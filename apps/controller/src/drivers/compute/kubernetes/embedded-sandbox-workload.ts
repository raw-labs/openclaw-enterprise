import type {
  HarnessWorkloadRequirements,
  SandboxEmbeddedRuntimeRequirements,
  SandboxEnvironmentVariable,
} from "@openclaw-enterprise/contracts";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { ConfigurationHarnessError as ConfigurationFailure } from "@openclaw-enterprise/occ";
import { NETWORK_PROFILE_LABEL, PROVIDER_FENCED_NETWORK_PROFILE } from "./resources/network.ts";

function required(value: unknown, field: string): string {
  if (!isNonEmptyString(value)) {
    throw new ConfigurationFailure(`Embedded runtime requires ${field}.`);
  }
  return value;
}

function entries(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function mounts(value: unknown): SandboxEmbeddedRuntimeRequirements["volumeMounts"] {
  return entries(value).map((item) => {
    const mount = asRecord(item);
    if (
      Object.keys(mount ?? {}).some(
        (key) => !["name", "mountPath", "subPath", "readOnly"].includes(key),
      )
    ) {
      throw new ConfigurationFailure("Embedded runtime mount options cannot be preserved.");
    }
    return {
      name: required(mount?.name, "volume name"),
      mountPath: required(mount?.mountPath, "mount path"),
      ...(mount?.subPath === undefined ? {} : { subPath: required(mount.subPath, "subpath") }),
      readOnly: mount?.readOnly === true,
    };
  });
}

function environment(value: unknown): readonly SandboxEnvironmentVariable[] {
  return entries(value).flatMap((item): readonly SandboxEnvironmentVariable[] => {
    const variable = asRecord(item);
    const name = required(variable?.name, "environment name");
    // Pod UID is supplied by the provider's exact workload identity, not a copied literal.
    if (name === "OPENCLAW_POD_UID") {
      const field = asRecord(asRecord(variable?.valueFrom)?.fieldRef);
      if (field?.fieldPath !== "metadata.uid" || variable?.value !== undefined) {
        throw new ConfigurationFailure("Embedded runtime Pod UID must be provider projected.");
      }
      return [];
    }
    if (typeof variable?.value === "string") {
      return [{ name, value: variable.value }];
    }
    const ref = asRecord(asRecord(variable?.valueFrom)?.secretKeyRef);
    return [
      {
        name,
        valueFrom: {
          secretKeyRef: {
            name: required(ref?.name, "Secret name"),
            key: required(ref?.key, "Secret key"),
          },
        },
      },
    ];
  });
}

function command(container: Record<string, unknown>): readonly string[] {
  const result = [...entries(container.command), ...entries(container.args)];
  if (result.length === 0 || result.some((value) => typeof value !== "string")) {
    throw new ConfigurationFailure("Embedded runtime command must be explicit.");
  }
  return result as string[];
}

/** Render the original Gateway template without creating any Deployment or losing mounted state. */
export function embeddedSandboxRequirements(
  deployment: { readonly spec?: Readonly<Record<string, unknown>> },
  loginMode: HarnessWorkloadRequirements["loginMode"],
  configMaps: ReadonlyMap<string, Readonly<Record<string, string>>>,
  workloadIdentity: HarnessWorkloadRequirements["workloadIdentity"],
): SandboxEmbeddedRuntimeRequirements {
  const template = asRecord(asRecord(deployment.spec)?.template);
  const spec = asRecord(template?.spec);
  const containers = entries(spec?.containers);
  const container = containers.length === 1 ? asRecord(containers[0]) : undefined;
  if (container === undefined) {
    throw new ConfigurationFailure("Embedded runtime requires one combined workload container.");
  }
  const volumeMounts = mounts(container.volumeMounts);
  const podOptions = Object.fromEntries(
    Object.entries(spec ?? {}).filter(
      ([key]) =>
        ![
          "containers",
          "initContainers",
          "volumes",
          "securityContext",
          "serviceAccountName",
        ].includes(key),
    ),
  );
  const containerOptions = Object.fromEntries(
    Object.entries(container).filter(
      ([key]) =>
        ![
          "name",
          "image",
          "command",
          "args",
          "env",
          "volumeMounts",
          "securityContext",
          "resources",
          "readinessProbe",
        ].includes(key),
    ),
  );
  const volumes = entries(spec?.volumes).map((value) => asRecord(value));
  const persistentVolumes: { name: string; claimName: string }[] = [];
  const ephemeralVolumes: { name: string; sizeLimit: string; medium?: "Memory" }[] = [];
  const secretVolumes: { name: string; secretName: string; defaultMode?: number }[] = [];
  const mountedFiles: SandboxEmbeddedRuntimeRequirements["mountedFiles"][number][] = [];
  const initializers = entries(spec?.initContainers).map((item) => {
    const init = asRecord(item);
    if (init === undefined) {
      throw new ConfigurationFailure("Embedded runtime initializer is invalid.");
    }
    if (
      Object.keys(init).some(
        (key) =>
          ![
            "name",
            "image",
            "imagePullPolicy",
            "command",
            "args",
            "env",
            "volumeMounts",
            "securityContext",
            "resources",
          ].includes(key),
      )
    ) {
      throw new ConfigurationFailure("Embedded runtime initializer options cannot be preserved.");
    }
    return {
      name: required(init.name, "initializer name"),
      image: required(init.image, "initializer image"),
      command: command(init),
      ...(typeof init.imagePullPolicy === "string"
        ? { imagePullPolicy: init.imagePullPolicy }
        : {}),
      environment: environment(init.env),
      volumeMounts: mounts(init.volumeMounts),
      ...(asRecord(init.securityContext) === undefined
        ? {}
        : { securityContext: asRecord(init.securityContext)! }),
      ...(asRecord(init.resources) === undefined ? {} : { resources: asRecord(init.resources)! }),
    };
  });
  const allMounts = [...volumeMounts, ...initializers.flatMap((init) => init.volumeMounts)];
  for (const volume of volumes) {
    const name = required(volume?.name, "volume name");
    if (
      Object.keys(volume ?? {}).some(
        (key) =>
          ![
            "name",
            "persistentVolumeClaim",
            "emptyDir",
            "secret",
            "configMap",
            "projected",
          ].includes(key),
      )
    ) {
      throw new ConfigurationFailure("Embedded runtime volume options cannot be preserved.");
    }
    const pvc = asRecord(volume?.persistentVolumeClaim);
    const empty = asRecord(volume?.emptyDir);
    const secret = asRecord(volume?.secret);
    const config = asRecord(volume?.configMap);
    if (pvc !== undefined) {
      if (
        Object.keys(pvc).some((key) => key !== "claimName" && key !== "readOnly") ||
        pvc.readOnly === true
      ) {
        throw new ConfigurationFailure("Embedded runtime claim options cannot be preserved.");
      }
      persistentVolumes.push({ name, claimName: required(pvc.claimName, "claim name") });
    } else if (empty !== undefined) {
      if (
        Object.keys(empty).some((key) => !["sizeLimit", "medium"].includes(key)) ||
        (empty.medium !== undefined && empty.medium !== "Memory" && empty.medium !== "")
      ) {
        throw new ConfigurationFailure(
          "Embedded runtime ephemeral volume options cannot be preserved.",
        );
      }
      ephemeralVolumes.push({
        name,
        sizeLimit: required(empty.sizeLimit, "bounded private storage"),
        ...(empty.medium === "Memory" ? { medium: "Memory" as const } : {}),
      });
    } else if (secret !== undefined) {
      if (Object.keys(secret).some((key) => !["secretName", "defaultMode"].includes(key))) {
        throw new ConfigurationFailure(
          "Embedded runtime Secret volume options cannot be preserved.",
        );
      }
      secretVolumes.push({
        name,
        secretName: required(secret.secretName, "private delivery Secret"),
        ...(typeof secret.defaultMode === "number" ? { defaultMode: secret.defaultMode } : {}),
      });
    } else if (config !== undefined) {
      if (
        Object.keys(config).some(
          (key) => !["name", "items", "optional", "defaultMode"].includes(key),
        ) ||
        config.optional === true
      ) {
        throw new ConfigurationFailure(
          "Embedded runtime configuration options cannot be preserved.",
        );
      }
      const data = configMaps.get(required(config.name, "configuration name"));
      if (data === undefined) {
        throw new ConfigurationFailure("Embedded runtime configuration material is unavailable.");
      }
      for (const mount of allMounts.filter((item) => item.name === name)) {
        for (const item of entries(config.items)) {
          const file = asRecord(item);
          if (Object.keys(file ?? {}).some((key) => !["key", "path", "mode"].includes(key))) {
            throw new ConfigurationFailure(
              "Embedded runtime configuration file options cannot be preserved.",
            );
          }
          const key = required(file?.key, "configuration key");
          const path = required(file?.path, "configuration path");
          if (mount.subPath !== undefined && mount.subPath !== path) {
            continue;
          }
          const content = data[key];
          if (typeof content !== "string" || Buffer.byteLength(content) > 1_048_576) {
            throw new ConfigurationFailure(
              "Embedded runtime file is missing or exceeds its bound.",
            );
          }
          const mountPath =
            mount.subPath === undefined ? mount.mountPath + "/" + path : mount.mountPath;
          if (!mountedFiles.some((prior) => prior.mountPath === mountPath)) {
            mountedFiles.push({
              name: name + "/" + path,
              mountPath,
              content,
              readOnly: true,
              mode:
                typeof file?.mode === "number"
                  ? file.mode
                  : typeof config.defaultMode === "number"
                    ? config.defaultMode
                    : 0o644,
            });
          }
        }
      }
    } else if (
      name !== "openclaw-service-principal" ||
      workloadIdentity === undefined ||
      Object.keys(asRecord(volume?.projected) ?? {}).some((key) => key !== "sources") ||
      JSON.stringify(asRecord(volume?.projected)?.sources) !==
        JSON.stringify([
          {
            serviceAccountToken: {
              audience: workloadIdentity.token.audience,
              expirationSeconds: workloadIdentity.token.expirationSeconds,
              path: workloadIdentity.token.path,
            },
          },
        ])
    ) {
      throw new ConfigurationFailure("Embedded runtime volume cannot be preserved.");
    }
  }
  if (mountedFiles.reduce((size, file) => size + Buffer.byteLength(file.content), 0) > 4_194_304) {
    throw new ConfigurationFailure("Embedded runtime files exceed the aggregate bound.");
  }
  const labels = asRecord(asRecord(template?.metadata)?.labels);
  if (labels === undefined || Object.values(labels).some((value) => typeof value !== "string")) {
    throw new ConfigurationFailure("Embedded runtime labels are invalid.");
  }
  return {
    renderedPodSpec: structuredClone(spec ?? {}),
    loginMode,
    image: required(container.image, "image"),
    command: command(container),
    podUidEnvironment: entries(container.env).some(
      (item) => asRecord(item)?.name === "OPENCLAW_POD_UID",
    )
      ? ["OPENCLAW_POD_UID"]
      : [],
    readinessProbe: asRecord(container.readinessProbe) ?? {},
    ...(workloadIdentity === undefined ? {} : { workloadIdentity }),
    environment: environment(container.env),
    files: [],
    credentialAttachments: [],
    workspaceMounts: volumeMounts.flatMap((mount) => {
      const volume = persistentVolumes.find((item) => item.name === mount.name);
      return volume === undefined
        ? []
        : [
            {
              claimName: volume.claimName,
              subPath: mount.subPath ?? "",
              mountPath: mount.mountPath,
              readOnly: mount.readOnly,
            },
          ];
    }),
    labels: {
      ...(labels as Record<string, string>),
      [NETWORK_PROFILE_LABEL]: PROVIDER_FENCED_NETWORK_PROFILE,
    },
    mountedFiles,
    ephemeralVolumes,
    persistentVolumes,
    secretVolumes,
    volumeMounts,
    initializers,
    podSecurityContext: asRecord(spec?.securityContext) ?? {},
    containerSecurityContext: asRecord(container.securityContext) ?? {},
    resources: asRecord(container.resources) ?? {},
    podOptions,
    containerOptions,
  };
}

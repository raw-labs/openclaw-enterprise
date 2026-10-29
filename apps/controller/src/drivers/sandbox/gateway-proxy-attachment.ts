import {
  KubernetesObjectApi,
  type KubernetesObject,
  type V1NetworkPolicySpec,
} from "@kubernetes/client-node";
import { ObjectSerializer } from "@kubernetes/client-node/dist/serializer.js";
import type {
  GatewayDestinationPlan,
  GatewayProxyAttachment,
  GatewayProxyAttachmentContext,
} from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  STOCK_GATEWAY_PROXY,
  gatewayProxyAssets,
  openShellGatewayDestinations,
  type OpenShellGatewayDestinationsOptions,
} from "../egress-proxy/gateway-destinations.ts";
import { networkPolicySpecToJson } from "../kubernetes/network-policy.ts";

const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const selector = (labels: Readonly<Record<string, string>>) =>
  Object.entries(labels)
    .map(([key, value]) => key + "=" + value)
    .join(",");

function missing(error: unknown): boolean {
  const value = asRecord(error);
  return [
    value?.code,
    value?.statusCode,
    asRecord(value?.response)?.statusCode,
    asRecord(value?.response)?.status,
  ].includes(404);
}

/** The Sandbox owns the network boundary; the Gateway never shares this Pod's public egress. */
export function openShellGatewayProxyAttachment(
  options: OpenShellGatewayDestinationsOptions,
  driverId: string,
  sandboxDriverId: string,
): GatewayProxyAttachment {
  const assets = gatewayProxyAssets(options);
  const admission = openShellGatewayDestinations(options, driverId, sandboxDriverId);

  function resources(
    context: GatewayProxyAttachmentContext,
    plan: GatewayDestinationPlan,
  ): KubernetesObject[] {
    if (
      !(context.kubernetes instanceof KubernetesObjectApi) ||
      context.namespace.id !== plan.namespaceId ||
      context.revision.namespaceId !== context.namespace.id ||
      context.namespace.name !== context.namespaceName ||
      !isDeepStrictEqual(plan, admission.admit(context.revision, plan.destinations)) ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(context.namespaceName) ||
      !context.dnsPeer.namespace ||
      Object.keys(context.dnsPeer.podLabels).length === 0
    ) {
      throw new Error("Gateway proxy attachment ownership or admission changed.");
    }
    const name = plan.endpoint.serviceName;
    const labels = { ...plan.endpoint.podLabels };
    const annotations = {
      "openclaw.dev/gateway-policy-hash": plan.policyHash,
      "openclaw.dev/gateway-attachment-digest": plan.attachmentDigest,
      "openclaw.dev/driver-id": driverId,
      "openclaw.dev/sandbox-driver-id": sandboxDriverId,
    };
    const metadata = { name, namespace: context.namespaceName, labels, annotations };
    const securityContext = {
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
      runAsNonRoot: true,
      runAsUser: 10001,
      runAsGroup: 10001,
      seccompProfile: { type: "RuntimeDefault" },
    };
    const podSpec = {
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      dnsPolicy: "ClusterFirst",
      restartPolicy: "Always",
      terminationGracePeriodSeconds: 5,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 10001,
        runAsGroup: 10001,
        fsGroup: 10001,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "proxy",
          image: assets.options.supervisorImage,
          imagePullPolicy: "IfNotPresent",
          command: ["/openshell-supervisor"],
          args: [
            "--role=network-proxy",
            "--listen=127.0.0.1:3128",
            "--policy-rules=/policy/sandbox-policy.rego",
            "--policy-data=/policy/policy.json",
            // The volume root belongs to kubelet; stock creates this private child as UID 10001.
            "--tls-dir=/tls/private",
          ],
          securityContext,
          resources: {
            requests: { cpu: "25m", memory: "64Mi" },
            limits: { cpu: "500m", memory: "256Mi" },
          },
          volumeMounts: [
            { name: "policy", mountPath: "/policy", readOnly: true },
            { name: "tls", mountPath: "/tls" },
            { name: "tmp", mountPath: "/tmp" },
          ],
        },
        {
          name: "relay",
          image: assets.options.relayImage,
          imagePullPolicy: "IfNotPresent",
          command: ["socat"],
          args: ["TCP4-LISTEN:3129,bind=0.0.0.0,reuseaddr,fork", "TCP4:127.0.0.1:3128"],
          securityContext,
          resources: {
            requests: { cpu: "10m", memory: "8Mi" },
            limits: { cpu: "100m", memory: "32Mi" },
          },
          // A live relay alone is insufficient: query the actual stock CONNECT policy engine.
          readinessProbe: {
            exec: {
              command: [
                "/bin/sh",
                "-ec",
                "printf 'CONNECT readiness-denied.invalid:443 HTTP/1.1\r\nHost: readiness-denied.invalid:443\r\n\r\n' | nc -w 2 127.0.0.1 3128 | head -n 1 | grep -q ' 403 '",
              ],
            },
            initialDelaySeconds: 1,
            periodSeconds: 3,
            timeoutSeconds: 3,
            failureThreshold: 1,
            successThreshold: 1,
          },
        },
      ],
      volumes: [
        { name: "policy", configMap: { name, defaultMode: 292 } },
        { name: "tls", emptyDir: { medium: "Memory", sizeLimit: "8Mi" } },
        { name: "tmp", emptyDir: { medium: "Memory", sizeLimit: "8Mi" } },
      ],
    };
    const gatewayLabels = {
      ...labels,
      "openclaw.dev/network-profile": "gateway-destinations-v1",
      "openclaw.dev/workload-role": "gateway",
    };
    return [
      {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata,
        immutable: true,
        data: { "sandbox-policy.rego": assets.rules, "policy.json": plan.policy },
      } as KubernetesObject,
      {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata,
        spec: {
          podSelector: { matchLabels: labels },
          policyTypes: ["Ingress", "Egress"],
          ingress: [
            {
              from: [
                {
                  namespaceSelector: {
                    matchLabels: { "kubernetes.io/metadata.name": context.namespaceName },
                  },
                  podSelector: { matchLabels: gatewayLabels },
                },
              ],
              ports: [{ protocol: "TCP", port: 3129 }],
            },
          ],
          egress: [
            {
              to: [
                {
                  namespaceSelector: {
                    matchLabels: { "kubernetes.io/metadata.name": context.dnsPeer.namespace },
                  },
                  podSelector: { matchLabels: context.dnsPeer.podLabels },
                },
              ],
              ports: [
                { protocol: "UDP", port: 53 },
                { protocol: "TCP", port: 53 },
              ],
            },
            {
              to: [
                {
                  ipBlock: {
                    cidr: "0.0.0.0/0",
                    except: [...plan.egress.excludedCidrs],
                  },
                },
              ],
              ports: [{ protocol: "TCP", port: 443 }],
            },
          ],
        },
      } as KubernetesObject,
      {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata,
        spec: {
          replicas: 1,
          revisionHistoryLimit: 0,
          strategy: { type: "Recreate" },
          selector: { matchLabels: labels },
          template: { metadata: { labels, annotations }, spec: podSpec },
        },
      } as KubernetesObject,
      {
        apiVersion: "v1",
        kind: "Service",
        metadata,
        spec: {
          type: "ClusterIP",
          selector: labels,
          ports: [{ name: "connect", protocol: "TCP", port: 3129, targetPort: 3129 }],
          sessionAffinity: "None",
          internalTrafficPolicy: "Cluster",
        },
      } as KubernetesObject,
    ];
  }

  async function read(
    api: KubernetesObjectApi,
    resource: KubernetesObject,
  ): Promise<KubernetesObject | undefined> {
    try {
      return await api.read({
        apiVersion: resource.apiVersion!,
        kind: resource.kind!,
        metadata: { name: resource.metadata!.name!, namespace: resource.metadata!.namespace! },
      });
    } catch (error) {
      if (!missing(error)) {
        throw error;
      }
      return undefined;
    }
  }

  function owned(actual: KubernetesObject, expected: KubernetesObject): void {
    const annotations = { ...actual.metadata?.annotations };
    if (expected.kind === "Deployment") {
      // The Deployment controller adds this counter after creation, not attachment authority.
      const revision = annotations["deployment.kubernetes.io/revision"];
      if (revision !== undefined && !/^[1-9][0-9]*$/.test(revision)) {
        throw new Error("Gateway proxy Deployment revision annotation is invalid.");
      }
      delete annotations["deployment.kubernetes.io/revision"];
    }
    if (
      actual.metadata?.name !== expected.metadata?.name ||
      actual.metadata?.namespace !== expected.metadata?.namespace ||
      !isDeepStrictEqual(actual.metadata?.labels, expected.metadata?.labels) ||
      !isDeepStrictEqual(annotations, expected.metadata?.annotations)
    ) {
      throw new Error("Refusing a foreign or changed Gateway proxy resource.");
    }
  }

  // Compare all authored fields, allowing API defaults only where they cannot broaden authority.
  function match(actual: unknown, expected: unknown): boolean {
    if (Array.isArray(expected)) {
      return (
        Array.isArray(actual) &&
        actual.length === expected.length &&
        expected.every((item, i) => match(actual[i], item))
      );
    }
    if (expected && typeof expected === "object") {
      const record = asRecord(actual);
      return (
        !!record && Object.entries(expected).every(([key, value]) => match(record[key], value))
      );
    }
    return isDeepStrictEqual(actual, expected);
  }

  function podWithDefaults(value: unknown): Record<string, unknown> | undefined {
    const pod = asRecord(value);
    // Kubernetes omits these false defaults; explicit host access must still be refused.
    return pod === undefined
      ? undefined
      : { hostNetwork: false, hostPID: false, hostIPC: false, ...pod };
  }

  function assertResource(actual: KubernetesObject, expected: KubernetesObject): void {
    owned(actual, expected);
    const observed = json(actual) as Record<string, unknown>;
    const desired = json(expected) as Record<string, unknown>;
    if (expected.kind === "Deployment") {
      const template = asRecord(asRecord(observed.spec)?.template)!;
      template.spec = podWithDefaults(template.spec);
    }
    if (expected.kind === "NetworkPolicy") {
      observed.spec = networkPolicySpecToJson(
        (actual as unknown as { spec: V1NetworkPolicySpec }).spec,
      );
      if (!isDeepStrictEqual(observed.spec, desired.spec)) {
        throw new Error("Gateway proxy network policy changed.");
      }
    } else if (!match(observed, desired)) {
      throw new Error("Gateway proxy configuration changed.");
    }
    if (
      expected.kind === "ConfigMap" &&
      (!isDeepStrictEqual(observed.data, desired.data) ||
        observed.binaryData !== undefined ||
        observed.immutable !== true)
    ) {
      throw new Error("Gateway proxy policy content changed.");
    }
    if (expected.kind === "Service") {
      const spec = asRecord(observed.spec)!;
      if (
        !isDeepStrictEqual(spec.selector, asRecord(desired.spec)?.selector) ||
        spec.externalIPs !== undefined ||
        spec.externalName !== undefined ||
        spec.loadBalancerIP !== undefined ||
        spec.loadBalancerSourceRanges !== undefined ||
        spec.publishNotReadyAddresses === true ||
        (spec.ports as Record<string, unknown>[]).some((port) => port.nodePort !== undefined) ||
        Object.keys(spec).some(
          (key) =>
            !Object.hasOwn(asRecord(desired.spec)!, key) &&
            !["clusterIP", "clusterIPs", "ipFamilies", "ipFamilyPolicy"].includes(key),
        )
      ) {
        throw new Error("Gateway proxy Service has unexpected exposure.");
      }
    }
    if (expected.kind === "Deployment") {
      assertPod(
        asRecord(asRecord(asRecord(observed.spec)?.template)?.spec),
        asRecord(asRecord(asRecord(desired.spec)?.template)?.spec),
      );
    }
  }

  function assertPod(actual: unknown, expected: unknown): void {
    const pod = podWithDefaults(actual);
    const wanted = asRecord(expected);
    if (
      !pod ||
      !wanted ||
      !match(pod, wanted) ||
      pod.initContainers !== undefined ||
      pod.ephemeralContainers !== undefined ||
      Object.keys(pod).some(
        (key) =>
          !Object.hasOwn(wanted, key) &&
          ![
            "serviceAccount",
            "serviceAccountName",
            "schedulerName",
            "priority",
            "preemptionPolicy",
            "nodeName",
            "tolerations",
            "imagePullSecrets",
          ].includes(key),
      ) ||
      (pod.serviceAccountName !== undefined && pod.serviceAccountName !== "default") ||
      !isDeepStrictEqual(pod.securityContext, wanted.securityContext) ||
      !isDeepStrictEqual(pod.volumes, wanted.volumes) ||
      (pod.containers as Record<string, unknown>[]).some((container, index) => {
        const expectedContainer = (wanted.containers as Record<string, unknown>[])[index]!;
        return (
          !isDeepStrictEqual(container.securityContext, expectedContainer.securityContext) ||
          !isDeepStrictEqual(container.resources, expectedContainer.resources) ||
          !isDeepStrictEqual(container.volumeMounts, expectedContainer.volumeMounts)
        );
      }) ||
      (pod.containers as Record<string, unknown>[]).some((container, index) =>
        Object.keys(container).some(
          (key) =>
            !Object.hasOwn((wanted.containers as Record<string, unknown>[])[index]!, key) &&
            !["terminationMessagePath", "terminationMessagePolicy"].includes(key),
        ),
      ) ||
      (pod.containers as Record<string, unknown>[]).some(
        (container) =>
          container.env !== undefined ||
          container.envFrom !== undefined ||
          container.lifecycle !== undefined ||
          container.startupProbe !== undefined ||
          container.livenessProbe !== undefined ||
          container.volumeDevices !== undefined,
      )
    ) {
      throw new Error("Gateway proxy Pod has unexpected configuration or authority.");
    }
  }

  async function pods(
    api: KubernetesObjectApi,
    context: GatewayProxyAttachmentContext,
    plan: GatewayDestinationPlan,
  ) {
    return (
      await api.list(
        "v1",
        "Pod",
        context.namespaceName,
        undefined,
        undefined,
        undefined,
        undefined,
        selector(plan.endpoint.podLabels),
      )
    ).items;
  }

  return {
    async prepare(context, plan) {
      const expected = resources(context, plan);
      const api = context.kubernetes as KubernetesObjectApi;
      context.signal.throwIfAborted();
      // Never patch existing resources: revision configuration is immutable, replacement needs drain.
      for (const resource of expected) {
        const actual = await read(api, resource);
        if (actual) {
          assertResource(actual, resource);
          if (!actual.metadata?.uid || actual.metadata.deletionTimestamp) {
            return false;
          }
        } else {
          // ObjectApi serializes SDK models: plain JSON ingress.from would be dropped.
          const body =
            resource.kind === "NetworkPolicy"
              ? ObjectSerializer.deserialize(resource, "V1NetworkPolicy")
              : resource;
          assertResource(await api.create(body), resource);
        }
      }
      const deployment = expected.find((item) => item.kind === "Deployment")! as unknown as {
        spec: { template: { spec: unknown } };
      };
      const observedPods = await pods(api, context, plan);
      if (observedPods.length !== 1) {
        return false;
      }
      const pod = observedPods[0]!;
      if (
        pod.metadata?.deletionTimestamp ||
        pod.metadata?.namespace !== context.namespaceName ||
        !isDeepStrictEqual(
          pod.metadata?.labels &&
            Object.fromEntries(
              Object.keys(plan.endpoint.podLabels).map((key) => [key, pod.metadata?.labels?.[key]]),
            ),
          plan.endpoint.podLabels,
        )
      ) {
        return false;
      }
      const podRecord = asRecord(pod)!;
      assertPod(json(podRecord.spec), deployment.spec.template.spec);
      const status = asRecord(podRecord.status);
      const observedDeployment = await read(
        api,
        expected.find((item) => item.kind === "Deployment")!,
      );
      const deploymentUid = observedDeployment?.metadata?.uid;
      if (
        !deploymentUid ||
        !pod.metadata?.uid ||
        (pod.metadata.ownerReferences?.length ?? 0) !== 1
      ) {
        return false;
      }
      const owner = pod.metadata.ownerReferences![0]!;
      if (owner.kind !== "ReplicaSet" || owner.controller !== true || !owner.name || !owner.uid) {
        return false;
      }
      const replicaSet = await read(api, {
        apiVersion: "apps/v1",
        kind: "ReplicaSet",
        metadata: { name: owner.name, namespace: context.namespaceName },
      });
      if (
        replicaSet?.metadata?.uid !== owner.uid ||
        !replicaSet?.metadata?.ownerReferences?.some(
          (item) =>
            item.uid === deploymentUid && item.kind === "Deployment" && item.controller === true,
        )
      ) {
        return false;
      }
      const statuses = status?.containerStatuses as
        | {
            name: string;
            ready: boolean;
            image: string;
            imageID: string;
            state?: { running?: unknown };
          }[]
        | undefined;
      return (
        status?.phase === "Running" &&
        !!statuses &&
        statuses.length === 2 &&
        ["proxy", "relay"].every((name) =>
          statuses.some(
            (item) =>
              item.name === name &&
              item.ready &&
              item.state?.running &&
              // Pod spec pins the requested image; CRI may normalize its reported name.
              (name === "proxy"
                ? STOCK_GATEWAY_PROXY.supervisorDigests
                : STOCK_GATEWAY_PROXY.relayDigests
              ).some(
                (digest) =>
                  item.imageID.endsWith("@sha256:" + digest) ||
                  item.imageID.endsWith("://sha256:" + digest),
              ),
          ),
        ) &&
        (status.conditions as { type: string; status: string }[] | undefined)?.some(
          (item) => item.type === "Ready" && item.status === "True",
        ) === true
      );
    },
    async remove(context, plan) {
      const expected = resources(context, plan);
      const api = context.kubernetes as KubernetesObjectApi;
      async function remove(resource: KubernetesObject) {
        context.signal.throwIfAborted();
        const actual = await read(api, resource);
        if (!actual) {
          return;
        }
        assertResource(actual, resource);
        if (!actual.metadata?.uid || !actual.metadata.resourceVersion) {
          throw new Error("Missing Gateway proxy deletion precondition.");
        }
        try {
          await api.delete(resource, undefined, undefined, undefined, undefined, "Foreground", {
            preconditions: {
              uid: actual.metadata.uid,
              resourceVersion: actual.metadata.resourceVersion,
            },
          });
        } catch (error) {
          if (!missing(error)) {
            throw error;
          }
        }
      }
      const service = expected.find((item) => item.kind === "Service")!;
      const deployment = expected.find((item) => item.kind === "Deployment")!;
      // Fence new connections before terminating every proxy of this revision.
      await remove(service);
      if (await read(api, service)) {
        return false;
      }
      await remove(deployment);
      const deadline = Date.now() + 5_000;
      while ((await read(api, deployment)) || (await pods(api, context, plan)).length !== 0) {
        if (Date.now() >= deadline) {
          return false;
        }
        await delay(200, undefined, { signal: context.signal });
      }
      for (const resource of expected.filter(
        (item) => item.kind === "ConfigMap" || item.kind === "NetworkPolicy",
      )) {
        await remove(resource);
        if (await read(api, resource)) {
          return false;
        }
      }
      return true;
    },
  };
}

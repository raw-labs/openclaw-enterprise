import type {
  Backend,
  CredentialProxyBinding,
  CredentialProxyDriver,
  CredentialProviderDefinition,
  SandboxDriver,
} from "@openclaw-enterprise/contracts";
import type { PostgresPool } from "@openclaw-enterprise/occ";
import { DependencyUnavailableError } from "@openclaw-enterprise/occ";
import { openShellGatewayProxyAttachment } from "../sandbox/gateway-proxy-attachment.ts";
import {
  openShellGatewayDestinations,
  type OpenShellGatewayDestinationsOptions,
} from "./gateway-destinations.ts";
import type { OpenShellGateway } from "../../backends/openshell.ts";
import type { startPreparedGitHubGitOwner } from "../../backends/repository-credentials/prepared-git-owner.ts";
import type { EgressAuthorityConfiguration } from "../../composition/egress-authority.ts";
import type { RepositoryGitDeliveryResolver } from "../repo/credentials/delivery.ts";
import type { OpenShellSandboxDriverSelection } from "../sandbox/openshell.ts";
import { openShellGitRecipientEvidence } from "../repo/credentials/protected-repository-git-installation.ts";
import { OpenShellCredentialProxyDriver, type OpenShellProxyOptions } from "./openshell.ts";
import {
  OpenShellGitRuntime,
  type OpenShellGitRuntimeConfiguration,
} from "./openshell-git-runtime.ts";

export interface OpenShellRepositoryTransport {
  readonly evidence: typeof openShellGitRecipientEvidence;
  bind(
    owner: Awaited<ReturnType<typeof startPreparedGitHubGitOwner>>,
    pool: PostgresPool,
    emit?: (event: Readonly<Record<string, unknown>>) => void,
  ): Promise<CredentialProxyBinding>;
}

/** The installed OpenShell Driver owns its transport. Composition receives capability
 * views and one worker binding, not a separately managed Git lifecycle coordinator. */
export function createOpenShellCapabilities(input: {
  readonly sandbox: {
    readonly id: string;
    readonly implementation: string;
    readonly configuration: Readonly<Record<string, unknown>>;
  };
  readonly createSandbox: (
    configuration: Readonly<Record<string, unknown>>,
    selection: OpenShellSandboxDriverSelection,
  ) => SandboxDriver;
  readonly backend: Backend<OpenShellGateway>;
  readonly operatorOwnedKubernetesResources: boolean;
  readonly repository?: {
    readonly configuration: OpenShellGitRuntimeConfiguration | undefined;
    readonly resolveDelivery: RepositoryGitDeliveryResolver | undefined;
  };
  readonly proxy?: {
    readonly id: string;
    readonly configuration: OpenShellProxyOptions;
    readonly exchangeAuthority?: EgressAuthorityConfiguration;
    readonly preparedProviders: readonly CredentialProviderDefinition[];
  };
}) {
  const destinationOptions = input.proxy?.configuration.gatewayDestinations;
  const configuration = input.repository?.configuration;
  const resolveDelivery = input.repository?.resolveDelivery;
  if (configuration && !resolveDelivery) {
    throw new Error("OpenShell Git requires its Repo delivery binding.");
  }
  const git =
    configuration &&
    resolveDelivery &&
    new OpenShellGitRuntime(
      { ...configuration, ...(input.proxy && { protectedExecution: true }) },
      resolveDelivery,
    );
  const sandbox = input.createSandbox(
    {
      ...input.sandbox.configuration,
      ...(input.proxy && { egress: input.proxy.configuration }),
    },
    {
      id: input.sandbox.id,
      implementation: input.sandbox.implementation,
      backend: input.backend,
      operatorOwnedKubernetesResources: input.operatorOwnedKubernetesResources,
      ...(git && { openShellGit: git }),
      ...(destinationOptions && {
        gatewayDestinations: { options: destinationOptions, driverId: input.proxy!.id },
      }),
    },
  );
  const proxy: CredentialProxyDriver | undefined =
    input.proxy &&
    new OpenShellCredentialProxyDriver(input.proxy.configuration, {
      id: input.proxy.id,
      backend: input.backend,
      sandbox,
      preparedProviders: input.proxy.preparedProviders,
      ...(input.proxy.exchangeAuthority && { exchangeAuthority: input.proxy.exchangeAuthority }),
      ...(git && {
        bindRepositoryGit: git.bindRepositoryGit.bind(git),
        previewEnforcement: git.previewEnforcement.bind(git),
      }),
    });
  const repositoryTransport: OpenShellRepositoryTransport | undefined = git && {
    evidence: openShellGitRecipientEvidence,
    async bind(owner, pool, emit) {
      const routes = git.connectRouteStore(pool, emit);
      if (git.configuration.protectedExecution) {
        if (!owner.protectedGit || !proxy?.bindRepositoryGit) {
          throw new Error("Missing the selected Driver's protected repository Git authority.");
        }
        return proxy.bindRepositoryGit(owner.protectedGit);
      }
      // The explicitly selected legacy profile retains its own drain owner.
      await git.start(owner, emit, routes);
      return { close: () => git.close() };
    },
  };
  return {
    sandbox,
    proxy,
    repositoryTransport,
    async close() {
      await git?.close();
      await input.backend.client.close();
    },
  };
}

/** Gateway-only views refuse execution without constructing management clients. */
export function createOpenShellGatewayCapabilities(input: {
  readonly sandboxId: string;
  readonly proxyId: string;
  readonly options: OpenShellGatewayDestinationsOptions;
}): { readonly sandbox: SandboxDriver; readonly proxy: CredentialProxyDriver } {
  const refuse = (): never => {
    throw new DependencyUnavailableError(
      "Gateway-only registration does not provide OpenShell management or execution operations.",
    );
  };
  const unavailable = async (): Promise<never> => refuse();
  return {
    sandbox: {
      id: input.sandboxId,
      implementation: "openshell",
      capability: "sandbox",
      facets: ["networking"],
      gatewayProxy: openShellGatewayProxyAttachment(input.options, input.proxyId, input.sandboxId),
      cleanup: unavailable,
    },
    proxy: {
      id: input.proxyId,
      implementation: "openshell",
      capability: "credential_proxy",
      gatewayDestinations: openShellGatewayDestinations(
        input.options,
        input.proxyId,
        input.sandboxId,
      ),
      // The existing contract requires sourceControl, but Gateway-only registration
      // has no credential authority. Refuse identity reads instead of inventing one.
      sourceControl: {
        get backend(): never {
          return refuse();
        },
        get sender(): never {
          return refuse();
        },
        get resolver(): never {
          return refuse();
        },
        providers: [],
        assertAvailable: unavailable,
      },
      configureRevision: unavailable,
      wiringStatus: unavailable,
      verifyInstallation: unavailable,
      removeRevision: unavailable,
    },
  };
}

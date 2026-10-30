package occdev

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
)

const (
	developmentGatewayPodCIDR     = "10.42.0.0/16"
	developmentGatewayServiceCIDR = "10.43.0.0/16"
	developmentGatewayRelayImage  = "alpine/socat:1.8.0.3@sha256:beb4a68d9e4fe6b0f21ea774a0fde6c31f580dde6368939ed70100c5385b015e"
	developmentGatewayRulesHash   = "f60349dcfe8f42ff6c6957fd860cbfc1aef536c6f22740025c6771745f637c38"
)

// Normal k3d Gateways require their own pair regardless of Harness selection.
// OpenShell Harness selection retains its separate native TLS opt-in.
func (r *runner) checkGatewayDestinationSelection(controlPlane, sandbox string) error {
	value := r.env["OCC_DEVELOPMENT_GATEWAY_DESTINATIONS"]
	if value != "" && value != "0" && value != "1" {
		return fmt.Errorf("OCC_DEVELOPMENT_GATEWAY_DESTINATIONS must be 0 or 1")
	}
	if value != "1" {
		return nil
	}
	if controlPlane != "kubernetes" {
		return fmt.Errorf("Gateway destinations require Kubernetes control plane")
	}
	return r.checkGatewayDestinationRules()
}

func (r *runner) checkGatewayDestinationRules() error {
	rules, err := os.ReadFile(filepath.Join(r.opts.Repository, "deploy/runtime/gateway-proxy/sandbox-policy.rego"))
	if err != nil || fmt.Sprintf("%x", sha256.Sum256(rules)) != developmentGatewayRulesHash {
		return fmt.Errorf("Gateway destinations require the unchanged pinned stock policy rules in this checkout")
	}
	return nil
}

// The owned one-node cluster fixes Pod/Service ranges at creation. Discover the
// complete engine node subnet, rather than excluding only today's node address.
// Metadata is explicit even though it is also covered by the Driver's defaults.
func (r *runner) prepareGatewayDestinationInfrastructure(ctx context.Context, state *developmentState) error {
	if !state.GatewayDestinations {
		return nil
	}
	endpoint, err := r.output(ctx, r.engine, "inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", "k3d-"+state.Cluster+"-server-0")
	if err != nil {
		return err
	}
	address, err := netip.ParseAddr(string(endpoint))
	if err != nil || !address.Is4() {
		return fmt.Errorf("owned k3d node must report exactly one IPv4 network address")
	}
	subnet, err := r.developmentNodeSubnet(ctx, state, address.String())
	if err != nil {
		return err
	}
	state.InfrastructureCIDRs = []string{developmentGatewayPodCIDR, developmentGatewayServiceCIDR, subnet, "169.254.0.0/16"}
	return nil
}

// Pull the exact stock index into containerd. A platform-only Docker archive can
// change its digest, so it cannot establish the independently pinned identity.
func (r *runner) importGatewayDestinationImages(ctx context.Context, state *developmentState) error {
	if !state.GatewayDestinations {
		return nil
	}
	for _, image := range []string{openShellSupervisorImage, "docker.io/" + developmentGatewayRelayImage} {
		if err := r.run(ctx, r.engine, "exec", "k3d-"+state.Cluster+"-server-0", "ctr", "-n", "k8s.io", "images", "pull", image); err != nil {
			return err
		}
	}
	return nil
}

// Register only Gateway attachment capabilities, with no management Backend,
// OpenShell service, Harness, or credential authority.
func configureGatewayOnlyPair(state *developmentState, installation map[string]any) {
	drivers := installation["drivers"].(map[string]any)
	sandbox := openShellInstallationConfiguration(state, nil, nil)
	configuration := sandbox["configuration"].(map[string]any)
	// Execution-only workspace resources, callback policies, and startup delays
	// do not belong to registration-only Gateway attachments.
	configuration["gateway"] = map[string]any{"workspaceMode": "operator"}
	delete(configuration, "startupDelayMs")
	delete(configuration["kubernetes"].(map[string]any), "agentResources")
	drivers["sandbox"] = sandbox
	proxy := developmentEgressConfiguration(state)
	proxy["usage"] = "gateway"
	delete(proxy["configuration"].(map[string]any), "authority")
	drivers["credential_proxy"] = proxy
}

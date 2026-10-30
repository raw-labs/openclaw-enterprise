package occdev

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestGatewayDestinationSelectionRequiresSecureProfileBeforeEffects(t *testing.T) {
	state := kubernetesOnlyOpenShellState(t)
	r := newRunner(Options{Repository: state.Repository})
	r.env["OCC_DEVELOPMENT_GATEWAY_DESTINATIONS"] = "1"
	for _, c := range []struct{ plane, sandbox string }{{"compose", "openshell"}, {"kubernetes", "none"}} {
		if err := r.checkGatewayDestinationSelection(c.plane, c.sandbox); err == nil {
			t.Fatal("accepted incomplete secure profile", c)
		}
	}
	if err := r.checkGatewayDestinationSelection("kubernetes", "openshell"); err != nil {
		t.Fatal("native TLS profile must not require protected middleware", err)
	}
	r.env["OCC_DEVELOPMENT_GATEWAY_DESTINATIONS"] = "true"
	if err := r.checkGatewayDestinationSelection("kubernetes", "openshell"); err == nil {
		t.Fatal("accepted invalid selector")
	}
	r.env["OCC_DEVELOPMENT_GATEWAY_DESTINATIONS"] = "1"
	r.opts.Repository = t.TempDir()
	if err := r.checkGatewayDestinationSelection("kubernetes", "openshell"); err == nil {
		t.Fatal("accepted missing rules")
	}
	path := filepath.Join(r.opts.Repository, "deploy/runtime/gateway-proxy")
	if err := os.MkdirAll(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "sandbox-policy.rego"), []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := r.checkGatewayDestinationSelection("kubernetes", "openshell"); err == nil {
		t.Fatal("accepted changed rules")
	}
}

func TestGatewayDestinationInfrastructureUsesOwnedNetworkAndPinnedClusterRanges(t *testing.T) {
	state := kubernetesOnlyOpenShellState(t)
	state.GatewayDestinations = true
	t.Setenv("PATH", t.TempDir())
	fakeProfileCommands(t, map[string]string{"docker": `"inspect --format {{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}} k3d-occ-dev-owned-server-0") echo 172.30.42.2 ;;
"network inspect k3d-occ-dev-owned") echo '[{"IPAM":{"Config":[{"Subnet":"172.30.42.0/24"}]}}]' ;;`})
	r := newRunner(Options{Repository: state.Repository})
	r.engine = "docker"
	if err := r.prepareGatewayDestinationInfrastructure(context.Background(), state); err != nil {
		t.Fatal(err)
	}
	want := []string{"10.42.0.0/16", "10.43.0.0/16", "172.30.42.0/24", "169.254.0.0/16"}
	if !slices.Equal(state.InfrastructureCIDRs, want) {
		t.Fatalf("incomplete exclusions: %v", state.InfrastructureCIDRs)
	}
	args := strings.Join(kubernetesOnlyClusterArgs(state, 60, 6443, 5, ""), " ")
	if !strings.Contains(args, "--cluster-cidr=10.42.0.0/16@server:*") || !strings.Contains(args, "--service-cidr=10.43.0.0/16@server:*") {
		t.Fatal("cluster ranges were not fixed", args)
	}
	config := developmentEgressConfiguration(state)["configuration"].(map[string]any)
	if config["authority"] == nil || config["gatewayDestinations"] == nil {
		t.Fatal("destination capability lost execution authority")
	}
	destination := config["gatewayDestinations"].(map[string]any)
	if !slices.Equal(destination["blockedCidrs"].([]string), want) {
		t.Fatal("proxy exclusions differ")
	}
}

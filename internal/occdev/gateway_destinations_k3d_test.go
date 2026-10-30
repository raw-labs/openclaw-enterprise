package occdev

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

func TestGatewayDestinationSelectionRequiresSecureProfileBeforeEffects(t *testing.T) {
	state := kubernetesOnlyOpenShellState(t)
	r := newRunner(Options{Repository: state.Repository})
	r.env["OCC_DEVELOPMENT_GATEWAY_DESTINATIONS"] = "1"
	for _, c := range []struct{ plane, sandbox string }{{"compose", "openshell"}, {"compose", "none"}} {
		if err := r.checkGatewayDestinationSelection(c.plane, c.sandbox); err == nil {
			t.Fatal("accepted incomplete secure profile", c)
		}
	}
	if err := r.checkGatewayDestinationSelection("kubernetes", "openshell"); err != nil {
		t.Fatal("native TLS profile must not require protected middleware", err)
	}
	for _, value := range []string{"", "0", "1"} {
		r.env["OCC_DEVELOPMENT_GATEWAY_DESTINATIONS"] = value
		if err := r.checkGatewayDestinationSelection("kubernetes", "none"); err != nil {
			t.Fatal("normal Gateway pair must not require OpenShell Harness", err)
		}
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

// The normal profile must admit dedicated Gateways without selecting an
// execution-capable OpenShell Harness or its credential authority.
func TestNormalK3dInstallationIncludesGatewayOnlyPair(t *testing.T) {
	state := kubernetesOnlyOpenShellState(t)
	state.SandboxDriver = "none"
	state.GatewayDestinations = true
	if state.secureOpenShell() {
		t.Fatal("registration-only pair must not provision OpenShell TLS or authority")
	}
	if err := writeInstallation(state, "runtime@"+profileTestDigest, nil, "", "", "10.42.0.1/32"); err == nil {
		t.Fatal("normal Gateway pair accepted missing infrastructure exclusions")
	}
	state.InfrastructureCIDRs = []string{"10.42.0.0/16", "10.43.0.0/16", "172.30.42.0/24", "169.254.0.0/16"}
	if err := writeInstallation(state, "runtime@"+profileTestDigest, nil, "", "", "10.42.0.1/32"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(state.directory, "installation.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var installation map[string]any
	if err := yaml.Unmarshal(data, &installation); err != nil {
		t.Fatal(err)
	}
	drivers := installation["drivers"].(map[string]any)
	proxy, ok := drivers["credential_proxy"].(map[string]any)
	if !ok {
		t.Fatal("normal dedicated Gateways have no destination proxy pair")
	}
	if proxy["usage"] != "gateway" {
		t.Fatalf("execution authority selected: %v", proxy)
	}
	policy := proxy["configuration"].(map[string]any)
	if policy["authority"] != nil || policy["preparedGitHub"] != nil || drivers["credential_gateway"] != nil {
		t.Fatal("Gateway pair must not select credential custody")
	}
	destination := policy["gatewayDestinations"].(map[string]any)
	compute := drivers["compute"].(map[string]any)["configuration"].(map[string]any)
	network := compute["network"].(map[string]any)
	for _, cidrs := range []any{network["infrastructureCidrs"], destination["blockedCidrs"]} {
		if !reflect.DeepEqual(cidrs, []any{"10.42.0.0/16", "10.43.0.0/16", "172.30.42.0/24", "169.254.0.0/16"}) {
			t.Fatalf("incomplete infrastructure exclusions: %v", cidrs)
		}
	}
	if !strings.Contains(destination["supervisorImage"].(string), "@sha256:") || !strings.Contains(destination["relayImage"].(string), "@sha256:") {
		t.Fatal("proxy images are not immutable")
	}
	if network["providerHarness"] != nil || compute["servicePrincipalCredentials"].(map[string]any)["mode"] != "projectedServiceAccountToken" || installation["presets"].(map[string]any)["includeDefaults"] != true || drivers["plugin"].(map[string]any)["id"] != "codex-plugin" {
		t.Fatal("Gateway registration changed native Harness selection")
	}
	backend := installation["backend"].([]any)[0].(map[string]any)
	members := backend["drivers"].(map[string]any)
	if len(members) != 2 || members["sandbox"] != drivers["sandbox"].(map[string]any)["id"] || members["credential_proxy"] != proxy["id"] {
		t.Fatalf("Backend does not own exactly the Gateway pair: %v", members)
	}
	if backend["configuration"].(map[string]any)["endpoint"] != "https://127.0.0.1:9" {
		t.Fatal("registration-only Backend must fail closed for management RPC")
	}
}

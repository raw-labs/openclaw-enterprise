package occcli

import (
	"encoding/json/v2"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The CLI must pass the Agent field through unchanged, including an explicit empty
// list. These are HTTP transport tests, not authorization or persistence proof.
func TestAgentGatewayOutboundJSONFiles(t *testing.T) {
	for _, tc := range []struct{ name, verb, method, body string }{
		{"create-empty", "create", "POST", `{"name":"example-agent","configurationId":"cfg_55555555-5555-4555-8555-555555555555","executionMode":"dedicated","gatewayOutbound":{"destinations":[]}}`},
		{"update-only-outbound", "update", "PATCH", `{"gatewayOutbound":{"destinations":[{"host":"api.example.com","port":443}]}}`},
		{"clear-additional-hosts", "update", "PATCH", `{"gatewayOutbound":{"destinations":[]}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "agent.json")
			if err := os.WriteFile(file, []byte(tc.body), 0600); err != nil {
				t.Fatal(err)
			}
			var want map[string]any
			if err := json.Unmarshal([]byte(tc.body), &want); err != nil {
				t.Fatal(err)
			}
			calls := 0
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				path := "/namespaces/" + testNamespaceID + "/agents"
				if tc.verb == "update" {
					path += "/" + testAgentID
				}
				if r.Method != tc.method || r.URL.Path != path {
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
				}
				var got map[string]any
				if err := json.UnmarshalRead(r.Body, &got); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(got, want) {
					t.Errorf("JSON file changed in transit: got %#v, want %#v", got, want)
				}
				w.Header().Set("Content-Type", "application/json")
				if tc.verb == "create" {
					w.WriteHeader(http.StatusCreated)
				}
				_ = json.MarshalWrite(w, map[string]any{"data": map[string]any{"id": testAgentID, "namespaceId": testNamespaceID, "gatewayOutbound": got["gatewayOutbound"]}, "meta": map[string]string{"requestId": "req_test"}})
			})
			args := []string{"--namespace", testNamespaceID, "agent", tc.verb}
			if tc.verb == "update" {
				args = append(args, testAgentID)
			}
			args = append(args, "--file", file, "-o", "json")
			out, _, err := runOCCAgainst(t, handler, args...)
			if err != nil {
				t.Fatal(err)
			}
			if calls != 1 {
				t.Fatalf("wanted one write, got %d", calls)
			}
			var saved map[string]any
			if err := json.Unmarshal([]byte(out), &saved); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(saved["gatewayOutbound"], want["gatewayOutbound"]) {
				t.Fatalf("saved destinations not available in JSON output: %s", out)
			}
		})
	}
}

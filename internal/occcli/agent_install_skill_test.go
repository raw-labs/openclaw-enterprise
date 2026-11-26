package occcli

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json/v2"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallSkillVerifiesPinAndReceipt(t *testing.T) {
	archive := []byte("test skill archive bytes")
	slug := "example-guide"
	digest := fmt.Sprintf("%x", sha256.Sum256(archive))
	path := filepath.Join(t.TempDir(), "guide.zip")
	if err := os.WriteFile(path, archive, 0600); err != nil {
		t.Fatal(err)
	}
	args := []string{"--namespace", testNamespaceID, "--output", "json", "agent", "install-skill", testAgentID, testRevision1ID, "--archive", path, "--slug", slug, "--sha256", digest}
	for _, scenario := range []string{"success", "bad local pin", "mismatched receipt", "unknown outcome"} {
		t.Run(scenario, func(t *testing.T) {
			requestArgs := append([]string{}, args...)
			if scenario == "bad local pin" {
				requestArgs[len(requestArgs)-1] = strings.Repeat("0", 64)
			}
			calls := 0
			output, _, err := runOCCAgainst(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.Method != "POST" || r.URL.Path != "/namespaces/"+testNamespaceID+"/agents/"+testAgentID+"/workspace/skills/install" || r.Header.Get("x-api-key") != "test-key" {
					t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
				}
				var body map[string]any
				if e := json.UnmarshalRead(r.Body, &body); e != nil {
					t.Error(e)
				}
				if body["archiveBase64"] != base64.StdEncoding.EncodeToString(archive) || body["sha256"] != digest || body["slug"] != slug || body["revisionId"] != testRevision1ID || body["replace"] != false {
					t.Error("unexpected upload body")
				}
				if scenario == "unknown outcome" {
					w.WriteHeader(503)
					fmt.Fprint(w, `{"error":{"code":"UNKNOWN_OUTCOME","message":"installation outcome unknown"}}`)
					return
				}
				receiptDigest := digest
				if scenario == "mismatched receipt" {
					receiptDigest = strings.Repeat("f", 64)
				}
				_ = json.MarshalWrite(w, map[string]any{"meta": map[string]any{}, "data": map[string]any{"agentId": testAgentID, "revisionId": testRevision1ID, "slug": slug, "sha256": receiptDigest}})
			}), requestArgs...)
			if scenario == "bad local pin" {
				if calls != 0 || err == nil {
					t.Fatalf("expected local refusal, calls=%d err=%v", calls, err)
				}
			} else if calls != 1 || (scenario == "success") != (err == nil) || (scenario == "success" && !strings.Contains(output, digest)) {
				t.Fatalf("calls=%d output=%q err=%v", calls, output, err)
			}
		})
	}
}

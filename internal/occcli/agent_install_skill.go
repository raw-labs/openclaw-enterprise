package occcli

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"

	"github.com/openclaw/openclaw-enterprise/internal/occclient"
	"github.com/spf13/cobra"
)

const workspaceSkillMaxBytes = 40 * 1024 * 1024

var workspaceSkillSlug = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

func (app *application) installSkillCommand() *cobra.Command {
	var archivePath, slug, digest string
	var replace bool
	cmd := &cobra.Command{
		Use:   "install-skill AGENT_ID REVISION_ID",
		Short: "Install a pinned skill ZIP in an active embedded OpenClaw workspace",
		Args:  idArgs(agentIDArg, revisionIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			if len(slug) > 64 || !workspaceSkillSlug.MatchString(slug) {
				return fmt.Errorf("--slug must be at most 64 lowercase letters, digits, or separating hyphens")
			}
			want, err := hex.DecodeString(digest)
			if err != nil || len(want) != sha256.Size || hex.EncodeToString(want) != digest {
				return fmt.Errorf("--sha256 must be a 64-character lowercase hexadecimal digest")
			}
			archive, err := readSkillArchive(archivePath, digest)
			if err != nil {
				return err
			}
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			result, err := client.InstallWorkspaceSkill(namespace, args[0], args[1], slug, digest, archive, replace)
			if err != nil {
				var apiErr *occclient.APIError
				if !errors.As(err, &apiErr) || apiErr.Code == "UNKNOWN_OUTCOME" || apiErr.Status >= http.StatusInternalServerError {
					return fmt.Errorf("check installed skill provenance before retrying: %w", err)
				}
				return err
			}
			receipt, ok := result.(map[string]any)
			if !ok || receipt["agentId"] != args[0] || receipt["revisionId"] != args[1] || receipt["slug"] != slug || receipt["sha256"] != digest {
				return fmt.Errorf("OCC returned a mismatched installation receipt; check installed provenance before retrying")
			}
			return app.printItems(receipt, false, []column{{title: "AGENT", key: "agentId"}, {title: "REVISION", key: "revisionId"}, {title: "SKILL", key: "slug"}, {title: "SHA256", key: "sha256"}})
		},
	}
	cmd.Flags().StringVar(&archivePath, "archive", "", "Local skill ZIP file")
	cmd.Flags().StringVar(&slug, "slug", "", "Workspace skill slug")
	cmd.Flags().StringVar(&digest, "sha256", "", "Expected SHA-256 from the release manifest")
	cmd.Flags().BoolVar(&replace, "replace", false, "Replace an existing skill with the same slug")
	for _, name := range []string{"archive", "slug", "sha256"} {
		_ = cmd.MarkFlagRequired(name)
	}
	return cmd
}

func readSkillArchive(path, digest string) ([]byte, error) {
	metadata, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !metadata.Mode().IsRegular() || metadata.Size() < 1 || metadata.Size() > workspaceSkillMaxBytes {
		return nil, fmt.Errorf("skill archive must be a regular file between 1 byte and 40 MiB")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	bytes, err := io.ReadAll(io.LimitReader(f, workspaceSkillMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(bytes) == 0 || len(bytes) > workspaceSkillMaxBytes || fmt.Sprintf("%x", sha256.Sum256(bytes)) != digest {
		return nil, fmt.Errorf("skill archive does not match the expected size or SHA-256")
	}
	return bytes, nil
}

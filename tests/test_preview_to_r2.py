"""Tests for the org reusable preview-to-r2 workflow."""

from pathlib import Path
from unittest import TestCase, main

WORKFLOW_PATH = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "preview-to-r2.yml"


class PreviewWorkflowTests(TestCase):
    def setUp(self) -> None:
        self.text = WORKFLOW_PATH.read_text(encoding="utf-8")

    def test_uses_isolated_preview_prefix(self) -> None:
        self.assertIn("tenants/${TENANT_ID}/_preview/${PR_NUMBER}", self.text)
        self.assertIn("rclone sync", self.text)
        self.assertIn("rclone delete", self.text)

    def test_guards_against_fork_prs_and_cleans_up_on_close(self) -> None:
        self.assertIn("github.event.pull_request.head.repo.full_name == github.repository", self.text)
        self.assertIn("github.event.action != 'closed'", self.text)
        self.assertIn("github.event.action == 'closed'", self.text)

    def test_never_touches_live_d1(self) -> None:
        for forbidden in [
            "CLOUDFLARE_API_TOKEN",
            "CLOUDFLARE_ACCOUNT_ID",
            "api.cloudflare.com",
            "tenant_registry",
            "INSERT INTO",
        ]:
            self.assertNotIn(forbidden, self.text)


if __name__ == "__main__":
    main()

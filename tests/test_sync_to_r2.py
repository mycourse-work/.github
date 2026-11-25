"""Tests for the org reusable sync-to-r2 workflow's D1 course registration SQL."""

import json
from pathlib import Path
import re
import sqlite3
import subprocess
from unittest import TestCase, main

WORKFLOW_PATH = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "sync-to-r2.yml"

COURSES_SCHEMA = """
CREATE TABLE courses (
  id TEXT PRIMARY KEY,
  r2_base_path TEXT NOT NULL,
  r2_manifest_path TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  total_modules INTEGER DEFAULT 0,
  total_lessons INTEGER DEFAULT 0,
  total_quizzes INTEGER DEFAULT 0,
  cover_image TEXT,
  access_type TEXT NOT NULL DEFAULT 'public',
  access_sku TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  manifest_format TEXT DEFAULT 'monolithic',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


def extract_course_upsert_sql() -> str:
    content = WORKFLOW_PATH.read_text(encoding="utf-8")
    match = re.search(
        r'await d1\(dbId,\s*\n((?:\s*"[^"]+"\s*[+,]?\s*\n)+)\s*\[cid,',
        content,
    )
    if not match:
        raise AssertionError("Could not locate courses INSERT statement in sync-to-r2.yml")
    literals = re.findall(r'"([^"]*)"', match.group(1))
    return "".join(literals)


class SyncCourseDraftDefaultTests(TestCase):
    def setUp(self) -> None:
        self.conn = sqlite3.connect(":memory:")
        self.conn.executescript(COURSES_SCHEMA)
        self.sql = extract_course_upsert_sql()

    def tearDown(self) -> None:
        self.conn.close()

    def _upsert(self, course_id: str, title: str, modules: int = 1, lessons: int = 3, quizzes: int = 1) -> None:
        self.conn.execute(
            self.sql,
            (
                course_id,
                f"tenants/demo/courses/{course_id}",
                f"tenants/demo/courses/{course_id}/course.json",
                title,
                "Course description",
                modules,
                lessons,
                quizzes,
                None,
            ),
        )
        self.conn.commit()

    def _row(self, course_id: str) -> tuple[str, str, int, int, int]:
        row = self.conn.execute(
            "SELECT status, title, total_modules, total_lessons, total_quizzes FROM courses WHERE id = ?",
            (course_id,),
        ).fetchone()
        self.assertIsNotNone(row)
        return row

    def test_new_course_defaults_to_draft(self) -> None:
        self._upsert("new-course", "Brand New Course", modules=2, lessons=6, quizzes=2)
        status, title, mods, lessons, quizzes = self._row("new-course")
        self.assertEqual(status, "draft")
        self.assertEqual(title, "Brand New Course")
        self.assertEqual((mods, lessons, quizzes), (2, 6, 2))

    def test_existing_active_and_published_courses_keep_status_on_resync(self) -> None:
        for cid, initial_status in [
            ("live-active", "active"),
            ("live-published", "published"),
            ("old-archived", "archived"),
            ("still-draft", "draft"),
        ]:
            self.conn.execute(
                """
                INSERT INTO courses (id, r2_base_path, r2_manifest_path, title, status, manifest_format)
                VALUES (?, ?, ?, ?, ?, 'blueprint')
                """,
                (
                    cid,
                    f"tenants/demo/courses/{cid}",
                    f"tenants/demo/courses/{cid}/course.json",
                    "Original Title",
                    initial_status,
                ),
            )
        self.conn.commit()

        for cid, expected_status in [
            ("live-active", "active"),
            ("live-published", "published"),
            ("old-archived", "archived"),
            ("still-draft", "draft"),
        ]:
            self._upsert(cid, f"Updated {cid}", modules=4, lessons=10, quizzes=3)
            status, title, mods, lessons, quizzes = self._row(cid)
            self.assertEqual(status, expected_status, f"status changed for {cid}")
            self.assertEqual(title, f"Updated {cid}")
            self.assertEqual((mods, lessons, quizzes), (4, 10, 3))


class SyncWidgetReleaseTests(TestCase):
    def test_only_published_course_and_standalone_widgets_upload_and_register(self):
        workflow = WORKFLOW_PATH.read_text(encoding="utf-8")
        upload, register = workflow.split("- name: Register content in D1", 1)
        self.assertIn('[[ "$file" == widgets/* ]] && continue', upload)
        # Execute the real registration script with in-memory filesystem, D1,
        # and transfer doubles. The first course is already serving learners.
        script = register.split("node << 'REGISTER_SCRIPT'\n", 1)[1].split("\n          REGISTER_SCRIPT", 1)[0]
        harness = r"""
const vm = require('node:vm');
const { posix: path } = require('node:path');
const files = {
  'courses/live/course.json': '{"modules":["live-module"]}',
  'courses/draft/course.json': '{"modules":["draft-module"]}',
  'modules/live-module/manifest.json': '{"lessons":[{"markdownPath":"lesson.md"}]}',
  'modules/draft-module/manifest.json': '{"lessons":[{"markdownPath":"lesson.md"}]}',
  'modules/live-module/lesson.md': ':::widget live-widget\n:::\n',
  'modules/draft-module/lesson.md': ':::widget held-widget\n:::\n',
  'widgets/live-widget.html': '<p>Live</p>',
  'widgets/held-widget.html': '<p>Held</p>',
  'widgets/standalone.html': '<p>Standalone</p>',
  'widgets/unlinked.html': '<p>Unlinked</p>',
};
const fs = {
  readFileSync: key => files[key],
  existsSync: key => key in files,
  lstatSync: () => ({ isFile: () => true }),
  readdirSync: () => [],
};
const calls = [];
async function fetch(_url, {body}) {
  const {sql, params} = JSON.parse(body);
  let results = [];
  if (sql.includes('tenant_registry')) {
    results = [{ database_id: 'fixture', features: '{"standaloneWidgets":["standalone.html"]}' }];
  }
  if (sql.startsWith('INSERT INTO widgets')) calls.push(['register', params[3]]);
  return { ok: true, json: async () => ({ success: true, result: [{ results }] }) };
}
async function run(published) {
  calls.length = 0;
  await vm.runInNewContext(SCRIPT, {
    require: name => ({ fs, path, child_process: {
      execFileSync: (_cmd, _args, options) => calls.push(['upload', options.input.trim().split('\n')]),
    } }[name]),
    process: { env: { TENANT_ID: 'demo', CLOUDFLARE_ACCOUNT_ID: 'fixture',
      CLOUDFLARE_API_TOKEN: 'fixture', CONTENT_CHANGED: 'true' }, exit: code => { throw Error(code); } },
    fetch: (url, options) => query(published, url, options),
    console: { log() {}, error: console.error },
  });
  return calls.slice();
}
async function query(published, url, options) {
  const {sql} = JSON.parse(options.body);
  if (sql.includes("status IN ('active', 'published')")) {
    return { ok: true, json: async () => ({ success: true, result: [{ results: published.map(id => ({id})) }] }) };
  }
  return fetch(url, options);
}
(async () => console.log(JSON.stringify([await run(['live']), await run(['live', 'draft'])])))();
"""
        result = subprocess.run(
            ["node", "-"], input="const SCRIPT = " + json.dumps(script) + ";\n" + harness,
            text=True, capture_output=True, check=True,
        )
        before, after = json.loads(result.stdout)
        for calls, allowed in ((before, ["standalone", "live-widget"]), (after, ["standalone", "live-widget", "held-widget"])):
            paths = [f"widgets/{name}.html" for name in allowed]
            self.assertEqual(calls, [["upload", paths]] + [["register", path] for path in paths])


if __name__ == "__main__":
    main()

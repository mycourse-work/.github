"""Tests for the org reusable sync-to-r2 workflow's D1 course registration SQL."""

from pathlib import Path
import re
import sqlite3
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


if __name__ == "__main__":
    main()

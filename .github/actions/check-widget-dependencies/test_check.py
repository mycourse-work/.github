from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, main

from check import check_widgets, css_issues, html_issues, js_issues


class WidgetDependencyTests(TestCase):
    def test_rejects_remote_widget_resources_and_normalises_urls(self):
        markup = """<p>Risk matrix</p>
<script src="https://cdn.example/widget.js"></script>
<link rel="stylesheet" href="&#47;&#47;assets.example/widget.css">
<img srcset="local.png 1x, //images.example/photo.png 2x">
<style>@import "https://fonts.example/widget.css";</style>
<svg><use href="//assets.example/icons.svg#check"></use></svg>
"""
        self.assertEqual([line for line, _ in html_issues(markup)], [2, 3, 4, 5, 6])

    def test_checks_inline_scripts_modules_and_generated_resources(self):
        source = """const cdn = 'https://cdn.jsdelivr.net/npm/example';
import '//assets.example/widget.mjs';
const request = fetch('https://assets.example/config.json');
script.setAttribute('src', '//assets.example/widget.js');
new Worker("https:\\/\\/assets.example/worker.js");
"""
        self.assertEqual([line for line, _ in js_issues(source)], list(range(5)))
        self.assertEqual(html_issues('<script>import("//assets.example/widget.js")</script>')[0][0], 1)

    def test_allows_local_resources_and_ordinary_references(self):
        markup = """<img src="/branding/logo.png" alt="Tenant">
<link rel="stylesheet" href="./widget.css">
<script src="./widget.js"></script>
<a href="https://www.aviation.govt.nz/rules/">Rules</a>
<style>
/* Example: url(https://fonts.example/widget.css) */
body { background: url(data:image/svg+xml,icon); }
</style>
<script>
const namespace = 'http://www.w3.org/2000/svg';
const citation = 'https://creativecommons.org/licenses/by/4.0/';
</script>
"""
        self.assertEqual(html_issues(markup), [])
        self.assertEqual(list(css_issues(".card { background: url(./photo.png); }")), [])

    def test_checks_only_widget_files_and_handles_a_missing_directory(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "lesson.md").write_text("[Reference](https://cdn.example/resource)")
            self.assertEqual(check_widgets(root / "absent"), [])
            (root / "widget.js").write_text('fetch("https://assets.example/config.json")')
            self.assertEqual(check_widgets(root), [(Path("widget.js"), 1, "JavaScript refers to a remote dependency")])


if __name__ == "__main__":
    main()

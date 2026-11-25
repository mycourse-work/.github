"""Reject external resources in the checked-out widgets tree."""

import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit


NETWORK_PREFIX = r"(?:https?:|wss?:|ftp:)?//"
NETWORK_URL = re.compile(rf"^{NETWORK_PREFIX}", re.I)
MULTI_URL = re.compile(rf"(?:^|[\s,]){NETWORK_PREFIX}", re.I)
CSS_RESOURCE = re.compile(r"""@import\b\s*(?:url\(\s*)?|url\(\s*""", re.I)
LITERAL_URL = re.compile(rf"""["'`]({NETWORK_PREFIX}[^"'\x60\s<>]+)""", re.I)
JS_LOADER = re.compile(
    r"""(?:\b(?:import|fetch|importScripts|Worker|SharedWorker|WebSocket|EventSource)\s*\(\s*"""
    r"""|\b(?:import|from)\s+(?=["'\x60])|\.src\s*=\s*)["'\x60]""",
    re.I,
)
JS_ATTRIBUTE = re.compile(r"""\.setAttribute\s*\(\s*["'](?:src|href)["']\s*,\s*["'\x60]""", re.I)
CDN_HOSTS = ("cdn.jsdelivr.net", "jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com",
             "cdn.skypack.dev", "esm.sh", "fonts.googleapis.com", "fonts.gstatic.com")
RESOURCE_HREF = {"image", "use", "feimage", "link"}
ASSET_SUFFIXES = {".html", ".htm", ".svg", ".css", ".js", ".mjs", ".cjs"}


def remote(value):
    # Browsers remove tabs and line breaks in URLs and accept backslash as a slash
    # for HTTP URLs. HTMLParser decodes HTML entities before calling us.
    normalized = value.strip().replace("\\", "/").translate({9: None, 10: None, 13: None})
    return bool(NETWORK_URL.match(normalized))


def css_issues(source):
    source = re.sub(r"/\*[\s\S]*?\*/", lambda match: "\n" * match[0].count("\n"), source)
    for match in CSS_RESOURCE.finditer(source):
        if remote(source[match.end():].lstrip().lstrip("\"'")):
            yield source.count("\n", 0, match.start()), "CSS loads an external resource"


def js_issues(source):
    # Static literals cover CDN imports, direct requests and CDN constants used
    # later by a loader. The offline sandbox enforces the runtime network policy.
    source = source.replace(r"\/", "/")
    dependencies = set()
    for pattern in (JS_LOADER, JS_ATTRIBUTE):
        for match in pattern.finditer(source):
            if remote(source[match.end():]):
                dependencies.add(source.count("\n", 0, match.start()))
    for match in LITERAL_URL.finditer(source):
        url = match[1]
        try:
            hostname = urlsplit(url).hostname or ""
        except ValueError:
            continue
        if any(hostname == cdn or hostname.endswith("." + cdn) for cdn in CDN_HOSTS):
            dependencies.add(source.count("\n", 0, match.start()))
    for line in sorted(dependencies):
        yield line, "JavaScript refers to a remote dependency"


class WidgetParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.issues = []
        self.body = None

    def handle_starttag(self, tag, attrs):
        line, _ = self.getpos()
        for name, value in attrs:
            if not value:
                continue
            if name == "style":
                self.issues.extend((line + offset, reason) for offset, reason in css_issues(value))
            elif name.startswith("on"):
                self.issues.extend((line + offset, reason) for offset, reason in js_issues(value))
            elif name == "srcset":
                if MULTI_URL.search(value):
                    self.issues.append((line, "srcset loads an external resource"))
            elif (name in {"src", "poster", "action", "formaction"}
                  or name in {"href", "xlink:href"} and tag in RESOURCE_HREF
                  or name == "data" and tag == "object") and remote(value):
                self.issues.append((line, f"<{tag}> {name} loads an external resource"))
            elif name == "srcdoc":
                self.issues.extend((line + offset - 1, reason) for offset, reason in html_issues(value))
        if tag in {"script", "style"}:
            self.body = tag

    def handle_endtag(self, tag):
        if tag == self.body:
            self.body = None

    def handle_data(self, data):
        line, _ = self.getpos()
        if self.body == "style":
            self.issues.extend((line + offset, reason) for offset, reason in css_issues(data))
        elif self.body == "script":
            self.issues.extend((line + offset, reason) for offset, reason in js_issues(data))


def html_issues(source):
    parser = WidgetParser()
    parser.feed(source)
    parser.close()
    return parser.issues


def check_widgets(root):
    issues = []
    if root.exists() and not root.is_dir():
        raise ValueError("The widgets path must be a directory.")
    for path in sorted(root.rglob("*")):
        suffix = path.suffix.lower()
        if not path.is_file() or suffix not in ASSET_SUFFIXES:
            continue
        source = path.read_text(encoding="utf-8")
        if suffix in {".html", ".htm", ".svg"}:
            violations = html_issues(source)
        else:
            scan = css_issues if suffix == ".css" else js_issues
            violations = ((offset + 1, reason) for offset, reason in scan(source))
        issues.extend((path.relative_to(root), line, reason) for line, reason in violations)
    return issues


if __name__ == "__main__":
    issues = check_widgets(Path(sys.argv[1]))
    for path, line, reason in issues:
        label = ascii((Path("widgets") / path).as_posix())[1:-1]
        print(f"{label}:{line}: {reason}", file=sys.stderr)
    if issues:
        print("Widget deployment blocked. Bundle dependencies locally before publishing.", file=sys.stderr)
        sys.exit(1)
    print("Widget dependency check passed.")

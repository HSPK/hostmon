from __future__ import annotations

import json
import re
import tomllib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DOCS = [
    ROOT / "README.md",
    ROOT / "RELEASING.md",
    ROOT / "docs" / "alerts.md",
    ROOT / "docs" / "plugins.md",
    ROOT / "examples" / "thermal-plugin" / "README.md",
]
FENCE_RE = re.compile(r"```(?P<language>\w+)\n(?P<body>.*?)```", re.DOTALL)
LINK_RE = re.compile(r"\[[^\]]+\]\((?!https?://|#)([^)]+)\)")
CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")


class DocumentationTests(unittest.TestCase):
    def test_public_documentation_is_english(self):
        for path in DOCS:
            with self.subTest(path=path):
                self.assertIsNone(CJK_RE.search(path.read_text(encoding="utf-8")))

    def test_toml_and_json_examples_parse(self):
        for path in DOCS:
            text = path.read_text(encoding="utf-8")
            for index, match in enumerate(FENCE_RE.finditer(text), start=1):
                language = match.group("language")
                body = match.group("body")
                with self.subTest(path=path, block=index, language=language):
                    if language == "toml":
                        tomllib.loads(body)
                    elif language == "json":
                        json.loads(body)

    def test_local_markdown_links_exist(self):
        for path in DOCS:
            text = path.read_text(encoding="utf-8")
            for target in LINK_RE.findall(text):
                resolved = (path.parent / target.split("#", 1)[0]).resolve()
                with self.subTest(path=path, target=target):
                    self.assertTrue(resolved.exists(), resolved)


if __name__ == "__main__":
    unittest.main()

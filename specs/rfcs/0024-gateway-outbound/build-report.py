#!/usr/bin/env python3
"""Build the Gateway outbound reading report with installed Pandoc and Typst."""

import argparse
import hashlib
import re
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPOSITORY = ROOT.parents[2]
CHAPTERS = ("index.md", "report.md", "sources.md")
BASE_SHA = "5dae426ec5c591b43609a4b50c154016e2c5483c"
BASE_URL = f"https://github.com/openclaw/openclaw-enterprise/blob/{BASE_SHA}/"
CREATION_TIMESTAMP = "1793145600"


def anchor(title):
    return re.sub(r"[^\w\s-]", "", title.lower()).replace(" ", "-")


def assemble():
    anchors = {}
    for chapter in CHAPTERS:
        title = re.search(r"^# (.+)$", (ROOT / chapter).read_text(), re.MULTILINE)
        anchors[chapter] = anchor(title.group(1))

    def link(match):
        label, target = match.groups()
        if target.startswith(("https://", "http://", "#", "mailto:")):
            return match.group(0)
        filename, separator, fragment = target.partition("#")
        if filename in anchors:
            destination = fragment if separator else anchors[filename]
            return f"{label}(#{destination})"
        if label.startswith("!"):
            return f"{label}({Path(filename).with_suffix('.png').as_posix()})"
        relative = (ROOT / filename).resolve().relative_to(REPOSITORY)
        return f"{label}({BASE_URL}{relative.as_posix()}{separator}{fragment})"

    sections = []
    for chapter in CHAPTERS:
        content = (ROOT / chapter).read_text()
        content = re.sub(r"\A---\n.*?\n---\n", "", content, flags=re.DOTALL)
        content = re.sub(
            r"<!-- report:omit:start -->.*?<!-- report:omit:end -->",
            "",
            content,
            flags=re.DOTALL,
        )
        content = re.sub(r"(!?\[[^\]]+\])\(([^)]+)\)", link, content)
        sections.append(content.strip())
    page_break = "\n\n```{=typst}\n#pagebreak()\n```\n\n"
    return page_break.join(sections) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--render-diagram", action="store_true")
    args = parser.parse_args()
    if args.render_diagram:
        source = ROOT / "assets/architecture.mmd"
        for suffix in (".svg", ".png"):
            subprocess.run(
                [
                    "mmdc", "--input", str(source),
                    "--output", str(source.with_suffix(suffix)),
                    "--backgroundColor", "transparent", "--width", "1440",
                ],
                check=True,
            )
    output = ROOT / "architecture-report.pdf"
    with tempfile.TemporaryDirectory(prefix=".report-", dir=ROOT) as temporary:
        source = Path(temporary) / "report.md"
        source.write_text(assemble())
        subprocess.run(
            [
                "pandoc", str(source), "--from=markdown", "--standalone",
                "--pdf-engine=typst", f"--pdf-engine-opt=--root={ROOT}",
                f"--pdf-engine-opt=--creation-timestamp={CREATION_TIMESTAMP}",
                "--template", str(ROOT / "report-template.typ"),
                "--lua-filter", str(ROOT / "report-tables.lua"),
                "--metadata=title:Gateway outbound destination control",
                "--metadata=subtitle:Architecture, interfaces, and delivery requirements",
                "--output", str(output),
            ],
            check=True,
            cwd=ROOT,
        )
    files = [ROOT / chapter for chapter in CHAPTERS]
    files.extend(ROOT / name for name in (
        "build-report.py", "report-template.typ", "report-tables.lua", "architecture-report.pdf",
    ))
    files.extend(path for path in (ROOT / "assets").iterdir() if path.is_file())
    manifest = "".join(
        f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(ROOT).as_posix()}\n"
        for path in sorted(files)
    )
    (ROOT / "SHA256SUMS").write_text(manifest)
    print(f"{hashlib.sha256(output.read_bytes()).hexdigest()}  {output.name}")


if __name__ == "__main__":
    main()

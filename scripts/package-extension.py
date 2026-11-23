#!/usr/bin/env python3
"""Build and package the WXT Chrome extension."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD_DIR = ROOT / ".output" / "chrome-mv3"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="ZIP destination (default: dist/keji-vVERSION.zip)")
    args = parser.parse_args()

    try:
        subprocess.run(["npm", "run", "build"], cwd=ROOT, check=True)
        manifest_path = BUILD_DIR / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("manifest_version") != 3:
            raise ValueError("WXT output must use Manifest V3.")
        version = manifest.get("version")
        if not isinstance(version, str) or not version.strip():
            raise ValueError("Built manifest must define a non-empty version.")

        output = args.output or ROOT / "dist" / f"keji-v{version}.zip"
        output = output if output.is_absolute() else ROOT / output
        output = output.resolve()
        if ROOT not in output.parents:
            raise ValueError("Output must be inside the repository.")
        if output.suffix.lower() != ".zip":
            raise ValueError("Output path must end in .zip.")

        files = sorted(path for path in BUILD_DIR.rglob("*") if path.is_file())
        if not files:
            raise FileNotFoundError(f"No built extension files found in {BUILD_DIR}.")
        output.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for path in files:
                archive.write(path, path.relative_to(BUILD_DIR).as_posix())

        with zipfile.ZipFile(output) as archive:
            bad_member = archive.testzip()
            if bad_member:
                raise zipfile.BadZipFile(f"Corrupt ZIP member: {bad_member}")
            if "manifest.json" not in archive.namelist():
                raise zipfile.BadZipFile("manifest.json is missing from the archive root")

        print(f"Packaged {len(files)} files: {output}")
        return 0
    except (OSError, ValueError, json.JSONDecodeError, subprocess.CalledProcessError, zipfile.BadZipFile) as error:
        print(f"Package failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

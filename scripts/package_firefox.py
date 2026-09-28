"""Prepare and package the extension as an XPI for Firefox/AMO submission."""
import argparse
import json
import os
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from prepare_extension import prepare  # noqa: E402


STATIC_FILES = (
    "manifest.json",
    "content.js",
    "page-hook.js",
    "background.js",
    "background-core.mjs",
    "quiz-core.mjs",
    "styles.css",
    "lookup.mjs",
)


def package(output=None):
    summary = prepare()
    extension = ROOT / "extension"
    manifest = json.loads((extension / "manifest.json").read_text(encoding="utf-8"))
    gecko = manifest.get("browser_specific_settings", {}).get("gecko", {})
    if not gecko.get("id") or "gecko_android" not in manifest.get("browser_specific_settings", {}):
        raise ValueError("Firefox ID and Android compatibility metadata are required")

    db_manifest = json.loads((extension / "db" / "manifest.json").read_text(encoding="utf-8"))
    # Firefox uses event pages for MV3; Chrome uses a service worker and ignores
    # this Firefox package-specific background declaration.
    packaged_manifest = {**manifest, "background": {"scripts": ["background.js"]}}
    assets = [f"db/{db_manifest['stocksFile']}"]
    assets.extend(f"db/{entry['file']}" for entry in db_manifest["files"])
    files = sorted(set(STATIC_FILES) | {"db/manifest.json"} | set(assets))
    for relative in files:
        path = extension / relative
        if not path.is_file():
            raise FileNotFoundError(path)

    output = Path(output) if output else ROOT / "dist" / f"scalp-quiz-lookup-{manifest['version']}.xpi"
    if not output.is_absolute():
        output = ROOT / output
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".tmp")
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for relative in files:
                if relative == "manifest.json":
                    archive.writestr(relative, json.dumps(packaged_manifest, ensure_ascii=False, indent=2) + "\n")
                else:
                    archive.write(extension / relative, relative)
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)

    with zipfile.ZipFile(output) as archive:
        names = set(archive.namelist())
        if names != set(files):
            output.unlink(missing_ok=True)
            raise ValueError("XPI contains missing or unexpected files")
        damaged = archive.testzip()
        if damaged is not None:
            output.unlink(missing_ok=True)
            raise ValueError(f"XPI CRC check failed: {damaged}")
        actual_manifest = json.loads(archive.read("manifest.json"))
        if actual_manifest != packaged_manifest:
            output.unlink(missing_ok=True)
            raise ValueError("Packaged manifest mismatch")

    return {"output": str(output), "bytes": output.stat().st_size,
            "fileCount": len(files), "dbBytes": summary["dbBytes"],
            "firefoxId": gecko["id"], "androidMinVersion":
                manifest["browser_specific_settings"]["gecko_android"].get("strict_min_version", gecko.get("strict_min_version"))}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", help="XPI output path (default: dist/scalp-quiz-lookup-<version>.xpi)")
    args = parser.parse_args()
    print(json.dumps(package(args.out), ensure_ascii=False))

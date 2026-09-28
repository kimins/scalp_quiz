"""Copy only the current, verified lookup assets into the unpacked extension."""
import hashlib
import json
import os
import re
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def safe_file(name, pattern):
    if not isinstance(name, str) or not re.fullmatch(pattern, name) or Path(name).name != name:
        raise ValueError(f"Unexpected manifest filename: {name!r}")
    return name


def copy_atomic(source, destination):
    temporary = destination.with_name(destination.name + ".tmp")
    try:
        shutil.copyfile(source, temporary)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def prepare(source=ROOT / "data" / "lookup", extension=ROOT / "extension"):
    source = Path(source)
    extension = Path(extension)
    manifest_bytes = (source / "manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    files = manifest.get("files")
    if manifest.get("version") != 1 or manifest.get("windows") != [3] or not isinstance(files, list) or len(files) != 1:
        raise ValueError("This extension expects a single window=3 lookup DB")

    stock_name = safe_file(manifest.get("stocksFile"), r"stocks-[0-9a-f]{16}\.json")
    expected = {stock_name: (manifest.get("stocksSha256"), None)}
    entry = files[0]
    bin_name = safe_file(entry.get("file"), r"w3-[0-9a-f]{16}\.bin")
    if entry.get("window") != 3 or not isinstance(entry.get("bytes"), int):
        raise ValueError("Invalid window=3 manifest entry")
    expected[bin_name] = (entry.get("sha256"), entry["bytes"])

    for name, (checksum, length) in expected.items():
        if not isinstance(checksum, str) or not re.fullmatch(r"[0-9a-f]{64}", checksum):
            raise ValueError(f"Missing SHA-256 for {name}")
        if checksum[:16] not in name:
            raise ValueError(f"Content-addressed name mismatch: {name}")
        path = source / name
        if not path.is_file() or (length is not None and path.stat().st_size != length) or digest(path) != checksum:
            raise ValueError(f"Missing or damaged lookup asset: {name}")

    destination = extension / "db"
    destination.mkdir(parents=True, exist_ok=True)
    for name in expected:
        copy_atomic(source / name, destination / name)
    lookup_source = ROOT / "web" / "lookup.mjs"
    copy_atomic(lookup_source, extension / "lookup.mjs")
    if digest(extension / "lookup.mjs") != digest(lookup_source):
        raise ValueError("Copied lookup module checksum mismatch")
    # Publish the manifest only after every referenced file is present.
    temporary = destination / "manifest.json.tmp"
    temporary.write_bytes(manifest_bytes)
    os.replace(temporary, destination / "manifest.json")

    keep = {"manifest.json", *expected}
    for path in destination.iterdir():
        if not path.is_file():
            raise ValueError(f"Unexpected directory in generated DB: {path.name}")
        if path.name not in keep:
            path.unlink()
    return {"windows": [3], "records": entry["records"], "files": sorted(keep),
            "dbBytes": sum((destination / name).stat().st_size for name in keep),
            "lookupBytes": (extension / "lookup.mjs").stat().st_size}


if __name__ == "__main__":
    print(json.dumps(prepare(), ensure_ascii=False))

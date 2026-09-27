import hashlib
import sqlite3
import tempfile
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from .core import (HEADER, MAGIC, RECORD, atomic_write, json_bytes, read_json,
                   records_for, validate_rows, tradable)
from .sources import (KIND_URL, NAVER_URL, completed_day, download, parse_kind,
                      parse_naver, stocks_csv)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def collect(args):
    cache = Path(args.cache)
    cache.mkdir(parents=True, exist_ok=True)
    cutoff = completed_day()
    effective_end = min(args.end, cutoff)
    if args.start > effective_end:
        raise ValueError("No completed dates in requested range")
    if args.symbols:
        stocks = stocks_csv(args.symbols)
        universe_source = "user CSV"
    else:
        listing = cache / "universe.json"
        if args.refresh or not listing.exists() or read_json(listing)["asOf"] != cutoff:
            stocks = parse_kind(download(KIND_URL, delay=args.delay))
            atomic_write(listing, json_bytes({"asOf": cutoff, "stocks": stocks}))
        stocks = read_json(listing)["stocks"]
        universe_source = KIND_URL
    if args.codes:
        wanted = set(args.codes.split(","))
        missing = wanted - {s["code"] for s in stocks}
        if missing:
            raise ValueError(f"Codes absent from universe; use --symbols CSV: {sorted(missing)}")
        stocks = [s for s in stocks if s["code"] in wanted]
    registry_path = cache / "stock-registry.json"
    registry = read_json(registry_path) if registry_path.exists() else []
    by_code = {s["code"]: s for s in registry}
    for stock in stocks:
        if stock["code"] not in by_code:
            entry = dict(stock, stockId=len(registry))
            registry.append(entry)
            by_code[stock["code"]] = entry
        else:
            by_code[stock["code"]]["name"] = stock["name"]
    if len(registry) > 65536:
        raise ValueError("stockId exceeds uint16")
    atomic_write(registry_path, json_bytes(registry))
    report = {"version": 1, "requestedStart": args.start, "requestedEnd": args.end,
              "effectiveEnd": effective_end, "completedCutoff": cutoff,
              "universeSource": universe_source, "complete": False,
              "expectedCodes": [s["code"] for s in stocks], "stocks": [], "failures": []}
    atomic_write(cache / "collection.json", json_bytes(report))
    for i, stock in enumerate(stocks, 1):
        code = stock["code"]
        path = cache / "bars" / f"{code}.json"
        try:
            cached = read_json(path) if path.exists() and not args.refresh else None
            reuse = (cached and cached.get("version") == 1 and cached.get("code") == code
                     and cached.get("cutoff") == cutoff and cached.get("count") == args.count)
            if reuse:
                validate_rows(cached["rows"])
                if sha(json_bytes(cached["rows"])) != cached["rowsSha256"]:
                    raise ValueError("Cache checksum mismatch; rerun with --refresh")
                payload = cached
            else:
                url = NAVER_URL.format(code=code, count=args.count)
                rows, source_name = parse_naver(download(url, delay=args.delay), code)
                payload = {"version": 1, "code": code, "source": url,
                           "sourceName": source_name, "cutoff": cutoff, "count": args.count,
                           "fetchedAt": datetime.now(timezone.utc).isoformat(),
                           "rawCount": len(rows), "rows": [r for r in rows if r[0] <= cutoff]}
                payload["rowsSha256"] = sha(json_bytes(payload["rows"]))
                atomic_write(path, json_bytes(payload))
            rows = payload["rows"]
            if not rows:
                raise ValueError("No completed bars")
            if payload["rawCount"] >= min(args.count, 3000) and rows[0][0] > args.start:
                raise ValueError("History truncated before start; increase --count")
            report["stocks"].append({**by_code[code], "cache": f"bars/{code}.json",
                                     "rowsSha256": payload["rowsSha256"],
                                     "first": rows[0][0], "last": rows[-1][0], "rows": len(rows),
                                     "ineligibleBars": sum(not tradable(r) for r in rows)})
            print(f"[{i}/{len(stocks)}] {code} {'cached' if reuse else 'downloaded'} {len(rows)} rows", flush=True)
        except Exception as exc:
            # Continue other symbols and persist an explicit failure list for resume.
            report["failures"].append({"code": code, "error": str(exc)})
            print(f"[{i}/{len(stocks)}] {code} FAILED: {exc}", flush=True)
        atomic_write(cache / "collection.json", json_bytes(report))
    report["complete"] = True
    atomic_write(cache / "collection.json", json_bytes(report))
    return report


def load_rows(cache, stock):
    payload = read_json(Path(cache) / stock["cache"])
    rows = validate_rows(payload["rows"])
    if payload["code"] != stock["code"] or sha(json_bytes(rows)) != stock["rowsSha256"]:
        raise ValueError(f"Cache changed/corrupt for {stock['code']}; collect again")
    return rows


def build(args):
    report = read_json(Path(args.cache) / "collection.json")
    if not report.get("complete"):
        raise ValueError("Collection interrupted; resume collect before building")
    if report["failures"] and not args.allow_partial:
        raise ValueError("Collection has failures; retry collect or explicitly use --allow-partial")
    if not report["stocks"]:
        raise ValueError("No successful stocks")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    windows = sorted(set(args.windows))
    manifest = {"version": 1, "fingerprint": "sha256-first8", "recordBytes": RECORD.size,
                "dateEpoch": "2020-01-01", "returnUnit": "basis points (0.01%)",
                "rounding": "half away from zero", "priceMode": "naver-as-served",
                "requestedStart": report["requestedStart"], "requestedEnd": report["requestedEnd"],
                "effectiveEnd": report["effectiveEnd"], "universeSource": report["universeSource"],
                "failedStocks": report["failures"], "files": [],
                "coverage": report["stocks"], "windows": windows}
    stock_data = json_bytes([{k: s[k] for k in ("stockId", "code", "name")} for s in report["stocks"]])
    stock_file = f"stocks-{sha(stock_data)[:16]}.json"
    atomic_write(out / stock_file, stock_data)
    manifest["stocksFile"] = stock_file
    manifest["stocksSha256"] = sha(stock_data)
    # SQLite handles external sorting: memory does not grow with market size.
    with tempfile.TemporaryDirectory(prefix="scalp-build-") as temp:
        with closing(sqlite3.connect(str(Path(temp) / "sort.sqlite"))) as db:
            db.execute("PRAGMA temp_store=FILE")
            db.execute("CREATE TABLE records (digest BLOB, sid INTEGER, day INTEGER, next INTEGER, bps INTEGER)")
            for window in windows:
                db.execute("DELETE FROM records")
                for stock in report["stocks"]:
                    rows = load_rows(args.cache, stock)
                    db.executemany("INSERT INTO records VALUES (?,?,?,?,?)", records_for(
                        rows, stock["stockId"], window, report["requestedStart"], report["effectiveEnd"]))
                db.commit()
                count = db.execute("SELECT COUNT(*) FROM records").fetchone()[0]
                if not count:
                    raise ValueError(f"No eligible {window}-bar records")
                temp_file = Path(temp) / f"w{window}.bin"
                digest = hashlib.sha256()
                previous = None
                duplicates = 0
                with temp_file.open("wb") as handle:
                    header = HEADER.pack(MAGIC, 1, window, RECORD.size, count)
                    handle.write(header)
                    digest.update(header)
                    for record in db.execute("SELECT * FROM records ORDER BY digest,sid,day,next,bps"):
                        if record[0] == previous:
                            duplicates += 1
                        previous = record[0]
                        packed = RECORD.pack(*record)
                        handle.write(packed)
                        digest.update(packed)
                checksum = digest.hexdigest()
                filename = f"w{window}-{checksum[:16]}.bin"
                # Atomic per file, then commit manifest last; old manifest remains usable on failure.
                import shutil
                shutil.copyfile(temp_file, out / (filename + ".tmp"))
                (out / (filename + ".tmp")).replace(out / filename)
                manifest["files"].append({"window": window, "file": filename, "records": count,
                                          "bytes": HEADER.size + count * RECORD.size,
                                          "sha256": checksum, "duplicateKeys": duplicates})
                print(f"window={window} records={count} bytes={HEADER.size + count * RECORD.size}", flush=True)
    atomic_write(out / "manifest.json", json_bytes(manifest))
    return manifest


def find_records(data, key):
    count = (len(data) - HEADER.size) // RECORD.size
    lo, hi = 0, count
    while lo < hi:
        mid = (lo + hi) // 2
        pos = HEADER.size + mid * RECORD.size
        if data[pos:pos + 8] < key:
            lo = mid + 1
        else:
            hi = mid
    result = []
    while lo < count:
        record = RECORD.unpack_from(data, HEADER.size + lo * RECORD.size)
        if record[0] != key:
            break
        result.append(record)
        lo += 1
    return result


def verify(args):
    out = Path(args.out)
    manifest = read_json(out / "manifest.json")
    if manifest["version"] != 1 or manifest["recordBytes"] != RECORD.size:
        raise ValueError("Unsupported manifest")
    stock_data = (out / manifest["stocksFile"]).read_bytes()
    if sha(stock_data) != manifest["stocksSha256"]:
        raise ValueError("Stocks checksum mismatch")
    stocks = read_json(out / manifest["stocksFile"])
    ids = {s["stockId"] for s in stocks}
    if len(ids) != len(stocks) or len({s["code"] for s in stocks}) != len(stocks):
        raise ValueError("Duplicate stocks")
    if [f["window"] for f in manifest["files"]] != manifest["windows"]:
        raise ValueError("Window list mismatch")
    checked = 0
    for file in manifest["files"]:
        data = (out / file["file"]).read_bytes()
        if len(data) != file["bytes"] or sha(data) != file["sha256"]:
            raise ValueError(f"Checksum/length mismatch: {file['file']}")
        header = HEADER.unpack_from(data)
        expected = (MAGIC, 1, file["window"], RECORD.size, file["records"])
        if header != expected or len(data) != HEADER.size + file["records"] * RECORD.size:
            raise ValueError("Invalid binary header")
        previous = None
        for record in RECORD.iter_unpack(data[HEADER.size:]):
            if (previous is not None and record <= previous) or record[1] not in ids or record[2] >= record[3]:
                raise ValueError("Invalid order, duplicate record, stockId or next date")
            previous = record
        if args.cache:
            expected_count = 0
            for stock in manifest["coverage"]:
                rows = load_rows(args.cache, stock)
                for record in records_for(rows, stock["stockId"], file["window"],
                                          manifest["requestedStart"], manifest["effectiveEnd"]):
                    if record not in find_records(data, record[0]):
                        raise ValueError(f"Source mismatch: {stock['code']}")
                    expected_count += 1
            if expected_count != file["records"]:
                raise ValueError("Source record count mismatch")
        checked += file["records"]
    return {"verifiedRecords": checked, "stocks": len(stocks), "sourceVerified": bool(args.cache)}

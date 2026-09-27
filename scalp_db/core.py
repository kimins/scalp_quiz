"""Version 1 wire format, shared by the builder and verifier."""
import hashlib
import json
import os
import re
import struct
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

EPOCH = date(2020, 1, 1)
MAGIC = b"SCALPDB1"
HEADER = struct.Struct("<8sBBHI")
RECORD = struct.Struct("<8sHHHi")  # digest, stockId, last day, next day, basis points


def atomic_write(path, content):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_bytes(content)
    os.replace(temp, path)


def json_bytes(obj):
    return (json.dumps(obj, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def validate_rows(rows):
    """Keep zero/suspension bars as barriers; never silently bridge bad bars."""
    previous = ""
    for row in rows:
        if len(row) != 6 or not isinstance(row[0], str):
            raise ValueError("Expected [YYYY-MM-DD, open, high, low, close, volume]")
        day = row[0]
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
            raise ValueError(f"Invalid date: {day}")
        date.fromisoformat(day)
        if day <= previous:
            raise ValueError("Dates must be unique and strictly ascending")
        previous = day
        if any(type(x) is not int or x < 0 or x > 2**53 - 1 for x in row[1:]):
            raise ValueError(f"OHLCV must be nonnegative safe integers: {day}")
    return rows


def tradable(row):
    _, o, h, low, c, v = row
    return min(o, h, low, c, v) > 0 and low <= min(o, c) <= max(o, c) <= h


def canonical(rows):
    validate_rows(rows)
    if len(rows) not in (3, 4, 5) or not all(map(tradable, rows)):
        raise ValueError("Fingerprint requires 3, 4 or 5 positive OHLCV bars")
    return (f"scalp-v1|{len(rows)}\n" + "\n".join("|".join(map(str, r)) for r in rows) + "\n").encode("ascii")


def fingerprint(rows):
    return hashlib.sha256(canonical(rows)).digest()[:8]


def day_number(day):
    n = (date.fromisoformat(day) - EPOCH).days
    if not 0 <= n <= 65535:
        raise ValueError("Date outside binary format range")
    return n


def return_bps(close, next_close):
    return int((Decimal(next_close - close) * 10000 / Decimal(close)).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def records_for(rows, stock_id, window, start, end):
    validate_rows(rows)
    for i in range(window - 1, len(rows) - 1):
        tail = rows[i - window + 1:i + 1]
        following = rows[i + 1]
        if not start <= rows[i][0] <= end:
            continue
        if not all(map(tradable, tail + [following])):
            continue
        yield (fingerprint(tail), stock_id, day_number(rows[i][0]),
               day_number(following[0]), return_bps(rows[i][4], following[4]))

import argparse
import json
import sys
from datetime import date

from .pipeline import build, collect, verify


def iso_date(value):
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("Use a valid YYYY-MM-DD date") from exc
    if parsed.isoformat() != value:
        raise argparse.ArgumentTypeError("Use YYYY-MM-DD")
    return value


def main():
    parser = argparse.ArgumentParser(description="KRX daily-bar compact lookup builder (no API keys)")
    commands = parser.add_subparsers(dest="command", required=True)
    c = commands.add_parser("collect", help="Download current KIND universe and Naver bars")
    c.add_argument("--cache", default="cache")
    c.add_argument("--start", type=iso_date, default="2023-01-01")
    c.add_argument("--end", type=iso_date, default="2026-12-31")
    c.add_argument("--symbols", help="UTF-8 CSV with code,name columns (replaces KIND universe)")
    c.add_argument("--codes", help="Comma-separated subset of universe")
    c.add_argument("--refresh", action="store_true")
    c.add_argument("--count", type=int, default=3000)
    c.add_argument("--delay", type=float, default=0.4)
    b = commands.add_parser("build", help="Build content-addressed binary files and manifest")
    b.add_argument("--cache", default="cache")
    b.add_argument("--out", default="data/lookup")
    b.add_argument("--windows", type=int, choices=[3, 4, 5], nargs="+", default=[3])
    b.add_argument("--allow-partial", action="store_true")
    v = commands.add_parser("verify", help="Verify integrity and optionally recompute every source record")
    v.add_argument("--out", default="data/lookup")
    v.add_argument("--cache", help="Source cache for full semantic verification")
    args = parser.parse_args()
    try:
        if args.command == "collect":
            if args.start > args.end or args.count < 6 or args.delay < 0:
                raise ValueError("Invalid range, count (<6) or delay (<0)")
            result = collect(args)
            print(json.dumps({"successful": len(result["stocks"]), "failures": result["failures"]}, ensure_ascii=False))
            if result["failures"]:
                sys.exit(1)
        else:
            result = build(args) if args.command == "build" else verify(args)
            print(json.dumps(result if args.command == "verify" else {"files": result["files"]}, ensure_ascii=False))
    except (ValueError, OSError, KeyError) as exc:
        parser.exit(1, f"Error: {exc}\n")

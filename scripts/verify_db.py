"""Convenience wrapper; also available as python -m scalp_db verify."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scalp_db.cli import main

sys.argv.insert(1, "verify")
main()

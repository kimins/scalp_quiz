"""Integration regression using the local full-market cache and generated lookup DB."""
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class QuizHarRegressionTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node.js is required for browser lookup")
    @unittest.skipUnless((ROOT / "cache/collection.json").is_file()
                         and (ROOT / "data/lookup/manifest.json").is_file(),
                         "Full-market cache and DB are required")
    def test_real_quiz_cases_in_browser_lookup(self):
        result = subprocess.run(
            ["node", "scripts/check_har_regression.mjs", "data/lookup", "cache"],
            cwd=ROOT, capture_output=True, text=True, encoding="utf-8", check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()

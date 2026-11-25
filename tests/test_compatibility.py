"""Неподдерживаемый Python должен давать понятную ошибку до загрузки игры."""
from pathlib import Path
import subprocess
import sys
import unittest


class CompatibilityTests(unittest.TestCase):
    def test_old_python_stops_before_importing_dependencies(self):
        result = subprocess.run(
            [sys.executable, "-c",
             "import runpy, sys; sys.version_info = (3, 8, 0); "
             "runpy.run_path('app.py', run_name='__main__')"],
            cwd=str(Path(__file__).resolve().parents[1]),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            encoding="utf-8", errors="replace", timeout=10,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Python 3.9", result.stderr)
        self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()

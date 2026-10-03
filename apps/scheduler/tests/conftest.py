"""
Skip the solver tests when the solver cannot be imported.

`ortools` is a native extension. Loaded under an interpreter it was not built
for, it does not raise an ImportError — it aborts the process, taking the whole
pytest run with it and reporting nothing useful.

That happens whenever these run outside the scheduler's own virtualenv: a CI
runner using the system Python, a scanning sandbox, a laptop with conda first on
PATH. In every one of those cases the honest answer is "not checked here", not
"broken".

The import is attempted once, in a subprocess, so an abort kills the subprocess
rather than the test session.
"""

import subprocess
import sys

import pytest


def _solver_importable() -> bool:
    """
    Try the import somewhere expendable.

    A plain `try: import ortools` is not enough — the failure mode is a process
    abort, which no except clause can catch.
    """
    try:
        result = subprocess.run(
            [sys.executable, "-c", "import ortools.sat.python.cp_model"],
            capture_output=True,
            timeout=60,
        )
        return result.returncode == 0
    except Exception:
        return False


def pytest_collection_modifyitems(config, items):
    if _solver_importable():
        return

    skip = pytest.mark.skip(
        reason=(
            "ortools could not be loaded by this interpreter. Run these from the "
            "scheduler's virtualenv: "
            "cd apps/scheduler && python -m pytest"
        ),
    )
    for item in items:
        item.add_marker(skip)

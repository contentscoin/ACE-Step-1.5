"""Regression guard for the Python side of the coupling invariant.

The checker script is the enforcement mechanism for design §1.4.4 / §14 risk #9,
so it gets its own tests: if detection is ever weakened, these fail instead of
the violation slipping through CI silently.
"""

from __future__ import annotations

from pathlib import Path

from hypothesis import given
from hypothesis import strategies as st

import check_import_boundary as checker

FORBIDDEN_SOURCES = [
    "import acestep\n",
    "import acestep.pipeline_ace_step as pipeline\n",
    "from acestep import pipeline_ace_step\n",
    "from acestep.models.ace_step_transformer import Transformer\n",
    "def load():\n    from acestep import pipeline_ace_step\n    return pipeline_ace_step\n",
]

ALLOWED_SOURCES = [
    "import numpy as np\n",
    "from musicstudio_dsp import __version__\n",
    "ENGINE_URL = 'http://acestep-engine.internal:8000/generate'\n",
    "import acestepper\n",
    "from acestep_client import Client\n",
]


def test_detects_forbidden_imports() -> None:
    for source in FORBIDDEN_SOURCES:
        violations = checker.find_violations_in_source(source, Path("sample.py"))
        assert violations, f"expected a violation for: {source!r}"


def test_allows_non_engine_imports() -> None:
    for source in ALLOWED_SOURCES:
        violations = checker.find_violations_in_source(source, Path("sample.py"))
        assert violations == [], f"unexpected violation for: {source!r}"


def test_scanning_the_musicstudio_tree_is_clean() -> None:
    musicstudio_root = Path(__file__).resolve().parents[2]

    assert checker.main([str(musicstudio_root)]) == 0


def test_violation_in_scanned_tree_fails(tmp_path: Path) -> None:
    (tmp_path / "worker.py").write_text("from acestep import pipeline\n", encoding="utf-8")

    assert checker.main([str(tmp_path)]) == 1


@given(st.lists(st.sampled_from(FORBIDDEN_SOURCES), min_size=1, max_size=4))
def test_every_forbidden_import_is_reported(sources: list[str]) -> None:
    """Detection count matches the number of forbidden import statements."""
    source = "".join(sources)

    violations = checker.find_violations_in_source(source, Path("sample.py"))

    assert len(violations) == len(sources)

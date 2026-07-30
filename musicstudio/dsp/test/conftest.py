"""Shared pytest configuration for the DSP worker test suite.

Registers the hypothesis profile that design §10 requires (>= 100 examples per
property) and makes the boundary checker script importable by its tests.
"""

from __future__ import annotations

import sys
from pathlib import Path

from hypothesis import settings

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

settings.register_profile("musicstudio", max_examples=100)
settings.load_profile("musicstudio")

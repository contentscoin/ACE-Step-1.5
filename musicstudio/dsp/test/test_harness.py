"""Harness smoke check for the Python property-based testing setup.

No DSP behaviour is asserted here. The purpose is to prove that ``hypothesis``
executes under pytest with the example count design §10 requires. Numbered
correctness properties land in sibling files as their subject modules appear.
"""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st


def test_hypothesis_harness_runs_at_least_100_examples() -> None:
    seen: list[int] = []

    @given(st.integers())
    @settings(max_examples=100)
    def property_under_test(value: int) -> None:
        seen.append(value)
        assert isinstance(value, int)

    property_under_test()

    assert len(seen) >= 100

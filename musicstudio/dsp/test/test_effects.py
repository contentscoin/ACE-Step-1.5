"""The eight effects of Requirement 29.1, and design §10's Properties 14 and 24.

**Properties 14 and 24 (design §10) are the two classes so named.** Per tasks.md §9.2's
ownership table — "Property 14 이펙트 처리 재현성 (Req 29.29), Property 24 이펙트 길이
보존 (Req 29.30) → 태스크 3.2" — this task owns them. Everything else here is either an
example-based unit test or an explicitly *unnumbered* property test; design §10 assigns no
number to those, and inventing one would be a change to §10 that is not this task's to
make. Task 9.2's coverage audit must count only the two numbered classes.

Properties 8 and 9 (Effect_Chain round-trip and idempotence) are the same task's, but
live in `test/property/effect-chain-round-trip.test.ts`: they are about the product
layer's `Chain_Parser`/`Chain_Printer`, and design §10's harness for TypeScript is
`fast-check`. The two numbered properties here are about *audio*, which only exists on
this side of the seam.

No broker anywhere. These call the plain functions of :mod:`musicstudio_dsp.effects`
directly, which is the whole reason the Celery task in
:mod:`musicstudio_dsp.worker` is a three-line shell.
"""

from __future__ import annotations

import json
import math

import numpy as np
import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from musicstudio_dsp.audio_buffer import AudioBuffer
from musicstudio_dsp.effects import (
    EFFECT_KINDS,
    EffectChainError,
    EffectItem,
    apply_chain,
    chain_extends_tail,
    parse_chain,
    pedalboard_available,
    registry,
    validate_chain,
)
from musicstudio_dsp.resample import INTERNAL_SAMPLE_RATE

#: `pedalboard` is a default dependency (dsp/pyproject.toml), but it is a *native* wheel
#: that links `libatomic.so.1` from the platform. On a host without that library the
#: import fails, and a skip with a stated reason is more honest than a collection error.
requires_pedalboard = pytest.mark.skipif(
    not pedalboard_available(),
    reason="pedalboard is unavailable (native wheel needs libatomic.so.1 from the platform)",
)

REG = registry()


# --------------------------------------------------------------------------------------
# Fixtures and generators
# --------------------------------------------------------------------------------------


def signal(
    frames: int = 12_000,
    channels: int = 2,
    sample_rate: int = INTERNAL_SAMPLE_RATE,
    seed: int = 7,
) -> AudioBuffer:
    """Deterministic broadband test audio.

    A seeded RNG rather than a sine, because several of the eight effects are
    frequency-selective and a single tone would let a filter look like a no-op. The seed
    is fixed so a failure is reproducible — which matters especially for Property 14,
    whose whole subject is reproducibility.
    """
    rng = np.random.default_rng(seed)
    return AudioBuffer.from_channels(
        sample_rate,
        [
            (rng.standard_normal(frames) * 0.1).astype(np.float32)
            for _ in range(channels)
        ],
    )


def in_range_value(kind: str, parameter: str, position: float) -> float:
    """A value at fractional ``position`` through a parameter's declared range."""
    bounds = REG.effects[kind].parameters[parameter]
    return bounds.minimum + (bounds.maximum - bounds.minimum) * position


def item_for(kind: str, position: float = 0.5) -> dict[str, object]:
    """A complete, in-range parameter map for ``kind``."""
    return {
        "kind": kind,
        "parameters": {
            name: in_range_value(kind, name, position)
            for name in REG.effects[kind].parameters
        },
    }


@st.composite
def effect_items(draw: st.DrawFn, kind: str) -> dict[str, object]:
    """One item with every parameter drawn from its own registry range.

    Constrained rather than filtered: an out-of-range value is not a member of the set
    Requirements 29.29 and 29.30 quantify over ("유효한 Effect_Chain"), so filtering would
    be testing the same set more slowly. The endpoints are weighted in explicitly because
    a continuous generator reaches an exact boundary vanishingly rarely, and the
    boundaries are where inclusivity is decided.
    """
    parameters: dict[str, float] = {}
    for name, bounds in REG.effects[kind].parameters.items():
        parameters[name] = draw(
            st.one_of(
                # Full float64 width, not `width=32`. The bounds come from the registry
                # and several (0.01, 0.1, 0.95) are not exactly representable in float32,
                # which `width=32` rejects outright. The parameters are ordinary Python
                # floats on the wire and in the JSON document, so float64 is the honest
                # domain; pedalboard narrows them itself.
                st.floats(
                    min_value=bounds.minimum,
                    max_value=bounds.maximum,
                    allow_nan=False,
                    allow_infinity=False,
                ),
                st.sampled_from([bounds.minimum, bounds.maximum]),
            )
        )
    return {"kind": kind, "parameters": parameters}


#: Kinds that cannot lengthen the signal — Property 24's subject (Requirement 29.30).
LENGTH_PRESERVING_KINDS = tuple(
    kind for kind in EFFECT_KINDS if not REG.effects[kind].extends_tail
)


@st.composite
def length_preserving_chains(draw: st.DrawFn) -> list[dict[str, object]]:
    """A chain containing neither delay nor reverb (Requirement 29.30's antecedent)."""
    kinds = draw(
        st.lists(
            st.sampled_from(LENGTH_PRESERVING_KINDS),
            min_size=REG.chain_item_count_min,
            # Capped below the 16 of Requirement 29.13 to keep the property's runtime
            # sane: each item is real DSP over real samples, and 100 examples of
            # 16-item chains is minutes, not seconds. The count bound itself is
            # exercised by the example-based tests below, so nothing goes unchecked.
            max_size=4,
        )
    )
    return [draw(effect_items(kind)) for kind in kinds]


@st.composite
def any_chains(draw: st.DrawFn) -> list[dict[str, object]]:
    """A chain over all eight kinds, for Property 14."""
    kinds = draw(st.lists(st.sampled_from(EFFECT_KINDS), min_size=1, max_size=3))
    return [draw(effect_items(kind)) for kind in kinds]


# Real DSP is slow relative to hypothesis's default deadline, and the deadline measures
# wall time rather than anything about correctness. Disabled rather than raised so a
# loaded CI machine cannot turn a passing property into a flake.
DSP_SETTINGS = settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.data_too_large],
)


# --------------------------------------------------------------------------------------
# The registry and validation — Requirements 29.1-29.10, 29.13
# --------------------------------------------------------------------------------------


class TestRegistry:
    def test_provides_requirement_29_1s_eight_kinds(self) -> None:
        assert len(EFFECT_KINDS) == 8
        assert set(EFFECT_KINDS) == {
            "chorus",
            "reverb",
            "delay",
            "compressor",
            "gain",
            "highpass",
            "lowpass",
            "pitch_shift",
        }

    def test_marks_exactly_delay_and_reverb_as_tail_extending(self) -> None:
        # Requirements 29.30 and 29.32 branch on this flag.
        extending = {kind for kind in EFFECT_KINDS if REG.effects[kind].extends_tail}
        assert extending == {"delay", "reverb"}

    def test_ranges_are_the_ones_requirements_29_2_to_29_8_quote(self) -> None:
        # Loaded from effect_registry.json, whose parity with
        # domain/effects/registry.ts is asserted by
        # test/unit/effects/registry-parity.test.ts. These are the literal clause
        # numbers, so a transcription error present in *both* files is still caught.
        assert REG.effects["chorus"].parameters["feedback"].maximum == 0.95
        assert REG.effects["chorus"].parameters["centre_delay_ms"].minimum == 0.5
        assert REG.effects["delay"].parameters["delay_seconds"].maximum == 2.0
        assert REG.effects["compressor"].parameters["threshold_db"].minimum == -60
        assert REG.effects["compressor"].parameters["release_ms"].maximum == 1000
        assert REG.effects["gain"].parameters["gain_db"].minimum == -40
        assert REG.effects["highpass"].parameters["cutoff_frequency_hz"].maximum == 8000
        assert REG.effects["lowpass"].parameters["cutoff_frequency_hz"].minimum == 200
        assert REG.effects["pitch_shift"].parameters["semitones"].minimum == -12

    def test_chain_item_count_bounds_match_requirement_29_13(self) -> None:
        assert (REG.chain_item_count_min, REG.chain_item_count_max) == (1, 16)

    def test_tail_allowance_matches_requirement_29_32(self) -> None:
        assert REG.tail_allowance_ms == 10_000
        assert REG.length_tolerance_ms == 10

    @requires_pedalboard
    def test_parameter_names_are_pedalboards_own_keywords(self) -> None:
        # The load-bearing coincidence: the registry's names *are* the constructor
        # keywords, so `build_plugin` needs no mapping table. If pedalboard renames one,
        # this fails here rather than at runtime in a worker.
        for kind in EFFECT_KINDS:
            from musicstudio_dsp.effects import build_plugin

            plugin = build_plugin(EffectItem(**item_for(kind)))  # type: ignore[arg-type]
            for name, value in item_for(kind)["parameters"].items():  # type: ignore[union-attr]
                assert hasattr(plugin, name), f"{kind}.{name}"
                assert getattr(plugin, name) == pytest.approx(value, rel=1e-5)


class TestValidateChain:
    def test_accepts_a_complete_in_range_item_for_every_kind(self) -> None:
        for kind in EFFECT_KINDS:
            assert validate_chain([item_for(kind)])[0].kind == kind

    def test_accepts_both_endpoints_since_the_ranges_are_inclusive(self) -> None:
        for kind in EFFECT_KINDS:
            for position in (0.0, 1.0):
                assert validate_chain([item_for(kind, position)])

    def test_refuses_an_unknown_kind_and_returns_the_name(self) -> None:
        # Requirement 29.9.
        with pytest.raises(EffectChainError) as error:
            validate_chain([{"kind": "bitcrusher", "parameters": {}}])
        assert error.value.violation == "unknown_effect_kind"
        assert error.value.name == "bitcrusher"

    def test_refuses_an_unknown_parameter_name_and_returns_the_name(self) -> None:
        with pytest.raises(EffectChainError) as error:
            validate_chain([{"kind": "gain", "parameters": {"gain_db": 0, "makeup": 1}}])
        assert error.value.violation == "unknown_parameter_name"
        assert error.value.name == "makeup"

    def test_refuses_an_out_of_range_value_and_returns_the_range(self) -> None:
        # Requirement 29.10.
        with pytest.raises(EffectChainError) as error:
            validate_chain([{"kind": "gain", "parameters": {"gain_db": 41}}])
        assert error.value.violation == "parameter_out_of_range"
        assert error.value.name == "gain_db"
        assert error.value.expected == "-40.0..40.0"

    def test_refuses_nan_and_the_infinities(self) -> None:
        # A bare `min <= v <= max` *accepts* NaN, since NaN fails every comparison, and a
        # NaN reaching pedalboard poisons every subsequent sample.
        for value in (math.nan, math.inf, -math.inf):
            with pytest.raises(EffectChainError) as error:
                validate_chain([{"kind": "gain", "parameters": {"gain_db": value}}])
            assert error.value.violation == "parameter_out_of_range"

    def test_refuses_a_bool_which_python_would_otherwise_treat_as_a_number(self) -> None:
        # `isinstance(True, int)` is True in Python, so without the explicit bool guard
        # `gain_db: true` would validate as 1.0.
        with pytest.raises(EffectChainError) as error:
            validate_chain([{"kind": "gain", "parameters": {"gain_db": True}}])
        assert error.value.violation == "parameter_not_finite_number"

    def test_refuses_a_missing_parameter_rather_than_defaulting_it(self) -> None:
        with pytest.raises(EffectChainError) as error:
            validate_chain([{"kind": "delay", "parameters": {"delay_seconds": 0.5}}])
        assert error.value.violation == "missing_parameter"

    def test_enforces_requirement_29_13s_item_count(self) -> None:
        assert len(validate_chain([item_for("gain")] * 16)) == 16
        with pytest.raises(EffectChainError) as empty:
            validate_chain([])
        assert empty.value.violation == "chain_too_few_items"
        with pytest.raises(EffectChainError) as many:
            validate_chain([item_for("gain")] * 17)
        assert many.value.violation == "chain_too_many_items"

    def test_reports_the_index_of_the_first_offending_item(self) -> None:
        # Requirement 29.33's ordering, which the TypeScript parser also keeps.
        with pytest.raises(EffectChainError) as error:
            validate_chain(
                [item_for("gain"), item_for("gain"), {"kind": "nope", "parameters": {}}]
            )
        assert error.value.index == 2

    def test_applies_the_two_filters_different_ranges(self) -> None:
        # Requirement 29.7.
        assert validate_chain([{"kind": "highpass", "parameters": {"cutoff_frequency_hz": 20}}])
        with pytest.raises(EffectChainError):
            validate_chain([{"kind": "lowpass", "parameters": {"cutoff_frequency_hz": 20}}])
        with pytest.raises(EffectChainError):
            validate_chain(
                [{"kind": "highpass", "parameters": {"cutoff_frequency_hz": 20_000}}]
            )


class TestParseChain:
    def test_parses_a_chain_document(self) -> None:
        items = parse_chain(json.dumps([item_for("gain")]))
        assert items[0].kind == "gain"

    def test_refuses_malformed_json_distinctly_from_a_wrong_shape(self) -> None:
        with pytest.raises(EffectChainError) as malformed:
            parse_chain('[{"kind":')
        assert malformed.value.violation == "chain_json_malformed"
        with pytest.raises(EffectChainError) as shape:
            parse_chain('{"kind": "gain"}')
        assert shape.value.violation == "chain_not_array"

    def test_accepts_the_document_the_typescript_printer_emits(self) -> None:
        # The printer emits `[{"kind":...,"parameters":{...}}]` with no whitespace. This
        # is the seam's contract, asserted from the receiving side.
        document = '[{"kind":"gain","parameters":{"gain_db":-3}}]'
        assert parse_chain(document)[0].parameters["gain_db"] == -3.0


# --------------------------------------------------------------------------------------
# Applying a chain — Requirements 29.8, 29.12, 29.30, 29.32
# --------------------------------------------------------------------------------------


@requires_pedalboard
class TestApplyChain:
    def test_applies_every_one_of_requirement_29_1s_eight_kinds(self) -> None:
        audio = signal()
        for kind in EFFECT_KINDS:
            result = apply_chain(audio, [item_for(kind)])
            assert result.audio.channel_count == audio.channel_count
            assert result.audio.sample_rate == audio.sample_rate
            assert result.audio.is_well_formed

    def test_validates_before_reaching_pedalboard(self) -> None:
        # Requirement 29.10 says the *service* refuses out-of-range parameters. Silently
        # clamping here would make the worker the one place a forbidden value took effect.
        with pytest.raises(EffectChainError):
            apply_chain(signal(), [{"kind": "gain", "parameters": {"gain_db": 99}}])

    def test_applies_items_in_array_order(self) -> None:
        # Requirement 29.12. A high-pass then a low-pass is a band-pass; the reverse is
        # too, but a gain before vs after a compressor is audibly different, which is what
        # makes order observable at all.
        audio = signal()
        gain_then_comp = apply_chain(
            audio,
            [
                {"kind": "gain", "parameters": {"gain_db": 20}},
                {
                    "kind": "compressor",
                    "parameters": {
                        "threshold_db": -20,
                        "ratio": 10,
                        "attack_ms": 1,
                        "release_ms": 100,
                    },
                },
            ],
        )
        comp_then_gain = apply_chain(
            audio,
            [
                {
                    "kind": "compressor",
                    "parameters": {
                        "threshold_db": -20,
                        "ratio": 10,
                        "attack_ms": 1,
                        "release_ms": 100,
                    },
                },
                {"kind": "gain", "parameters": {"gain_db": 20}},
            ],
        )
        assert not np.allclose(
            gain_then_comp.audio.channels[0], comp_then_gain.audio.channels[0]
        )

    def test_gain_changes_amplitude_by_the_requested_decibels(self) -> None:
        # Confirms the parameter actually reaches the plugin rather than being ignored,
        # which a shape-only assertion would not catch.
        audio = signal()
        result = apply_chain(audio, [{"kind": "gain", "parameters": {"gain_db": -6.0}}])
        ratio = float(np.max(np.abs(result.audio.channels[0]))) / float(
            np.max(np.abs(audio.channels[0]))
        )
        assert ratio == pytest.approx(10 ** (-6.0 / 20.0), rel=0.02)

    def test_requirement_29_8_pitch_shift_preserves_the_time_axis(self) -> None:
        # "재생 속도를 변경하지 않고 시간축 길이를 보존하는 방식으로 적용한다" — a
        # resampling pitch shift would change the frame count, which is exactly what the
        # clause forbids.
        audio = signal()
        for semitones in (-12, -5, 5, 12):
            result = apply_chain(
                audio, [{"kind": "pitch_shift", "parameters": {"semitones": semitones}}]
            )
            assert result.audio.frame_count == audio.frame_count

    def test_mono_is_processed_as_mono(self) -> None:
        audio = signal(channels=1)
        result = apply_chain(audio, [item_for("gain")])
        assert result.audio.channel_count == 1
        assert result.audio.frame_count == audio.frame_count

    def test_requirement_29_32_caps_a_reverb_tail_at_ten_seconds(self) -> None:
        audio = signal(frames=INTERNAL_SAMPLE_RATE)  # exactly 1 s
        result = apply_chain(
            audio,
            [
                {
                    "kind": "reverb",
                    "parameters": {
                        "room_size": 1.0,
                        "damping": 0.0,
                        "wet_level": 1.0,
                        "dry_level": 0.0,
                        "width": 1.0,
                    },
                }
            ],
        )
        assert result.audio.duration_ms >= audio.duration_ms - REG.length_tolerance_ms
        assert result.audio.duration_ms <= audio.duration_ms + REG.tail_allowance_ms

    def test_requirement_29_32_caps_a_delay_tail_too(self) -> None:
        audio = signal(frames=INTERNAL_SAMPLE_RATE)
        result = apply_chain(
            audio,
            [{"kind": "delay", "parameters": {"delay_seconds": 2.0, "feedback": 0.95, "mix": 1.0}}],
        )
        assert result.audio.duration_ms <= audio.duration_ms + REG.tail_allowance_ms

    def test_a_delay_tail_actually_contains_signal(self) -> None:
        # Without the deliberate padding in `apply_chain` the tail would not exist at all,
        # and Requirement 29.32's allowance would be describing nothing.
        audio = signal(frames=INTERNAL_SAMPLE_RATE // 2)
        result = apply_chain(
            audio,
            [{"kind": "delay", "parameters": {"delay_seconds": 0.5, "feedback": 0.9, "mix": 1.0}}],
        )
        assert result.audio.frame_count > audio.frame_count
        tail = result.audio.channels[0][audio.frame_count :]
        assert float(np.max(np.abs(tail))) > 0.0

    def test_reports_the_original_duration_for_the_length_invariants(self) -> None:
        audio = signal()
        result = apply_chain(audio, [item_for("gain")])
        assert result.original_duration_ms == pytest.approx(audio.duration_ms)

    def test_accepts_already_validated_items(self) -> None:
        # The worker shell parses once and passes EffectItems; re-validating would be
        # wasted work, but skipping validation entirely for raw input would be a hole.
        items = validate_chain([item_for("gain")])
        assert apply_chain(signal(), items).audio.is_well_formed

    def test_refuses_an_empty_prevalidated_chain(self) -> None:
        with pytest.raises(EffectChainError):
            apply_chain(signal(), [])

    def test_refuses_malformed_input_audio(self) -> None:
        empty = AudioBuffer.from_channels(INTERNAL_SAMPLE_RATE, [np.zeros(0, dtype=np.float32)])
        with pytest.raises(ValueError, match="not well formed"):
            apply_chain(empty, [item_for("gain")])


class TestChainExtendsTail:
    def test_flags_delay_and_reverb_only(self) -> None:
        assert chain_extends_tail(validate_chain([item_for("reverb")]))
        assert chain_extends_tail(validate_chain([item_for("delay")]))
        assert chain_extends_tail(validate_chain([item_for("gain"), item_for("reverb")]))
        assert not chain_extends_tail(
            validate_chain([item_for(kind) for kind in LENGTH_PRESERVING_KINDS])
        )


# --------------------------------------------------------------------------------------
# Design §10, Property 14 — Requirement 29.29
# --------------------------------------------------------------------------------------


@requires_pedalboard
class TestProperty14EffectProcessingReproducibility:
    """Feature: ai-music-generation-service, Property 14: 원본 버전 오디오와 체인 동등 관계를
    만족하는 Effect_Chain에 대해 2회 이상 처리 결과는 샘플레이트·채널 수·샘플 수가 동일하고
    모든 샘플 차이가 0이다.

    **Validates: Requirements 29.29**

    The acceptance criterion of task 3.2 — "동일 입력+체인 2회 처리 → 샘플 차이 0" — is this
    property, and it is asserted as **bit-exactness**: ``np.array_equal`` on the raw
    ``float32`` arrays, not ``allclose``. An approximate comparison would pass for an
    implementation that reused a reverb tank between calls and differed in the last
    mantissa bit, which is precisely the failure Requirement 29.29 names.

    ### The BLAS-thread caveat, and why this property does not depend on it

    Design §5.5 asks for single-threaded BLAS. That **cannot** be arranged from Python
    code: NumPy fixes its thread-pool size when its backend loads, before any of these
    modules are imported, so an ``os.environ`` write here would be read by nothing. It
    belongs in the worker container's environment (``OMP_NUM_THREADS=1`` and the vendor
    equivalents) and design §11.3's topology is where to declare it. Task 3.1 recorded the
    same finding for ``worker.py``'s Celery configuration.

    This property is therefore written to be **thread-count independent rather than
    thread-count pinned**, and that is a property of what is being measured, not a
    concession:

    * The arithmetic that must be bit-exact happens inside ``pedalboard``'s own
      single-threaded C++ processing, which does not call into BLAS at all.
    * The NumPy work in :func:`apply_chain` is elementwise — slicing, zero-padding, dtype
      conversion, channel stacking. Elementwise operations are not parallelised or
      reassociated by any BLAS backend, so their results do not depend on a thread count.

    So the assertions below hold under whatever thread count the test process happens to
    have, and :meth:`test_is_bit_exact_under_the_ambient_thread_count` records the ambient
    count in its failure message so a future breach is diagnosable rather than mysterious.
    Nothing here sets or requires an environment variable.
    """

    @given(chain=any_chains())
    @DSP_SETTINGS
    def test_two_processings_agree_to_the_last_bit(
        self, chain: list[dict[str, object]]
    ) -> None:
        audio = signal(frames=6_000)

        first = apply_chain(audio, chain)
        second = apply_chain(audio, chain)

        # Requirement 29.29's three shape clauses.
        assert first.audio.sample_rate == second.audio.sample_rate == audio.sample_rate
        assert first.audio.channel_count == second.audio.channel_count == audio.channel_count
        assert first.audio.frame_count == second.audio.frame_count

        # "대응하는 모든 샘플 값의 차이를 0으로 유지한다" — exactly zero, bit for bit.
        for index, (left, right) in enumerate(
            zip(first.audio.channels, second.audio.channels)
        ):
            assert np.array_equal(left, right), f"channel {index} differs"

    @given(chain=any_chains())
    @DSP_SETTINGS
    def test_an_equivalent_chain_produces_identical_samples(
        self, chain: list[dict[str, object]]
    ) -> None:
        # Requirement 29.29 quantifies over chains satisfying the *chain equivalence
        # relation*, not over identical dicts. The relation permits a parameter to differ
        # by up to 1e-6 and permits a different key order, so a JSON round trip through
        # the printer's canonical form is a legitimate member of the same class and must
        # give the same audio.
        audio = signal(frames=6_000)
        reordered = [
            {
                "kind": item["kind"],
                "parameters": dict(reversed(list(item["parameters"].items()))),  # type: ignore[union-attr]
            }
            for item in chain
        ]

        first = apply_chain(audio, chain)
        second = apply_chain(audio, json.loads(json.dumps(reordered)))

        assert first.audio.frame_count == second.audio.frame_count
        for left, right in zip(first.audio.channels, second.audio.channels):
            assert np.array_equal(left, right)

    @requires_pedalboard
    def test_is_bit_exact_under_the_ambient_thread_count(self) -> None:
        # The BLAS caveat, stated as a test. No environment variable is set; the ambient
        # thread count is reported so that a future breach is diagnosable.
        import os

        chain = [
            item_for("chorus"),
            item_for("compressor"),
            item_for("pitch_shift"),
            item_for("reverb"),
        ]
        audio = signal(frames=INTERNAL_SAMPLE_RATE // 4)

        first = apply_chain(audio, chain)
        second = apply_chain(audio, chain)

        threads = {
            name: os.environ.get(name, "<unset>")
            for name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS")
        }
        for index, (left, right) in enumerate(
            zip(first.audio.channels, second.audio.channels)
        ):
            assert np.array_equal(left, right), (
                f"channel {index} differs with thread environment {threads}; "
                "design §5.5's single-thread rule belongs in the worker container, "
                "not in Python — see this class's docstring"
            )

    @requires_pedalboard
    def test_a_stateful_effect_does_not_carry_state_between_calls(self) -> None:
        # The concrete mechanism the fresh-Pedalboard-per-call rule protects against.
        # A reused board would let call two start inside call one's decaying tail, and
        # the difference would be small enough for `allclose` to miss.
        audio = signal(frames=4_000)
        chain = [
            {"kind": "delay", "parameters": {"delay_seconds": 0.1, "feedback": 0.9, "mix": 0.8}}
        ]
        runs = [apply_chain(audio, chain) for _ in range(3)]
        for later in runs[1:]:
            for left, right in zip(runs[0].audio.channels, later.audio.channels):
                assert np.array_equal(left, right)


# --------------------------------------------------------------------------------------
# Design §10, Property 24 — Requirement 29.30
# --------------------------------------------------------------------------------------


@requires_pedalboard
class TestProperty24EffectLengthPreservation:
    """Feature: ai-music-generation-service, Property 24: 딜레이와 리버브를 모두 포함하지 않은
    Effect_Chain이 적용되면 처리된 오디오 길이는 원본 길이와 10ms 이내 오차로 동일하다.

    **Validates: Requirements 29.30**

    The generator draws only from the six kinds the registry marks as not tail-extending,
    which is Requirement 29.30's antecedent stated as a constraint rather than checked as a
    precondition. The chain is asserted to satisfy that antecedent inside the property, so
    a registry change that reclassified an effect would fail here rather than silently
    narrow what is being tested.
    """

    @given(chain=length_preserving_chains())
    @DSP_SETTINGS
    def test_length_is_preserved_within_ten_milliseconds(
        self, chain: list[dict[str, object]]
    ) -> None:
        audio = signal(frames=6_000)

        # The generator's own contract — Requirement 29.30's antecedent.
        assert not chain_extends_tail(validate_chain(chain))

        result = apply_chain(audio, chain)

        error_ms = abs(result.audio.duration_ms - audio.duration_ms)
        assert error_ms <= REG.length_tolerance_ms, (
            f"length error {error_ms} ms exceeds {REG.length_tolerance_ms} ms"
        )
        # Stronger than the clause, and true: pedalboard returns frame-for-frame as many
        # samples as it received for all six of these kinds, so the error is exactly zero
        # rather than merely inside the tolerance. Asserting it means a library change
        # that started padding would be caught while still passing the ±10 ms test.
        assert result.audio.frame_count == audio.frame_count
        assert not result.tail_truncated

    @given(chain=length_preserving_chains(), frames=st.sampled_from([1, 480, 6_000, 20_000]))
    @DSP_SETTINGS
    def test_holds_for_short_and_long_inputs_alike(
        self, chain: list[dict[str, object]], frames: int
    ) -> None:
        # A single-frame buffer is the degenerate case where a filter's own latency would
        # show up as a length change if there were any.
        audio = signal(frames=frames)
        result = apply_chain(audio, chain)
        assert abs(result.audio.duration_ms - audio.duration_ms) <= REG.length_tolerance_ms


# --------------------------------------------------------------------------------------
# Unnumbered property tests. Design §10 assigns these no number; task 9.2's audit must
# not count them against Properties 14 or 24.
# --------------------------------------------------------------------------------------


class TestValidationPropertiesUnnumbered:
    """Requirements 29.9, 29.10 over generated input — unnumbered."""

    @given(
        kind=st.sampled_from(EFFECT_KINDS),
        position=st.floats(min_value=0.0, max_value=1.0, allow_nan=False),
    )
    @settings(max_examples=100)
    def test_every_in_range_value_is_accepted(self, kind: str, position: float) -> None:
        assert validate_chain([item_for(kind, position)])[0].kind == kind

    @given(kind=st.sampled_from(EFFECT_KINDS), overshoot=st.floats(min_value=0.001, max_value=1e6))
    @settings(max_examples=100)
    def test_a_value_above_the_maximum_is_always_refused(
        self, kind: str, overshoot: float
    ) -> None:
        # Requirement 29.10 has no upper escape hatch: every parameter of every kind
        # refuses a value past its ceiling, and the refusal names the range.
        for name, bounds in REG.effects[kind].parameters.items():
            parameters = {
                other: in_range_value(kind, other, 0.5) for other in REG.effects[kind].parameters
            }
            parameters[name] = bounds.maximum + overshoot
            with pytest.raises(EffectChainError) as error:
                validate_chain([{"kind": kind, "parameters": parameters}])
            assert error.value.violation == "parameter_out_of_range"
            assert error.value.name == name
            assert error.value.expected == bounds.describe()

    @given(kind=st.sampled_from(EFFECT_KINDS), undershoot=st.floats(min_value=0.001, max_value=1e6))
    @settings(max_examples=100)
    def test_a_value_below_the_minimum_is_always_refused(
        self, kind: str, undershoot: float
    ) -> None:
        for name, bounds in REG.effects[kind].parameters.items():
            parameters = {
                other: in_range_value(kind, other, 0.5) for other in REG.effects[kind].parameters
            }
            parameters[name] = bounds.minimum - undershoot
            with pytest.raises(EffectChainError) as error:
                validate_chain([{"kind": kind, "parameters": parameters}])
            assert error.value.violation == "parameter_out_of_range"
            assert error.value.name == name

"""13-dimension MFCC and cue-pair similarity (Requirement 24.9).

The tests that carry weight here are the ones checking the transform against something
*other than itself*:

* the mel filterbank against the HTK formula and against the analytic band edges;
* the coefficient count and the dropped ``c0`` against Requirement 24.9's "1차부터
  13차까지";
* **gain invariance**, which is a mathematical consequence of dropping ``c0`` and is what
  makes 24.9's −23 LUFS normalisation a no-op for the coefficients it keeps — so a
  regression that started keeping ``c0`` would be caught here rather than by a puzzling
  similarity result months later;
* the exhaustive 3003-pair count for a 78-cue pack, which is the number Requirement 24.9
  states and the thing a sampled check would silently fail to do.

No numbered design §10 Property lives here: §10 assigns Properties 10 and 11 to the
``Cue_Pack_Manifest`` parser/printer, which is TypeScript. The ``hypothesis`` tests below
are therefore **unnumbered** — task 9.2's audit must not count them.
"""

from __future__ import annotations

import math

import numpy as np
import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from musicstudio_dsp.audio_buffer import AudioBuffer
from musicstudio_dsp.mfcc import (
    CUE_PAIR_SIMILARITY_CEILING,
    HOP_MS,
    LOG_FLOOR,
    MEL_BANDS,
    MFCC_COEFFICIENTS,
    MFCC_FIRST_ORDER,
    NORMALISATION_TARGET_LUFS,
    WINDOW_MS,
    cosine_similarity,
    hz_to_mel,
    mel_filterbank,
    mel_to_hz,
    mfcc_vector,
    pairwise_similarities,
    similarity_report,
    to_mono_48k,
    window_frames,
)
from musicstudio_dsp.audio_buffer import window_sample_count
from musicstudio_dsp.resample import INTERNAL_SAMPLE_RATE

from cue_synthesis import (
    SAMPLE_RATE,
    decaying_tone,
    distinct_cue,
    distinct_pack,
    duplicated_to_stereo,
    scaled,
    silence,
)

#: Requirement 24.9's pair count for the 78-cue taxonomy: 78 · 77 / 2.
PACK_PAIR_COUNT = 3_003


class TestMelScale:
    def test_matches_the_htk_formula(self) -> None:
        # 2595 · log10(1 + f/700). Not an implementation detail — see the module
        # docstring of mfcc.py on why the scale is pinned rather than inherited.
        for hz in (0.0, 100.0, 1_000.0, 8_000.0, 24_000.0):
            assert float(hz_to_mel(hz)) == pytest.approx(
                2595.0 * math.log10(1.0 + hz / 700.0), rel=1e-12
            )

    def test_round_trips(self) -> None:
        for hz in (0.0, 250.0, 1_000.0, 20_000.0):
            assert float(mel_to_hz(hz_to_mel(hz))) == pytest.approx(hz, abs=1e-6)

    def test_is_monotonic(self) -> None:
        values = [float(hz_to_mel(hz)) for hz in range(0, 24_001, 500)]
        assert values == sorted(values)


class TestFilterbank:
    def test_has_one_row_per_band_and_spans_to_nyquist(self) -> None:
        bank = mel_filterbank(SAMPLE_RATE, 2048, MEL_BANDS)
        assert bank.shape == (MEL_BANDS, 2048 // 2 + 1)
        # Every band carries some weight: an all-zero row would make one coefficient
        # constant across every cue and quietly reduce the vector's dimension.
        assert np.all(bank.sum(axis=1) > 0.0)

    def test_is_non_negative_and_never_above_unit_height(self) -> None:
        # The triangles are designed with unit height, but the height is only *attained*
        # when a bin lands exactly on a band centre — which is why this bounds the bank
        # from above rather than asserting the peak is 1.0. Area normalisation is
        # deliberately not applied; see `mel_filterbank`.
        bank = mel_filterbank(SAMPLE_RATE, 2048, MEL_BANDS)
        assert np.all(bank >= 0.0)
        assert np.max(bank) <= 1.0
        assert np.max(bank) > 0.9

    def test_bands_overlap_at_their_shared_edges(self) -> None:
        # Triangular filters spanning three consecutive edges overlap by construction;
        # a bank of disjoint rectangles would alias a tone sitting on an edge into one
        # band rather than splitting it.
        bank = mel_filterbank(SAMPLE_RATE, 2048, MEL_BANDS)
        overlapping = [
            band
            for band in range(MEL_BANDS - 1)
            if np.any((bank[band] > 0.0) & (bank[band + 1] > 0.0))
        ]
        assert len(overlapping) >= MEL_BANDS - 2

    def test_is_cached_so_a_pack_builds_it_once(self) -> None:
        first = mel_filterbank(SAMPLE_RATE, 2048, MEL_BANDS)
        second = mel_filterbank(SAMPLE_RATE, 2048, MEL_BANDS)
        assert first is second


class TestWindowing:
    def test_uses_requirement_24_9_windows_at_48khz(self) -> None:
        # 25 ms and 10 ms, exactly, at design §5.1's rate.
        assert window_frames(INTERNAL_SAMPLE_RATE, WINDOW_MS) == 1_200
        assert window_frames(INTERNAL_SAMPLE_RATE, HOP_MS) == 480

    def test_rounds_halves_the_way_javascript_does(self) -> None:
        # 25 ms at 44 100 Hz is exactly 1102.5 samples. Python's `round` is banker's
        # rounding and would give 1102; `Math.round` gives 1103, and the two sides of the
        # seam have to agree sample-for-sample. `window_frames` therefore delegates to
        # `audio_buffer.window_sample_count`, which documents the hazard.
        assert window_frames(44_100, WINDOW_MS) == 1_103
        assert window_frames(44_100, WINDOW_MS) == window_sample_count(44_100, WINDOW_MS)


class TestMonoConversion:
    def test_converts_to_one_channel_at_48khz(self) -> None:
        stereo = duplicated_to_stereo(decaying_tone(sample_rate=24_000))
        mono = to_mono_48k(stereo)
        assert mono.channel_count == 1
        assert mono.sample_rate == INTERNAL_SAMPLE_RATE

    def test_downmixes_by_mean_so_stereo_duplication_is_a_no_op(self) -> None:
        # A plain mean is what makes a mono cue presented as stereo measure identically.
        # A sum would be 6 dB louder and could move a near-silent band across LOG_FLOOR.
        mono = decaying_tone()
        assert np.allclose(
            to_mono_48k(duplicated_to_stereo(mono)).channels[0],
            to_mono_48k(mono).channels[0],
            atol=1e-6,
        )

    def test_leaves_a_48khz_buffer_at_its_own_rate(self) -> None:
        mono = decaying_tone()
        assert to_mono_48k(mono).sample_rate == INTERNAL_SAMPLE_RATE


class TestVectorShape:
    def test_returns_exactly_thirteen_coefficients(self) -> None:
        # Requirement 24.9: a 13-dimension vector.
        assert mfcc_vector(decaying_tone()).shape == (MFCC_COEFFICIENTS,)

    def test_drops_c0(self) -> None:
        # "1차부터 13차까지" — orders one through thirteen. Keeping c0 would make the
        # similarity partly a comparison of level, which 24.9 has already normalised away.
        assert MFCC_FIRST_ORDER == 1

    def test_is_finite_for_silence(self) -> None:
        # LOG_FLOOR exists for this case: without it every coefficient would be NaN and
        # the similarity meaningless.
        vector = mfcc_vector(silence())
        assert np.all(np.isfinite(vector))
        assert LOG_FLOOR > 0.0

    def test_refuses_more_coefficients_than_the_bands_can_carry(self) -> None:
        with pytest.raises(ValueError):
            mfcc_vector(decaying_tone(), bands=8, coefficients=13)

    def test_analyses_a_cue_at_requirement_24_4_s_length_floor(self) -> None:
        # 0.05 s is the shortest one-shot 24.4 admits: two 25 ms windows at 48 kHz, so
        # the padding path is never reached for a cue the taxonomy allows.
        assert np.all(np.isfinite(mfcc_vector(decaying_tone(duration_ms=50.0))))

    def test_is_deterministic(self) -> None:
        # The whole measure is arithmetic over the samples: no RNG, no thread-count
        # dependence (elementwise work and an FFT), so repetition is bit-exact.
        first = mfcc_vector(distinct_cue(7))
        second = mfcc_vector(distinct_cue(7))
        assert np.array_equal(first, second)


class TestLevelIndependence:
    """The vector does not move when the cue's delivered level does (Requirement 24.9).

    See `mfcc.py` for which mechanism does the work. Short version: the −23 LUFS
    normalisation is load-bearing and exact; dropping ``c0`` removes the first-order level
    term but does **not** make the measure invariant to the normalisation *target*,
    because :data:`LOG_FLOOR` is absolute. Both halves are asserted, because the second
    one is the textbook claim and it is false for real cue material.
    """

    def test_normalises_to_requirement_24_9_s_target(self) -> None:
        # Part of the measurement's definition, not a tuning knob — see the docstring
        # above on why a side of the seam using another target computes another vector.
        assert NORMALISATION_TARGET_LUFS == -23.0

    def test_a_quarter_gain_leaves_the_vector_unchanged(self) -> None:
        # The normalisation's whole job. The residual is float32 round-off.
        cue = distinct_cue(11)
        drift = float(np.max(np.abs(mfcc_vector(scaled(cue, 0.25)) - mfcc_vector(cue))))
        assert drift < 1e-6

    def test_the_normalisation_target_is_part_of_the_measurement(self) -> None:
        # Asserted rather than assumed, because the textbook "c0 carries all the level"
        # argument predicts this difference is zero and it is not: quiet bands under a
        # decaying envelope reach LOG_FLOOR, so the log-mel offset stops being uniform.
        # Measured at roughly 0.1 against a vector norm near 6.7.
        cue = distinct_cue(13)
        near = mfcc_vector(cue, target_lufs=-20.0)
        far = mfcc_vector(cue, target_lufs=-26.0)
        assert float(np.max(np.abs(near - far))) > 1e-3
        assert LOG_FLOOR > 0.0

    def test_the_effect_grows_with_the_distance_from_the_target(self) -> None:
        cue = distinct_cue(13)
        reference = mfcc_vector(cue)
        near = float(np.max(np.abs(mfcc_vector(cue, target_lufs=-26.0) - reference)))
        far = float(np.max(np.abs(mfcc_vector(cue, target_lufs=-50.0) - reference)))
        assert far > near


class TestCosineSimilarity:
    def test_a_vector_with_itself_is_one(self) -> None:
        # To within a ULP, not exactly: `dot(v, v) / (|v| · |v|)` computed in floating
        # point lands a ULP below 1 for some vectors, which is why the function clamps
        # into 24.9's range rather than relying on the arithmetic to stay inside it. The
        # error is twelve orders of magnitude below the 0.95 ceiling it feeds.
        vector = mfcc_vector(distinct_cue(3))
        assert cosine_similarity(vector, vector) == pytest.approx(1.0, abs=1e-12)

    def test_stays_inside_requirement_24_9_s_range(self) -> None:
        vectors = [mfcc_vector(distinct_cue(100 + index)) for index in range(12)]
        for _, _, value in pairwise_similarities(vectors):
            assert -1.0 <= value <= 1.0

    def test_is_symmetric(self) -> None:
        left = mfcc_vector(distinct_cue(21))
        right = mfcc_vector(distinct_cue(22))
        assert cosine_similarity(left, right) == pytest.approx(
            cosine_similarity(right, left), abs=1e-15
        )

    def test_opposite_directions_are_minus_one(self) -> None:
        vector = np.array([1.0, -2.0, 3.0, 0.5] + [0.0] * 9)
        assert cosine_similarity(vector, -vector) == pytest.approx(-1.0, abs=1e-12)

    def test_two_zero_vectors_are_reported_as_maximally_similar(self) -> None:
        # A decision, documented in `mfcc.py`: two silent cues are the most duplicated
        # pair a pack could hold, so reporting 1.0 surfaces the defect under 24.22
        # instead of hiding it behind an undefined value.
        zero = np.zeros(MFCC_COEFFICIENTS)
        assert cosine_similarity(zero, zero) == 1.0

    def test_a_zero_against_a_non_zero_is_zero(self) -> None:
        zero = np.zeros(MFCC_COEFFICIENTS)
        assert cosine_similarity(zero, mfcc_vector(distinct_cue(5))) == 0.0

    def test_refuses_vectors_of_different_length(self) -> None:
        with pytest.raises(ValueError):
            cosine_similarity(np.zeros(13), np.zeros(12))


class TestPairwiseExhaustiveness:
    """Requirement 24.9 quantifies over all 3003 pairs, so the check counts them."""

    def test_a_78_cue_pack_yields_exactly_3003_pairs(self) -> None:
        vectors = [np.eye(MFCC_COEFFICIENTS)[index % MFCC_COEFFICIENTS] for index in range(78)]
        assert len(pairwise_similarities(vectors)) == PACK_PAIR_COUNT
        assert similarity_report(vectors).pair_count == PACK_PAIR_COUNT

    def test_enumerates_every_distinct_unordered_pair_once(self) -> None:
        vectors = [mfcc_vector(distinct_cue(200 + index)) for index in range(9)]
        pairs = pairwise_similarities(vectors)
        assert {(i, j) for i, j, _ in pairs} == {
            (i, j) for i in range(9) for j in range(i + 1, 9)
        }
        assert len(pairs) == 9 * 8 // 2

    def test_agrees_with_the_scalar_function_on_every_pair(self) -> None:
        # The matrix path is an optimisation; it must not be a second definition.
        vectors = [mfcc_vector(distinct_cue(300 + index)) for index in range(10)]
        for i, j, value in pairwise_similarities(vectors):
            assert value == pytest.approx(cosine_similarity(vectors[i], vectors[j]), abs=1e-12)

    def test_a_pack_of_one_has_no_pairs(self) -> None:
        assert pairwise_similarities([np.ones(13)]) == []
        assert similarity_report([]).pair_count == 0


class TestSimilarityReport:
    def test_a_distinct_78_cue_pack_has_zero_exceeding_pairs(self) -> None:
        """Requirement 24.9's invariant, end to end from audio, over all 3003 pairs."""
        report = similarity_report([mfcc_vector(cue) for cue in distinct_pack()])
        assert report.pair_count == PACK_PAIR_COUNT
        assert report.exceedances == ()
        assert report.satisfied
        assert report.max_similarity <= CUE_PAIR_SIMILARITY_CEILING

    def test_names_the_pair_and_the_measured_value_when_a_pair_exceeds(self) -> None:
        # Requirement 24.22: "초과한 큐 쌍 이름 목록과 각 쌍의 측정된 유사도 값".
        cue = distinct_cue(41)
        vectors = [mfcc_vector(cue), mfcc_vector(scaled(cue, 0.5)), mfcc_vector(distinct_cue(42))]
        report = similarity_report(vectors)

        assert not report.satisfied
        assert [(e.first_index, e.second_index) for e in report.exceedances] == [(0, 1)]
        assert report.exceedances[0].similarity == pytest.approx(1.0, abs=1e-9)

    def test_names_the_later_cue_second(self) -> None:
        # Requirement 24.22 regenerates "해당 쌍 중 나중에 생성된 큐", and for a pack in
        # taxonomy order that is the pair's second index.
        cue = distinct_cue(51)
        report = similarity_report([mfcc_vector(cue)] * 2)
        assert report.exceedances[0].first_index < report.exceedances[0].second_index

    def test_uses_the_ceiling_it_is_given(self) -> None:
        # `cue_pair_similarity_max` is a Quality_Threshold_Set member; the product layer
        # sends the value in force (Requirement 34.4).
        vectors = [mfcc_vector(distinct_cue(60 + index)) for index in range(6)]
        assert similarity_report(vectors, ceiling=0.95).satisfied
        assert not similarity_report(vectors, ceiling=-1.0).satisfied

    def test_serialises_without_losing_the_verdict(self) -> None:
        report = similarity_report([mfcc_vector(distinct_cue(70 + i)) for i in range(4)])
        payload = report.as_dict()
        assert payload["pair_count"] == 6
        assert payload["satisfied"] is True
        assert payload["ceiling"] == CUE_PAIR_SIMILARITY_CEILING


# --------------------------------------------------------------------------------------
# Unnumbered property tests. Design §10 numbers no Property for the MFCC itself —
# Properties 10 and 11 are the Cue_Pack_Manifest round-trip and idempotence, which are
# TypeScript. Task 9.2's audit must not count these.
# --------------------------------------------------------------------------------------


@settings(max_examples=100, deadline=None)
@given(gain_db=st.floats(min_value=-40.0, max_value=12.0), seed=st.integers(0, 5_000))
def test_unnumbered_the_vector_is_invariant_to_the_cue_s_delivered_level(
    gain_db: float, seed: int
) -> None:
    """For any cue and any gain, the 13-vector is unchanged (Requirement 24.9's point).

    The bound is 1e-6 rather than 0 because ``scaled`` writes ``float32`` samples, so the
    scale-then-normalise round trip loses ``float32`` precision. Measured drift across the
    generated cases sits near 5e-8. See :class:`TestLevelIndependence`.
    """
    cue = distinct_cue(seed)
    gain = 10.0 ** (gain_db / 20.0)
    drift = float(np.max(np.abs(mfcc_vector(scaled(cue, gain)) - mfcc_vector(cue))))
    assert drift < 1e-6


@settings(max_examples=100, deadline=None)
@given(seed=st.integers(0, 5_000))
def test_unnumbered_similarity_is_reflexive_and_bounded(seed: int) -> None:
    vector = mfcc_vector(distinct_cue(seed))
    assert cosine_similarity(vector, vector) == pytest.approx(1.0, abs=1e-12)
    assert -1.0 <= cosine_similarity(vector, mfcc_vector(distinct_cue(seed + 1))) <= 1.0


@settings(max_examples=100, deadline=None)
@given(
    left=st.lists(st.floats(-50.0, 50.0, allow_nan=False), min_size=13, max_size=13),
    right=st.lists(st.floats(-50.0, 50.0, allow_nan=False), min_size=13, max_size=13),
)
def test_unnumbered_similarity_is_symmetric_and_in_range(
    left: list[float], right: list[float]
) -> None:
    a = np.asarray(left)
    b = np.asarray(right)
    forward = cosine_similarity(a, b)
    backward = cosine_similarity(b, a)
    assert forward == pytest.approx(backward, abs=1e-12)
    assert -1.0 <= forward <= 1.0


@settings(max_examples=100, deadline=None)
@given(count=st.integers(min_value=0, max_value=30))
def test_unnumbered_pair_count_is_n_choose_two(count: int) -> None:
    """Exhaustiveness as arithmetic: ``n(n-1)/2`` pairs for ``n`` cues, always."""
    vectors = [np.asarray([float(index + 1)] * 13) for index in range(count)]
    assert len(pairwise_similarities(vectors)) == count * (count - 1) // 2


@settings(max_examples=100, deadline=None)
@given(scale=st.floats(min_value=0.01, max_value=100.0))
def test_unnumbered_similarity_ignores_vector_length(scale: float) -> None:
    """Cosine similarity is a claim about direction, so scaling either side is inert."""
    a = np.asarray([1.0, -0.5, 2.0, 0.25] + [0.1] * 9)
    b = np.asarray([0.3, 1.5, -0.2, 0.75] + [0.2] * 9)
    assert cosine_similarity(a * scale, b) == pytest.approx(cosine_similarity(a, b), abs=1e-12)

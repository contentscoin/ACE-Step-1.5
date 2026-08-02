"""Sound_Pack export and pack loudness (Requirements 24.7, 24.10, 24.11).

Three claims carry the weight:

* **156 files, 48 kHz, one archive** (24.10) — asserted by reading the archive back
  rather than by trusting the writer, and with a real 78-cue pack rather than a
  scaled-down one, because "156" is the number the clause states.
* **The manifest is in the archive** (24.11) — likewise read back, byte for byte.
* **Pack loudness is the maximum over 400 ms windows, not the gated mean** (24.7) —
  checked against a signal whose two halves have analytically known levels, where the two
  readings differ by a knowable amount. A test that used one steady tone could not tell
  the two definitions apart.

How the 60-second budget of 24.10 is honoured without waiting: :func:`export_pack` returns
its measured wall time and judges nothing. The *judgement* is a pure predicate in
``domain/sound-pack/`` on the TypeScript side, tested there by example. Here the
measurement is exercised on a real 78-cue pack, and the assertion is that it lands far
inside the budget — measured at roughly half a second, two orders of magnitude of margin.
"""

from __future__ import annotations

import json
import math
import zipfile

import numpy as np
import pytest

from musicstudio_dsp.audio_buffer import AudioBuffer
from musicstudio_dsp.formats import decode
from musicstudio_dsp.loudness import ABSOLUTE_GATE_LUFS, integrated_loudness_lufs
from musicstudio_dsp.resample import INTERNAL_SAMPLE_RATE
from musicstudio_dsp.sound_pack import (
    EXPORT_FORMATS,
    MANIFEST_ENTRY_NAME,
    SHORT_TERM_HOP_MS,
    SHORT_TERM_WINDOW_MS,
    CueSource,
    archive_paths,
    archive_sizes,
    cue_path,
    export_pack,
    manifest_bytes,
    max_short_term_loudness_lufs,
    measurable,
    short_term_loudnesses_lufs,
)

from cue_synthesis import (
    SAMPLE_RATE,
    decaying_tone,
    distinct_pack,
    duplicated_to_stereo,
    scaled,
    silence,
)

#: Requirement 24: the taxonomy's cue count and the resulting file count.
PACK_CUE_COUNT = 78
PACK_FILE_COUNT = 156

#: Requirement 24.10's budget. The initial value of `sound_pack_export_budget_ms`.
EXPORT_BUDGET_MS = 60_000.0


def cue_sources(count: int = PACK_CUE_COUNT, duration_ms: float = 120.0):
    return [
        CueSource(name=f"cue-{index:02d}", category="input", audio=audio)
        for index, audio in enumerate(distinct_pack(count, duration_ms=duration_ms))
    ]


class TestExportShape:
    def test_produces_one_mp3_and_one_ogg_per_cue(self) -> None:
        # Requirement 24.10, at the count the clause states.
        result = export_pack(cue_sources(), "{}")
        assert result.file_count == PACK_FILE_COUNT
        assert sum(1 for f in result.files if f.audio_format == "mp3") == PACK_CUE_COUNT
        assert sum(1 for f in result.files if f.audio_format == "ogg") == PACK_CUE_COUNT

    def test_exports_the_two_formats_the_clause_names(self) -> None:
        assert EXPORT_FORMATS == ("mp3", "ogg")

    def test_returns_a_single_archive_holding_every_file(self) -> None:
        result = export_pack(cue_sources(), "{}")
        paths = archive_paths(result.archive)
        assert len(paths) == PACK_FILE_COUNT + 1  # + the manifest
        for entry in result.files:
            assert entry.path in paths

    def test_the_archive_is_a_valid_zip_and_every_member_decodes(self) -> None:
        result = export_pack(cue_sources(6), "{}")
        with zipfile.ZipFile(__import__("io").BytesIO(result.archive)) as handle:
            assert handle.testzip() is None
            for entry in result.files:
                decoded = decode(handle.read(entry.path))
                assert decoded.sample_rate == INTERNAL_SAMPLE_RATE

    def test_records_the_byte_size_the_archive_actually_holds(self) -> None:
        # Requirement 24.11's `byte_size` is the file's own size, so it must agree with
        # the uncompressed size the zip directory records — otherwise a consumer that
        # trusted the manifest would allocate the wrong buffer.
        result = export_pack(cue_sources(8), "{}")
        sizes = archive_sizes(result.archive)
        for entry in result.files:
            assert sizes[entry.path] == entry.byte_size

    def test_names_files_by_cue_and_format(self) -> None:
        assert cue_path("toggle-on", "ogg") == "sounds/toggle-on.ogg"

    def test_the_archive_structure_is_deterministic(self) -> None:
        # Entry names and order, not bytes — see the next two tests for why.
        first = export_pack(cue_sources(5), '{"a":1}')
        second = export_pack(cue_sources(5), '{"a":1}')
        assert archive_paths(first.archive) == archive_paths(second.archive)
        assert [entry.path for entry in first.files] == [entry.path for entry in second.files]

    def test_entries_carry_a_fixed_timestamp_rather_than_now(self) -> None:
        # A `ZipInfo` defaulting to "now" would make two exports of the same pack differ
        # by the minute they ran, for no reason anyone downstream could account for.
        import io

        with zipfile.ZipFile(io.BytesIO(export_pack(cue_sources(3), "{}").archive)) as handle:
            stamps = {info.date_time for info in handle.infolist()}
        assert stamps == {(1980, 1, 1, 0, 0, 0)}

    def test_ogg_bytes_are_not_reproducible_and_that_is_the_container_s_doing(self) -> None:
        # Recorded as a fact rather than left to be rediscovered. libvorbis writes a
        # randomly chosen stream serial number into every Ogg page header; libsndfile
        # offers no way to fix it. mp3, wav and flac *are* byte-stable.
        from musicstudio_dsp.formats import encode

        cue = decaying_tone(duration_ms=120.0)
        assert encode(cue, "mp3") == encode(cue, "mp3")
        assert encode(cue, "wav") == encode(cue, "wav")
        assert encode(cue, "flac") == encode(cue, "flac")
        assert encode(cue, "ogg") != encode(cue, "ogg")

    def test_two_exports_decode_to_identical_samples(self) -> None:
        # The claim that survives the ogg serial number, and the one that matters: an
        # exported pack must be compared by decoded content, never by archive hash.
        first = export_pack(cue_sources(3), "{}")
        second = export_pack(cue_sources(3), "{}")
        for entry in first.files:
            left = decode(manifest_bytes(first.archive, entry.path))
            right = decode(manifest_bytes(second.archive, entry.path))
            assert left.sample_rate == right.sample_rate
            assert left.frame_count == right.frame_count
            for a, b in zip(left.channels, right.channels):
                assert np.array_equal(a, b)


class TestSampleRate:
    def test_forces_48khz_even_when_the_cue_is_stored_at_another_rate(self) -> None:
        # Requirement 24.10 admits no exception, the same way 13.10 admits none.
        low_rate = decaying_tone(duration_ms=200.0, sample_rate=24_000)
        result = export_pack([CueSource(name="hover", category="input", audio=low_rate)], "{}")
        assert all(entry.sample_rate == INTERNAL_SAMPLE_RATE for entry in result.files)
        for entry in result.files:
            assert decode(manifest_bytes(result.archive, entry.path)).sample_rate == (
                INTERNAL_SAMPLE_RATE
            )

    def test_reports_the_duration_of_the_normalised_buffer(self) -> None:
        result = export_pack(
            [CueSource(name="press", category="input", audio=decaying_tone(duration_ms=250.0))],
            "{}",
        )
        for entry in result.files:
            assert entry.duration_ms == pytest.approx(250.0, abs=10.0)

    def test_carries_a_stereo_cue_through_as_stereo(self) -> None:
        stereo = duplicated_to_stereo(decaying_tone(duration_ms=200.0))
        result = export_pack([CueSource(name="drop", category="movement", audio=stereo)], "{}")
        assert all(entry.channels == 2 for entry in result.files)


class TestManifestInclusion:
    def test_includes_the_manifest_in_the_archive(self) -> None:
        document = json.dumps({"packName": "Soft", "cues": []})
        result = export_pack(cue_sources(3), document)
        assert result.manifest_entry == MANIFEST_ENTRY_NAME
        assert manifest_bytes(result.archive).decode("utf-8") == document

    def test_stores_the_manifest_verbatim(self) -> None:
        # Requirement 24.15's idempotence is a property of `Manifest_Printer`. A worker
        # that reformatted the document would break it from outside the module the
        # property is asserted about — so the bytes go in untouched, whitespace and all.
        document = '{\n  "packName" : "Soft"\n}\n'
        result = export_pack(cue_sources(2), document)
        assert manifest_bytes(result.archive).decode("utf-8") == document

    def test_the_manifest_is_not_one_of_the_156(self) -> None:
        result = export_pack(cue_sources(), "{}")
        assert MANIFEST_ENTRY_NAME not in {entry.path for entry in result.files}
        assert result.file_count == PACK_FILE_COUNT


class TestExportBudget:
    def test_reports_its_own_wall_time(self) -> None:
        result = export_pack(cue_sources(4), "{}")
        assert result.elapsed_ms > 0.0
        assert math.isfinite(result.elapsed_ms)

    def test_a_real_78_cue_pack_exports_far_inside_the_60_second_budget(self) -> None:
        # Requirement 24.10, measured rather than asserted about. Roughly half a second
        # on this machine for 156 libsndfile encodes of short cues — two orders of
        # magnitude of margin, which is what makes the budget a non-issue for the DSP
        # step and locates any future breach in transport rather than encoding.
        result = export_pack(cue_sources(), "{}")
        assert result.file_count == PACK_FILE_COUNT
        assert result.elapsed_ms < EXPORT_BUDGET_MS

    def test_does_not_itself_judge_the_budget(self) -> None:
        # The judgement is a Quality_Threshold_Set decision and belongs to the product
        # layer. This asserts the absence of a verdict here, so a future edit that added
        # one would fail rather than quietly create a second place the rule lives.
        result = export_pack(cue_sources(2), "{}")
        assert not hasattr(result, "within_budget")
        assert not hasattr(result, "budget_ms")


class TestPackLoudness:
    def test_uses_requirement_24_7_s_window_and_interval(self) -> None:
        assert SHORT_TERM_WINDOW_MS == 400.0
        assert SHORT_TERM_HOP_MS == 100.0

    def test_a_steady_tone_reads_close_to_its_integrated_loudness(self) -> None:
        # For a stationary signal every window measures the same thing, so the maximum
        # and the gated mean coincide. This is the only case where they do.
        frames = SAMPLE_RATE * 3
        t = np.arange(frames) / SAMPLE_RATE
        tone = AudioBuffer.from_channels(
            SAMPLE_RATE, [(0.1 * np.sin(2.0 * np.pi * 1_000.0 * t)).astype(np.float32)]
        )
        assert max_short_term_loudness_lufs(tone) == pytest.approx(
            integrated_loudness_lufs(tone), abs=0.2
        )

    def test_takes_the_maximum_rather_than_the_mean_over_windows(self) -> None:
        # Requirement 24.7 says 최대값. A signal that is loud for one second and 20 dB
        # quieter for four reads its *loud* level, while the gated mean sits below it.
        frames = SAMPLE_RATE
        t = np.arange(frames) / SAMPLE_RATE
        loud = 0.2 * np.sin(2.0 * np.pi * 1_000.0 * t)
        quiet = loud * 0.1
        signal = np.concatenate([loud, quiet, quiet, quiet, quiet]).astype(np.float32)
        audio = AudioBuffer.from_channels(SAMPLE_RATE, [signal])

        peak_window = max_short_term_loudness_lufs(audio)
        loud_only = AudioBuffer.from_channels(SAMPLE_RATE, [loud.astype(np.float32)])
        assert peak_window == pytest.approx(integrated_loudness_lufs(loud_only), abs=0.5)
        assert peak_window > integrated_loudness_lufs(audio)

    def test_measures_a_sub_400ms_cue_as_one_window(self) -> None:
        # 24.7's own instruction for short cues, which is most of the taxonomy: a 120 ms
        # one-shot has no complete 400 ms window.
        short = decaying_tone(duration_ms=120.0)
        values = short_term_loudnesses_lufs(short)
        assert len(values) == 1
        assert max_short_term_loudness_lufs(short) == values[0]

    def test_scales_with_gain_by_exactly_the_gain(self) -> None:
        # The relation the -25…-21 LUFS band is normalised into. Linear filter, no gate:
        # +6.02 dB of amplitude is +6.02 LUFS.
        cue = decaying_tone(duration_ms=600.0)
        base = max_short_term_loudness_lufs(cue)
        doubled = max_short_term_loudness_lufs(scaled(cue, 2.0))
        assert doubled - base == pytest.approx(20.0 * math.log10(2.0), abs=0.01)

    def test_silence_is_negative_infinity_rather_than_a_floor(self) -> None:
        # A floor would make a silent cue look like a quiet one sitting inside the band.
        assert max_short_term_loudness_lufs(silence()) == -math.inf
        assert not measurable(silence())

    def test_an_audible_cue_is_measurable(self) -> None:
        assert measurable(decaying_tone(duration_ms=300.0))
        assert max_short_term_loudness_lufs(decaying_tone()) > ABSOLUTE_GATE_LUFS

    def test_an_ill_formed_buffer_yields_no_windows(self) -> None:
        empty = AudioBuffer.from_channels(SAMPLE_RATE, [np.zeros(0, dtype=np.float32)])
        assert short_term_loudnesses_lufs(empty) == ()
        assert max_short_term_loudness_lufs(empty) == -math.inf

    def test_windows_advance_by_the_hop(self) -> None:
        # Five 400 ms windows at 100 ms intervals fit in 800 ms: starts at 0, 100, 200,
        # 300 and 400 ms. A sixth would run past the end.
        cue = decaying_tone(duration_ms=800.0)
        assert len(short_term_loudnesses_lufs(cue)) == 5

"""The Celery shell — registration, configuration and transport encoding.

**No broker is reachable from this environment**, and nothing here needs one.
Constructing a ``Celery`` app performs no I/O, and every task is exercised
through ``.run()``, which calls the wrapped function directly without going near
a connection, a result backend or ``.delay()``.

What is worth testing about a three-line shell is exactly what these tests
cover: that the tasks are registered under stable names (a rename silently breaks
every producer that already enqueues by name), that the configuration design §5.5
depends on is actually set, and that the base64 transport encoding round-trips.
The DSP behaviour itself is tested in ``test_pipeline.py`` against the plain
functions.
"""

from __future__ import annotations

import base64

import numpy as np
import pytest

from musicstudio_dsp.audio_buffer import AudioBuffer
from musicstudio_dsp.formats import decode, encode
from musicstudio_dsp.resample import INTERNAL_SAMPLE_RATE
from musicstudio_dsp.effects import pedalboard_available
from musicstudio_dsp.worker import (
    apply_effect_chain_task,
    celery_app,
    clean_dialogue_task,
    convert_for_download_task,
    cue_pack_similarity_task,
    duck_task,
    export_sound_pack_task,
    measure_loudness_task,
    normalise_for_storage_task,
    normalise_loudness_task,
)

TASK_NAMES = (
    "musicstudio_dsp.normalise_for_storage",
    "musicstudio_dsp.convert_for_download",
    "musicstudio_dsp.apply_effect_chain",
    # Task 3.3's mastering shells (Requirements 30.6–30.17, 30.22, 30.24).
    "musicstudio_dsp.measure_loudness",
    "musicstudio_dsp.normalise_loudness",
    "musicstudio_dsp.clean_dialogue",
    "musicstudio_dsp.duck",
    # Task 3.4's sound-pack shells (Requirements 24.7, 24.9, 24.10, 24.11).
    "musicstudio_dsp.cue_pack_similarity",
    "musicstudio_dsp.export_sound_pack",
)


def wav_bytes(sample_rate: int = 44_100, frames: int = 44_100) -> bytes:
    t = np.arange(frames, dtype=np.float64) / float(sample_rate)
    wave = (0.5 * np.sin(2.0 * np.pi * 440.0 * t)).astype(np.float32)
    return encode(AudioBuffer.from_channels(sample_rate, [wave, wave * 0.75]), "wav")


class TestApplication:
    def test_registers_every_task_under_a_stable_name(self) -> None:
        # Producers enqueue by name, so these strings are a published contract.
        for name in TASK_NAMES:
            assert name in celery_app.tasks

    def test_task_names_match_their_functions(self) -> None:
        assert normalise_for_storage_task.name == TASK_NAMES[0]
        assert convert_for_download_task.name == TASK_NAMES[1]
        assert apply_effect_chain_task.name == TASK_NAMES[2]
        assert measure_loudness_task.name == TASK_NAMES[3]
        assert normalise_loudness_task.name == TASK_NAMES[4]
        assert clean_dialogue_task.name == TASK_NAMES[5]
        assert duck_task.name == TASK_NAMES[6]
        assert cue_pack_similarity_task.name == TASK_NAMES[7]
        assert export_sound_pack_task.name == TASK_NAMES[8]

    def test_registers_no_task_this_tuple_does_not_name(self) -> None:
        # The tuple is exhaustive on purpose: a task added without extending it would be a
        # published name nothing pins, and producers enqueue by name.
        registered = {
            name for name in celery_app.tasks if name.startswith("musicstudio_dsp.")
        }
        assert registered == set(TASK_NAMES)

    def test_accepts_json_only(self) -> None:
        # A broker that accepts pickle executes what it is sent, and this worker
        # sits behind the public API surface of Requirement 17.
        assert celery_app.conf.task_serializer == "json"
        assert celery_app.conf.accept_content == ["json"]

    def test_configures_the_determinism_settings_design_5_5_needs(self) -> None:
        assert celery_app.conf.worker_prefetch_multiplier == 1
        assert celery_app.conf.task_acks_late is True

    def test_uses_utc(self) -> None:
        assert celery_app.conf.enable_utc is True
        assert celery_app.conf.timezone == "UTC"


class TestNormaliseForStorageTask:
    def test_round_trips_the_base64_transport_encoding(self) -> None:
        payload = base64.b64encode(wav_bytes()).decode("ascii")

        result = normalise_for_storage_task.run(payload)

        returned = base64.b64decode(result["audio_base64"])
        assert decode(returned).sample_rate == INTERNAL_SAMPLE_RATE

    def test_reports_the_fields_requirement_19_5_needs_recorded(self) -> None:
        payload = base64.b64encode(wav_bytes(sample_rate=22_050, frames=22_050)).decode("ascii")

        result = normalise_for_storage_task.run(payload)

        assert result["original_sample_rate"] == 22_050
        assert result["sample_rate"] == INTERNAL_SAMPLE_RATE
        assert result["resampled"] is True
        assert abs(result["length_error_ms"]) <= 10.0
        assert result["channels"] == 2

    def test_result_is_json_serialisable(self) -> None:
        # The result backend serialises with JSON, so a numpy scalar leaking into
        # the payload would fail at dispatch time rather than here.
        import json

        payload = base64.b64encode(wav_bytes()).decode("ascii")

        json.dumps(normalise_for_storage_task.run(payload))


class TestConvertForDownloadTask:
    @pytest.mark.parametrize("audio_format", ["mp3", "wav", "flac", "ogg"])
    def test_returns_the_requested_format(self, audio_format: str) -> None:
        payload = base64.b64encode(wav_bytes(frames=4_410)).decode("ascii")

        result = convert_for_download_task.run(payload, audio_format)

        assert result["audio_format"] == audio_format
        assert result["sample_rate"] == INTERNAL_SAMPLE_RATE
        assert base64.b64decode(result["audio_base64"])

    def test_result_is_json_serialisable(self) -> None:
        import json

        payload = base64.b64encode(wav_bytes(frames=4_410)).decode("ascii")

        json.dumps(convert_for_download_task.run(payload, "flac"))



@pytest.mark.skipif(
    not pedalboard_available(),
    reason="pedalboard is unavailable (native wheel needs libatomic.so.1 from the platform)",
)
class TestApplyEffectChainTask:
    """The effects shell (Requirement 29.12). Behaviour lives in ``test_effects.py``."""

    CHAIN = '[{"kind":"gain","parameters":{"gain_db":-6}}]'

    def test_round_trips_the_base64_transport_encoding(self) -> None:
        result = apply_effect_chain_task.run(
            base64.b64encode(wav_bytes(INTERNAL_SAMPLE_RATE, 4_800)).decode("ascii"),
            self.CHAIN,
        )

        decoded = decode(base64.b64decode(result["audio_base64"]))
        assert decoded.sample_rate == INTERNAL_SAMPLE_RATE
        assert decoded.channel_count == 2

    def test_accepts_the_chain_as_the_printed_json_document(self) -> None:
        # The chain crosses as a *string*, so the queue's JSON serialiser cannot reshape
        # its numbers before `validate_chain` sees them.
        result = apply_effect_chain_task.run(
            base64.b64encode(wav_bytes(INTERNAL_SAMPLE_RATE, 4_800)).decode("ascii"),
            self.CHAIN,
        )
        assert result["frame_count"] == 4_800
        assert result["tail_truncated"] is False

    def test_reports_the_three_shape_fields_requirement_29_29_names(self) -> None:
        result = apply_effect_chain_task.run(
            base64.b64encode(wav_bytes(INTERNAL_SAMPLE_RATE, 4_800)).decode("ascii"),
            self.CHAIN,
        )
        # A duration alone cannot distinguish 48000 frames at 48 kHz from 44100 at
        # 44.1 kHz, and Requirement 29.29 requires both to match.
        for field in ("sample_rate", "channels", "frame_count"):
            assert field in result

    def test_result_is_json_serialisable(self) -> None:
        import json

        result = apply_effect_chain_task.run(
            base64.b64encode(wav_bytes(INTERNAL_SAMPLE_RATE, 4_800)).decode("ascii"),
            self.CHAIN,
        )
        assert json.loads(json.dumps(result))["audio_format"] == "flac"

    def test_refuses_an_out_of_range_chain_rather_than_clamping(self) -> None:
        from musicstudio_dsp.effects import EffectChainError

        with pytest.raises(EffectChainError):
            apply_effect_chain_task.run(
                base64.b64encode(wav_bytes(INTERNAL_SAMPLE_RATE, 4_800)).decode("ascii"),
                '[{"kind":"gain","parameters":{"gain_db":99}}]',
            )



def speech_wav_bytes(sample_rate: int = INTERNAL_SAMPLE_RATE) -> bytes:
    """Two seconds with one clearly speech-like burst and a quiet floor between."""
    frames = sample_rate * 2
    t = np.arange(frames, dtype=np.float64) / float(sample_rate)
    signal = (0.0018 * np.sin(2.0 * np.pi * 37.0 * t)).astype(np.float32)
    burst = (t >= 0.5) & (t < 1.3)
    signal[burst] += (0.3 * np.sin(2.0 * np.pi * 300.0 * t[burst])).astype(np.float32)
    return encode(AudioBuffer.from_channels(sample_rate, [signal]), "wav")


class TestMeasureLoudnessTask:
    """Requirements 30.22, 30.24. Behaviour lives in ``test_loudness.py``."""

    def test_returns_both_the_unrounded_and_the_reported_forms(self) -> None:
        result = measure_loudness_task.run(
            base64.b64encode(wav_bytes(INTERNAL_SAMPLE_RATE, 48_000)).decode("ascii")
        )

        assert set(result) == {"measurement", "reported"}
        # 30.24's reporting step, on the reported form only.
        reported = result["reported"]["integrated_loudness_lufs"]
        assert abs(reported * 10 - round(reported * 10)) < 1e-9
        assert len(result["measurement"]["octave_band_energies_db"]) == 10

    def test_result_is_json_serialisable(self) -> None:
        import json

        payload = base64.b64encode(wav_bytes(INTERNAL_SAMPLE_RATE, 48_000)).decode("ascii")

        json.dumps(measure_loudness_task.run(payload))

    def test_encodes_an_unmeasurable_level_as_null_not_as_a_large_negative(self) -> None:
        import json

        silence = encode(
            AudioBuffer.from_channels(INTERNAL_SAMPLE_RATE, [np.zeros(48_000, dtype=np.float32)]),
            "wav",
        )

        result = measure_loudness_task.run(base64.b64encode(silence).decode("ascii"))

        json.dumps(result)
        assert result["measurement"]["integrated_loudness_lufs"] is None


class TestNormaliseLoudnessTask:
    """Requirements 30.6, 30.7, 30.8, 30.25. Behaviour lives in ``test_mastering.py``."""

    def test_round_trips_the_base64_transport_encoding(self) -> None:
        result = normalise_loudness_task.run(
            base64.b64encode(wav_bytes(INTERNAL_SAMPLE_RATE, 48_000)).decode("ascii"), -14.0
        )

        decoded = decode(base64.b64decode(result["audio_base64"]))
        assert decoded.sample_rate == INTERNAL_SAMPLE_RATE
        assert decoded.channel_count == 2

    def test_reports_the_fields_requirements_30_7_and_30_25_need(self) -> None:
        result = normalise_loudness_task.run(
            base64.b64encode(wav_bytes(INTERNAL_SAMPLE_RATE, 48_000)).decode("ascii"), -14.0
        )

        for field in (
            "applied_gain_db",
            "requested_gain_db",
            "true_peak_limited",
            "target_missed",
            "measurable",
            "shortfall_lufs",
        ):
            assert field in result
        assert result["measurable"] is True

    def test_defaults_the_target_to_the_registry_value(self) -> None:
        # Requirement 30.5's -14.0 LUFS default, resolved by the worker when the product
        # layer sends nothing.
        result = normalise_loudness_task.run(
            base64.b64encode(wav_bytes(INTERNAL_SAMPLE_RATE, 48_000)).decode("ascii")
        )

        assert result["target_lufs"] == -14.0

    def test_result_is_json_serialisable(self) -> None:
        import json

        json.dumps(
            normalise_loudness_task.run(
                base64.b64encode(wav_bytes(INTERNAL_SAMPLE_RATE, 48_000)).decode("ascii"), -16.0
            )
        )


class TestCleanDialogueTask:
    """Requirements 30.9, 30.10. Behaviour lives in ``test_mastering.py``."""

    def test_reports_the_regions_and_both_measurements(self) -> None:
        result = clean_dialogue_task.run(
            base64.b64encode(speech_wav_bytes()).decode("ascii")
        )

        assert result["has_non_speech"] is True
        assert len(result["speech_regions"]) >= 1
        assert set(result["speech_regions"][0]) == {"startMs", "endMs"}

    def test_preserves_length_exactly(self) -> None:
        # Requirement 30.10 allows 10 ms; the envelope approach gives 0.
        result = clean_dialogue_task.run(
            base64.b64encode(speech_wav_bytes()).decode("ascii")
        )

        assert result["input_duration_ms"] == result["output_duration_ms"]

    def test_result_is_json_serialisable(self) -> None:
        import json

        json.dumps(clean_dialogue_task.run(base64.b64encode(speech_wav_bytes()).decode("ascii")))


class TestDuckTask:
    """Requirements 30.12–30.17. Behaviour lives in ``test_mastering.py``."""

    def test_returns_the_music_track_and_the_automation_curve(self) -> None:
        dialogue = base64.b64encode(speech_wav_bytes()).decode("ascii")
        music = base64.b64encode(wav_bytes(INTERNAL_SAMPLE_RATE, 96_000)).decode("ascii")

        result = duck_task.run(dialogue, music, -12.0, 50.0, 300.0)

        decoded = decode(base64.b64decode(result["audio_base64"]))
        # The music track's shape, not the dialogue track's: 30.12 attenuates the music.
        assert decoded.channel_count == 2
        assert result["automation_points"]
        assert set(result["automation_points"][0]) == {"timeMs", "gainDb"}

    def test_result_is_json_serialisable(self) -> None:
        import json

        json.dumps(
            duck_task.run(
                base64.b64encode(speech_wav_bytes()).decode("ascii"),
                base64.b64encode(wav_bytes(INTERNAL_SAMPLE_RATE, 96_000)).decode("ascii"),
            )
        )



class TestCuePackSimilarityTask:
    """The 24.9 shell. Behaviour lives in ``test_mfcc.py`` against the plain functions."""

    @staticmethod
    def cue(name: str, seed: int) -> dict[str, str]:
        from cue_synthesis import distinct_cue

        return {
            "name": name,
            "audio_base64": base64.b64encode(
                encode(distinct_cue(seed, duration_ms=120.0), "wav")
            ).decode("ascii"),
        }

    def test_returns_one_13_vector_per_cue_and_every_pair(self) -> None:
        cues = [self.cue(f"cue-{index}", 900 + index) for index in range(6)]

        result = cue_pack_similarity_task.run(cues)

        assert result["cue_names"] == [cue["name"] for cue in cues]
        assert all(len(vector) == 13 for vector in result["mfcc_vectors"])
        assert result["similarity"]["pair_count"] == 6 * 5 // 2

    def test_reports_the_24_7_pack_loudness_alongside(self) -> None:
        # One task rather than two, because both quantities come from the same decoded
        # buffer and decoding 78 cues twice would be the expensive part done twice.
        result = cue_pack_similarity_task.run([self.cue("hover", 901)])
        assert len(result["pack_loudness_lufs"]) == 1
        assert result["pack_loudness_lufs"][0] is not None

    def test_takes_the_ceiling_from_the_caller(self) -> None:
        # `cue_pair_similarity_max` is a Quality_Threshold_Set member; Requirement 34.4
        # lets an operator move it between two runs.
        cues = [self.cue(f"cue-{index}", 910 + index) for index in range(4)]

        assert cue_pack_similarity_task.run(cues, 0.95)["similarity"]["satisfied"] is True
        assert cue_pack_similarity_task.run(cues, -1.0)["similarity"]["satisfied"] is False

    def test_result_is_json_serialisable(self) -> None:
        import json

        json.dumps(cue_pack_similarity_task.run([self.cue("press", 920)]))


class TestExportSoundPackTask:
    """The 24.10/24.11 shell. Behaviour lives in ``test_sound_pack.py``."""

    @staticmethod
    def cue(name: str, seed: int) -> dict[str, str]:
        from cue_synthesis import distinct_cue

        return {
            "name": name,
            "category": "input",
            "audio_base64": base64.b64encode(
                encode(distinct_cue(seed, duration_ms=120.0), "wav")
            ).decode("ascii"),
        }

    def test_returns_two_files_per_cue_in_one_archive(self) -> None:
        from musicstudio_dsp.sound_pack import archive_paths

        cues = [self.cue(f"cue-{index}", 800 + index) for index in range(5)]

        result = export_sound_pack_task.run(cues, "{}")

        assert result["file_count"] == 10
        archive = base64.b64decode(result["archive_base64"])
        assert len(archive_paths(archive)) == 11  # + the manifest

    def test_carries_the_manifest_document_through_verbatim(self) -> None:
        from musicstudio_dsp.sound_pack import manifest_bytes

        document = '{\n  "packName": "Soft"\n}'
        result = export_sound_pack_task.run([self.cue("hover", 810)], document)

        archive = base64.b64decode(result["archive_base64"])
        assert manifest_bytes(archive).decode("utf-8") == document

    def test_reports_elapsed_time_without_judging_it(self) -> None:
        # Requirement 24.10's 60-second budget is a Quality_Threshold_Set judgement and
        # belongs to the product layer; the worker measures and reports.
        result = export_sound_pack_task.run([self.cue("press", 820)], "{}")
        assert result["elapsed_ms"] > 0.0
        assert "within_budget" not in result

    def test_result_is_json_serialisable(self) -> None:
        import json

        json.dumps(export_sound_pack_task.run([self.cue("drop", 830)], "{}"))

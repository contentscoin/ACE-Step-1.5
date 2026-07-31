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
    convert_for_download_task,
    normalise_for_storage_task,
)

TASK_NAMES = (
    "musicstudio_dsp.normalise_for_storage",
    "musicstudio_dsp.convert_for_download",
    "musicstudio_dsp.apply_effect_chain",
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

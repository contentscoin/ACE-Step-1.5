"""MusicStudio DSP worker package (design §5, §12).

The base pipeline of design §5.1–§5.2 lives here: the PCM buffer shape
(:mod:`musicstudio_dsp.audio_buffer`), 48 kHz normalisation with ``libsoxr`` VHQ
(:mod:`musicstudio_dsp.resample`), container conversion for the four download
formats (:mod:`musicstudio_dsp.formats`), the composed operations
(:mod:`musicstudio_dsp.pipeline`), and the Celery shell over them
(:mod:`musicstudio_dsp.worker`).

Design §5.5's processing sits on top: the eight effects of Requirement 29.1
(:mod:`musicstudio_dsp.effects`), BS.1770-4 loudness and true peak over
``pyloudnorm`` (:mod:`musicstudio_dsp.loudness`), and Requirement 30's
normalisation, dialogue cleanup and auto-ducking
(:mod:`musicstudio_dsp.mastering`). Design §6.1's deterministic timeline
mixdown is :mod:`musicstudio_dsp.mixdown`. Onset detection is added by the task
that owns it.

:mod:`musicstudio_dsp.worker` is the only module that imports Celery, and it is
imported lazily by nothing else, so the pipeline is usable and testable with no
broker in sight.

This package never imports ``acestep``; the engine is reached only through the
``ACE_Engine_Adapter`` HTTP interface (design §1.4.4).
"""

from .audio_buffer import AudioBuffer, from_interleaved, to_interleaved, window_sample_count
from .loudness import (
    MeasurementReport,
    integrated_loudness_lufs,
    measure,
    octave_band_energies_db,
    true_peak_dbtp,
)
from .mastering import (
    CleanupResult,
    DuckingResult,
    NormalisationResult,
    SpeechRegion,
    clean_dialogue,
    detect_speech_regions,
    duck,
    normalise_loudness,
)
from .formats import (
    DOWNLOAD_FORMATS,
    LOSSLESS_FORMATS,
    SFX_DOWNLOAD_FORMATS,
    AudioFormat,
    UnsupportedFormatError,
    convert,
    decode,
    encode,
)
from .pipeline import (
    AssetAudioShape,
    NormalisedAudio,
    convert_for_download,
    describe_audio,
    normalise_for_storage,
)
from .resample import (
    INTERNAL_SAMPLE_RATE,
    LENGTH_TOLERANCE_MS,
    RESAMPLE_QUALITY,
    LengthToleranceExceededError,
    ResampleReport,
    normalise_sample_rate,
    normalise_sample_rate_strict,
    resample,
)

__all__ = [
    "AssetAudioShape",
    "AudioBuffer",
    "AudioFormat",
    "CleanupResult",
    "DOWNLOAD_FORMATS",
    "DuckingResult",
    "INTERNAL_SAMPLE_RATE",
    "LENGTH_TOLERANCE_MS",
    "LOSSLESS_FORMATS",
    "LengthToleranceExceededError",
    "MeasurementReport",
    "NormalisationResult",
    "NormalisedAudio",
    "RESAMPLE_QUALITY",
    "ResampleReport",
    "SFX_DOWNLOAD_FORMATS",
    "SpeechRegion",
    "UnsupportedFormatError",
    "__version__",
    "clean_dialogue",
    "convert",
    "convert_for_download",
    "decode",
    "describe_audio",
    "detect_speech_regions",
    "duck",
    "encode",
    "from_interleaved",
    "integrated_loudness_lufs",
    "measure",
    "normalise_for_storage",
    "normalise_loudness",
    "normalise_sample_rate",
    "normalise_sample_rate_strict",
    "octave_band_energies_db",
    "resample",
    "to_interleaved",
    "true_peak_dbtp",
    "window_sample_count",
]

__version__ = "0.0.0"

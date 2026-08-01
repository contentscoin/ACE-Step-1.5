"""Clip effects inside a mixdown, and the tail policy (Requirements 29.31, 29.32; design §6.3).

This module is small on purpose. It is the **wiring**, not a third implementation:

* the effect processing is :func:`musicstudio_dsp.effects.apply_chain` (task 3.2), including
  the silence padding that lets a delay or reverb tail develop and the trim that caps it at
  Requirement 29.32's allowance;
* the per-clip stage order and the cut to the play length are
  :func:`musicstudio_dsp.mixdown._clip_signal` (task 4.2), which already conforms every clip to
  its play length at step 4 whether or not anything lengthened it;
* what was missing is the ``effect_processor`` those two need to meet, and the statement of
  *which* ceiling applies *where*. That is here.

### The tail goes two ways, and only one of them keeps it

Design §6.3, in full: 딜레이/리버브 포함 이펙트 → 테일 발생 → **클립 재생 길이**에서 잘라냄;
이펙트 테일은 독립 Generation_Version 저장 시에만 보존 (최대 +10000ms).

So:

============================  ==========================================  ==========
destination                   tail                                        clause
============================  ==========================================  ==========
inside a mixdown              cut at the clip's play length                29.31
independent Generation_Version  preserved, up to original + 10 000 ms      29.32
============================  ==========================================  ==========

:func:`clip_effect_processor` is the mixdown arm. It deliberately does **not** truncate: it
returns whatever :func:`~musicstudio_dsp.effects.apply_chain` produced, tail and all, and
:mod:`musicstudio_dsp.mixdown` cuts it to the play length one stage later. Truncating here as
well would put the same rule in two places, and the copy in ``mixdown.py`` is the one
Requirement 28.25's length arithmetic depends on — it runs for clips with no chain too.

The version arm needs no code here at all: ``apply_chain`` already caps at
``original + tail_allowance_ms`` and reports ``tail_truncated``, and the product layer's
``lengthViolationFor`` (``services/effects/effects-service.ts``) is what judges the result.
:func:`version_tail_ceiling_ms` exists so that the two ceilings can be *stated together*, which
is the only way to read design §6.3 as one policy rather than two unrelated numbers.

### Determinism

Nothing is added to what tasks 3.2 and 4.2 already argued. ``apply_chain`` builds a fresh
``Pedalboard`` per call, so no delay line or reverb tank carries state from one clip into the
next or from one render into the next — which is what makes Requirement 28.27's reproducibility
survive the arrival of clip effects. :func:`clip_effect_processor` holds no state of its own: it
is a closure over nothing, returned as a function only because
:data:`musicstudio_dsp.mixdown.ClipEffectProcessor` is the seam's shape.

The order clips are processed in cannot matter for the same reason: each clip's chain sees only
that clip's audio, and a fresh board. ``dsp/test/test_mixdown.py``'s Property 13 asserts this
with an ``effect_processor`` supplied, which is exactly the case the reproducibility claim
would fail in if a board were reused.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

from .audio_buffer import AudioBuffer
from .effects import apply_chain, chain_extends_tail, registry, validate_chain
from .mixdown import ClipEffectProcessor

__all__ = [
    "MIXDOWN_TAIL_PRESERVED",
    "chain_needs_tail_room",
    "clip_effect_processor",
    "mixdown_tail_ceiling_ms",
    "tail_allowance_ms",
    "version_tail_ceiling_ms",
]

#: Design §6.3: a mixdown never keeps an effect tail. Stated as a named constant rather than
#: left implicit, because "the tail is discarded" is the *policy*, and a reader of
#: :func:`clip_effect_processor` would otherwise have to infer it from the absence of code.
MIXDOWN_TAIL_PRESERVED = False


def tail_allowance_ms() -> int:
    """Requirement 29.32's allowance, read from the effect registry.

    Not a literal here. ``effect_registry.json`` is the single declaration on the Python side
    and ``domain/effects/registry.ts`` is its mirror on the other, with a bidirectional parity
    test between them; a third copy in this module would be the one that drifted.
    """
    return registry().tail_allowance_ms


def mixdown_tail_ceiling_ms(play_length_ms: float) -> float:
    """Requirement 29.31: inside a mix, a clip is exactly its play length.

    Takes the play length rather than computing it, for the reason
    :class:`musicstudio_dsp.mixdown.MixdownClip` gives: Requirement 28.13 derives it from the
    *stored* asset duration, and re-deriving it from a decoded frame count would let a one-frame
    decode difference move the mix length.
    """
    return play_length_ms


def version_tail_ceiling_ms(original_length_ms: float) -> float:
    """Requirement 29.32: stored as its own version, a tail survives up to +10 000 ms."""
    return original_length_ms + tail_allowance_ms()


def chain_needs_tail_room(items: Sequence[Mapping[str, Any]]) -> bool:
    """Whether this chain can ring on past its input (Requirements 29.30, 29.32).

    Delegates to :func:`musicstudio_dsp.effects.chain_extends_tail`, which reads the
    ``extends_tail`` flag off the registry, so "delay and reverb are the tail-extending two" is
    recorded once for both requirements rather than as a pair of hard-coded names.
    """
    return chain_extends_tail(validate_chain(items))


def clip_effect_processor() -> ClipEffectProcessor:
    """Requirement 29.31's stage 3, as :mod:`musicstudio_dsp.mixdown` wants it.

    ``mixdown.render_mixdown(..., effect_processor=clip_effect_processor())`` is what turns
    :class:`~musicstudio_dsp.mixdown.MixdownClip.effect_chain` from a wired slot into applied
    audio. Without it a clip carrying a chain is *refused* with
    ``mixdown_clip_effects_unsupported`` rather than silently rendered dry — task 4.2's choice,
    and the reason there is no path where a user's edits go missing from a mix that looks
    finished.

    ### Validation is not skipped, and not duplicated either

    ``apply_chain`` validates the chain (Requirements 29.9, 29.10, 29.13) before touching
    ``pedalboard``. The product layer validated it too, when the clip was stored — a
    ``TimelineClip``'s chain goes through ``chainViolations`` in
    ``domain/timeline/project.ts``. Both checks stay: the worker accepts whatever is on the
    queue, and :mod:`musicstudio_dsp.effects` gives the argument for that in full.

    ### The tail is *not* cut here

    See the module docstring. This returns ``apply_chain``'s audio unchanged, including the
    tail, and ``mixdown._clip_signal`` cuts it to the play length at the next stage. Cutting
    here as well would be a second copy of Requirement 28.13's arithmetic, and the copy in
    ``mixdown.py`` is the one that also runs for clips with no chain.
    """

    def process(audio: AudioBuffer, items: Sequence[Mapping[str, Any]]) -> AudioBuffer:
        return apply_chain(audio, items).audio

    return process

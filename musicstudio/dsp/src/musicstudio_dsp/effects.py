"""The eight effects of Requirement 29.1, over ``pedalboard`` (design §5.5).

Plain callables, like :mod:`musicstudio_dsp.pipeline`. Nothing here imports Celery,
touches a broker or reaches the network; :mod:`musicstudio_dsp.worker`'s task shell
is three lines and delegates. That is what makes the effects testable, because **no
broker is reachable from a test environment**.

### Where the parameter ranges come from

Not from constants in this file. They are loaded from ``effect_registry.json``, which
sits beside this module and is the DSP worker's single declaration of Requirements
29.1–29.8. The TypeScript product layer declares the same table in
``domain/effects/registry.ts`` and ``test/unit/effects/registry-parity.test.ts``
compares the two in both directions, so the numbers cannot drift apart silently.

The registry's parameter names are ``pedalboard``'s keyword arguments, quoted verbatim
from the requirement text, so :func:`build_plugin` splats a validated parameter map
straight into a constructor. There is no mapping table, which is one fewer thing to
keep in step — and :func:`build_plugin`'s ``TypeError`` guard turns a future
``pedalboard`` rename into a clear failure rather than a silently ignored parameter.

### Why the worker validates too

The product layer already refuses an out-of-range chain before queueing work — that is
what makes Requirement 29.10's synchronous response possible (see
``services/effects/ports.ts``). This module validates *again*, and does not treat the
duplication as waste. A Celery task accepts whatever is on the queue: a replayed
message, a hand-crafted payload, or a caller written after this one. Requirement 29.10
says the *service* refuses out-of-range parameters, and silently clamping them here
would make the worker the one place a forbidden value took effect. So
:func:`apply_chain` raises :class:`EffectChainError` rather than clamping.

### Determinism (design §5.5, Requirement 29.29)

Requirement 29.29 requires two processings of the same audio with an equivalent chain
to produce bit-identical samples. Three things make that hold, and one of them is not
this module's to give:

1. **``pedalboard`` plugin state is not reused.** :func:`apply_chain` builds a fresh
   ``Pedalboard`` on every call. Delay lines, reverb tanks and compressor envelopes are
   *stateful*; reusing a board would make the second call's output depend on the first
   call's tail, which is exactly the reproducibility failure 29.29 forbids.
2. **No dithering, no randomness.** Nothing here draws from an RNG, and the export
   depth conversion of :mod:`musicstudio_dsp.formats` is applied downstream, not here.
3. **Single-threaded BLAS is *not* set here, and cannot be.** Design §5.5 asks for it,
   but NumPy fixes its thread-pool size when its backend loads — before this module is
   imported — so an ``os.environ`` write in this file would be read by nothing. It
   belongs in the worker container's environment (``OMP_NUM_THREADS=1`` and the vendor
   equivalents), which design §11.3's topology is where to declare. :mod:`worker` says
   the same thing about its own Celery config.

   The reproducibility property therefore does not *rely* on the thread count being
   pinned: the arithmetic that must be bit-exact is inside ``pedalboard``'s own
   single-threaded C++ processing, which does not go through BLAS at all. The NumPy
   work in this module is elementwise (slicing, padding, dtype conversion), and
   elementwise operations are not parallelised or reassociated by any BLAS backend. So
   the property is thread-count independent by construction rather than by
   configuration, and ``dsp/test/test_effects.py`` asserts it under whatever thread
   count the test process happens to have. See that file's ``TestDeterminism`` for the
   argument stated as a test.

### The tail rules

Requirement 29.30 requires a chain with neither delay nor reverb to preserve length
within 10 ms; 29.32 caps a chain with either at the original length plus 10 s.
``pedalboard`` returns exactly as many frames as it is given for every one of the eight
effects — including ``PitchShift``, which is what Requirement 29.8's "재생 속도를
변경하지 않고 시간축 길이를 보존" asks for — so length preservation is inherited rather
than enforced. The reverb and delay *tails* are the exception: they only exist if the
caller asks for them by padding the input, which :func:`apply_chain` does deliberately
and then trims to 29.32's ceiling.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

from .audio_buffer import AudioBuffer, SAMPLE_DTYPE

__all__ = [
    "EFFECT_KINDS",
    "EffectChainError",
    "EffectItem",
    "EffectRegistry",
    "ParameterRange",
    "ProcessedAudio",
    "apply_chain",
    "chain_extends_tail",
    "parse_chain",
    "pedalboard_available",
    "registry",
    "validate_chain",
]

REGISTRY_PATH = Path(__file__).with_name("effect_registry.json")


@dataclass(frozen=True)
class ParameterRange:
    """An inclusive range, as Requirements 29.2–29.8 state them ("이상 … 이하")."""

    minimum: float
    maximum: float

    def contains(self, value: float) -> bool:
        """Whether ``value`` is admissible.

        Non-finite values are rejected before the comparison. ``NaN`` fails both
        ``<`` and ``>``, so a bare range test would *accept* it, and a ``NaN``
        reaching ``pedalboard`` poisons every subsequent sample.
        """
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return False
        if not np.isfinite(value):
            return False
        return self.minimum <= float(value) <= self.maximum

    def describe(self) -> str:
        """Requirement 29.10's payload: the permitted range, rendered."""
        return f"{self.minimum}..{self.maximum}"


@dataclass(frozen=True)
class EffectDefinition:
    kind: str
    extends_tail: bool
    parameters: Mapping[str, ParameterRange]


@dataclass(frozen=True)
class EffectRegistry:
    """Requirements 29.1–29.8, 29.13, loaded from ``effect_registry.json``."""

    effects: Mapping[str, EffectDefinition]
    chain_item_count_min: int
    chain_item_count_max: int
    parameter_tolerance: float
    tail_allowance_ms: int
    length_tolerance_ms: int

    @property
    def kinds(self) -> tuple[str, ...]:
        return tuple(self.effects)

    def definition(self, kind: str) -> EffectDefinition:
        try:
            return self.effects[kind]
        except KeyError as error:
            raise EffectChainError(
                0, "unknown_effect_kind", name=kind, expected="|".join(self.kinds)
            ) from error


@lru_cache(maxsize=1)
def registry() -> EffectRegistry:
    """The registry, read once.

    Cached because it is immutable and because reading it per chain would put a file
    open inside the processing hot path.
    """
    raw: dict[str, Any] = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    effects = {
        kind: EffectDefinition(
            kind=kind,
            extends_tail=bool(spec["extends_tail"]),
            parameters={
                name: ParameterRange(minimum=float(bounds["min"]), maximum=float(bounds["max"]))
                for name, bounds in spec["parameters"].items()
            },
        )
        for kind, spec in raw["effects"].items()
    }
    return EffectRegistry(
        effects=effects,
        chain_item_count_min=int(raw["chain_item_count_min"]),
        chain_item_count_max=int(raw["chain_item_count_max"]),
        parameter_tolerance=float(raw["parameter_tolerance"]),
        tail_allowance_ms=int(raw["tail_allowance_ms"]),
        length_tolerance_ms=int(raw["length_tolerance_ms"]),
    )


#: Requirement 29.1's eight kinds, in the registry's published order.
EFFECT_KINDS: tuple[str, ...] = registry().kinds


class EffectChainError(ValueError):
    """A refused chain, carrying what Requirements 29.9, 29.10 and 29.33 return.

    ``index`` is the offending item's position, ``violation`` a stable code, ``name``
    the offending kind or parameter name, and ``expected`` the permitted range. The
    same four fields the TypeScript ``ChainViolation`` carries, so an error crossing
    the seam does not have to be reshaped.
    """

    def __init__(
        self,
        index: int,
        violation: str,
        *,
        name: str | None = None,
        expected: str | None = None,
        actual: str | None = None,
    ) -> None:
        self.index = index
        self.violation = violation
        self.name = name
        self.expected = expected
        self.actual = actual
        detail = ", ".join(
            part
            for part in (
                f"index {index}",
                violation,
                None if name is None else f"name={name}",
                None if expected is None else f"expected={expected}",
                None if actual is None else f"actual={actual}",
            )
            if part is not None
        )
        super().__init__(detail)


@dataclass(frozen=True)
class EffectItem:
    """One validated position in a chain."""

    kind: str
    parameters: Mapping[str, float]


def validate_chain(items: Sequence[Mapping[str, Any]]) -> tuple[EffectItem, ...]:
    """Requirements 29.9, 29.10, 29.13: the same rules the product layer applies.

    Raises :class:`EffectChainError` on the **first** violation, in item order, which
    matches what Requirement 29.33 specifies for the ``Chain_Parser``. The product
    layer's ``chainViolations`` reports the whole list because Requirements 29.9 and
    29.10 place no first-only limit on the *service*; the worker is past the point
    where a user is composing a chain interactively, so one clear fault is enough and
    it is the same first fault the parser would have named.
    """
    reg = registry()

    if not isinstance(items, Sequence) or isinstance(items, (str, bytes)):
        raise EffectChainError(0, "chain_not_array", actual=type(items).__name__)

    if len(items) < reg.chain_item_count_min:
        raise EffectChainError(
            0,
            "chain_too_few_items",
            actual=str(len(items)),
            expected=f"{reg.chain_item_count_min}..{reg.chain_item_count_max}",
        )
    if len(items) > reg.chain_item_count_max:
        raise EffectChainError(
            reg.chain_item_count_max,
            "chain_too_many_items",
            actual=str(len(items)),
            expected=f"{reg.chain_item_count_min}..{reg.chain_item_count_max}",
        )

    validated: list[EffectItem] = []
    for index, raw in enumerate(items):
        validated.append(_validate_item(index, raw, reg))
    return tuple(validated)


def _validate_item(index: int, raw: Any, reg: EffectRegistry) -> EffectItem:
    if not isinstance(raw, Mapping):
        raise EffectChainError(index, "item_not_object", actual=type(raw).__name__)

    kind = raw.get("kind")
    if not isinstance(kind, str) or kind not in reg.effects:
        raise EffectChainError(
            index,
            "unknown_effect_kind",
            name=kind if isinstance(kind, str) else None,
            expected="|".join(reg.kinds),
            actual=repr(kind),
        )

    definition = reg.effects[kind]
    supplied = raw.get("parameters")
    if not isinstance(supplied, Mapping):
        raise EffectChainError(
            index, "item_not_object", name="parameters", actual=type(supplied).__name__
        )

    # Requirement 29.9's second half: an unregistered parameter name is refused, and
    # the name comes back. Checked before the range pass so a misspelling reads as a
    # misspelling rather than as a missing parameter.
    for name in supplied:
        if name not in definition.parameters:
            raise EffectChainError(
                index,
                "unknown_parameter_name",
                name=str(name),
                expected="|".join(definition.parameters),
            )

    values: dict[str, float] = {}
    for name, bounds in definition.parameters.items():
        if name not in supplied:
            raise EffectChainError(index, "missing_parameter", name=name)
        value = supplied[name]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise EffectChainError(
                index,
                "parameter_not_finite_number",
                name=name,
                actual=type(value).__name__,
            )
        if not bounds.contains(value):
            # Requirement 29.10: the permitted range travels with the rejection.
            raise EffectChainError(
                index,
                "parameter_out_of_range",
                name=name,
                actual=str(value),
                expected=bounds.describe(),
            )
        values[name] = float(value)

    return EffectItem(kind=kind, parameters=values)


def parse_chain(document: str) -> tuple[EffectItem, ...]:
    """Requirement 29.25/29.33 over a JSON string, for the task shell's benefit."""
    try:
        decoded = json.loads(document)
    except json.JSONDecodeError as error:
        raise EffectChainError(
            0, "chain_json_malformed", expected="a JSON array of effect items"
        ) from error
    if not isinstance(decoded, list):
        raise EffectChainError(0, "chain_not_array", actual=type(decoded).__name__)
    return validate_chain(decoded)


def chain_extends_tail(items: Sequence[EffectItem]) -> bool:
    """Requirements 29.30, 29.32: does this chain contain delay or reverb?"""
    reg = registry()
    return any(reg.effects[item.kind].extends_tail for item in items)


def pedalboard_available() -> bool:
    """Whether ``pedalboard`` can be imported in this environment.

    ``pedalboard`` is a default dependency (see ``dsp/pyproject.toml``), so this is
    normally true. It is still a *native* wheel and needs ``libatomic.so.1`` from the
    platform, so the tests degrade to a skip with a stated reason rather than an error
    on a host that lacks it.
    """
    try:
        import pedalboard  # noqa: F401
    except (ImportError, OSError):
        return False
    return True


def build_plugin(item: EffectItem) -> Any:
    """One validated item as a ``pedalboard`` plugin.

    The kind→class map is the only place the two vocabularies meet. Parameters are
    passed as ``**item.parameters`` because the registry's names *are* the constructor
    keywords; a ``TypeError`` from that call means ``pedalboard`` renamed one, and it
    is re-raised with the kind and the names attached rather than allowed to surface as
    an opaque signature error.
    """
    import pedalboard as pb

    classes: Mapping[str, Any] = {
        "chorus": pb.Chorus,
        "reverb": pb.Reverb,
        "delay": pb.Delay,
        "compressor": pb.Compressor,
        "gain": pb.Gain,
        "highpass": pb.HighpassFilter,
        "lowpass": pb.LowpassFilter,
        "pitch_shift": pb.PitchShift,
    }
    plugin_class = classes.get(item.kind)
    if plugin_class is None:  # pragma: no cover - registry and map are parity-tested
        raise EffectChainError(0, "unknown_effect_kind", name=item.kind)
    try:
        return plugin_class(**item.parameters)
    except TypeError as error:  # pragma: no cover - guards a pedalboard rename
        raise EffectChainError(
            0,
            "parameter_not_accepted_by_plugin",
            name=item.kind,
            expected=",".join(item.parameters),
        ) from error


@dataclass(frozen=True)
class ProcessedAudio:
    """The result of a chain, plus what the length invariants need.

    ``tail_truncated`` is reported rather than inferred, so Requirement 29.32 can be
    asserted against what the worker did instead of against a recomputation of what it
    should have done. Mirrors ``EffectProcessingResult`` in
    ``services/effects/ports.ts`` field for field.
    """

    audio: AudioBuffer
    original_duration_ms: float
    tail_truncated: bool

    @property
    def duration_ms(self) -> float:
        return self.audio.duration_ms


def apply_chain(
    audio: AudioBuffer, items: Sequence[Mapping[str, Any]] | Sequence[EffectItem]
) -> ProcessedAudio:
    """Requirements 29.12, 29.29, 29.30, 29.32: apply a chain, in order, deterministically.

    ``items`` may be raw mappings or already-validated :class:`EffectItem`s; raw input
    is validated first, so there is no path into ``pedalboard`` that skips Requirements
    29.9 and 29.10.

    ### Order

    Requirement 29.12 requires sequential application in array order, and that is what
    a single ``Pedalboard`` constructed from the items does — it is an ordered list of
    plugins and processes them front to back. Applying each plugin in a separate call
    would be equivalent for the memoryless effects but *not* for the stateful ones,
    since each call would restart their internal state mid-signal.

    ### The tail

    For a chain containing delay or reverb, the input is padded with
    ``tail_allowance_ms`` of silence so the tail has somewhere to develop, and the
    result is then trimmed to at most ``original + tail_allowance_ms`` — Requirement
    29.32's ceiling exactly. For every other chain no padding is added and
    ``pedalboard`` returns frame-for-frame as many samples as it received, so
    Requirement 29.30's ±10 ms holds with zero error rather than within tolerance.

    ### Determinism

    A fresh ``Pedalboard`` per call. See the module docstring: reusing a board would
    carry the previous call's delay-line and envelope state into this one, which is
    precisely the reproducibility breach Requirement 29.29 forbids.
    """
    if all(isinstance(item, EffectItem) for item in items):
        validated: tuple[EffectItem, ...] = tuple(items)  # type: ignore[arg-type]
        if len(validated) < registry().chain_item_count_min:
            raise EffectChainError(
                0,
                "chain_too_few_items",
                actual=str(len(validated)),
                expected=f"{registry().chain_item_count_min}..{registry().chain_item_count_max}",
            )
    else:
        validated = validate_chain(items)  # type: ignore[arg-type]

    if not audio.is_well_formed:
        raise ValueError("input audio is not well formed")

    import pedalboard as pb

    reg = registry()
    original_frames = audio.frame_count
    original_duration_ms = audio.duration_ms
    extends = chain_extends_tail(validated)

    # ``pedalboard`` speaks (channels, frames) float32 — the transpose of the
    # (frames, channels) layout ``libsndfile`` and ``libsoxr`` use. AudioBuffer is
    # de-interleaved already, so stacking the channels is the whole conversion.
    signal = np.stack(audio.channels, axis=0).astype(SAMPLE_DTYPE, copy=True)

    if extends:
        pad_frames = int(round(reg.tail_allowance_ms * audio.sample_rate / 1000.0))
        signal = np.concatenate(
            [signal, np.zeros((signal.shape[0], pad_frames), dtype=SAMPLE_DTYPE)], axis=1
        )

    board = pb.Pedalboard([build_plugin(item) for item in validated])
    processed = np.asarray(board(signal, audio.sample_rate), dtype=SAMPLE_DTYPE)

    if processed.ndim == 1:  # pragma: no cover - mono is returned 2-D by pedalboard
        processed = processed.reshape(1, -1)

    tail_truncated = False
    if extends:
        ceiling = original_frames + int(
            round(reg.tail_allowance_ms * audio.sample_rate / 1000.0)
        )
        if processed.shape[1] > ceiling:
            processed = processed[:, :ceiling]
            tail_truncated = True
    elif processed.shape[1] != original_frames:  # pragma: no cover - pedalboard is exact
        # Requirement 29.30 is an invariant of what Effects_Service produces, so a
        # library that started changing length is corrected rather than trusted. The
        # branch is unreachable with pedalboard 0.9.x and exists so that a future
        # version cannot breach the clause quietly.
        if processed.shape[1] > original_frames:
            processed = processed[:, :original_frames]
        else:
            processed = np.concatenate(
                [
                    processed,
                    np.zeros(
                        (processed.shape[0], original_frames - processed.shape[1]),
                        dtype=SAMPLE_DTYPE,
                    ),
                ],
                axis=1,
            )

    return ProcessedAudio(
        audio=AudioBuffer.from_channels(
            audio.sample_rate, [processed[index] for index in range(processed.shape[0])]
        ),
        original_duration_ms=original_duration_ms,
        tail_truncated=tail_truncated,
    )

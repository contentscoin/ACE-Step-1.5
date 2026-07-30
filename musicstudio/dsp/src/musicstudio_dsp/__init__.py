"""MusicStudio DSP worker package (design §5, §12).

Scaffold only. Resampling, effect processing, loudness normalisation, onset
detection and the mixdown chain are added by the tasks that own them.

This package never imports ``acestep``; the engine is reached only through the
``ACE_Engine_Adapter`` HTTP interface (design §1.4.4).
"""

__all__ = ["__version__"]

__version__ = "0.0.0"

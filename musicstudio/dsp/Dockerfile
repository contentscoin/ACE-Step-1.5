# The DSP sidecar image (roadmap §4.4, slices S2 and S6).
#
# `musicstudio_dsp.sidecar` exposes every Celery task over HTTP with no task-specific code, so
# this image is the eleven pipeline functions and nothing else. It holds no state and reaches
# no database: audio arrives in the request and leaves in the response.

FROM python:3.11-slim-bookworm

WORKDIR /app

# Two system packages, both for reasons `pyproject.toml` records:
#   libatomic1 — pedalboard's native extension links it and the wheel does not bundle it.
#   ffmpeg     — pydub's mp3/ogg fallback shells out to it. The primary conversion path is
#                libsndfile (bundled in the soundfile wheel), so this is the redundancy
#                design §5.5 asks for rather than the main road.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libatomic1 ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# The project metadata first, so the dependency layer survives a change to the sources.
COPY pyproject.toml README.md* ./
COPY src ./src
RUN python -m pip install --no-cache-dir --upgrade pip && python -m pip install --no-cache-dir .

RUN useradd --create-home --uid 10001 sidecar
USER sidecar

# `main()` reads both; the defaults bind the loopback, which inside a container means nothing
# outside it can connect.
ENV MUSICSTUDIO_DSP_HTTP_HOST=0.0.0.0 \
    MUSICSTUDIO_DSP_HTTP_PORT=8002
EXPOSE 8002

# `GET /health` returns the task list, so this checks dispatch is really wired and not merely
# that a socket is open.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if 'tasks' in urllib.request.urlopen('http://127.0.0.1:8002/health', timeout=2).read().decode() else 1)"

CMD ["python", "-m", "musicstudio_dsp.sidecar"]

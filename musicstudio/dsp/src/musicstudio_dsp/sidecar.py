"""An HTTP shell over the same tasks :mod:`musicstudio_dsp.worker` exposes to Celery.

Roadmap §4.4, step S2 — the second of the three seams the re-plan found missing:
the TypeScript services had no way to *call* the DSP. Eleven tasks were registered
with Celery, and nothing on the other side of the process boundary spoke Celery.

### One dispatcher, not eleven handlers

Every task in :mod:`worker` has the same shape — JSON-serialisable keyword
arguments in, a JSON-serialisable ``dict`` out — because that is what Celery's
JSON serializer already demanded of them. This module therefore adds **no
per-task code**. A request to ``POST /tasks/<name>`` looks the name up in
``celery_app.tasks`` and calls that task object's ``.run`` with the body as
keyword arguments. Registering a task with Celery is what publishes it here; there
is no second list to keep in step, and the two shells cannot drift, because this
one does not have a copy of anything — it calls the other one's task objects.

``.run`` invokes the wrapped function directly and never touches a broker, which
is the same door :mod:`test.test_worker` uses, and the reason the sidecar needs no
Redis to answer.

### Why HTTP rather than a Celery client in Node

Speaking Celery's wire protocol from another language means reproducing its
message envelope, its result backend and its retry semantics, and each of those
is a place to be subtly wrong. Speaking HTTP means the other side needs ``fetch``.
The plan weighed both and chose the one with fewer ways to break; if the Celery
worker is kept for batch work, both shells run against the same
:mod:`pipeline` and neither cares.

### The transport is still base64

Audio travels as base64 text inside JSON, exactly as it does through Celery. That
is the stopgap :mod:`worker`'s docstring already names, and it is kept here on
purpose so the two shells present *one* contract to callers. The step after this
one — handing the sidecar an object key and letting it read the store directly —
is a change to both shells at once, made once the object store exists on this
side of the boundary.

### What is deliberately not here

No authentication. This is an internal service on a private interface, and the
composition that deploys it is responsible for not exposing it. No streaming:
tasks are whole-buffer functions and the HTTP layer reflects that. No threading
beyond one request at a time per worker process — design §5.5's determinism
rule wants one task per process, and ``ThreadingHTTPServer`` is used only so a
health probe is answered while a long task runs.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Final

from .worker import celery_app

__all__ = [
    "DEFAULT_HOST",
    "DEFAULT_PORT",
    "MAX_REQUEST_BYTES",
    "TASK_PREFIX",
    "SidecarHandler",
    "create_server",
    "main",
    "registered_task_names",
]

log = logging.getLogger("musicstudio_dsp.sidecar")

#: Loopback by default. The engine listens on 8001; this takes the next one.
DEFAULT_HOST: Final[str] = "127.0.0.1"
DEFAULT_PORT: Final[int] = 8002

#: Only names under this prefix are callable. Celery registers its own built-in
#: tasks (``celery.backend_cleanup`` and friends) in the same registry, and none
#: of them is something an HTTP caller should be able to run.
TASK_PREFIX: Final[str] = "musicstudio_dsp."

#: A ten-minute 48 kHz stereo FLAC is on the order of 100 MB; base64 adds a third.
#: Bounded so a mistaken client cannot ask the process to hold arbitrary memory.
MAX_REQUEST_BYTES: Final[int] = 256 * 1024 * 1024


def registered_task_names() -> list[str]:
    """Every task this sidecar will dispatch, as the published names."""
    return sorted(name for name in celery_app.tasks if name.startswith(TASK_PREFIX))


class SidecarHandler(BaseHTTPRequestHandler):
    """Routes: ``GET /health`` and ``POST /tasks/<task name>``."""

    #: Quieter than the default, which prints every request to stderr.
    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - BaseHTTPRequestHandler's name
        log.info("%s - %s", self.address_string(), format % args)

    # -- responses ----------------------------------------------------------

    def _send_json(self, status: HTTPStatus, body: dict[str, Any]) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _send_error_json(self, status: HTTPStatus, code: str, message: str) -> None:
        self._send_json(status, {"error": {"code": code, "message": message}})

    # -- routes -------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 - http.server's naming
        if self.path == "/health":
            self._send_json(HTTPStatus.OK, {"ok": True, "tasks": registered_task_names()})
            return
        self._send_error_json(HTTPStatus.NOT_FOUND, "not_found", f"no route for GET {self.path}")

    def do_POST(self) -> None:  # noqa: N802 - http.server's naming
        prefix = "/tasks/"
        if not self.path.startswith(prefix):
            self._send_error_json(HTTPStatus.NOT_FOUND, "not_found", f"no route for POST {self.path}")
            return

        name = self.path[len(prefix) :]
        # The prefix check is the allowlist: a caller cannot reach a Celery built-in or
        # any task another package registered by naming it.
        if not name.startswith(TASK_PREFIX) or name not in celery_app.tasks:
            self._send_error_json(HTTPStatus.NOT_FOUND, "task_unknown", f"no task named {name!r}")
            return

        body = self._read_json_object()
        if body is None:
            return  # a response has already been sent

        task = celery_app.tasks[name]
        try:
            result = task.run(**body)
        except TypeError as error:
            # Wrong or missing keyword arguments surface from Python as TypeError before the
            # task body runs. Reported as the caller's error, because it is.
            self._send_error_json(HTTPStatus.BAD_REQUEST, "arguments_invalid", str(error))
            return
        except Exception as error:  # noqa: BLE001 - the boundary of the process; everything is reported
            traceback.print_exc(file=sys.stderr)
            self._send_error_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                "task_failed",
                f"{type(error).__name__}: {error}",
            )
            return

        self._send_json(HTTPStatus.OK, result)

    # -- request body -------------------------------------------------------

    def _read_json_object(self) -> dict[str, Any] | None:
        """The body as a JSON object, or ``None`` after sending the reason it is not."""
        raw_length = self.headers.get("Content-Length")
        try:
            length = int(raw_length) if raw_length is not None else 0
        except ValueError:
            self._send_error_json(HTTPStatus.BAD_REQUEST, "content_length_invalid", "Content-Length is not an integer")
            return None
        if length > MAX_REQUEST_BYTES:
            self._send_error_json(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                "request_too_large",
                f"body is {length} bytes; the limit is {MAX_REQUEST_BYTES}",
            )
            return None

        raw = self.rfile.read(length)
        try:
            parsed: Any = json.loads(raw) if raw else {}
        except json.JSONDecodeError as error:
            self._send_error_json(HTTPStatus.BAD_REQUEST, "json_invalid", str(error))
            return None
        if not isinstance(parsed, dict):
            # Keyword arguments need names. An array or a scalar cannot be spread into them,
            # and guessing a positional order would make argument order part of the contract.
            self._send_error_json(HTTPStatus.BAD_REQUEST, "body_not_object", "body must be a JSON object")
            return None
        return parsed


def create_server(host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> ThreadingHTTPServer:
    """A bound, unstarted server. Port ``0`` asks the OS for a free one — tests use that."""
    return ThreadingHTTPServer((host, port), SidecarHandler)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    host = os.environ.get("MUSICSTUDIO_DSP_HTTP_HOST", DEFAULT_HOST)
    port = int(os.environ.get("MUSICSTUDIO_DSP_HTTP_PORT", str(DEFAULT_PORT)))
    server = create_server(host, port)
    log.info("dsp sidecar listening on http://%s:%d with %d tasks", host, server.server_port, len(registered_task_names()))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

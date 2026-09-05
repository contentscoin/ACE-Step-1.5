"""The HTTP sidecar answers with exactly what the Celery shell would (S2).

These go over a real socket — a server bound to port 0 in a background thread,
``urllib`` on the other end — rather than calling the handler's methods, because
the thing under test is the contract a TypeScript process will see: status codes,
JSON bodies, and the fact that the two shells return the same dictionary for the
same input. Nothing here reaches a broker; ``.run`` is the same offline door
``test_worker`` uses.
"""

from __future__ import annotations

import base64
import json
import threading
import urllib.error
import urllib.request
from collections.abc import Iterator
from typing import Any

import numpy as np
import pytest

from musicstudio_dsp.audio_buffer import AudioBuffer
from musicstudio_dsp.formats import encode
from musicstudio_dsp.pipeline import STORAGE_FORMAT

#: The container's leading bytes, keyed by the format name the pipeline uses. The parity case
#: asserts against whatever ``STORAGE_FORMAT`` declares rather than hard-coding one magic, so a
#: change to the storage format moves this test with it instead of breaking it.
CONTAINER_MAGIC = {"flac": b"fLaC", "wav": b"RIFF"}
from musicstudio_dsp.sidecar import (
    MAX_REQUEST_BYTES,
    TASK_PREFIX,
    create_server,
    registered_task_names,
)
from musicstudio_dsp.worker import celery_app, normalise_for_storage_task


def wav_bytes(sample_rate: int = 44_100, frames: int = 44_100) -> bytes:
    # The same signal ``test_worker.wav_bytes`` builds, so the parity case below compares the
    # two shells on identical input rather than on two fixtures that happen to agree.
    t = np.arange(frames, dtype=np.float64) / float(sample_rate)
    wave = (0.5 * np.sin(2.0 * np.pi * 440.0 * t)).astype(np.float32)
    return encode(AudioBuffer.from_channels(sample_rate, [wave, wave * 0.75]), "wav")


@pytest.fixture(scope="module")
def base_url() -> Iterator[str]:
    server = create_server("127.0.0.1", 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()


def get(url: str) -> tuple[int, Any]:
    with urllib.request.urlopen(url) as response:  # noqa: S310 - loopback test server
        return response.status, json.loads(response.read())


def post(url: str, body: bytes, content_type: str = "application/json") -> tuple[int, Any]:
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(request) as response:  # noqa: S310 - loopback test server
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def post_json(url: str, body: Any) -> tuple[int, Any]:
    return post(url, json.dumps(body).encode("utf-8"))


class TestHealth:
    def test_lists_every_registered_task(self, base_url: str) -> None:
        status, body = get(f"{base_url}/health")
        assert status == 200
        assert body["ok"] is True
        assert body["tasks"] == registered_task_names()

    def test_the_published_names_are_the_celery_ones_and_nothing_else(self) -> None:
        # Registering with Celery is what publishes a task here. Every name the sidecar lists
        # is in Celery's registry under the product prefix, and every such Celery task is listed.
        names = registered_task_names()
        assert names
        assert all(name.startswith(TASK_PREFIX) for name in names)
        assert set(names) == {n for n in celery_app.tasks if n.startswith(TASK_PREFIX)}

    def test_unknown_get_route_is_404(self, base_url: str) -> None:
        with pytest.raises(urllib.error.HTTPError) as raised:
            get(f"{base_url}/nope")
        assert raised.value.code == 404


class TestDispatch:
    def test_normalise_for_storage_matches_the_celery_shell_exactly(self, base_url: str) -> None:
        # The contract that matters: a caller cannot tell which shell answered.
        payload = base64.b64encode(wav_bytes(sample_rate=22_050, frames=22_050)).decode("ascii")

        status, over_http = post_json(f"{base_url}/tasks/musicstudio_dsp.normalise_for_storage", {"audio_base64": payload})
        via_celery_run = normalise_for_storage_task.run(payload)

        assert status == 200
        assert over_http == via_celery_run

    def test_the_result_carries_what_requirement_19_5_and_16_6_record(self, base_url: str) -> None:
        payload = base64.b64encode(wav_bytes(sample_rate=22_050, frames=22_050)).decode("ascii")
        status, body = post_json(f"{base_url}/tasks/musicstudio_dsp.normalise_for_storage", {"audio_base64": payload})

        assert status == 200
        assert body["sample_rate"] == 48_000
        assert body["original_sample_rate"] == 22_050
        assert body["resampled"] is True
        assert isinstance(body["watermark_version"], int)
        # Stored in the format the pipeline declares — and the bytes agree with the label.
        assert body["audio_format"] == STORAGE_FORMAT
        assert base64.b64decode(body["audio_base64"])[:4] == CONTAINER_MAGIC[STORAGE_FORMAT]

    def test_forwards_keyword_arguments_by_name(self, base_url: str) -> None:
        payload = base64.b64encode(wav_bytes(frames=4_410)).decode("ascii")
        status, body = post_json(
            f"{base_url}/tasks/musicstudio_dsp.convert_for_download",
            {"audio_base64": payload, "audio_format": "flac"},
        )
        assert status == 200
        assert body["audio_format"] == "flac"

    def test_unknown_task_is_404_before_any_body_is_read(self, base_url: str) -> None:
        status, body = post_json(f"{base_url}/tasks/musicstudio_dsp.does_not_exist", {})
        assert status == 404
        assert body["error"]["code"] == "task_unknown"

    def test_celery_builtins_are_not_reachable(self, base_url: str) -> None:
        # ``celery.backend_cleanup`` sits in the same registry. The prefix is the allowlist.
        status, body = post_json(f"{base_url}/tasks/celery.backend_cleanup", {})
        assert status == 404
        assert body["error"]["code"] == "task_unknown"

    def test_missing_arguments_are_the_callers_error(self, base_url: str) -> None:
        status, body = post_json(f"{base_url}/tasks/musicstudio_dsp.normalise_for_storage", {})
        assert status == 400
        assert body["error"]["code"] == "arguments_invalid"

    def test_a_task_that_raises_is_500_with_the_exception_named(self, base_url: str) -> None:
        # Bytes that are not audio: the pipeline's decoder raises, and the caller is told
        # which exception rather than receiving a bare 500.
        garbage = base64.b64encode(b"not audio at all").decode("ascii")
        status, body = post_json(f"{base_url}/tasks/musicstudio_dsp.normalise_for_storage", {"audio_base64": garbage})
        assert status == 500
        assert body["error"]["code"] == "task_failed"
        assert ":" in body["error"]["message"]


class TestBody:
    def test_non_object_body_is_400(self, base_url: str) -> None:
        # Keyword arguments need names; an array cannot be spread into them without inventing
        # a positional order, which would make argument order part of the contract.
        status, body = post_json(f"{base_url}/tasks/musicstudio_dsp.measure_loudness", ["x"])
        assert status == 400
        assert body["error"]["code"] == "body_not_object"

    def test_malformed_json_is_400(self, base_url: str) -> None:
        status, body = post(f"{base_url}/tasks/musicstudio_dsp.measure_loudness", b"{not json")
        assert status == 400
        assert body["error"]["code"] == "json_invalid"

    def test_oversized_body_is_413_without_being_read(self, base_url: str) -> None:
        request = urllib.request.Request(
            f"{base_url}/tasks/musicstudio_dsp.measure_loudness",
            data=b"{}",
            method="POST",
        )
        request.add_header("Content-Type", "application/json")
        # Lie about the length: the server must refuse on the header, not after reading.
        request.add_header("Content-Length", str(MAX_REQUEST_BYTES + 1))
        with pytest.raises(urllib.error.HTTPError) as raised:
            urllib.request.urlopen(request)  # noqa: S310 - loopback test server
        assert raised.value.code == 413
        assert json.loads(raised.value.read())["error"]["code"] == "request_too_large"

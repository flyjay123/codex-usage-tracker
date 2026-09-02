from __future__ import annotations

import hashlib
import json
from pathlib import Path
from urllib.request import Request

from codex_usage_tracker.kernel.application import KernelApplication, RuntimePaths
from codex_usage_tracker.kernel.interfaces.http.app import API_PREFIX, HttpApp
from codex_usage_tracker.kernel.interfaces.http.usage_provider import UsageProvider


class _Response:
    def __init__(self, payload: dict) -> None:
        self._body = json.dumps(payload).encode()

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self, _limit: int) -> bytes:
        return self._body


def _key_id(api_key: str) -> str:
    return hashlib.sha256(api_key.encode()).hexdigest()[:16]


def test_usage_provider_migrates_legacy_config(tmp_path: Path) -> None:
    config = tmp_path / "nextcode-usage.json"
    config.write_text(json.dumps({"api_key": "legacy-test-key"}), encoding="utf-8")

    status = UsageProvider(config).status()
    stored = json.loads(config.read_text(encoding="utf-8"))

    assert status == {
        "configured": True,
        "keys": [{"id": _key_id("legacy-test-key"), "label": "legac…-key"}],
        "selected_id": _key_id("legacy-test-key"),
    }
    assert stored["version"] == 2
    assert stored["keys"][0]["api_key"] == "legacy-test-key"
    assert "api_key" not in status["keys"][0]


def test_usage_provider_stores_and_queries_multiple_keys(tmp_path: Path) -> None:
    requests: list[Request] = []

    def open_request(request: Request, *, timeout: int) -> _Response:
        assert timeout == 10
        requests.append(request)
        authorization = request.get_header("Authorization")
        return _Response({"usage": 11 if authorization == "Bearer test-key-one" else 22})

    config = tmp_path / "nextcode-usage.json"
    provider = UsageProvider(config, opener=open_request)
    first_id = _key_id("test-key-one")
    second_id = _key_id("test-key-two")

    assert provider.status() == {"configured": False, "keys": [], "selected_id": None}
    provider.save("test-key-one", label="账号一")
    saved = provider.save("test-key-two", label="账号二")
    first = provider.fetch(key_id=first_id)
    second = provider.fetch(key_id=second_id)
    cached = provider.fetch(key_id=first_id)

    assert saved == {
        "configured": True,
        "keys": [
            {"id": first_id, "label": "账号一"},
            {"id": second_id, "label": "账号二"},
        ],
        "selected_id": second_id,
    }
    assert first["usage"] == {"usage": 11}
    assert second["usage"] == {"usage": 22}
    assert cached["cached"] is True
    assert [request.get_header("Authorization") for request in requests] == [
        "Bearer test-key-one",
        "Bearer test-key-two",
    ]
    assert "api_key" not in json.dumps(saved)

    cleared = provider.clear(first_id)
    assert cleared["keys"] == [{"id": second_id, "label": "账号二"}]
    assert json.loads(config.read_text(encoding="utf-8"))["keys"][0]["api_key"] == ("test-key-two")


def test_http_usage_routes_select_key_without_exposing_credentials(tmp_path: Path) -> None:
    provider = UsageProvider(
        tmp_path / "nextcode-usage.json",
        opener=lambda *_args, **_kwargs: _Response({"usage": 7}),
    )
    application = KernelApplication(
        RuntimePaths(tmp_path / "codex", tmp_path / "cache"),
        worker_launcher=lambda _paths, _preset: None,
    )
    adapter = HttpApp(application, usage_provider=provider)

    saved = adapter.handle(
        "POST",
        f"{API_PREFIX}/usage-provider/config",
        body=b'{"api_key":"test-key","label":"test account"}',
        headers={"Host": "127.0.0.1:8765"},
    )
    key_id = _key_id("test-key")
    fetched = adapter.handle(
        "GET",
        f"{API_PREFIX}/usage-provider?key_id={key_id}",
        headers={"Host": "127.0.0.1:8765"},
    )

    saved_payload = json.loads(saved.body)
    fetched_payload = json.loads(fetched.body)
    assert saved_payload["selected_id"] == key_id
    assert saved_payload["keys"] == [{"id": key_id, "label": "test account"}]
    assert fetched_payload["usage"] == {"usage": 7}
    assert fetched_payload["selected_id"] == key_id
    assert b"test-key" not in saved.body
    assert b"test-key" not in fetched.body

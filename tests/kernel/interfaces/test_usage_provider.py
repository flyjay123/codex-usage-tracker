from __future__ import annotations

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


def test_usage_provider_persists_key_filters_response_and_caches(tmp_path: Path) -> None:
    requests: list[Request] = []

    def open_request(request: Request, *, timeout: int) -> _Response:
        assert timeout == 10
        requests.append(request)
        return _Response(
            {
                "usage": 42,
                "remaining": 8,
                "daily_usage": [{"date": "2026-08-31", "usage": 42}],
                "private_account_field": "must not leave the server",
            }
        )

    config = tmp_path / "nextcode-usage.json"
    provider = UsageProvider(config, opener=open_request)

    assert provider.status() == {"configured": False}
    assert provider.save("secret-key") == {"configured": True}
    first = provider.fetch()
    second = provider.fetch()

    assert json.loads(config.read_text())["api_key"] == "secret-key"
    assert first == {
        "configured": True,
        "cached": False,
        "usage": {
            "usage": 42,
            "remaining": 8,
            "daily_usage": [{"date": "2026-08-31", "usage": 42}],
        },
    }
    assert second["cached"] is True
    assert len(requests) == 1
    assert requests[0].get_header("Authorization") == "Bearer secret-key"
    assert provider.clear() == {"configured": False}
    assert not config.exists()


def test_http_usage_routes_keep_credentials_on_the_local_provider(tmp_path: Path) -> None:
    provider = UsageProvider(tmp_path / "nextcode-usage.json", opener=lambda *_args, **_kwargs: _Response({"usage": 7}))
    application = KernelApplication(
        RuntimePaths(tmp_path / "codex", tmp_path / "cache"),
        worker_launcher=lambda _paths, _preset: None,
    )
    adapter = HttpApp(application, usage_provider=provider)

    saved = adapter.handle(
        "POST",
        f"{API_PREFIX}/usage-provider/config",
        body=b'{"api_key":"test-key"}',
        headers={"Host": "127.0.0.1:8765"},
    )
    fetched = adapter.handle(
        "GET",
        f"{API_PREFIX}/usage-provider",
        headers={"Host": "127.0.0.1:8765"},
    )

    assert json.loads(saved.body) == {"configured": True}
    assert json.loads(fetched.body) == {
        "cached": False,
        "configured": True,
        "usage": {"usage": 7},
    }
    assert b"test-key" not in fetched.body

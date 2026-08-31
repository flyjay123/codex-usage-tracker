"""Persistent local credentials and bounded access to relay usage facts."""

from __future__ import annotations

import json
import os
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

USAGE_ENDPOINT = "https://nextcode.buildtoconnect.com/v1/usage"
MAX_RESPONSE_BYTES = 1_048_576
ALLOWED_FIELDS = {
    "balance",
    "daily_usage",
    "isValid",
    "mode",
    "model_stats",
    "planName",
    "remaining",
    "unit",
    "usage",
}


class UsageProviderError(RuntimeError):
    """A sanitized relay usage error suitable for a local client."""


class UsageProvider:
    def __init__(
        self,
        config_path: Path,
        *,
        opener: Callable[..., Any] = urlopen,
        cache_seconds: int = 300,
    ) -> None:
        self._config_path = config_path
        self._opener = opener
        self._cache_seconds = cache_seconds
        self._cached_at = 0.0
        self._cached_payload: dict[str, Any] | None = None
        self._lock = threading.Lock()

    def status(self) -> dict[str, bool]:
        return {"configured": self._read_key() is not None}

    def save(self, api_key: str) -> dict[str, bool]:
        key = api_key.strip()
        if not key or len(key) > 512:
            raise ValueError("API key is required")
        self._config_path.parent.mkdir(parents=True, exist_ok=True)
        staging = self._config_path.with_suffix(".tmp")
        staging.write_text(json.dumps({"api_key": key}), encoding="utf-8")
        staging.chmod(0o600)
        os.replace(staging, self._config_path)
        self._config_path.chmod(0o600)
        self._cached_payload = None
        self._cached_at = 0.0
        return {"configured": True}

    def clear(self) -> dict[str, bool]:
        self._config_path.unlink(missing_ok=True)
        self._cached_payload = None
        self._cached_at = 0.0
        return {"configured": False}

    def fetch(self, *, force: bool = False) -> dict[str, Any]:
        with self._lock:
            return self._fetch_locked(force=force)

    def _fetch_locked(self, *, force: bool) -> dict[str, Any]:
        key = self._read_key()
        if key is None:
            return {"configured": False}
        now = time.monotonic()
        if (
            not force
            and self._cached_payload is not None
            and now - self._cached_at < self._cache_seconds
        ):
            return {**self._cached_payload, "cached": True}
        request = Request(
            USAGE_ENDPOINT,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {key}",
            },
        )
        try:
            with self._opener(request, timeout=10) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as exc:
            raise UsageProviderError(
                f"usage service returned HTTP {exc.code}"
            ) from exc
        except (TimeoutError, URLError) as exc:
            raise UsageProviderError("usage service is unavailable") from exc
        if len(raw) > MAX_RESPONSE_BYTES:
            raise UsageProviderError("usage response is too large")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise UsageProviderError("usage service returned invalid JSON") from exc
        if not isinstance(payload, dict):
            raise UsageProviderError("usage service returned an invalid response")
        allowed = {key: payload[key] for key in ALLOWED_FIELDS if key in payload}
        result = {"configured": True, "cached": False, "usage": allowed}
        self._cached_payload = result
        self._cached_at = now
        return result

    def _read_key(self) -> str | None:
        if not self._config_path.is_file():
            return None
        try:
            payload = json.loads(self._config_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            raise UsageProviderError("saved usage configuration is invalid") from exc
        key = payload.get("api_key") if isinstance(payload, dict) else None
        return key if isinstance(key, str) and key else None

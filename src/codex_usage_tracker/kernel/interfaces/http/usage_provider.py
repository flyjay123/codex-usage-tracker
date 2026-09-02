"""Persistent local credentials and bounded access to relay usage facts."""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from collections.abc import Callable
from datetime import datetime, timezone
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
        self._cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self._lock = threading.Lock()

    def status(self) -> dict[str, Any]:
        return self._public_config(self._read_config())

    def save(self, api_key: str, *, label: str | None = None) -> dict[str, Any]:
        key = api_key.strip()
        if not key or len(key) > 512:
            raise ValueError("API key is required")
        config = self._read_config()
        key_id = _key_id(key)
        display_label = label.strip() if isinstance(label, str) else ""
        entry = {
            "id": key_id,
            "label": display_label or _masked_key(key),
            "api_key": key,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        existing = next((item for item in config["keys"] if item["id"] == key_id), None)
        if existing is None:
            config["keys"].append(entry)
        else:
            entry["created_at"] = existing.get("created_at", entry["created_at"])
            existing.update(entry)
        config["selected_id"] = key_id
        self._write_config(config)
        self._cache.pop(key_id, None)
        return self._public_config(config)

    def clear(self, key_id: str | None = None) -> dict[str, Any]:
        config = self._read_config()
        target = key_id or config.get("selected_id")
        if target:
            config["keys"] = [item for item in config["keys"] if item["id"] != target]
            self._cache.pop(target, None)
        config["selected_id"] = config["keys"][0]["id"] if config["keys"] else None
        if config["keys"]:
            self._write_config(config)
        else:
            self._config_path.unlink(missing_ok=True)
        return self._public_config(config)

    def fetch(self, *, key_id: str | None = None, force: bool = False) -> dict[str, Any]:
        with self._lock:
            return self._fetch_locked(key_id=key_id, force=force)

    def _fetch_locked(self, *, key_id: str | None, force: bool) -> dict[str, Any]:
        config = self._read_config()
        selected_id = key_id or config.get("selected_id")
        public = self._public_config(config, selected_id=selected_id)
        if not selected_id:
            return public
        entry = next((item for item in config["keys"] if item["id"] == selected_id), None)
        if entry is None:
            raise ValueError("saved API key was not found")
        now = time.monotonic()
        cached = self._cache.get(selected_id)
        if not force and cached is not None and now - cached[0] < self._cache_seconds:
            return {**public, **cached[1], "cached": True}
        request = Request(
            USAGE_ENDPOINT,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {entry['api_key']}",
            },
        )
        try:
            with self._opener(request, timeout=10) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as exc:
            raise UsageProviderError(f"usage service returned HTTP {exc.code}") from exc
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
        allowed = {field: payload[field] for field in ALLOWED_FIELDS if field in payload}
        result = {"cached": False, "usage": allowed}
        self._cache[selected_id] = (now, result)
        return {**public, **result}

    def _read_config(self) -> dict[str, Any]:
        if not self._config_path.is_file():
            return {"version": 2, "keys": [], "selected_id": None}
        try:
            payload = json.loads(self._config_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            raise UsageProviderError("saved usage configuration is invalid") from exc
        if not isinstance(payload, dict):
            raise UsageProviderError("saved usage configuration is invalid")
        legacy_key = payload.get("api_key")
        if isinstance(legacy_key, str) and legacy_key:
            key_id = _key_id(legacy_key)
            migrated = {
                "version": 2,
                "keys": [
                    {
                        "id": key_id,
                        "label": _masked_key(legacy_key),
                        "api_key": legacy_key,
                        "created_at": datetime.now(timezone.utc).isoformat(),
                    }
                ],
                "selected_id": key_id,
            }
            self._write_config(migrated)
            return migrated
        keys = payload.get("keys")
        if not isinstance(keys, list) or any(not _valid_entry(item) for item in keys):
            raise UsageProviderError("saved usage configuration is invalid")
        selected_id = payload.get("selected_id")
        if selected_id not in {item["id"] for item in keys}:
            selected_id = keys[0]["id"] if keys else None
        return {"version": 2, "keys": keys, "selected_id": selected_id}

    def _write_config(self, config: dict[str, Any]) -> None:
        self._config_path.parent.mkdir(parents=True, exist_ok=True)
        staging = self._config_path.with_suffix(".tmp")
        staging.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
        staging.chmod(0o600)
        os.replace(staging, self._config_path)
        self._config_path.chmod(0o600)

    @staticmethod
    def _public_config(config: dict[str, Any], *, selected_id: str | None = None) -> dict[str, Any]:
        keys = [{"id": item["id"], "label": item["label"]} for item in config["keys"]]
        selected = selected_id or config.get("selected_id")
        key_ids = {item["id"] for item in keys}
        return {
            "configured": bool(keys),
            "keys": keys,
            "selected_id": selected if selected in key_ids else None,
        }


def _key_id(api_key: str) -> str:
    return hashlib.sha256(api_key.encode()).hexdigest()[:16]


def _masked_key(api_key: str) -> str:
    if len(api_key) <= 10:
        return f"{api_key[:2]}…{api_key[-2:]}"
    return f"{api_key[:5]}…{api_key[-4:]}"


def _valid_entry(value: object) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("id"), str)
        and isinstance(value.get("label"), str)
        and isinstance(value.get("api_key"), str)
    )

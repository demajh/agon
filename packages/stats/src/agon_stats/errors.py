"""Errors agon-stats raises on purpose. `code` mirrors `ErrorCodes` in @agon/spec."""

from __future__ import annotations


class StatsError(Exception):
    """Base class; the CLI prints `{"error": {"code", "message"}}` to stderr and exits 1."""

    code: str = "internal_error"

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code

    def to_json(self) -> dict[str, dict[str, str]]:
        return {"error": {"code": self.code, "message": str(self)}}


class ConfigError(StatsError):
    code = "config_error"


class ValidationError(StatsError):
    code = "validation_error"


class NotFoundError(StatsError):
    code = "not_found"

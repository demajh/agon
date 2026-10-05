"""Load simulated sessions into `SessionRow` records.

Accepted inputs:

* ``.jsonl`` - one @agon/spec `Session` JSON object per line (camelCase, nested
  ``persona.personaId`` / ``persona.model``).
* ``.json`` - a JSON array of the same objects, or ``{"sessions": [...]}``.
* ``.parquet`` - one row per session with the columns the Parquet exporter writes. Column
  names may be snake_case or camelCase: ``id``, ``run_id``, ``variant``, ``scenario_id``,
  ``persona_id``, ``model``, ``outcome``, ``steps``, ``cost_usd``, ``metrics`` (a JSON string,
  a struct or a map) and the judgement either as a ``judgement`` struct / JSON string or as flat
  ``judgement_success``, ``judgement_satisfaction``, ``judgement_frustration``,
  ``judgement_confidence``, ``judgement_summary`` columns. A nested ``persona`` struct is
  accepted as well, so a Parquet file written straight from Session objects also loads.
"""

from __future__ import annotations

import json
import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq

from agon_stats.errors import NotFoundError, ValidationError

JUDGEMENT_FIELDS: tuple[str, ...] = (
    "success",
    "satisfaction",
    "frustration",
    "confidence",
    "summary",
)

_MISSING = object()


@dataclass(frozen=True, slots=True)
class SessionRow:
    """One session, flattened for analysis. `outcome` is None while a session is unfinished."""

    session_id: str
    variant: str
    scenario_id: str
    persona_id: str
    model: str
    outcome: str | None
    steps: int
    cost_usd: float
    metrics: dict[str, float] = field(default_factory=dict)
    judgement: dict[str, Any] | None = None


def load_sessions(path: str | Path) -> list[SessionRow]:
    """Read a sessions file (``.jsonl``, ``.json`` or ``.parquet``) into rows, in file order."""
    file = Path(path)
    if not file.exists():
        raise NotFoundError(f"sessions file not found: {file}")
    suffix = file.suffix.lower()
    if suffix == ".jsonl":
        records: Iterable[Mapping[str, Any]] = _read_jsonl(file)
    elif suffix == ".json":
        records = _read_json(file)
    elif suffix in {".parquet", ".pq"}:
        records = _read_parquet(file)
    else:
        raise ValidationError(
            f"unsupported sessions format '{suffix}' ({file.name}); "
            "expected .jsonl, .json or .parquet"
        )
    return [row_from_mapping(record, index=i) for i, record in enumerate(records)]


def row_from_mapping(record: Mapping[str, Any], *, index: int = 0) -> SessionRow:
    """Normalize one session record (nested Session JSON or a flat Parquet row)."""
    if not isinstance(record, Mapping):
        raise ValidationError(f"session {index}: expected an object, got {type(record).__name__}")

    persona = record.get("persona")
    persona_id: Any = None
    model: Any = None
    if isinstance(persona, Mapping):
        persona_id = _pick(persona, "personaId", "persona_id", "id")
        model = _pick(persona, "model")
    persona_id = _pick(record, "persona_id", "personaId", default=persona_id)
    model = _pick(record, "model", "persona_model", "personaModel", default=model)

    variant = _pick(record, "variant")
    if not isinstance(variant, str) or not variant:
        raise ValidationError(f"session {index}: missing variant")

    session_id = _pick(record, "id", "session_id", "sessionId", default=f"ses_{index}")
    scenario_id = _pick(record, "scenario_id", "scenarioId", default="unknown")
    outcome = _pick(record, "outcome")
    if outcome is not None and not isinstance(outcome, str):
        outcome = str(outcome)
    if outcome == "":
        outcome = None

    return SessionRow(
        session_id=str(session_id),
        variant=variant,
        scenario_id=str(scenario_id),
        persona_id=str(persona_id) if persona_id is not None else "unknown",
        model=str(model) if model is not None else "unknown",
        outcome=outcome,
        steps=_to_int(_pick(record, "steps", default=0), index, "steps"),
        cost_usd=_to_float(_pick(record, "cost_usd", "costUsd", default=0.0), index, "costUsd"),
        metrics=_parse_metrics(_pick(record, "metrics"), index),
        judgement=_parse_judgement(record, index),
    )


def _read_jsonl(file: Path) -> list[Mapping[str, Any]]:
    records: list[Mapping[str, Any]] = []
    with file.open(encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, start=1):
            text = line.strip()
            if not text:
                continue
            try:
                records.append(json.loads(text))
            except json.JSONDecodeError as exc:
                raise ValidationError(f"{file.name}:{line_no}: invalid JSON ({exc.msg})") from exc
    return records


def _read_json(file: Path) -> list[Mapping[str, Any]]:
    try:
        data = json.loads(file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValidationError(f"{file.name}: invalid JSON ({exc.msg})") from exc
    if isinstance(data, Mapping) and isinstance(data.get("sessions"), list):
        data = data["sessions"]
    if not isinstance(data, list):
        raise ValidationError(f"{file.name}: expected a JSON array of sessions")
    return data


def _read_parquet(file: Path) -> list[Mapping[str, Any]]:
    try:
        table = pq.read_table(file)
    except Exception as exc:  # pyarrow raises ArrowInvalid / OSError subclasses
        raise ValidationError(f"{file.name}: cannot read Parquet ({exc})") from exc
    return table.to_pylist()


def _pick(record: Mapping[str, Any], *keys: str, default: Any = None) -> Any:
    for key in keys:
        value = record.get(key, _MISSING)
        if value is not _MISSING and value is not None:
            return value
    return default


def _to_int(value: Any, index: int, name: str) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if math.isfinite(value) else 0
    if isinstance(value, str) and value.strip():
        try:
            return int(float(value))
        except ValueError as exc:
            raise ValidationError(f"session {index}: {name} is not a number") from exc
    return 0


def _to_float(value: Any, index: int, name: str) -> float:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, int | float):
        number = float(value)
        return number if math.isfinite(number) else 0.0
    if isinstance(value, str) and value.strip():
        try:
            return float(value)
        except ValueError as exc:
            raise ValidationError(f"session {index}: {name} is not a number") from exc
    return 0.0


def _parse_metrics(raw: Any, index: int) -> dict[str, float]:
    if raw is None:
        return {}
    if isinstance(raw, str):
        if not raw.strip():
            return {}
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValidationError(f"session {index}: metrics is not valid JSON") from exc
    if isinstance(raw, list):  # pyarrow map columns arrive as [(key, value), ...]
        pairs: dict[str, Any] = {}
        for item in raw:
            if isinstance(item, Mapping) and "key" in item:
                pairs[str(item["key"])] = item.get("value")
            elif isinstance(item, list | tuple) and len(item) == 2:
                pairs[str(item[0])] = item[1]
        raw = pairs
    if not isinstance(raw, Mapping):
        raise ValidationError(f"session {index}: metrics must be an object")
    metrics: dict[str, float] = {}
    for key, value in raw.items():
        if value is None:
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(number):
            metrics[str(key)] = number
    return metrics


def _parse_judgement(record: Mapping[str, Any], index: int) -> dict[str, Any] | None:
    raw = _pick(record, "judgement", "judgment")
    if isinstance(raw, str):
        if not raw.strip():
            raw = None
        else:
            try:
                raw = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise ValidationError(f"session {index}: judgement is not valid JSON") from exc
    if isinstance(raw, Mapping):
        parsed = {str(k): v for k, v in raw.items() if v is not None}
        return parsed or None
    flat: dict[str, Any] = {}
    for name in JUDGEMENT_FIELDS:
        value = _pick(record, f"judgement_{name}", f"judgement{name.capitalize()}")
        if value is not None:
            flat[name] = value
    return flat or None

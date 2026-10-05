"""Metric semantics: parsing spec `Metric` objects, per-session values, direction, binary-ness.

Per-session value rules (``NaN`` means "no value; exclude this session for this metric"):

* ``scenario_success`` (always analyzed): 1.0 if ``outcome == "success"`` else 0.0.
* ``conversion``: ``metrics[id] > 0`` -> 1.0, otherwise 0.0 (absent counts as not converted).
* ``count``: ``metrics[id]`` or 0.
* ``duration``: ``metrics[id]`` in seconds when present, else NaN.
* ``steps``: ``metrics[id]`` when present, else the session's ``steps`` column.
* ``score`` (judge): ``metrics[id]`` when present, else ``judgement[score]``, else NaN.

Direction follows ``metricDirection`` in @agon/spec: an explicit ``direction`` wins; duration,
steps and the judge's frustration score are better when lower; everything else when higher.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

import numpy as np

from agon_stats.errors import ConfigError
from agon_stats.io import SessionRow

SCENARIO_SUCCESS_METRIC_ID = "scenario_success"
SUCCESS_OUTCOME = "success"

Direction = Literal["increase", "decrease"]
MetricType = Literal["conversion", "count", "duration", "steps", "score", "success"]

CONFIG_METRIC_TYPES: frozenset[str] = frozenset(
    {"conversion", "count", "duration", "steps", "score"}
)
SCORE_NAMES: frozenset[str] = frozenset({"satisfaction", "frustration"})
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")


@dataclass(frozen=True, slots=True)
class MetricSpec:
    """A metric to analyze. `type == "success"` is the built-in scenario_success metric."""

    id: str
    type: MetricType
    direction: Direction
    primary: bool = False
    score: str = "satisfaction"
    event: str | None = None

    @property
    def binary_by_type(self) -> bool:
        return self.type in {"conversion", "success"}


def scenario_success_metric(*, primary: bool = False) -> MetricSpec:
    return MetricSpec(
        id=SCENARIO_SUCCESS_METRIC_ID, type="success", direction="increase", primary=primary
    )


def default_direction(metric_type: str, score: str = "satisfaction") -> Direction:
    if metric_type in {"duration", "steps"}:
        return "decrease"
    if metric_type == "score" and score == "frustration":
        return "decrease"
    return "increase"


def parse_metric(obj: Mapping[str, Any]) -> MetricSpec:
    """Parse one spec `Metric` JSON object (camelCase keys, as written by the TS side)."""
    if not isinstance(obj, Mapping):
        raise ConfigError("each metric must be an object")
    metric_id = obj.get("id")
    if not isinstance(metric_id, str) or not SLUG_RE.match(metric_id):
        raise ConfigError(f"metric id must be a slug, got {metric_id!r}")
    metric_type = obj.get("type")
    if metric_id == SCENARIO_SUCCESS_METRIC_ID:
        metric_type = "success"
    elif metric_type not in CONFIG_METRIC_TYPES:
        raise ConfigError(
            f"metric {metric_id}: unknown type {metric_type!r}; "
            f"expected one of {sorted(CONFIG_METRIC_TYPES)}"
        )
    score = obj.get("score", "satisfaction")
    if metric_type == "score" and score not in SCORE_NAMES:
        raise ConfigError(f"metric {metric_id}: score must be one of {sorted(SCORE_NAMES)}")
    explicit = obj.get("direction")
    if explicit is not None and explicit not in {"increase", "decrease"}:
        raise ConfigError(f"metric {metric_id}: direction must be 'increase' or 'decrease'")
    direction: Direction = (
        explicit if explicit is not None else default_direction(metric_type, score)
    )
    primary = obj.get("primary", False)
    if not isinstance(primary, bool):
        raise ConfigError(f"metric {metric_id}: primary must be a boolean")
    event = obj.get("event")
    return MetricSpec(
        id=metric_id,
        type=metric_type,
        direction=direction,
        primary=primary,
        score=str(score),
        event=str(event) if isinstance(event, str) else None,
    )


def metric_value(spec: MetricSpec, row: SessionRow) -> float:
    """Value of `spec` for one session; NaN when the session has no value for it."""
    if spec.type == "success":
        return 1.0 if row.outcome == SUCCESS_OUTCOME else 0.0
    raw = row.metrics.get(spec.id)
    if spec.type == "conversion":
        return 1.0 if raw is not None and raw > 0 else 0.0
    if spec.type == "count":
        return raw if raw is not None else 0.0
    if spec.type == "duration":
        return raw if raw is not None else math.nan
    if spec.type == "steps":
        return raw if raw is not None else float(row.steps)
    if spec.type == "score":
        if raw is not None:
            return raw
        if row.judgement is not None:
            judged = row.judgement.get(spec.score)
            if isinstance(judged, int | float) and not isinstance(judged, bool):
                number = float(judged)
                return number if math.isfinite(number) else math.nan
        return math.nan
    raise ConfigError(f"metric {spec.id}: unsupported type {spec.type!r}")


def metric_values(spec: MetricSpec, rows: Sequence[SessionRow]) -> np.ndarray:
    """Vector of per-session values (float64, NaN = missing), aligned with `rows`."""
    return np.array([metric_value(spec, row) for row in rows], dtype=np.float64)


def is_binary(spec: MetricSpec, values: np.ndarray) -> bool:
    """Binary metrics get proportion tests and Beta posteriors.

    Conversion and scenario_success are binary by definition. A `count` metric whose observed
    values are all 0 or 1 is a conversion in disguise and is treated the same way; every other
    metric is continuous.
    """
    if spec.binary_by_type:
        return True
    if spec.type != "count":
        return False
    finite = values[np.isfinite(values)]
    return finite.size > 0 and bool(np.all((finite == 0.0) | (finite == 1.0)))

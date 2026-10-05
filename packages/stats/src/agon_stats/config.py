"""Analysis configuration: the `analysis.json` the TS side writes for `agon-stats analyze`.

Shape (camelCase; snake_case aliases are accepted for hand-written files)::

    {
      "runId": "run_abc123",
      "control": "control",                 // optional; default "control" or the first variant
      "method": "bayesian",                 // bayesian | sequential | fixed
      "minSessionsPerVariant": 30,
      "decision": { "shipIf": 0.95, "killIf": 0.05 },
      "alpha": 0.05,
      "clusterBy": ["persona", "model"],    // subset of persona | model | scenario; [] = iid
      "calibrationProfile": "uncalibrated-v0",
      "changeCategory": "copy",             // optional
      "seed": 0,
      "metrics": [ ...spec Metric objects... ],
      "draws": 20000,                       // optional: Monte Carlo posterior draws
      "bootstrapSamples": 1000,             // optional: cluster bootstrap replicates
      "mixtureVarianceScale": 0.01          // optional: mSPRT tau^2 as a fraction of sigma^2
    }
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

from agon_stats.errors import ConfigError
from agon_stats.metrics import SCENARIO_SUCCESS_METRIC_ID, MetricSpec, parse_metric

Method = Literal["bayesian", "sequential", "fixed"]
METHODS: tuple[str, ...] = ("bayesian", "sequential", "fixed")
CLUSTER_FACTORS: tuple[str, ...] = ("persona", "model", "scenario")
DEFAULT_CLUSTER_BY: tuple[str, ...] = ("persona", "model")
DEFAULT_CALIBRATION_PROFILE = "uncalibrated-v0"

_MISSING = object()


@dataclass(frozen=True, slots=True)
class AnalysisConfig:
    run_id: str
    metrics: tuple[MetricSpec, ...] = ()
    control: str | None = None
    method: Method = "bayesian"
    min_sessions_per_variant: int = 30
    ship_if: float = 0.95
    kill_if: float = 0.05
    alpha: float = 0.05
    cluster_by: tuple[str, ...] = DEFAULT_CLUSTER_BY
    calibration_profile: str = DEFAULT_CALIBRATION_PROFILE
    change_category: str | None = None
    seed: int = 0
    draws: int = 20_000
    bootstrap_samples: int = 1_000
    mixture_variance_scale: float = 0.01


def parse_config(obj: Mapping[str, Any]) -> AnalysisConfig:
    if not isinstance(obj, Mapping):
        raise ConfigError("analysis config must be a JSON object")

    run_id = _pick(obj, "runId", "run_id")
    if not isinstance(run_id, str) or not run_id:
        raise ConfigError("runId is required")

    method = _pick(obj, "method", default="bayesian")
    if method not in METHODS:
        raise ConfigError(f"method must be one of {list(METHODS)}, got {method!r}")

    control = _pick(obj, "control")
    if control is not None and (not isinstance(control, str) or not control):
        raise ConfigError("control must be a non-empty string")

    decision = _pick(obj, "decision", default={})
    if not isinstance(decision, Mapping):
        raise ConfigError("decision must be an object")

    cluster_by_raw = _pick(obj, "clusterBy", "cluster_by", default=list(DEFAULT_CLUSTER_BY))
    if not isinstance(cluster_by_raw, list) or any(
        factor not in CLUSTER_FACTORS for factor in cluster_by_raw
    ):
        raise ConfigError(f"clusterBy must be a list drawn from {list(CLUSTER_FACTORS)}")
    cluster_by = tuple(dict.fromkeys(cluster_by_raw))  # dedupe, keep order

    calibration_profile = _pick(
        obj, "calibrationProfile", "calibration_profile", default=DEFAULT_CALIBRATION_PROFILE
    )
    if not isinstance(calibration_profile, str) or not calibration_profile:
        raise ConfigError("calibrationProfile must be a non-empty string")

    change_category = _pick(obj, "changeCategory", "change_category")
    if change_category is not None and not isinstance(change_category, str):
        raise ConfigError("changeCategory must be a string")

    metrics_raw = _pick(obj, "metrics", default=[])
    if not isinstance(metrics_raw, list):
        raise ConfigError("metrics must be a list")
    metrics = tuple(parse_metric(m) for m in metrics_raw)
    seen: set[str] = set()
    for metric in metrics:
        if metric.id in seen:
            raise ConfigError(f"duplicate metric id {metric.id!r}")
        seen.add(metric.id)
    primaries = [m.id for m in metrics if m.primary]
    if len(primaries) > 1:
        raise ConfigError(f"more than one primary metric: {primaries}")

    return AnalysisConfig(
        run_id=run_id,
        metrics=metrics,
        control=control,
        method=method,
        min_sessions_per_variant=_int(
            _pick(obj, "minSessionsPerVariant", "min_sessions_per_variant", default=30),
            "minSessionsPerVariant",
            minimum=1,
        ),
        ship_if=_unit(_pick(decision, "shipIf", "ship_if", default=0.95), "decision.shipIf"),
        kill_if=_unit(_pick(decision, "killIf", "kill_if", default=0.05), "decision.killIf"),
        alpha=_alpha(_pick(obj, "alpha", default=0.05)),
        cluster_by=cluster_by,
        calibration_profile=calibration_profile,
        change_category=change_category,
        seed=_int(_pick(obj, "seed", default=0), "seed", minimum=0),
        draws=_int(_pick(obj, "draws", default=20_000), "draws", minimum=100),
        bootstrap_samples=_int(
            _pick(obj, "bootstrapSamples", "bootstrap_samples", default=1_000),
            "bootstrapSamples",
            minimum=10,
        ),
        mixture_variance_scale=_positive(
            _pick(obj, "mixtureVarianceScale", "mixture_variance_scale", default=0.01),
            "mixtureVarianceScale",
        ),
    )


def primary_metric_id(config: AnalysisConfig) -> str:
    for metric in config.metrics:
        if metric.primary:
            return metric.id
    return SCENARIO_SUCCESS_METRIC_ID


def _pick(obj: Mapping[str, Any], *keys: str, default: Any = None) -> Any:
    for key in keys:
        value = obj.get(key, _MISSING)
        if value is not _MISSING and value is not None:
            return value
    return default


def _int(value: Any, name: str, *, minimum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int | float) or value != int(value):
        raise ConfigError(f"{name} must be an integer")
    number = int(value)
    if number < minimum:
        raise ConfigError(f"{name} must be >= {minimum}")
    return number


def _unit(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ConfigError(f"{name} must be a number in [0, 1]")
    number = float(value)
    if not math.isfinite(number) or not 0.0 <= number <= 1.0:
        raise ConfigError(f"{name} must be a number in [0, 1]")
    return number


def _alpha(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ConfigError("alpha must be a number in (0, 1)")
    number = float(value)
    if not math.isfinite(number) or not 0.0 < number < 1.0:
        raise ConfigError("alpha must be a number in (0, 1)")
    return number


def _positive(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ConfigError(f"{name} must be a positive number")
    number = float(value)
    if not math.isfinite(number) or number <= 0.0:
        raise ConfigError(f"{name} must be a positive number")
    return number

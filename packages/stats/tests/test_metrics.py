from __future__ import annotations

import math

import numpy as np
import pytest

from agon_stats.errors import ConfigError
from agon_stats.io import SessionRow
from agon_stats.metrics import (
    MetricSpec,
    is_binary,
    metric_values,
    parse_metric,
    scenario_success_metric,
)


def row(**overrides: object) -> SessionRow:
    base: dict[str, object] = {
        "session_id": "ses_1",
        "variant": "control",
        "scenario_id": "s",
        "persona_id": "p",
        "model": "openai/gpt-5",
        "outcome": "success",
        "steps": 12,
        "cost_usd": 0.1,
        "metrics": {},
        "judgement": None,
    }
    base.update(overrides)
    return SessionRow(**base)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("metric", "direction"),
    [
        ({"id": "activation", "type": "conversion", "event": "x"}, "increase"),
        ({"id": "clicks", "type": "count", "event": "x"}, "increase"),
        ({"id": "ttv", "type": "duration", "to": "x"}, "decrease"),
        ({"id": "steps", "type": "steps"}, "decrease"),
        ({"id": "sat", "type": "score", "score": "satisfaction"}, "increase"),
        ({"id": "frus", "type": "score", "score": "frustration"}, "decrease"),
        (
            {"id": "frus", "type": "score", "score": "frustration", "direction": "increase"},
            "increase",
        ),
        ({"id": "ttv", "type": "duration", "to": "x", "direction": "increase"}, "increase"),
    ],
)
def test_direction_defaults_and_explicit_override(
    metric: dict[str, object], direction: str
) -> None:
    assert parse_metric(metric).direction == direction


def test_parse_metric_rejects_bad_input() -> None:
    with pytest.raises(ConfigError):
        parse_metric({"id": "Bad Id", "type": "conversion", "event": "x"})
    with pytest.raises(ConfigError):
        parse_metric({"id": "ok", "type": "ratio"})
    with pytest.raises(ConfigError):
        parse_metric({"id": "ok", "type": "steps", "direction": "sideways"})
    with pytest.raises(ConfigError):
        parse_metric({"id": "ok", "type": "score", "score": "joy"})


def test_scenario_success_values_follow_outcome() -> None:
    rows = [row(outcome="success"), row(outcome="gave_up"), row(outcome="error"), row(outcome=None)]
    values = metric_values(scenario_success_metric(), rows)
    assert values.tolist() == [1.0, 0.0, 0.0, 0.0]


def test_conversion_count_duration_steps_and_score_rules() -> None:
    rows = [
        row(metrics={"activation": 1.0, "clicks": 3.0, "ttv": 42.0, "steps": 4.0, "sat": 5.0}),
        row(metrics={"activation": 0.0}, judgement={"satisfaction": 2, "frustration": 4}),
        row(metrics={}, judgement=None),
    ]
    conversion = parse_metric({"id": "activation", "type": "conversion", "event": "x"})
    count = parse_metric({"id": "clicks", "type": "count", "event": "x"})
    duration = parse_metric({"id": "ttv", "type": "duration", "to": "x"})
    steps = parse_metric({"id": "steps", "type": "steps"})
    satisfaction = parse_metric({"id": "sat", "type": "score", "score": "satisfaction"})
    frustration = parse_metric({"id": "frus", "type": "score", "score": "frustration"})

    assert metric_values(conversion, rows).tolist() == [1.0, 0.0, 0.0]
    assert metric_values(count, rows).tolist() == [3.0, 0.0, 0.0]
    ttv = metric_values(duration, rows)
    assert ttv[0] == 42.0 and math.isnan(ttv[1]) and math.isnan(ttv[2])
    assert metric_values(steps, rows).tolist() == [4.0, 12.0, 12.0]
    sat = metric_values(satisfaction, rows)
    assert sat[0] == 5.0 and sat[1] == 2.0 and math.isnan(sat[2])
    frus = metric_values(frustration, rows)
    assert math.isnan(frus[0]) and frus[1] == 4.0 and math.isnan(frus[2])


def test_binary_versus_continuous_detection() -> None:
    conversion = MetricSpec(id="c", type="conversion", direction="increase")
    count = MetricSpec(id="n", type="count", direction="increase")
    duration = MetricSpec(id="d", type="duration", direction="decrease")
    assert is_binary(conversion, np.array([0.0, 0.0]))
    assert is_binary(scenario_success_metric(), np.array([1.0]))
    assert is_binary(count, np.array([0.0, 1.0, 1.0, np.nan]))
    assert not is_binary(count, np.array([0.0, 1.0, 2.0]))
    assert not is_binary(duration, np.array([0.0, 1.0]))

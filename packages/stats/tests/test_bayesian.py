from __future__ import annotations

import json

import pytest
from conftest import make_config, make_rows

from agon_stats.analysis import analyze_sessions
from agon_stats.result import build_result

FRUSTRATION = {"id": "frustration", "type": "score", "source": "judge", "score": "frustration"}
COMPUTED_AT = "2026-10-04T17:00:00.000Z"


def test_clearly_better_treatment_has_high_p_best_and_ships() -> None:
    rows = make_rows({"control": 0.3, "treatment": 0.6}, n=200)
    result = build_result(rows, make_config(minSessionsPerVariant=100), computed_at=COMPUTED_AT)
    primary = result["metrics"][0]
    assert primary["metricId"] == "scenario_success" == result["primaryMetricId"]
    comparison = primary["comparisons"][0]
    assert comparison["pBest"] > 0.95
    assert comparison["pBeatControl"] > 0.95
    assert comparison["expectedLoss"] < 1e-3
    assert comparison["lift"] == pytest.approx(1.0)
    assert comparison["liftCi95"][0] > 0.5
    assert result["decision"]["verdict"] == "ship"
    assert result["decision"]["variant"] == "treatment"
    assert "P(best)" in result["decision"]["rationale"]


def test_identical_variants_are_inconclusive_with_p_best_near_half() -> None:
    rows = make_rows({"control": 0.4, "treatment": 0.4}, n=200)
    result = build_result(rows, make_config(), computed_at=COMPUTED_AT)
    comparison = result["metrics"][0]["comparisons"][0]
    assert comparison["pBest"] == pytest.approx(0.5, abs=0.1)
    assert comparison["pBeatControl"] == pytest.approx(0.5, abs=0.1)
    assert comparison["lift"] == 0.0
    assert comparison["liftCi95"][0] < 0.0 < comparison["liftCi95"][1]
    assert result["decision"]["verdict"] == "inconclusive"
    assert "variant" not in result["decision"]


def test_p_best_sums_to_one_over_all_variants() -> None:
    rows = make_rows({"control": 0.3, "a": 0.4, "b": 0.5}, n=100)
    output = analyze_sessions(rows, make_config())
    analysis = output.metric("scenario_success")
    assert output.variants == ["control", "a", "b"]
    assert sum(analysis.p_best.values()) == pytest.approx(1.0)
    assert analysis.p_best["b"] > analysis.p_best["a"] > analysis.p_best["control"]
    assert [c.variant for c in analysis.comparisons] == ["a", "b"]


def test_lower_is_better_direction_flips_the_winner() -> None:
    rows = make_rows(
        {"control": 0.4, "treatment": 0.4}, n=150, frustration={"control": 3.6, "treatment": 2.2}
    )
    lower_is_better = build_result(
        rows, make_config(metrics=[{**FRUSTRATION, "primary": True}]), computed_at=COMPUTED_AT
    )
    assert lower_is_better["primaryMetricId"] == "frustration"
    metric = lower_is_better["metrics"][1]
    assert metric["direction"] == "decrease"
    assert "successes" not in metric["variants"][0]
    comparison = metric["comparisons"][0]
    assert comparison["lift"] < 0
    assert comparison["pBest"] > 0.95
    assert lower_is_better["decision"]["verdict"] == "ship"
    assert lower_is_better["decision"]["variant"] == "treatment"

    higher_is_better = build_result(
        rows,
        make_config(metrics=[{**FRUSTRATION, "primary": True, "direction": "increase"}]),
        computed_at=COMPUTED_AT,
    )
    flipped = higher_is_better["metrics"][1]
    assert flipped["direction"] == "increase"
    assert flipped["comparisons"][0]["pBest"] < 0.05
    assert flipped["comparisons"][0]["expectedLoss"] > 1.0
    assert higher_is_better["decision"]["verdict"] == "kill"
    assert higher_is_better["decision"]["variant"] == "treatment"


def test_same_seed_gives_identical_json_and_seed_changes_only_noise() -> None:
    rows = make_rows(
        {"control": 0.35, "treatment": 0.42}, n=120, duration={"control": 60, "treatment": 55}
    )
    metrics = [
        {"id": "activation", "type": "conversion", "event": "project_created", "primary": True},
        {"id": "time_to_activate", "type": "duration", "to": "project_created"},
        {"id": "steps", "type": "steps"},
    ]
    config = make_config(metrics=metrics, clusterBy=["persona", "model"], seed=7)
    first = json.dumps(build_result(rows, config, computed_at=COMPUTED_AT), sort_keys=True)
    second = json.dumps(build_result(rows, config, computed_at=COMPUTED_AT), sort_keys=True)
    assert first == second

    other = build_result(rows, make_config(metrics=metrics, clusterBy=["persona", "model"], seed=8))
    p_best_seed7 = json.loads(first)["metrics"][1]["comparisons"][0]["pBest"]
    p_best_seed8 = other["metrics"][1]["comparisons"][0]["pBest"]
    assert p_best_seed7 == pytest.approx(p_best_seed8, abs=0.02)


def test_continuous_posterior_detects_a_duration_improvement() -> None:
    rows = make_rows(
        {"control": 0.5, "treatment": 0.5}, n=100, duration={"control": 60, "treatment": 50}
    )
    duration = {"id": "time_to_activate", "type": "duration", "to": "x", "primary": True}
    output = analyze_sessions(rows, make_config(metrics=[duration]))
    analysis = output.metric("time_to_activate")
    assert not analysis.binary
    comparison = analysis.comparisons[0]
    assert comparison.p_best > 0.99
    assert comparison.lift == pytest.approx(-1 / 6, abs=0.05)
    assert comparison.lift_ci95[1] < 0

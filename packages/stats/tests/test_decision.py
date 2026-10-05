from __future__ import annotations

from conftest import make_config, make_rows

from agon_stats.analysis import analyze_sessions
from agon_stats.decision import decide
from agon_stats.result import build_result


def verdict(rows, **config_overrides):  # type: ignore[no-untyped-def]
    config = make_config(**config_overrides)
    output = analyze_sessions(rows, config)
    return decide(output.primary(), config, output.control)


def test_continue_when_any_variant_is_below_min_sessions() -> None:
    rows = make_rows({"control": 0.3, "treatment": 0.6}, n=40)
    decision = verdict(rows, minSessionsPerVariant=100)
    assert decision.verdict == "continue"
    assert decision.variant is None
    assert "at least 100 sessions" in decision.rationale
    assert "control has 40" in decision.rationale and "treatment has 40" in decision.rationale


def test_kill_when_control_is_clearly_best() -> None:
    rows = make_rows({"control": 0.6, "treatment": 0.2}, n=200)
    decision = verdict(rows)
    assert decision.verdict == "kill"
    assert decision.variant == "treatment"
    assert "every treatment has P(best) <= 0.05" in decision.rationale


def test_inconclusive_when_nothing_is_clear() -> None:
    rows = make_rows({"control": 0.40, "treatment": 0.43}, n=100)
    decision = verdict(rows)
    assert decision.verdict == "inconclusive"
    assert decision.variant is None


def test_multiple_treatments_ship_the_highest_p_best() -> None:
    rows = make_rows({"control": 0.3, "a": 0.65, "b": 0.45}, n=200)
    decision = verdict(rows)
    assert decision.verdict == "ship"
    assert decision.variant == "a"


def test_fixed_method_ships_on_significance_in_the_good_direction() -> None:
    rows = make_rows({"control": 0.3, "treatment": 0.5}, n=150)
    decision = verdict(rows, method="fixed")
    assert decision.verdict == "ship"
    assert decision.variant == "treatment"
    assert "fixed-horizon p=" in decision.rationale


def test_fixed_method_inconclusive_without_significance() -> None:
    rows = make_rows({"control": 0.40, "treatment": 0.42}, n=100)
    decision = verdict(rows, method="fixed")
    assert decision.verdict == "inconclusive"
    assert "alpha=0.05" in decision.rationale


def test_fixed_method_kills_a_significantly_worse_treatment() -> None:
    rows = make_rows({"control": 0.6, "treatment": 0.3}, n=150)
    decision = verdict(rows, method="fixed")
    assert decision.verdict == "kill"
    assert decision.variant == "treatment"


def test_fixed_method_bonferroni_corrects_for_several_treatments() -> None:
    rows = make_rows({"control": 0.3, "a": 0.6, "b": 0.31}, n=150)
    decision = verdict(rows, method="fixed")
    assert decision.verdict == "ship"
    assert decision.variant == "a"
    assert "Bonferroni" in decision.rationale and "alpha=0.025" in decision.rationale


def test_sequential_method_ships_a_strong_effect() -> None:
    rows = make_rows({"control": 0.3, "treatment": 0.6}, n=200)
    decision = verdict(rows, method="sequential")
    assert decision.verdict == "ship"
    assert "always-valid mSPRT" in decision.rationale


def test_single_variant_is_inconclusive_not_an_error() -> None:
    rows = make_rows({"control": 0.5}, n=50)
    result = build_result(rows, make_config())
    assert result["decision"]["verdict"] == "inconclusive"
    assert result["metrics"][0]["comparisons"] == []
    assert "nothing to compare" in result["decision"]["rationale"]


def test_primary_metric_drives_the_decision() -> None:
    rows = make_rows(
        {"control": 0.5, "treatment": 0.5}, n=150, duration={"control": 60, "treatment": 45}
    )
    duration = {"id": "time_to_activate", "type": "duration", "to": "x", "primary": True}
    result = build_result(rows, make_config(metrics=[duration]))
    assert result["primaryMetricId"] == "time_to_activate"
    assert result["decision"]["verdict"] == "ship"
    assert "time_to_activate" in result["decision"]["rationale"]

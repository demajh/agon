from __future__ import annotations

import pytest
from conftest import make_config, make_rows

from agon_stats.analysis import analyze_sessions
from agon_stats.decision import decide, max_quantile_bar
from agon_stats.errors import ConfigError
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


# ---- evaluation ledger: the trial count M ------------------------------------------------


def test_max_quantile_bar_matches_the_committed_values() -> None:
    assert max_quantile_bar(0.05, 1) == pytest.approx(1.645, abs=5e-4)
    assert max_quantile_bar(0.05, 100) == pytest.approx(3.283, abs=5e-4)
    assert max_quantile_bar(0.05, 0) == max_quantile_bar(0.05, 1)
    assert max_quantile_bar(0.01, 10) > max_quantile_bar(0.05, 10) > max_quantile_bar(0.05, 1)


def test_trials_default_to_one_and_must_be_positive() -> None:
    config = make_config()
    assert config.trials == 1 and config.sample_hash is None
    assert make_config(trials=7, sampleHash="3f9a2c1d" * 8).trials == 7
    with pytest.raises(ConfigError):
        make_config(trials=0)
    with pytest.raises(ConfigError):
        make_config(sampleHash="")


def test_fixed_method_with_one_trial_reproduces_the_uncorrected_verdicts() -> None:
    for rates, expected in (
        ({"control": 0.3, "treatment": 0.5}, "ship"),
        ({"control": 0.40, "treatment": 0.42}, "inconclusive"),
        ({"control": 0.6, "treatment": 0.3}, "kill"),
    ):
        rows = make_rows(rates, n=150)
        assert verdict(rows, method="fixed", trials=1).verdict == expected
        assert verdict(rows, method="fixed").verdict == expected
    decision = verdict(make_rows({"control": 0.3, "treatment": 0.5}, n=150), method="fixed")
    assert "Trials: M=1" in decision.rationale
    assert "ship bar z > 1.645" in decision.rationale
    assert "sample unknown" in decision.rationale


def test_fixed_method_raises_the_bar_to_the_quantile_of_the_max() -> None:
    # 0.30 vs 0.42 at n=200 per arm: pooled z is about 2.5, so p is about 0.012.
    rows = make_rows({"control": 0.30, "treatment": 0.42}, n=200)
    one = verdict(rows, method="fixed", trials=1, sampleHash="3f9a2c1d" * 8)
    assert one.verdict == "ship"
    assert "z=2.5" in one.rationale and "(1-trial bar)" in one.rationale
    assert "sample 3f9a2c1d3f9a" in one.rationale
    many = verdict(rows, method="fixed", trials=100, sampleHash="3f9a2c1d" * 8)
    assert many.verdict == "inconclusive"
    assert "below the 100-trial bar 3.283" in many.rationale
    assert "Trials: M=100" in many.rationale and "z > 3.283" in many.rationale
    # A large effect still ships at M=100: 0.3 vs 0.6 at n=200 is about z=6.
    strong = make_rows({"control": 0.3, "treatment": 0.6}, n=200)
    assert verdict(strong, method="fixed", trials=100).verdict == "ship"
    # The kill rule is not raised: significantly worse stays killed.
    worse = make_rows({"control": 0.6, "treatment": 0.3}, n=150)
    assert verdict(worse, method="fixed", trials=100).verdict == "kill"


def test_bayesian_and_sequential_report_trials_and_warn() -> None:
    rows = make_rows({"control": 0.3, "treatment": 0.6}, n=200)
    for method in ("bayesian", "sequential"):
        decision = verdict(rows, method=method, trials=12, sampleHash="abcdef0123456789")
        assert decision.verdict == "ship"
        assert "Trials: M=12 distinct variant(s) evaluated against sample abcdef012345" in (
            decision.rationale
        )
        assert "P(best) is not corrected for the number of trials searched" in decision.rationale
    short = verdict(rows, minSessionsPerVariant=500, trials=3)
    assert short.verdict == "continue" and "Trials: M=3" in short.rationale


def test_z_stat_is_serialized_for_frequentist_methods_only() -> None:
    rows = make_rows({"control": 0.3, "treatment": 0.5}, n=150)
    fixed = build_result(rows, make_config(method="fixed"))
    comparison = fixed["metrics"][0]["comparisons"][0]
    assert comparison["zStat"] > 3.0
    assert "zStat" not in build_result(rows, make_config())["metrics"][0]["comparisons"][0]

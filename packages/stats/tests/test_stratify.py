from __future__ import annotations

import numpy as np
import pytest
from conftest import PERSONAS, make_config, make_rows

from agon_stats.analysis import analyze_sessions, cochran_q
from agon_stats.errors import ConfigError
from agon_stats.result import build_result

INTERACTION = {"smb-owner": -0.3, "developer-evaluator": 0.3, "skeptical-cfo": 0.0}


def test_each_stratum_carries_its_own_effect_interval_and_counts() -> None:
    rows = make_rows({"control": 0.4, "treatment": 0.5}, n=300)
    metric = analyze_sessions(rows, make_config(stratifyBy=["persona"])).metric("scenario_success")
    report = metric.stratification
    assert report is not None and report.by == ("persona",)
    assert [s.levels for s in report.strata] == [{"persona": p} for p in sorted(PERSONAS)]
    for stratum in report.strata:
        assert stratum.sessions == sum(v.sessions for v in stratum.variants) == 200
        [comparison] = stratum.comparisons
        assert comparison.variant == "treatment" and comparison.control == "control"
        assert comparison.difference_ci95[0] < comparison.difference < comparison.difference_ci95[1]
        assert comparison.lift_ci95[0] < comparison.lift < comparison.lift_ci95[1]
        assert comparison.difference == pytest.approx(0.1)  # the same rates in every stratum
    [h] = report.heterogeneity
    assert h.strata == 3 and h.df == 2 and h.q == pytest.approx(0.0, abs=1e-9)
    assert h.i_squared == 0.0 and h.p_value == pytest.approx(1.0)
    assert h.pooled_difference_ci95[0] < h.pooled_difference == pytest.approx(0.1)
    assert not any("differs across strata" in w for w in metric.warnings)
    # the pooled comparison is untouched: stratification is reporting only
    assert metric.comparisons[0].lift == pytest.approx(0.25)


def test_heterogeneity_statistic_flags_an_effect_that_depends_on_the_stratum() -> None:
    control = make_rows({"control": 0.4}, n=300, seed=2, run_id="run_c")
    treatment = make_rows(
        {"treatment": 0.4}, n=300, persona_shift=INTERACTION, seed=3, run_id="run_t"
    )
    metric = analyze_sessions(control + treatment, make_config(stratifyBy=["persona"])).metric(
        "scenario_success"
    )
    assert metric.stratification is not None
    [h] = metric.stratification.heterogeneity
    assert h.i_squared > 0.8 and h.p_value < 0.01 and h.q > h.df
    by_persona = {
        s.levels["persona"]: s.comparisons[0].difference for s in metric.stratification.strata
    }
    assert by_persona["smb-owner"] < -0.15 and by_persona["developer-evaluator"] > 0.15
    assert any(
        "differs across strata" in w and "averages across regimes" in w for w in metric.warnings
    )


def test_a_single_stratum_reports_but_has_no_heterogeneity_statistic() -> None:
    rows = make_rows({"control": 0.4, "treatment": 0.5}, n=60, personas=("solo",))
    metric = analyze_sessions(rows, make_config(stratifyBy=["persona", "model"])).metric(
        "scenario_success"
    )
    report = metric.stratification
    assert report is not None and report.by == ("persona", "model")
    assert len(report.strata) == 2 and all(s.levels["persona"] == "solo" for s in report.strata)
    assert report.heterogeneity and report.heterogeneity[0].strata == 2
    rows = make_rows({"control": 0.4, "treatment": 0.5}, n=60, personas=("solo",), models=("m",))
    metric = analyze_sessions(rows, make_config(stratifyBy=["persona", "model"])).metric(
        "scenario_success"
    )
    assert metric.stratification is not None and metric.stratification.heterogeneity == []
    assert any("no heterogeneity statistic" in w for w in metric.warnings)


def test_small_arms_get_counts_but_no_comparison() -> None:
    rows = make_rows({"control": 0.4, "treatment": 0.5}, n=4, personas=("a", "b", "c", "d"))
    # one session per persona per variant: every stratum reports its means, none is estimable
    metric = analyze_sessions(rows, make_config(stratifyBy=["persona"])).metric("scenario_success")
    assert metric.stratification is not None
    assert all(s.comparisons == [] and s.sessions == 2 for s in metric.stratification.strata)
    assert metric.stratification.heterogeneity == []


def test_stratified_result_json_and_config_validation() -> None:
    rows = make_rows({"control": 0.4, "treatment": 0.5}, n=90, seed=4)
    result = build_result(
        rows, make_config(stratifyBy=["model", "model"]), computed_at="2026-10-13T00:00:00.000Z"
    )
    report = result["metrics"][0]["stratification"]
    assert report["by"] == ["model"] and len(report["strata"]) == 2
    assert set(report["strata"][0]) == {"levels", "sessions", "variants", "comparisons"}
    assert set(report["heterogeneity"][0]) == {
        "variant",
        "control",
        "strata",
        "pooledDifference",
        "pooledDifferenceCi95",
        "q",
        "df",
        "pValue",
        "iSquared",
    }
    assert any(
        a.startswith("Strata: effects are also reported per model") for a in result["assumptions"]
    )
    assert (
        "stratification"
        not in analyze_sessions(rows, make_config()).metric("scenario_success").to_json()
    )
    with pytest.raises(ConfigError, match="stratifyBy"):
        make_config(stratifyBy=["weather"])
    with pytest.raises(ConfigError, match="stratifyBy"):
        make_config(stratifyBy="persona")


def test_cochran_q_pools_by_inverse_variance() -> None:
    pooled, se, q, df, p, i2 = cochran_q(np.array([0.1, 0.1]), np.array([0.01, 0.01]))
    assert pooled == pytest.approx(0.1) and se == pytest.approx(np.sqrt(0.005))
    assert q == 0.0 and df == 1 and p == 1.0 and i2 == 0.0
    pooled, _, q, df, p, i2 = cochran_q(np.array([0.0, 0.4]), np.array([0.001, 0.003]))
    assert pooled == pytest.approx(0.1) and df == 1 and q > 20 and p < 1e-4 and i2 > 0.9

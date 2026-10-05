from __future__ import annotations

import math

import numpy as np
import pytest
from conftest import make_config, make_rows
from scipy import stats as sps

from agon_stats.analysis import (
    analyze_sessions,
    delta_method_lift_ci,
    msprt_p_value,
    two_proportion_z_test,
    welch_t_test,
)
from agon_stats.metrics import metric_values, parse_metric

DURATION = {"id": "time_to_activate", "type": "duration", "to": "project_created"}


def direct_two_proportion_p(x1: int, n1: int, x2: int, n2: int) -> float:
    p1, p2 = x1 / n1, x2 / n2
    pooled = (x1 + x2) / (n1 + n2)
    se = math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2))
    return float(2 * sps.norm.sf(abs((p1 - p2) / se)))


def test_two_proportion_z_test_matches_direct_scipy_computation() -> None:
    z, p = two_proportion_z_test(45, 100, 30, 100)
    assert p == pytest.approx(direct_two_proportion_p(45, 100, 30, 100))
    pooled_se = math.sqrt(0.375 * 0.625 * (1 / 100 + 1 / 100))
    assert z == pytest.approx(0.15 / pooled_se)
    assert p == pytest.approx(float(2 * sps.norm.sf(z)))
    assert two_proportion_z_test(0, 50, 0, 50) == (0.0, 1.0)


def test_fixed_binary_comparison_uses_pooled_z_test() -> None:
    rows = make_rows({"control": 0.3, "treatment": 0.45}, n=100)
    output = analyze_sessions(rows, make_config(method="fixed"))
    comparison = output.metric("scenario_success").comparisons[0]
    control, treatment = output.metric("scenario_success").variants
    assert (control.successes, treatment.successes) == (30, 45)
    assert comparison.p_value == pytest.approx(direct_two_proportion_p(45, 100, 30, 100))
    assert comparison.p_value == comparison.p_value_fixed
    assert comparison.lift == pytest.approx(0.5)


def test_welch_matches_scipy_ttest_ind() -> None:
    rows = make_rows(
        {"control": 0.4, "treatment": 0.4}, n=80, duration={"control": 60, "treatment": 52}
    )
    config = make_config(method="fixed", metrics=[DURATION])
    output = analyze_sessions(rows, config)
    values = metric_values(parse_metric(DURATION), rows)
    control = values[[r.variant == "control" for r in rows]]
    treatment = values[[r.variant == "treatment" for r in rows]]
    expected = float(sps.ttest_ind(treatment, control, equal_var=False).pvalue)
    comparison = output.metric("time_to_activate").comparisons[0]
    assert comparison.p_value == pytest.approx(expected)
    assert welch_t_test(treatment, control) == pytest.approx(expected)
    assert output.metric("time_to_activate").metric.direction == "decrease"
    assert comparison.lift < 0


def test_welch_degenerate_inputs_give_p_one() -> None:
    assert welch_t_test(np.array([1.0]), np.array([1.0, 2.0])) == 1.0
    assert welch_t_test(np.array([2.0, 2.0]), np.array([2.0, 2.0])) == 1.0


def test_delta_method_lift_interval_is_centred_on_the_lift() -> None:
    ci = delta_method_lift_ci(0.45, 0.05, 0.30, 0.046)
    assert ci is not None
    lo, hi = ci
    assert lo < 0.5 < hi
    assert (lo + hi) / 2 == pytest.approx(0.5)
    assert delta_method_lift_ci(0.1, 0.01, 0.0, 0.01) is None


def test_msprt_matches_the_documented_formula_and_is_monotone() -> None:
    delta, variance, tau2 = 0.1, 0.002, 0.0025
    log_lambda = 0.5 * math.log(variance / (variance + tau2)) + tau2 * delta**2 / (
        2 * variance * (variance + tau2)
    )
    assert msprt_p_value(delta, variance, tau2) == pytest.approx(min(1.0, math.exp(-log_lambda)))
    assert msprt_p_value(0.0, variance, tau2) == 1.0
    assert msprt_p_value(0.5, 0.0, tau2) == 1.0
    p_values = [msprt_p_value(d, variance, tau2) for d in (0.02, 0.05, 0.1, 0.2, 0.4)]
    assert p_values == sorted(p_values, reverse=True)
    assert all(0.0 <= p <= 1.0 for p in p_values)
    assert p_values[-1] < 1e-6


def test_sequential_method_reports_always_valid_p_and_keeps_fixed_p() -> None:
    rows = make_rows({"control": 0.3, "treatment": 0.6}, n=200)
    output = analyze_sessions(rows, make_config(method="sequential"))
    comparison = output.metric("scenario_success").comparisons[0]
    assert comparison.p_value == comparison.p_value_sequential
    assert comparison.p_value is not None and comparison.p_value < 0.05
    assert comparison.p_value_fixed < comparison.p_value  # always-valid is conservative
    assert comparison.p_value_fixed == pytest.approx(direct_two_proportion_p(120, 200, 60, 200))


def test_bayesian_method_omits_p_value_but_keeps_fixed_p_internally() -> None:
    rows = make_rows({"control": 0.3, "treatment": 0.6}, n=200)
    output = analyze_sessions(rows, make_config(method="bayesian"))
    comparison = output.metric("scenario_success").comparisons[0]
    assert comparison.p_value is None
    assert "pValue" not in comparison.to_json()
    assert comparison.p_value_fixed < 1e-6

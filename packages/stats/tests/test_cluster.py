from __future__ import annotations

import numpy as np
import pytest
from conftest import make_config, make_rows

from agon_stats.analysis import (
    analyze_sessions,
    cluster_bootstrap_means,
    icc_oneway,
    kish_ess,
    variance_decomposition,
)

HETEROGENEOUS = {"smb-owner": -0.3, "developer-evaluator": 0.3, "skeptical-cfo": 0.0}


def test_cluster_bootstrap_widens_variant_intervals_and_lowers_ess() -> None:
    rows = make_rows(
        {"control": 0.45, "treatment": 0.45}, n=300, persona_shift=HETEROGENEOUS, seed=3
    )
    iid = analyze_sessions(rows, make_config(clusterBy=[])).metric("scenario_success")
    clustered = analyze_sessions(rows, make_config(clusterBy=["persona", "model"])).metric(
        "scenario_success"
    )
    assert not any("iid" in w for w in clustered.warnings)
    for before, after in zip(iid.variants, clustered.variants, strict=True):
        assert after.stderr > before.stderr
        assert after.ci95[1] - after.ci95[0] > before.ci95[1] - before.ci95[0]
        assert before.effective_sample_size == before.sessions
        assert 1.0 <= after.effective_sample_size < after.sessions
        assert after.mean == before.mean and after.sessions == before.sessions


def test_cluster_comparison_is_never_more_certain_than_iid() -> None:
    rows = make_rows({"control": 0.4, "treatment": 0.5}, n=240, persona_shift=HETEROGENEOUS, seed=5)
    iid = analyze_sessions(rows, make_config(method="fixed", clusterBy=[])).metric(
        "scenario_success"
    )
    clustered = analyze_sessions(
        rows, make_config(method="fixed", clusterBy=["persona", "model"])
    ).metric("scenario_success")
    iid_cmp, cluster_cmp = iid.comparisons[0], clustered.comparisons[0]
    assert cluster_cmp.lift == iid_cmp.lift
    assert cluster_cmp.lift_ci95[0] <= iid_cmp.lift_ci95[0]
    assert cluster_cmp.lift_ci95[1] >= iid_cmp.lift_ci95[1]
    assert cluster_cmp.p_value is not None and iid_cmp.p_value is not None
    assert cluster_cmp.p_value >= iid_cmp.p_value * 0.9


def test_too_few_clusters_fall_back_to_iid_with_a_warning() -> None:
    rows = make_rows(
        {"control": 0.4, "treatment": 0.5}, n=60, personas=("solo",), models=("openai/gpt-5",)
    )
    iid = analyze_sessions(rows, make_config(clusterBy=[])).metric("scenario_success")
    clustered = analyze_sessions(rows, make_config(clusterBy=["persona", "model"])).metric(
        "scenario_success"
    )
    assert any("yields 1 clusters" in w and "iid" in w for w in clustered.warnings)
    assert [v.to_json() for v in clustered.variants] == [v.to_json() for v in iid.variants]


def test_bayesian_clustered_posterior_still_finds_a_large_effect() -> None:
    rows = make_rows({"control": 0.3, "treatment": 0.6}, n=240, persona_shift=HETEROGENEOUS, seed=9)
    output = analyze_sessions(rows, make_config(clusterBy=["persona", "model"]))
    comparison = output.metric("scenario_success").comparisons[0]
    assert comparison.p_best > 0.95
    assert comparison.lift_ci95[0] > 0


def test_icc_and_kish_ess_bounds() -> None:
    clusters = np.repeat(np.arange(4), 25)
    perfectly_clustered = np.repeat([0.0, 1.0, 2.0, 3.0], 25)
    assert icc_oneway(perfectly_clustered, clusters) == pytest.approx(1.0)
    rng = np.random.default_rng(0)
    noise = rng.normal(size=100)
    assert icc_oneway(noise, clusters) < 0.2
    assert icc_oneway(noise, np.zeros(100, dtype=int)) == 0.0
    assert kish_ess(100, 10, 0.0) == 100.0
    assert kish_ess(100, 10, 1.0) == pytest.approx(10.0)
    assert kish_ess(100, 1, 1.0) == 1.0
    assert kish_ess(0, 3, 0.5) == 0.0


def test_cluster_bootstrap_means_shape_and_balance() -> None:
    rng = np.random.default_rng(1)
    values = np.array([0.0, 1.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0])
    variant_idx = np.array([0, 0, 0, 0, 1, 1, 1, 1])
    cluster_codes = np.array([0, 1, 2, 3, 0, 1, 2, 3])
    boot = cluster_bootstrap_means(values, variant_idx, cluster_codes, 2, 500, rng)
    assert boot.means.shape == (500, 2)
    assert boot.n_clusters == 4
    finite = np.isfinite(boot.means).all(axis=1)
    assert finite.all()
    assert boot.means[:, 0].mean() == pytest.approx(0.75, abs=0.05)
    assert boot.means[:, 1].mean() == pytest.approx(0.25, abs=0.05)


def test_variance_decomposition_sums_to_one_and_attributes_persona_effects() -> None:
    rows = make_rows(
        {"control": 0.45, "treatment": 0.45}, n=300, persona_shift=HETEROGENEOUS, seed=3
    )
    analysis = analyze_sessions(rows, make_config()).metric("scenario_success")
    assert analysis.variance_decomposition is not None
    decomposition = analysis.variance_decomposition
    assert set(decomposition) == {"persona", "model", "residual"}
    assert sum(decomposition.values()) == pytest.approx(1.0)
    assert all(0.0 <= share <= 1.0 for share in decomposition.values())
    assert decomposition["persona"] > 0.05 > decomposition["model"]


def test_variance_decomposition_includes_scenario_when_several_are_present() -> None:
    rows = make_rows({"control": 0.4, "treatment": 0.5}, n=60, scenarios=("signup", "checkout"))
    analysis = analyze_sessions(rows, make_config()).metric("scenario_success")
    assert analysis.variance_decomposition is not None
    assert set(analysis.variance_decomposition) == {"persona", "model", "scenario", "residual"}
    assert sum(analysis.variance_decomposition.values()) == pytest.approx(1.0)


def test_variance_decomposition_degenerate_inputs() -> None:
    values = np.array([2.0, 2.0, 2.0, 2.0])
    variant_idx = np.array([0, 0, 1, 1])
    means = np.array([2.0, 2.0])
    out = variance_decomposition(values, variant_idx, means, {"persona": ["a", "b", "a", "b"]})
    assert out == {"persona": 0.0, "residual": 1.0}
    values = np.array([0.0, 4.0, 0.0, 4.0])
    out = variance_decomposition(values, variant_idx, means, {"persona": ["a", "b", "a", "b"]})
    assert out["persona"] == pytest.approx(1.0) and out["residual"] == pytest.approx(0.0)

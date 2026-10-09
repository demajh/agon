"""Experiment analysis: per-variant statistics, comparisons against control, warnings.

Methods
-------
``fixed``
    Binary metrics: two-proportion z-test with the pooled standard error. Continuous metrics:
    Welch's t-test (``scipy.stats.ttest_ind(equal_var=False)``). Relative lift
    ``(mean_v - mean_c) / mean_c`` with a delta-method 95% interval::

        Var(lift) ~= se_v^2 / mean_c^2 + mean_v^2 * se_c^2 / mean_c^4

``sequential``
    Mixture sequential probability ratio test (mSPRT, Johari, Pekelis & Walsh) under a normal
    approximation, which gives an always-valid p-value that stays valid however often the run is
    inspected. With ``d`` the observed difference in means, ``V`` its estimated variance
    (``s_v^2/n_v + s_c^2/n_c``, or the cluster-robust equivalent) and a ``N(0, tau^2)`` mixing
    distribution over the true effect::

        Lambda = sqrt(V / (V + tau^2)) * exp( tau^2 * d^2 / (2 * V * (V + tau^2)) )
        p      = min(1, 1 / Lambda)

    ``tau^2 = mixtureVarianceScale * sigma^2`` where ``sigma^2`` is the pooled per-observation
    variance; the default scale 0.01 says "true effects are typically about a tenth of a standard
    deviation". The fixed-horizon p-value is computed too and available on the Python objects.

``bayesian`` (default)
    Binary: ``Beta(1 + successes, 1 + failures)`` posteriors. Continuous: Normal-Normal with a
    weak prior ``N(grand mean, 100 * pooled variance)`` and the sample variance plugged in.
    20,000 Monte Carlo draws from the joint posterior give ``P(best)`` over *all* variants
    (ties split evenly), ``P(beat control)``, expected loss (expected regret in the metric's
    good direction, in metric units) and a 2.5%-97.5% credible interval for the relative lift.

Clustering (``clusterBy`` non-empty)
-----------------------------------
Sessions that share a persona x model (x scenario) combination are not independent users, so
uncertainty comes from a cluster bootstrap: the unique cluster keys are resampled with
replacement ``bootstrapSamples`` times and every variant's mean is recomputed from the sessions of
the drawn clusters. Because Agon runs the same seeded population against every variant, the same
resample is applied to all variants (a paired cluster bootstrap): per-variant ``stderr``/``ci95``
are the spread of a variant's replicate means, the lift interval and the difference's standard
error come from the joint replicates, so persona effects shared by both arms cancel the way they
do in a blocked design. With the handful of clusters a typical population has, the bootstrap
variance is itself noisy, so clustering is never allowed to make a comparison *more* certain
than iid sampling: the difference's standard error is floored at its iid value and the lift
interval contains the iid delta-method interval. The Bayesian posterior becomes a multivariate
normal centred on the sample means with the bootstrap covariance, with the same floors on the
variances and on every treatment-minus-control variance. Effective sample size per variant is
``n / (1 + (mean cluster size - 1) * ICC)`` (Kish design effect) with the ICC from a one-way
ANOVA, clipped to ``[1, n]``. Fewer than three clusters in any variant falls back to iid
uncertainty with a warning.

Variance decomposition
----------------------
After removing variant means, the one-way between-group sum of squares of persona, model (and
scenario when more than one is present) as a fraction of the total residual sum of squares, each
clipped to ``[0, 1]``; ``residual`` is the remainder, and the fractions are normalized to sum to 1.
"""

from __future__ import annotations

import math
import zlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from scipy import stats as sps

from agon_stats.config import AnalysisConfig
from agon_stats.errors import ConfigError, ValidationError
from agon_stats.io import SessionRow
from agon_stats.metrics import (
    SCENARIO_SUCCESS_METRIC_ID,
    MetricSpec,
    is_binary,
    metric_values,
    scenario_success_metric,
)

Z975: float = float(sps.norm.ppf(0.975))
MIN_CLUSTERS = 3
MIN_BOOTSTRAP_REPLICATES = 30
WEAK_PRIOR_VARIANCE_FACTOR = 100.0

# --------------------------------------------------------------------------------------------
# Result objects (serialized with the camelCase keys of @agon/spec `result.ts`)
# --------------------------------------------------------------------------------------------


@dataclass(slots=True)
class VariantStats:
    variant: str
    sessions: int
    mean: float
    stderr: float
    ci95: tuple[float, float]
    effective_sample_size: float
    successes: int | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"variant": self.variant, "sessions": int(self.sessions)}
        if self.successes is not None:
            out["successes"] = int(self.successes)
        out["mean"] = _num(self.mean)
        out["stderr"] = _num(self.stderr, lo=0.0)
        out["ci95"] = [_num(self.ci95[0]), _num(self.ci95[1])]
        out["effectiveSampleSize"] = _num(self.effective_sample_size, lo=0.0)
        return out


@dataclass(slots=True)
class Comparison:
    variant: str
    control: str
    lift: float
    lift_ci95: tuple[float, float]
    p_best: float
    p_beat_control: float
    expected_loss: float
    p_value: float | None
    """The method's p-value: fixed-horizon for `fixed`, always-valid for `sequential`."""
    p_value_fixed: float
    """Fixed-horizon p-value, always computed (not serialized for bayesian/sequential)."""
    p_value_sequential: float | None = None
    z_stat: float = 0.0
    """Test statistic of treatment minus control (z, or Welch's t for continuous iid data)."""

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "variant": self.variant,
            "control": self.control,
            "lift": _num(self.lift),
            "liftCi95": [_num(self.lift_ci95[0]), _num(self.lift_ci95[1])],
            "pBest": _num(self.p_best, lo=0.0, hi=1.0),
            "pBeatControl": _num(self.p_beat_control, lo=0.0, hi=1.0),
            "expectedLoss": _num(self.expected_loss, lo=0.0),
        }
        if self.p_value is not None:
            out["pValue"] = _num(self.p_value, lo=0.0, hi=1.0)
            out["zStat"] = _num(self.z_stat)
        return out


@dataclass(slots=True)
class MetricAnalysis:
    metric: MetricSpec
    binary: bool
    variants: list[VariantStats]
    comparisons: list[Comparison]
    p_best: dict[str, float]
    """P(best) for every variant, control included."""
    variance_decomposition: dict[str, float] | None = None
    warnings: list[str] = field(default_factory=list)

    def variant_stats(self, variant: str) -> VariantStats:
        for stats in self.variants:
            if stats.variant == variant:
                return stats
        raise KeyError(variant)

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "metricId": self.metric.id,
            "direction": self.metric.direction,
            "variants": [v.to_json() for v in self.variants],
            "comparisons": [c.to_json() for c in self.comparisons],
        }
        if self.variance_decomposition is not None:
            out["varianceDecomposition"] = {
                k: _num(v, lo=0.0, hi=1.0) for k, v in self.variance_decomposition.items()
            }
        out["warnings"] = list(self.warnings)
        return out


@dataclass(slots=True)
class AnalysisOutput:
    variants: list[str]
    control: str
    metrics: list[MetricAnalysis]

    def metric(self, metric_id: str) -> MetricAnalysis:
        for analysis in self.metrics:
            if analysis.metric.id == metric_id:
                return analysis
        raise KeyError(metric_id)

    def primary(self) -> MetricAnalysis:
        for analysis in self.metrics:
            if analysis.metric.primary:
                return analysis
        return self.metric(SCENARIO_SUCCESS_METRIC_ID)


# --------------------------------------------------------------------------------------------
# Pure statistics
# --------------------------------------------------------------------------------------------


def two_proportion_z_test(x1: int, n1: int, x2: int, n2: int) -> tuple[float, float]:
    """Pooled two-proportion z-test; returns ``(z, two-sided p)``. Degenerate inputs give p=1."""
    if n1 <= 0 or n2 <= 0:
        return 0.0, 1.0
    p1, p2 = x1 / n1, x2 / n2
    pooled = (x1 + x2) / (n1 + n2)
    se = math.sqrt(pooled * (1.0 - pooled) * (1.0 / n1 + 1.0 / n2))
    if se == 0.0:
        return 0.0, 1.0
    z = (p1 - p2) / se
    return z, float(2.0 * sps.norm.sf(abs(z)))


def welch_t(a: np.ndarray, b: np.ndarray) -> tuple[float, float]:
    """Welch t-test of ``a`` against ``b``: ``(t, two-sided p)``; ``(0, 1)`` when a sample is
    too small or neither has variance."""
    if a.size < 2 or b.size < 2:
        return 0.0, 1.0
    if np.var(a, ddof=1) == 0.0 and np.var(b, ddof=1) == 0.0:
        return 0.0, 1.0
    test = sps.ttest_ind(a, b, equal_var=False)
    t, p = float(test.statistic), float(test.pvalue)
    if not (math.isfinite(t) and math.isfinite(p)):
        return 0.0, 1.0
    return t, p


def welch_t_test(a: np.ndarray, b: np.ndarray) -> float:
    """Two-sided Welch t-test p-value; 1.0 when a sample is too small or has no variance."""
    return welch_t(a, b)[1]


def normal_two_sided_p(delta: float, se: float) -> float:
    if se <= 0.0 or not math.isfinite(se):
        return 1.0
    return float(2.0 * sps.norm.sf(abs(delta) / se))


def msprt_p_value(delta: float, variance: float, tau2: float) -> float:
    """Always-valid p-value of the mixture SPRT (normal approximation); see module docstring."""
    if variance <= 0.0 or tau2 <= 0.0 or not math.isfinite(delta):
        return 1.0
    log_lambda = 0.5 * math.log(variance / (variance + tau2)) + (
        tau2 * delta * delta / (2.0 * variance * (variance + tau2))
    )
    if log_lambda <= 0.0:
        return 1.0
    return min(1.0, math.exp(-log_lambda))


def wilson_interval(successes: int, n: int, z: float = Z975) -> tuple[float, float]:
    """Wilson score 95% interval for a proportion."""
    if n <= 0:
        return 0.0, 0.0
    p = successes / n
    denom = 1.0 + z * z / n
    centre = (p + z * z / (2.0 * n)) / denom
    half = z * math.sqrt(p * (1.0 - p) / n + z * z / (4.0 * n * n)) / denom
    return max(0.0, centre - half), min(1.0, centre + half)


def t_interval(mean: float, se: float, n: int, level: float = 0.95) -> tuple[float, float]:
    if n < 2 or se <= 0.0:
        return mean, mean
    q = float(sps.t.ppf(0.5 + level / 2.0, n - 1))
    return mean - q * se, mean + q * se


def delta_method_lift_ci(
    mean_t: float, se_t: float, mean_c: float, se_c: float, z: float = Z975
) -> tuple[float, float] | None:
    """95% interval for the relative lift ``mean_t / mean_c - 1`` by the delta method."""
    if mean_c == 0.0:
        return None
    lift = mean_t / mean_c - 1.0
    var = se_t * se_t / (mean_c * mean_c) + mean_t * mean_t * se_c * se_c / mean_c**4
    half = z * math.sqrt(max(var, 0.0))
    return lift - half, lift + half


def icc_oneway(values: np.ndarray, clusters: np.ndarray) -> float:
    """Intraclass correlation from a one-way ANOVA (ANOVA estimator), clipped to [0, 1]."""
    n = values.size
    if n == 0:
        return 0.0
    _, codes = np.unique(clusters, return_inverse=True)
    codes = codes.reshape(-1)
    m = int(codes.max()) + 1
    if m < 2 or n <= m:
        return 0.0
    sizes = np.bincount(codes, minlength=m).astype(np.float64)
    sums = np.bincount(codes, weights=values, minlength=m)
    cluster_means = sums / sizes
    grand = float(values.mean())
    ss_between = float(np.sum(sizes * (cluster_means - grand) ** 2))
    ss_within = float(np.sum((values - cluster_means[codes]) ** 2))
    ms_between = ss_between / (m - 1)
    ms_within = ss_within / (n - m)
    n0 = (n - float(np.sum(sizes * sizes)) / n) / (m - 1)
    denom = ms_between + (n0 - 1.0) * ms_within
    if denom <= 0.0:
        return 0.0
    return float(min(1.0, max(0.0, (ms_between - ms_within) / denom)))


def kish_ess(n: int, n_clusters: int, icc: float) -> float:
    """Effective sample size ``n / deff`` with ``deff = 1 + (mean cluster size - 1) * ICC``."""
    if n <= 0:
        return 0.0
    if n_clusters <= 0:
        return float(n)
    mean_size = n / n_clusters
    deff = 1.0 + (mean_size - 1.0) * max(0.0, min(1.0, icc))
    return float(min(float(n), max(1.0, n / deff)))


def variance_decomposition(
    values: np.ndarray,
    variant_idx: np.ndarray,
    variant_means: np.ndarray,
    factors: Mapping[str, Sequence[str]],
) -> dict[str, float]:
    """Share of residual (post-variant) variance explained by each factor; sums to 1."""
    residuals = values - variant_means[variant_idx]
    total = float(np.sum(residuals * residuals))
    if total <= 0.0 or values.size < 2:
        return {**{name: 0.0 for name in factors}, "residual": 1.0}
    overall = float(residuals.mean())
    shares: dict[str, float] = {}
    for name, labels in factors.items():
        _, codes = np.unique(np.asarray(list(labels), dtype=str), return_inverse=True)
        codes = codes.reshape(-1)
        sizes = np.bincount(codes).astype(np.float64)
        group_means = np.bincount(codes, weights=residuals) / sizes
        ss_between = float(np.sum(sizes * (group_means - overall) ** 2))
        shares[name] = min(1.0, max(0.0, ss_between / total))
    explained = sum(shares.values())
    shares["residual"] = max(0.0, 1.0 - explained)
    norm = sum(shares.values())
    return {name: share / norm for name, share in shares.items()}


@dataclass(slots=True)
class BootstrapMeans:
    means: np.ndarray
    """Replicate means, shape ``(replicates, variants)``; NaN where a variant drew no sessions."""
    n_clusters: int


def cluster_bootstrap_means(
    values: np.ndarray,
    variant_idx: np.ndarray,
    cluster_codes: np.ndarray,
    n_variants: int,
    n_replicates: int,
    rng: np.random.Generator,
) -> BootstrapMeans:
    """Paired cluster bootstrap: resample cluster keys, recompute every variant's mean."""
    n_clusters = int(cluster_codes.max()) + 1 if cluster_codes.size else 0
    if n_clusters == 0:
        return BootstrapMeans(np.full((n_replicates, n_variants), np.nan), 0)
    sums = np.zeros((n_clusters, n_variants))
    counts = np.zeros((n_clusters, n_variants))
    np.add.at(sums, (cluster_codes, variant_idx), values)
    np.add.at(counts, (cluster_codes, variant_idx), 1.0)
    draws = rng.integers(0, n_clusters, size=(n_replicates, n_clusters))
    weights = np.zeros((n_replicates, n_clusters))
    np.add.at(weights, (np.arange(n_replicates)[:, None], draws), 1.0)
    rep_sums = weights @ sums
    rep_counts = weights @ counts
    with np.errstate(invalid="ignore", divide="ignore"):
        means = np.where(rep_counts > 0, rep_sums / rep_counts, np.nan)
    return BootstrapMeans(means, n_clusters)


@dataclass(slots=True)
class MonteCarloSummary:
    p_best: np.ndarray
    p_beat_control: np.ndarray
    expected_loss: np.ndarray


def monte_carlo_summary(theta: np.ndarray, control_idx: int, direction: str) -> MonteCarloSummary:
    """P(best) over all variants (ties split), P(beat control) and expected loss per variant."""
    signed = theta if direction == "increase" else -theta
    best = signed.max(axis=1, keepdims=True)
    is_best = signed == best
    p_best = (is_best / is_best.sum(axis=1, keepdims=True)).mean(axis=0)
    control = signed[:, [control_idx]]
    p_beat = (signed > control).mean(axis=0) + 0.5 * (signed == control).mean(axis=0)
    expected_loss = (best - signed).mean(axis=0)
    return MonteCarloSummary(p_best, p_beat, np.maximum(expected_loss, 0.0))


# --------------------------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------------------------


def order_variants(rows: Sequence[SessionRow], control: str | None) -> tuple[list[str], str]:
    """Control first, then the other variants sorted. Control defaults per AnalysisSchema."""
    seen = list(dict.fromkeys(row.variant for row in rows))
    if not seen:
        raise ValidationError("no sessions to analyze")
    if control is None:
        control = "control" if "control" in seen else seen[0]
    elif control not in seen:
        raise ConfigError(f"control variant {control!r} has no sessions; present: {seen}")
    return [control, *sorted(v for v in seen if v != control)], control


def metric_specs(config: AnalysisConfig) -> list[MetricSpec]:
    """scenario_success first (always), then the configured metrics in config order."""
    configured = list(config.metrics)
    override = next((m for m in configured if m.id == SCENARIO_SUCCESS_METRIC_ID), None)
    any_primary = any(m.primary for m in configured)
    success = (
        scenario_success_metric(primary=override.primary)
        if override is not None
        else scenario_success_metric(primary=not any_primary)
    )
    return [success, *(m for m in configured if m.id != SCENARIO_SUCCESS_METRIC_ID)]


def metric_rng(seed: int, metric_id: str) -> np.random.Generator:
    """A generator that depends only on the run seed and the metric id, not on metric order."""
    return np.random.default_rng([seed, zlib.crc32(metric_id.encode("utf-8"))])


def cluster_key(row: SessionRow, cluster_by: Sequence[str]) -> str:
    parts: list[str] = []
    for factor in cluster_by:
        if factor == "persona":
            parts.append(row.persona_id)
        elif factor == "model":
            parts.append(row.model)
        elif factor == "scenario":
            parts.append(row.scenario_id)
        else:
            raise ConfigError(f"unknown clusterBy factor {factor!r}")
    return "\x1f".join(parts)


def analyze_sessions(rows: Sequence[SessionRow], config: AnalysisConfig) -> AnalysisOutput:
    """Analyze every metric (scenario_success plus the configured ones) over `rows`."""
    variants, control = order_variants(rows, config.control)
    analyses = [
        analyze_metric(
            spec,
            rows,
            metric_values(spec, rows),
            config,
            variants,
            control,
            rng=metric_rng(config.seed, spec.id),
        )
        for spec in metric_specs(config)
    ]
    return AnalysisOutput(variants=variants, control=control, metrics=analyses)


def analyze_metric(
    spec: MetricSpec,
    rows: Sequence[SessionRow],
    values: np.ndarray,
    config: AnalysisConfig,
    variants: Sequence[str],
    control: str,
    *,
    rng: np.random.Generator,
) -> MetricAnalysis:
    n_variants = len(variants)
    index = {variant: i for i, variant in enumerate(variants)}
    control_idx = index[control]
    variant_idx_all = np.array([index[row.variant] for row in rows], dtype=np.int64)
    finite = np.isfinite(values)
    warnings: list[str] = []

    totals = np.bincount(variant_idx_all, minlength=n_variants)
    y = values[finite]
    vidx = variant_idx_all[finite]
    kept_rows = [row for row, keep in zip(rows, finite, strict=True) if keep]
    counts = np.bincount(vidx, minlength=n_variants)
    for i, variant in enumerate(variants):
        if counts[i] < totals[i]:
            warnings.append(
                f"{variant}: {int(totals[i] - counts[i])} of {int(totals[i])} sessions have no "
                f"value for {spec.id}; excluded"
            )

    binary = is_binary(spec, y)
    sums = np.bincount(vidx, weights=y, minlength=n_variants) if y.size else np.zeros(n_variants)
    means = np.divide(sums, counts, out=np.zeros(n_variants), where=counts > 0)
    variances = np.zeros(n_variants)
    for i in range(n_variants):
        if counts[i] > 1:
            variances[i] = float(np.var(y[vidx == i], ddof=1))
    successes = np.rint(sums).astype(np.int64) if binary else None

    for i, variant in enumerate(variants):
        if counts[i] < config.min_sessions_per_variant:
            warnings.append(
                f"{variant}: {int(counts[i])} sessions < "
                f"minSessionsPerVariant={config.min_sessions_per_variant}"
            )
        if counts[i] >= 2 and variances[i] == 0.0:
            warnings.append(f"{variant}: zero variance for {spec.id} (every value is {means[i]:g})")

    se_iid = np.zeros(n_variants)
    for i in range(n_variants):
        if counts[i] == 0:
            continue
        if binary:
            p = means[i]
            se_iid[i] = math.sqrt(p * (1.0 - p) / counts[i])
        elif counts[i] > 1:
            se_iid[i] = math.sqrt(variances[i] / counts[i])

    # ---- clustering -------------------------------------------------------------------------
    use_cluster = bool(config.cluster_by)
    boot: BootstrapMeans | None = None
    complete = np.zeros(0, dtype=bool)
    cluster_codes = np.zeros(0, dtype=np.int64)
    if use_cluster:
        keys = np.array([cluster_key(row, config.cluster_by) for row in kept_rows], dtype=str)
        if keys.size:
            _, cluster_codes = np.unique(keys, return_inverse=True)
            cluster_codes = cluster_codes.reshape(-1).astype(np.int64)
        per_variant = [
            int(np.unique(cluster_codes[vidx == i]).size)
            for i in range(n_variants)
            if counts[i] > 0
        ]
        fewest = min(per_variant) if per_variant else 0
        if fewest < MIN_CLUSTERS:
            warnings.append(
                f"clusterBy={list(config.cluster_by)} yields {fewest} clusters in a variant "
                f"(< {MIN_CLUSTERS}); using iid uncertainty"
            )
            use_cluster = False
        else:
            boot = cluster_bootstrap_means(
                y, vidx, cluster_codes, n_variants, config.bootstrap_samples, rng
            )
            populated = counts > 0
            complete = np.all(np.isfinite(boot.means[:, populated]), axis=1)
            if int(complete.sum()) < MIN_BOOTSTRAP_REPLICATES:
                warnings.append(
                    f"cluster bootstrap produced only {int(complete.sum())} usable replicates; "
                    "using iid uncertainty"
                )
                use_cluster = False
                boot = None

    # ---- per-variant statistics -------------------------------------------------------------
    se = se_iid.copy()
    ess = counts.astype(np.float64)
    ci = np.zeros((n_variants, 2))
    for i in range(n_variants):
        n = int(counts[i])
        if n == 0:
            continue
        if binary:
            ci[i] = wilson_interval(int(successes[i]) if successes is not None else 0, n)
        else:
            ci[i] = t_interval(float(means[i]), float(se_iid[i]), n)
        if use_cluster and boot is not None:
            reps = boot.means[:, i]
            reps = reps[np.isfinite(reps)]
            if reps.size >= 2:
                se[i] = float(np.std(reps, ddof=1))
                ci[i] = np.percentile(reps, [2.5, 97.5])
            mask = vidx == i
            n_clusters_i = int(np.unique(cluster_codes[mask]).size)
            ess[i] = kish_ess(n, n_clusters_i, icc_oneway(y[mask], cluster_codes[mask]))

    variant_stats = [
        VariantStats(
            variant=variant,
            sessions=int(counts[i]),
            mean=float(means[i]),
            stderr=float(se[i]),
            ci95=(float(ci[i, 0]), float(ci[i, 1])),
            effective_sample_size=float(ess[i]),
            successes=int(successes[i]) if successes is not None else None,
        )
        for i, variant in enumerate(variants)
    ]

    # ---- posterior draws ------------------------------------------------------------------
    fallback_var = float(np.var(y, ddof=1)) if y.size >= 2 else 0.0
    theta = _posterior_draws_iid(
        means, variances, counts, successes, binary, config.draws, rng, fallback_var
    )
    if use_cluster and boot is not None:
        theta = _posterior_draws_clustered(
            means,
            boot.means[complete],
            se_iid,
            counts,
            successes,
            binary,
            control_idx,
            theta,
            rng,
        )
    summary = monte_carlo_summary(theta, control_idx, spec.direction)
    p_best = {variant: float(summary.p_best[i]) for i, variant in enumerate(variants)}

    # ---- comparisons against control ------------------------------------------------------
    comparisons: list[Comparison] = []
    mean_c = float(means[control_idx])
    n_c = int(counts[control_idx])
    if mean_c == 0.0 and n_variants > 1:
        warnings.append(f"{control}: mean of {spec.id} is zero; relative lift is undefined")
    for t, variant in enumerate(variants):
        if t == control_idx:
            continue
        mean_t = float(means[t])
        n_t = int(counts[t])
        lift = (mean_t - mean_c) / mean_c if mean_c != 0.0 else 0.0

        se_diff_iid = math.sqrt(se_iid[t] ** 2 + se_iid[control_idx] ** 2)
        if use_cluster and boot is not None:
            # Paired cluster bootstrap of the difference, never more certain than iid sampling.
            diff_reps = boot.means[complete, t] - boot.means[complete, control_idx]
            se_diff_boot = float(np.std(diff_reps, ddof=1)) if diff_reps.size >= 2 else 0.0
            se_diff = max(se_diff_boot, se_diff_iid)
            p_fixed = normal_two_sided_p(mean_t - mean_c, se_diff)
            z_stat = (mean_t - mean_c) / se_diff if se_diff > 0.0 else 0.0
        else:
            se_diff = se_diff_iid
            if binary and successes is not None:
                z_stat, p_fixed = two_proportion_z_test(
                    int(successes[t]), n_t, int(successes[control_idx]), n_c
                )
            else:
                z_stat, p_fixed = welch_t(y[vidx == t], y[vidx == control_idx])

        p_sequential: float | None = None
        if config.method == "sequential":
            if binary:
                total_n = n_t + n_c
                pooled_p = (sums[t] + sums[control_idx]) / total_n if total_n else 0.0
                sigma2 = float(pooled_p * (1.0 - pooled_p))
            else:
                dof = max(n_t - 1, 0) + max(n_c - 1, 0)
                sigma2 = (
                    float(
                        (max(n_t - 1, 0) * variances[t] + max(n_c - 1, 0) * variances[control_idx])
                        / dof
                    )
                    if dof > 0
                    else 0.0
                )
            p_sequential = msprt_p_value(
                mean_t - mean_c, se_diff * se_diff, config.mixture_variance_scale * sigma2
            )

        lift_ci: tuple[float, float] | None = None
        if mean_c != 0.0:
            if config.method == "bayesian":
                lift_ci = _credible_lift_interval(theta, t, control_idx)
                if lift_ci is None and use_cluster and boot is not None:
                    lift_ci = _bootstrap_lift_interval(boot.means[complete], t, control_idx)
            elif use_cluster and boot is not None:
                lift_ci = _bootstrap_lift_interval(boot.means[complete], t, control_idx)
                iid_ci = delta_method_lift_ci(
                    mean_t, float(se_iid[t]), mean_c, float(se_iid[control_idx])
                )
                if lift_ci is not None and iid_ci is not None:
                    # Envelope: the cluster interval is never narrower than the iid one.
                    lift_ci = (min(lift_ci[0], iid_ci[0]), max(lift_ci[1], iid_ci[1]))
            if lift_ci is None:
                lift_ci = delta_method_lift_ci(mean_t, float(se[t]), mean_c, float(se[control_idx]))
        if lift_ci is None:
            lift_ci = (lift, lift)

        if config.method == "fixed":
            p_value: float | None = p_fixed
        elif config.method == "sequential":
            p_value = p_sequential
        else:
            p_value = None

        comparisons.append(
            Comparison(
                variant=variant,
                control=control,
                lift=lift,
                lift_ci95=lift_ci,
                p_best=float(summary.p_best[t]),
                p_beat_control=float(summary.p_beat_control[t]),
                expected_loss=float(summary.expected_loss[t]),
                p_value=p_value,
                p_value_fixed=p_fixed,
                p_value_sequential=p_sequential,
                z_stat=float(z_stat),
            )
        )

    # ---- variance decomposition -----------------------------------------------------------
    decomposition: dict[str, float] | None = None
    if y.size >= 2:
        factors: dict[str, Sequence[str]] = {
            "persona": [row.persona_id for row in kept_rows],
            "model": [row.model for row in kept_rows],
        }
        scenarios = [row.scenario_id for row in kept_rows]
        if len(set(scenarios)) > 1:
            factors["scenario"] = scenarios
        decomposition = variance_decomposition(y, vidx, means, factors)

    return MetricAnalysis(
        metric=spec,
        binary=binary,
        variants=variant_stats,
        comparisons=comparisons,
        p_best=p_best,
        variance_decomposition=decomposition,
        warnings=warnings,
    )


# --------------------------------------------------------------------------------------------
# Posteriors
# --------------------------------------------------------------------------------------------


def _posterior_draws_iid(
    means: np.ndarray,
    variances: np.ndarray,
    counts: np.ndarray,
    successes: np.ndarray | None,
    binary: bool,
    draws: int,
    rng: np.random.Generator,
    fallback_var: float = 0.0,
) -> np.ndarray:
    n_variants = means.size
    theta = np.empty((draws, n_variants))
    if binary and successes is not None:
        for i in range(n_variants):
            theta[:, i] = rng.beta(1.0 + successes[i], 1.0 + counts[i] - successes[i], size=draws)
        return theta

    dof = np.maximum(counts - 1, 0)
    # Pooled within-variant variance; when no variant has two observations, the spread of all
    # observations together is the only scale available (better than a point-mass posterior).
    pooled_var = float(np.sum(dof * variances) / dof.sum()) if dof.sum() > 0 else fallback_var
    total = counts.sum()
    grand_mean = float(np.sum(means * counts) / total) if total > 0 else 0.0
    prior_var = WEAK_PRIOR_VARIANCE_FACTOR * pooled_var
    for i in range(n_variants):
        n = int(counts[i])
        if n == 0:
            theta[:, i] = (
                rng.normal(grand_mean, math.sqrt(prior_var), size=draws)
                if prior_var > 0.0
                else grand_mean
            )
            continue
        var_i = variances[i] if (n > 1 and variances[i] > 0.0) else pooled_var
        if var_i <= 0.0:
            theta[:, i] = means[i]
            continue
        data_precision = n / var_i
        prior_precision = 1.0 / prior_var if prior_var > 0.0 else 0.0
        post_var = 1.0 / (data_precision + prior_precision)
        post_mean = post_var * (data_precision * means[i] + prior_precision * grand_mean)
        theta[:, i] = rng.normal(post_mean, math.sqrt(post_var), size=draws)
    return theta


def _posterior_draws_clustered(
    means: np.ndarray,
    replicate_means: np.ndarray,
    se_iid: np.ndarray,
    counts: np.ndarray,
    successes: np.ndarray | None,
    binary: bool,
    control_idx: int,
    theta_iid: np.ndarray,
    rng: np.random.Generator,
) -> np.ndarray:
    """Multivariate-normal posterior with the bootstrap covariance of the variant means.

    Variances are floored at their iid values and, for every treatment, the variance of the
    difference against control is floored at its iid value too, so clustering never makes the
    posterior more certain than session-level sampling noise. Variants without sessions keep
    their iid (prior) draws.
    """
    n_variants = means.size
    draws = theta_iid.shape[0]
    cov = np.atleast_2d(np.cov(replicate_means, rowvar=False)).astype(np.float64)
    cov = np.nan_to_num(cov, nan=0.0, posinf=0.0, neginf=0.0)
    floor = se_iid**2
    if binary and successes is not None:
        with np.errstate(divide="ignore", invalid="ignore"):
            laplace = (successes + 1.0) / (counts + 2.0)
            floor = np.maximum(floor, np.where(counts > 0, laplace * (1.0 - laplace) / counts, 0.0))
    for i in range(n_variants):
        if cov[i, i] < floor[i]:
            cov[i, i] = floor[i]
    for t in range(n_variants):
        if t == control_idx:
            continue
        var_diff = cov[t, t] + cov[control_idx, control_idx] - 2.0 * cov[t, control_idx]
        deficit = floor[t] + floor[control_idx] - var_diff
        if deficit > 0.0:
            cov[t, t] += deficit
    theta = rng.multivariate_normal(means, cov, size=draws, method="svd")
    if binary:
        theta = np.clip(theta, 0.0, 1.0)
    empty = counts == 0
    if np.any(empty):
        theta[:, empty] = theta_iid[:, empty]
    return theta


def _credible_lift_interval(
    theta: np.ndarray, treatment: int, control: int
) -> tuple[float, float] | None:
    """2.5-97.5% interval of the relative lift over the joint posterior draws.

    Draws whose control value is not positive (possible under the normal approximation) are
    dropped; when more than 5% of draws are like that the ratio is meaningless and None is
    returned so the caller falls back to another interval.
    """
    ctrl = theta[:, control]
    valid = ctrl > 0.0
    if valid.mean() < 0.95:
        return None
    lifts = (theta[valid, treatment] - ctrl[valid]) / ctrl[valid]
    lo, hi = np.percentile(lifts, [2.5, 97.5])
    return float(lo), float(hi)


def _bootstrap_lift_interval(
    replicate_means: np.ndarray, treatment: int, control: int
) -> tuple[float, float] | None:
    ctrl = replicate_means[:, control]
    valid = ctrl > 0.0
    if int(valid.sum()) < MIN_BOOTSTRAP_REPLICATES:
        return None
    lifts = (replicate_means[valid, treatment] - ctrl[valid]) / ctrl[valid]
    lo, hi = np.percentile(lifts, [2.5, 97.5])
    return float(lo), float(hi)


def _num(value: float, *, lo: float | None = None, hi: float | None = None) -> float:
    """A finite JSON number (NaN/inf become 0), optionally clipped."""
    number = float(value)
    if not math.isfinite(number):
        number = 0.0
    if lo is not None:
        number = max(lo, number)
    if hi is not None:
        number = min(hi, number)
    return number

"""Turn the primary metric's analysis into a verdict (ship / kill / continue / inconclusive).

Rules, evaluated on the primary metric:

* ``continue`` - any variant has fewer than ``minSessionsPerVariant`` sessions.
* bayesian: the treatment with the highest P(best) is shipped when its P(best) >= ``shipIf``;
  ``kill`` when every treatment has P(best) <= ``killIf`` and control's P(best) >= ``shipIf``;
  otherwise ``inconclusive``.
* fixed / sequential: a treatment is shipped when its p-value is below alpha (Bonferroni-divided
  by the number of treatments) *and* its lift points in the metric's good direction; the
  candidate with the highest P(beat control) wins. ``kill`` when every treatment is significantly
  worse than control; otherwise ``inconclusive``.

The trial count M (``trials`` in the analysis config, read from the evaluation ledger: every
variant ever evaluated against the same sample, discarded ones included) corrects for the
search across variants. For ``fixed`` a ship candidate must also clear the quantile of the max
of M standard normals, ``z > Phi^-1((1 - alpha)^(1/M))`` (1.645 at M=1, 3.283 at M=100 for
alpha 0.05), so M=1 leaves the existing rule in charge. ``bayesian`` and ``sequential`` report
M and warn that P(best) is not corrected for it. Every rationale states M and the sample hash.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, Literal

from scipy import stats as sps

from agon_stats.analysis import Comparison, MetricAnalysis
from agon_stats.config import AnalysisConfig

Verdict = Literal["ship", "kill", "continue", "inconclusive"]


@dataclass(frozen=True, slots=True)
class Decision:
    verdict: Verdict
    rationale: str
    variant: str | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"verdict": self.verdict}
        if self.variant is not None:
            out["variant"] = self.variant
        out["rationale"] = self.rationale
        return out


def max_quantile_bar(alpha: float, trials: int) -> float:
    """``Phi^-1((1 - alpha)^(1/M))``: the one-sided bar the best of M null z-statistics clears
    with probability alpha."""
    m = max(1, int(trials))
    return float(sps.norm.ppf((1.0 - alpha) ** (1.0 / m)))


def decide(primary: MetricAnalysis, config: AnalysisConfig, control: str) -> Decision:
    decision = _decide(primary, config, control)
    return replace(decision, rationale=f"{decision.rationale} {_trials_note(config)}")


def _trials_note(config: AnalysisConfig) -> str:
    m = max(1, config.trials)
    sample = (
        f"sample {config.sample_hash[:12]}"
        if config.sample_hash
        else "sample unknown (no evaluation ledger supplied; round M up when unsure)"
    )
    head = f"Trials: M={m} distinct variant(s) evaluated against {sample};"
    if config.method == "fixed":
        bar = max_quantile_bar(config.alpha, m)
        return f"{head} ship bar z > {bar:.3f} = Phi^-1((1-{config.alpha:g})^(1/{m}))."
    return f"{head} P(best) is not corrected for the number of trials searched."


def _decide(primary: MetricAnalysis, config: AnalysisConfig, control: str) -> Decision:
    metric_id = primary.metric.id
    minimum = config.min_sessions_per_variant
    short = [(s.variant, s.sessions) for s in primary.variants if s.sessions < minimum]
    if short:
        detail = ", ".join(f"{variant} has {n}" for variant, n in short)
        return Decision(
            "continue",
            f"Need at least {minimum} sessions per variant on {metric_id}: {detail}.",
        )
    treatments = primary.comparisons
    if not treatments:
        return Decision(
            "inconclusive", f"Only one variant ({control}) has sessions; nothing to compare."
        )
    if config.method == "bayesian":
        return _bayesian_verdict(primary, treatments, config, control)
    return _frequentist_verdict(primary, treatments, config, control)


def _bayesian_verdict(
    primary: MetricAnalysis,
    treatments: list[Comparison],
    config: AnalysisConfig,
    control: str,
) -> Decision:
    metric_id = primary.metric.id
    control_p_best = primary.p_best.get(control, 0.0)
    top = max(treatments, key=lambda c: c.p_best)
    summary = "; ".join(
        f"{c.variant} P(best)={c.p_best:.3f}, lift {_pct(c.lift)} (95% {_interval(c.lift_ci95)})"
        for c in treatments
    )
    if top.p_best >= config.ship_if:
        return Decision(
            "ship",
            f"{top.variant} is the best variant on {metric_id} with P(best)={top.p_best:.3f} "
            f">= {config.ship_if:g}: lift {_pct(top.lift)} (95% {_interval(top.lift_ci95)}), "
            f"P(beat {control})={top.p_beat_control:.3f}, expected loss {top.expected_loss:.4g}; "
            f"{control} P(best)={control_p_best:.3f}.",
            top.variant,
        )
    if all(c.p_best <= config.kill_if for c in treatments) and control_p_best >= config.ship_if:
        return Decision(
            "kill",
            f"{control} is the best variant on {metric_id} with P(best)={control_p_best:.3f} "
            f">= {config.ship_if:g} and every treatment has P(best) <= {config.kill_if:g}: "
            f"{summary}.",
            top.variant,
        )
    return Decision(
        "inconclusive",
        f"No treatment reaches P(best) >= {config.ship_if:g} on {metric_id} and {control} is not "
        f"clearly best (P(best)={control_p_best:.3f}): {summary}.",
    )


def _frequentist_verdict(
    primary: MetricAnalysis,
    treatments: list[Comparison],
    config: AnalysisConfig,
    control: str,
) -> Decision:
    metric_id = primary.metric.id
    direction = primary.metric.direction
    alpha = config.alpha / len(treatments)
    label = "always-valid mSPRT" if config.method == "sequential" else "fixed-horizon"
    correction = (
        f" (alpha {config.alpha:g} Bonferroni-corrected for {len(treatments)} treatments)"
        if len(treatments) > 1
        else ""
    )
    trials = max(1, config.trials)
    bar = max_quantile_bar(config.alpha, trials) if config.method == "fixed" else None

    def good(c: Comparison) -> bool:
        return c.lift > 0.0 if direction == "increase" else c.lift < 0.0

    def significant(c: Comparison) -> bool:
        return c.p_value is not None and c.p_value < alpha

    def z_good(c: Comparison) -> float:
        return c.z_stat if direction == "increase" else -c.z_stat

    def clears_bar(c: Comparison) -> bool:
        return bar is None or z_good(c) > bar

    summary = "; ".join(
        f"{c.variant} p={_p(c.p_value)}, lift {_pct(c.lift)} (95% {_interval(c.lift_ci95)}), "
        f"P(beat {control})={c.p_beat_control:.3f}"
        for c in treatments
    )
    nominal = [c for c in treatments if significant(c) and good(c)]
    winners = [c for c in nominal if clears_bar(c)]
    if winners:
        top = max(winners, key=lambda c: c.p_beat_control)
        bar_note = f", z={z_good(top):.2f} > {bar:.3f} ({trials}-trial bar)" if bar else ""
        return Decision(
            "ship",
            f"{top.variant} beats {control} on {metric_id}: {label} p={_p(top.p_value)} < "
            f"alpha={alpha:.4g}{correction}{bar_note}, lift {_pct(top.lift)} "
            f"(95% {_interval(top.lift_ci95)}), P(beat {control})={top.p_beat_control:.3f}.",
            top.variant,
        )
    if all(significant(c) and not good(c) for c in treatments):
        top = max(treatments, key=lambda c: c.p_beat_control)
        return Decision(
            "kill",
            f"Every treatment is significantly worse than {control} on {metric_id} "
            f"({label}, alpha={alpha:.4g}{correction}): {summary}.",
            top.variant,
        )
    if nominal and bar is not None:
        held = "; ".join(f"{c.variant} z={z_good(c):.2f}" for c in nominal)
        return Decision(
            "inconclusive",
            f"Nominally significant but below the {trials}-trial bar {bar:.3f} on {metric_id} "
            f"({label}, alpha={alpha:.4g}{correction}): {held}; {summary}.",
        )
    return Decision(
        "inconclusive",
        f"No treatment is significantly better than {control} on {metric_id} "
        f"({label}, alpha={alpha:.4g}{correction}): {summary}.",
    )


def _pct(value: float) -> str:
    return f"{value:+.1%}"


def _interval(interval: tuple[float, float]) -> str:
    return f"[{_pct(interval[0])}, {_pct(interval[1])}]"


def _p(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.4g}"

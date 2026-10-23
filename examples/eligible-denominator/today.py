"""What agon-stats reports today for an empty denominator, next to what the contract asks for.

Runs ``agon-stats``'s own ``build_result`` on ``sessions.jsonl`` (three variants: ``control``,
``treatment``, and ``redesign``, whose four sessions never finished) and prints, per metric and
variant, the statistic the Result carries beside the denominator a rate row would carry under
docs/results-contract.md ("Rates carry their eligible rows"): raw, ineligible by reason,
eligible, measured, and the value printed from them.

The design point is RushantsBro's (Moltbook, 2026-10): "Does your results contract require a
denominator to declare how many of its rows were eligible, or only how the numerator was read?"

Run from the repository root (the stats package's environment supplies ``agon_stats``):

    uv run --project packages/stats python examples/eligible-denominator/today.py

Exits 1 when agon-stats no longer reports what the README says it reports.
"""

from __future__ import annotations

import json
import math
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from agon_stats.config import parse_config
from agon_stats.io import SessionRow, load_sessions
from agon_stats.metrics import metric_value, parse_metric
from agon_stats.result import build_result

HERE = Path(__file__).resolve().parent
SESSIONS = HERE / "sessions.jsonl"
ANALYSIS = HERE / "analysis.json"
COMPUTED_AT = "2026-10-23T00:00:00Z"


@dataclass(frozen=True, slots=True)
class Denominator:
    """The four counts a rate row carries; ``eligible = raw - sum(ineligible)``."""

    raw: int
    ineligible: dict[str, int]
    eligible: int
    measured: int


def denominator(rows: list[SessionRow], variant: str, metric: dict[str, Any]) -> Denominator:
    """Counts one variant's rows the way a rate row would, from the sessions file alone.

    A session without an outcome is ineligible (``no_outcome``): agon-stats drops it before any
    metric is computed. Every other session is eligible. An eligible session is measured when the
    metric has a value for it; a ``conversion`` always has one, because agon-stats reads an absent
    conversion as "not converted".
    """
    mine = [row for row in rows if row.variant == variant]
    ineligible = Counter("no_outcome" for row in mine if row.outcome is None)
    eligible = [row for row in mine if row.outcome is not None]
    spec = parse_metric(metric)
    measured = sum(1 for row in eligible if math.isfinite(metric_value(spec, row)))
    return Denominator(len(mine), dict(ineligible), len(eligible), measured)


def contract_value(numerator: float | None, d: Denominator) -> str:
    """The value as the contract prints it: undefined, with the reason, if nothing was measured."""
    if d.eligible == 0:
        reasons = ", ".join(f"{n} {r}" for r, n in sorted(d.ineligible.items()))
        return f"undefined (0 eligible: {reasons})"
    if d.measured == 0:
        return f"undefined (0 of {d.eligible} eligible measured)"
    assert numerator is not None
    return f"{numerator / d.measured:.2f}"


def main() -> int:
    rows = load_sessions(SESSIONS)
    config_json = json.loads(ANALYSIS.read_text())
    result = build_result(rows, parse_config(config_json), computed_at=COMPUTED_AT)
    variants = list(dict.fromkeys(row.variant for row in rows))
    metrics = {m["id"]: m for m in config_json["metrics"]}

    header = (
        f"{'metric':<26} {'variant':<10} {'agon-stats today':<34} "
        f"{'raw':>3} {'inelig':>6} {'elig':>4} {'meas':>4}  contract"
    )
    print(header)
    seen: dict[tuple[str, str], str] = {}
    for m in result["metrics"]:
        metric_id = m["metricId"]
        if metric_id not in metrics:
            continue
        by_variant = {v["variant"]: v for v in m["variants"]}
        for variant in variants:
            d = denominator(rows, variant, metrics[metric_id])
            stats = by_variant.get(variant)
            if stats is None:
                today = "absent from the result"
                numerator = None
            else:
                today = f"sessions={stats['sessions']} mean={stats['mean']:.2f}"
                numerator = stats["mean"] * stats["sessions"]
            seen[(metric_id, variant)] = today
            inelig = sum(d.ineligible.values())
            print(
                f"{metric_id:<26} {variant:<10} {today:<34} "
                f"{d.raw:>3} {inelig:>6} {d.eligible:>4} {d.measured:>4}  "
                f"{contract_value(numerator, d)}"
            )

    print()
    for m in result["metrics"]:
        if m["metricId"] not in metrics:
            continue
        for c in m["comparisons"]:
            print(f"{m['metricId']}: {c['variant']} vs {c['control']} lift {c['lift']:+.0%}")
        for w in m["warnings"]:
            print(f"{m['metricId']}: warning: {w}")
    first = result["metrics"][0]
    for w in first["warnings"]:
        print(f"{first['metricId']}: warning: {w}")

    # What the README says agon-stats does today; a change to agon-stats that fixes it fails here.
    duration = next(m for m in result["metrics"] if m["metricId"] == "seconds_to_first_project")
    treatment = next(v for v in duration["variants"] if v["variant"] == "treatment")
    lift = duration["comparisons"][0]["lift"]
    checks = {
        "an empty duration prints as a zero mean": treatment["sessions"] == 0
        and treatment["mean"] == 0.0
        and treatment["ci95"] == [0.0, 0.0],
        "its lift is -100%": lift == -1.0,
        "a variant with no outcomes is absent": all(
            v["variant"] != "redesign" for m in result["metrics"] for v in m["variants"]
        ),
        "its exclusion is one unattributed warning": any(
            w == "4 session(s) without an outcome were excluded from the analysis"
            for w in first["warnings"]
        ),
        "a real 0 of 6 is a zero": seen[("activation", "treatment")] == "sessions=6 mean=0.00",
    }
    print()
    failed = [name for name, ok in checks.items() if not ok]
    for name, ok in checks.items():
        print(f"{'ok  ' if ok else 'FAIL'} {name}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

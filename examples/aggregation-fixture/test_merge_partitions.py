"""Aggregation fixture: the same rows, merged through different partitionings, must agree.

The design point is excelsior's (Moltbook, 2026-10): "The test should merge the same disjoint
rows through several partitionings and get the same result and exclusion counts each time. An
all-excluded partition should contribute zero valid weight, not a zero-valued observation."

A partial result carries three markers per version (here: per variant): ``sum``, ``valid_n`` and
``missing_in_version``, the sessions that have no value for the metric. A merge adds all three;
the merged mean is merged sum over merged valid_n. The fixture fails any combiner that keeps the
markers but does not use them as the denominators: one that averages partition means, or one that
turns an all-excluded partition into a zero-valued observation.

Run as a test or as a script, from the repository root:

    uv run --project packages/stats pytest examples/aggregation-fixture
    uv run --project packages/stats python examples/aggregation-fixture/test_merge_partitions.py

Exclusion follows agon-stats: a ``duration`` metric a session never recorded is NaN and that
session is excluded for that metric (``agon_stats.metrics``). The whole-data check compares the
merge with ``analyze_sessions`` on the same rows, and the per-persona check merges the
``VariantStats`` agon-stats reports for each persona separately.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import sys
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

from agon_stats.analysis import MetricAnalysis, analyze_sessions
from agon_stats.config import AnalysisConfig, parse_config
from agon_stats.io import SessionRow, load_sessions
from agon_stats.metrics import MetricSpec, metric_value

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from make_sessions import METRIC_ID  # noqa: E402
from make_sessions import sessions as generated_sessions  # noqa: E402

SESSIONS = HERE / "sessions.jsonl"
ANALYSIS = HERE / "analysis.json"

EXPECTED_SUM = {"control": 4800.0, "treatment": 3640.0}
EXPECTED_VALID_N = {"control": 80, "treatment": 91}
EXPECTED_MISSING = {"control": 20, "treatment": 9}
EXPECTED_MEAN = {"control": 60.0, "treatment": 40.0}

EXCLUDED_WARNING = re.compile(
    r"^(?P<variant>\S+): (?P<missing>\d+) of (?P<total>\d+) sessions have no value for "
    + re.escape(METRIC_ID)
    + r"; excluded$"
)


# --------------------------------------------------------------------------------------------
# The partial result and its merge
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Partial:
    """One version's share of one partition: enough to be merged, nothing derived."""

    sum: float
    valid_n: int
    missing_in_version: int

    @property
    def mean(self) -> float | None:
        """Undefined, not zero, when nothing was observed."""
        return self.sum / self.valid_n if self.valid_n else None

    def __add__(self, other: Partial) -> Partial:
        return Partial(
            self.sum + other.sum,
            self.valid_n + other.valid_n,
            self.missing_in_version + other.missing_in_version,
        )


EMPTY = Partial(0.0, 0, 0)
PartitionResult = dict[str, Partial]  # version -> partial


def partial_result(spec: MetricSpec, rows: Iterable[SessionRow]) -> PartitionResult:
    """Per-version partial for one partition, using agon-stats' own value rule for exclusion."""
    out: dict[str, Partial] = {}
    for row in rows:
        value = metric_value(spec, row)
        valid = math.isfinite(value)
        out[row.variant] = out.get(row.variant, EMPTY) + Partial(
            value if valid else 0.0, int(valid), int(not valid)
        )
    return out


def merge(partials: Iterable[PartitionResult]) -> PartitionResult:
    """Add sums, valid counts and exclusions per version. The only correct combiner here."""
    merged: dict[str, Partial] = {}
    for partition in partials:
        for version, partial in partition.items():
            merged[version] = merged.get(version, EMPTY) + partial
    return merged


def partial_from_variant_stats(metric: MetricAnalysis, variant: str) -> Partial:
    """Rebuild a partial from what an agon-stats result carries for one variant.

    ``VariantStats.sessions`` is the valid count (sessions with a value), ``mean`` is over those,
    so the sum is ``mean * sessions``. The excluded count is not a field of the result; it is
    only stated in the metric's warnings, so it is parsed from there (zero when no warning).
    """
    stats = metric.variant_stats(variant)
    missing = 0
    for warning in metric.warnings:
        match = EXCLUDED_WARNING.match(warning)
        if match and match["variant"] == variant:
            missing = int(match["missing"])
    return Partial(stats.mean * stats.sessions, stats.sessions, missing)


# --------------------------------------------------------------------------------------------
# The two wrong combiners the fixture must catch
# --------------------------------------------------------------------------------------------


def mean_of_partition_means(
    partials: Sequence[PartitionResult], version: str, *, empty_as_zero: bool
) -> float | None:
    """Wrong: every partition weighs the same whatever its valid_n."""
    means: list[float] = []
    for partition in partials:
        partial = partition.get(version)
        if partial is None:
            continue
        if partial.mean is not None:
            means.append(partial.mean)
        elif empty_as_zero:
            means.append(0.0)
    return sum(means) / len(means) if means else None


def merge_with_zero_observations(partials: Iterable[PartitionResult]) -> PartitionResult:
    """Wrong: an all-excluded partition becomes one observation with value 0."""
    merged: dict[str, Partial] = {}
    for partition in partials:
        for version, partial in partition.items():
            if partial.valid_n == 0:
                partial = Partial(0.0, 1, partial.missing_in_version)
            merged[version] = merged.get(version, EMPTY) + partial
    return merged


# --------------------------------------------------------------------------------------------
# Partitionings: disjoint, covering, with very unequal sizes
# --------------------------------------------------------------------------------------------


def _chunks(rows: Sequence[SessionRow], sizes: Sequence[int]) -> Callable[[SessionRow], str]:
    assert sum(sizes) == len(rows)
    bounds: list[tuple[int, str]] = []
    start = 0
    for size in sizes:
        start += size
        bounds.append((start, f"first {start}"))
    position = {row.session_id: i for i, row in enumerate(rows)}

    def key(row: SessionRow) -> str:
        i = position[row.session_id]
        return next(label for end, label in bounds if i < end)

    return key


def partitionings(
    rows: Sequence[SessionRow], spec: MetricSpec
) -> dict[str, Callable[[SessionRow], str]]:
    return {
        "whole": lambda _row: "all",
        "persona": lambda row: row.persona_id,  # 61 / 128 / 11, one all-excluded
        "model": lambda row: row.model,  # 189 / 11
        "file order": _chunks(rows, (1, 9, 140, 50)),  # the third chunk straddles both arms
        "has a value": lambda row: (
            "valid" if math.isfinite(metric_value(spec, row)) else "excluded"
        ),
        "id hash": lambda row: (
            f"bucket {int(hashlib.sha1(row.session_id.encode()).hexdigest(), 16) % 7}"
        ),
    }


def split(
    rows: Sequence[SessionRow], key: Callable[[SessionRow], str]
) -> dict[str, list[SessionRow]]:
    parts: dict[str, list[SessionRow]] = {}
    for row in rows:
        parts.setdefault(key(row), []).append(row)
    return parts


# --------------------------------------------------------------------------------------------
# Fixture loading
# --------------------------------------------------------------------------------------------


def load() -> tuple[list[SessionRow], AnalysisConfig, MetricSpec]:
    rows = load_sessions(SESSIONS)
    config = parse_config(json.loads(ANALYSIS.read_text(encoding="utf-8")))
    spec = next(m for m in config.metrics if m.id == METRIC_ID)
    return rows, config, spec


def assert_equal_partials(actual: PartitionResult, expected: PartitionResult, label: str) -> None:
    assert actual.keys() == expected.keys(), f"{label}: versions {sorted(actual)}"
    for version in expected:
        assert actual[version] == expected[version], (
            f"{label}: {version} merged to {actual[version]}, expected {expected[version]}"
        )


# --------------------------------------------------------------------------------------------
# Tests
# --------------------------------------------------------------------------------------------


def test_committed_sessions_match_the_generator() -> None:
    committed = [json.loads(line) for line in SESSIONS.read_text(encoding="utf-8").splitlines()]
    assert committed == generated_sessions()


def test_reference_totals() -> None:
    rows, _config, spec = load()
    reference = partial_result(spec, rows)
    assert {v: p.sum for v, p in reference.items()} == EXPECTED_SUM
    assert {v: p.valid_n for v, p in reference.items()} == EXPECTED_VALID_N
    assert {v: p.missing_in_version for v, p in reference.items()} == EXPECTED_MISSING
    assert {v: p.mean for v, p in reference.items()} == EXPECTED_MEAN


def test_every_partitioning_merges_to_the_same_result_and_exclusion_counts() -> None:
    rows, _config, spec = load()
    reference = partial_result(spec, rows)
    sizes_seen: set[tuple[int, ...]] = set()
    for name, key in partitionings(rows, spec).items():
        parts = split(rows, key)
        sizes = tuple(sorted(len(p) for p in parts.values()))
        sizes_seen.add(sizes)
        assert sum(sizes) == len(rows), f"{name}: partitions must cover the rows"
        merged = merge(partial_result(spec, part) for part in parts.values())
        assert_equal_partials(merged, reference, f"partitioning by {name} {sizes}")
        assert {v: p.mean for v, p in merged.items()} == EXPECTED_MEAN, name
        assert {v: p.missing_in_version for v, p in merged.items()} == EXPECTED_MISSING, name
    # the partitionings really are different and really are lopsided
    assert len(sizes_seen) == len(partitionings(rows, spec))
    assert (1, 9, 50, 140) in sizes_seen and (11, 61, 128) in sizes_seen


def test_an_all_excluded_partition_contributes_zero_valid_weight() -> None:
    rows, _config, spec = load()
    by_persona = split(rows, lambda row: row.persona_id)
    cfo = partial_result(spec, by_persona["skeptical-cfo"])
    assert cfo == {
        "control": Partial(0.0, 0, 10),
        "treatment": Partial(0.0, 0, 1),
    }
    assert cfo["control"].mean is None  # undefined, not 0.0

    partials = [partial_result(spec, part) for part in by_persona.values()]
    right = merge(partials)
    assert right["control"] == Partial(4800.0, 80, 20)

    wrong = merge_with_zero_observations(partials)
    assert wrong["control"].valid_n == 81 and wrong["control"].mean != EXPECTED_MEAN["control"]
    assert wrong["control"].missing_in_version == 20  # the marker survives; the denominator lies

    # The same partition shows up as "excluded" under the has-a-value partitioning: 29 rows,
    # all of them missing, both versions. Still zero weight.
    excluded = partial_result(
        spec, split(rows, partitionings(rows, spec)["has a value"])["excluded"]
    )
    assert all(p.valid_n == 0 and p.sum == 0.0 for p in excluded.values())
    assert sum(p.missing_in_version for p in excluded.values()) == 29


def test_a_mean_of_partition_means_is_caught() -> None:
    rows, _config, spec = load()
    by_persona = [
        partial_result(spec, part) for part in split(rows, lambda r: r.persona_id).values()
    ]
    naive = mean_of_partition_means(by_persona, "treatment", empty_as_zero=False)
    zero_filled = mean_of_partition_means(by_persona, "treatment", empty_as_zero=True)
    assert naive == 485.0  # (30 + 940) / 2
    assert zero_filled is not None and round(zero_filled, 1) == 323.3  # (30 + 940 + 0) / 3
    assert merge(by_persona)["treatment"].mean == 40.0  # 3640 / 91

    # Control is the trap: every valid value averages 60 in each persona, so the naive mean agrees
    # with the merge by luck, and only the zero-filled variant exposes the all-excluded persona.
    assert mean_of_partition_means(by_persona, "control", empty_as_zero=False) == 60.0
    assert mean_of_partition_means(by_persona, "control", empty_as_zero=True) == 40.0

    # Under every other partitioning at least one of the two naive combiners is wrong for
    # treatment. (Under "has a value" the skip-empty one is right by luck: the only partition
    # with values is the whole valid set. The zero-filled one halves it.)
    for name, key in partitionings(rows, spec).items():
        if name == "whole":
            continue
        partials = [partial_result(spec, part) for part in split(rows, key).values()]
        naive_pair = {
            mean_of_partition_means(partials, "treatment", empty_as_zero=False),
            mean_of_partition_means(partials, "treatment", empty_as_zero=True),
        }
        assert naive_pair != {40.0}, name


def test_agon_stats_agrees_on_the_whole_data() -> None:
    rows, config, spec = load()
    metric = analyze_sessions(rows, config).metric(METRIC_ID)
    reference = partial_result(spec, rows)
    for variant in ("control", "treatment"):
        stats = metric.variant_stats(variant)
        assert stats.sessions == reference[variant].valid_n  # valid sessions, not all 100
        assert stats.mean == reference[variant].mean
        assert partial_from_variant_stats(metric, variant) == reference[variant]
    assert "control: 20 of 100 sessions have no value for seconds_to_first_project; excluded" in (
        metric.warnings
    )


def test_per_persona_agon_stats_results_merge_to_the_whole() -> None:
    rows, config, spec = load()
    reference = partial_result(spec, rows)
    per_persona: list[PartitionResult] = []
    for persona, part in split(rows, lambda r: r.persona_id).items():
        metric = analyze_sessions(part, config).metric(METRIC_ID)
        partial = {v: partial_from_variant_stats(metric, v) for v in ("control", "treatment")}
        if persona == "skeptical-cfo":
            # agon-stats reports sessions=0, mean=0.0 here. Weighted by sessions that is zero
            # weight; read as an observation it would be a spurious zero.
            assert all(p.valid_n == 0 and p.sum == 0.0 for p in partial.values())
            assert partial["control"].missing_in_version == 10
        per_persona.append(partial)
    assert_equal_partials(merge(per_persona), reference, "per-persona agon-stats results")


# --------------------------------------------------------------------------------------------
# Script entry point: print the table and run the checks
# --------------------------------------------------------------------------------------------


def main() -> int:
    rows, _config, spec = load()
    reference = partial_result(spec, rows)
    print(f"{len(rows)} sessions, metric {METRIC_ID}")
    print(
        f"{'partitioning':14} {'sizes':24} {'version':10} {'sum':>8} {'valid_n':>8} "
        f"{'missing':>8} {'mean':>8} {'mean of means':>14}"
    )
    for name, key in partitionings(rows, spec).items():
        parts = split(rows, key)
        partials = [partial_result(spec, part) for part in parts.values()]
        merged = merge(partials)
        sizes = "/".join(str(len(p)) for p in parts.values())
        for version in ("control", "treatment"):
            p = merged[version]
            naive = mean_of_partition_means(partials, version, empty_as_zero=True)
            print(
                f"{name:14} {sizes:24} {version:10} {p.sum:8.0f} {p.valid_n:8d} "
                f"{p.missing_in_version:8d} {p.mean:8.2f} {naive:14.2f}"
            )
        assert_equal_partials(merged, reference, name)
    tests = [obj for name, obj in globals().items() if name.startswith("test_") and callable(obj)]
    for test in tests:
        test()
        print(f"ok  {test.__name__}")
    assert len(tests) == 7
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Live-window recorder: the transition-matrix gate over aligned operational series.

Pre-release simulation is a model; the first hours after a release are the measurement it is
later checked against. This module takes two windows of four aligned series sampled at one grain
(latency, retry rate, abandonment rate, queue depth), turns each into a sequence of states, and
asks one question: did a transition that was improbable in the pre-release baseline become the
most likely successor of its state in the live window? The answer is reported with its direction
(from state, to state), never as a scalar distance, because the direction is what names the loop
(latency up, retries up, queue up, repeat).

States are bands of the baseline's distribution, one band per series. Granularity is
hierarchical: every series starts coarse (split at the baseline's 90th percentile) and only the
coarse states that carry more than a threshold share of the live transitions are decomposed into
fine states (50th, 90th and 99th percentiles). Fine edges refine the coarse ones, so a decomposed
state stays inside its cluster. Bucket edges can also be declared instead of derived.

Both windows are resampled with a moving-block bootstrap over their transitions: bucketed
operational series are autocorrelated and not Markov at the bucket level, so transitions out of a
band come in runs and a bound that treats them as independent draws is too narrow. A state fires
only with enough evidence on both sides:

1. support: at least ``min_transitions`` transitions out of it in the live window, so a fine state
   reached a handful of times after decomposition is never judged on noise;
2. a decisive successor: the live bootstrap lower bound of the margin between its most likely
   successor and the runner-up is above zero, so "most likely" is not an artefact of taking the
   largest of many thinly spread cells;
3. improbable in the baseline: the successor was not the baseline's most likely one, and its live
   lower bound exceeds the ``percentile``-th percentile of the bootstrap distribution of the same
   transition's baseline probability. A state the baseline never left has no baseline
   probability, so every transition out of it counts as improbable; support and decisiveness
   still have to hold.

The live-side bounds are family-wise across the states tested (Bonferroni: each state is held to
``(100 - percentile) / states_tested``), so a richer state space does not raise the chance that
one of its states fires on noise. The baseline percentile is used as given: it is the definition
of "improbable in the baseline".

Everything is deterministic for a seed (``numpy.random.default_rng``).
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

import numpy as np

from agon_stats import __version__
from agon_stats.errors import ConfigError, ValidationError

SCHEMA_VERSION = "2026-10-09.1"
"""Mirrors CONTRACT_SCHEMA_VERSION in @agon/spec; the report is stamped with it."""

SERIES: tuple[str, ...] = ("latencyMs", "retryRate", "abandonmentRate", "queueDepth")
RATE_SERIES: frozenset[str] = frozenset({"retryRate", "abandonmentRate"})
COARSE_QUANTILES: tuple[float, ...] = (0.9,)
FINE_QUANTILES: tuple[float, ...] = (0.5, 0.9, 0.99)

DEFAULT_PERCENTILE = 95.0
DEFAULT_DECOMPOSE_ABOVE = 0.25
DEFAULT_BOOTSTRAP_SAMPLES = 1000
DEFAULT_MIN_TRANSITIONS = 20

BucketSource = Literal["baseline-quantiles", "declared"]
GateStatus = Literal["passed", "fired", "insufficient"]


# --------------------------------------------------------------------------------------------
# Input
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Window:
    """Four aligned series at one grain, recorded at one capacity."""

    capacity: str
    grain_ms: int
    series: dict[str, np.ndarray]
    started_at: str | None = None

    @property
    def samples(self) -> int:
        return int(self.series[SERIES[0]].shape[0])


def parse_window(obj: Any, what: str = "window") -> Window:
    """Validates the recorder input (spec `LiveWindow`): aligned, finite, rates in [0, 1]."""
    if not isinstance(obj, Mapping):
        raise ValidationError(f"{what} must be a JSON object")
    capacity = obj.get("capacity")
    if not isinstance(capacity, str) or not capacity:
        raise ValidationError(f"{what}.capacity must be a non-empty string")
    grain = obj.get("grainMs", obj.get("grain_ms"))
    integral = isinstance(grain, int) or (isinstance(grain, float) and grain.is_integer())
    if isinstance(grain, bool) or not integral or grain <= 0:
        raise ValidationError(f"{what}.grainMs must be a positive integer")
    raw = obj.get("series")
    if not isinstance(raw, Mapping):
        raise ValidationError(f"{what}.series must be an object with {list(SERIES)}")
    series: dict[str, np.ndarray] = {}
    for name in SERIES:
        values = raw.get(name)
        if not isinstance(values, Sequence) or isinstance(values, str):
            raise ValidationError(f"{what}.series.{name} must be an array of numbers")
        if any(isinstance(v, bool) or not isinstance(v, int | float) for v in values):
            raise ValidationError(f"{what}.series.{name} must be an array of numbers")
        array = np.asarray(values, dtype=float)
        if not np.all(np.isfinite(array)):
            raise ValidationError(f"{what}.series.{name} must be finite numbers")
        if np.any(array < 0):
            raise ValidationError(f"{what}.series.{name} must be non-negative")
        if name in RATE_SERIES and np.any(array > 1):
            raise ValidationError(f"{what}.series.{name} is a rate in [0, 1]")
        series[name] = array
    lengths = {name: int(a.shape[0]) for name, a in series.items()}
    if len(set(lengths.values())) != 1:
        raise ValidationError(f"{what}.series must be aligned: lengths {lengths}")
    if next(iter(lengths.values())) < 2:
        raise ValidationError(f"{what}.series needs at least two samples")
    started = obj.get("startedAt", obj.get("started_at"))
    return Window(
        capacity=capacity,
        grain_ms=int(grain),
        series=series,
        started_at=started if isinstance(started, str) else None,
    )


# --------------------------------------------------------------------------------------------
# Buckets and states
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Edges:
    """Ascending bucket edges of one series at one level, each with the name its labels use.

    Bucket k holds the values with exactly k edges strictly below them, so a value equal to an
    edge falls in the lower bucket. Labels read as bands: ``..p50``, ``p50..p90``, ``p99..``.
    """

    values: tuple[float, ...]
    names: tuple[str, ...]

    def labels(self) -> tuple[str, ...]:
        if not self.values:
            return ("all",)
        inner = [f"{a}..{b}" for a, b in zip(self.names, self.names[1:], strict=False)]
        return (f"..{self.names[0]}", *inner, f"{self.names[-1]}..")


@dataclass(frozen=True, slots=True)
class Buckets:
    """Coarse and fine edges per series; every coarse edge is also a fine edge."""

    coarse: dict[str, Edges]
    fine: dict[str, Edges]
    source: BucketSource

    def __post_init__(self) -> None:
        for name in SERIES:
            if name not in self.coarse or name not in self.fine:
                raise ConfigError(f"buckets need coarse and fine edges for {name}")
            for level, edges in (("coarse", self.coarse[name]), ("fine", self.fine[name])):
                if len(edges.values) != len(edges.names):
                    raise ConfigError(f"{level} edges for {name} need one name per edge")
                if any(a >= b for a, b in zip(edges.values, edges.values[1:], strict=False)):
                    raise ConfigError(f"{level} edges for {name} must increase")
            if not set(self.coarse[name].values) <= set(self.fine[name].values):
                raise ConfigError(
                    f"fine edges for {name} must refine the coarse ones (every coarse edge is a "
                    "fine edge), so a decomposed state stays inside its coarse cluster"
                )


def _quantile_name(q: float) -> str:
    return f"p{round(q * 100, 4):g}"


def _quantile_edges(values: np.ndarray, quantiles: Sequence[float]) -> Edges:
    """Edges at quantiles of `values`; quantiles that coincide (a flat series) collapse into one
    edge named after the largest of them."""
    largest: dict[float, float] = {}
    for q in sorted(set(quantiles)):
        value = float(np.quantile(values, q))
        largest[value] = max(q, largest.get(value, q))
    ordered = sorted(largest)
    return Edges(values=tuple(ordered), names=tuple(_quantile_name(largest[v]) for v in ordered))


def default_buckets(
    baseline: Window,
    coarse_quantiles: Sequence[float] = COARSE_QUANTILES,
    fine_quantiles: Sequence[float] = FINE_QUANTILES,
) -> Buckets:
    """Edges at the baseline's quantiles: coarse at the 90th, fine at the 50th, 90th and 99th."""
    for q in (*coarse_quantiles, *fine_quantiles):
        if not 0.0 < q < 1.0:
            raise ConfigError(f"bucket quantile {q} must be in (0, 1)")
    fine_all = tuple(sorted(set(fine_quantiles) | set(coarse_quantiles)))
    return Buckets(
        coarse={n: _quantile_edges(baseline.series[n], coarse_quantiles) for n in SERIES},
        fine={n: _quantile_edges(baseline.series[n], fine_all) for n in SERIES},
        source="baseline-quantiles",
    )


def _declared_edges(raw: Any, where: str) -> Edges:
    if not isinstance(raw, Sequence) or isinstance(raw, str):
        raise ConfigError(f"{where} must be an array of numbers")
    if any(isinstance(v, bool) or not isinstance(v, int | float) for v in raw):
        raise ConfigError(f"{where} must be an array of numbers")
    values = tuple(float(v) for v in raw)
    if not all(math.isfinite(v) for v in values):
        raise ConfigError(f"{where} must be finite numbers")
    return Edges(values=values, names=tuple(f"{v:g}" for v in values))


def parse_buckets(obj: Any) -> Buckets:
    """Declared bucket edges: ``{"coarse": {series: [edges]}, "fine": {series: [edges]}}``.

    ``fine`` may be left out (decomposition then keeps the coarse bands); when given it must
    contain every coarse edge.
    """
    if not isinstance(obj, Mapping):
        raise ConfigError("buckets must be a JSON object with coarse (and optionally fine) edges")
    coarse_raw = obj.get("coarse")
    fine_raw = obj.get("fine", coarse_raw)
    if not isinstance(coarse_raw, Mapping) or not isinstance(fine_raw, Mapping):
        raise ConfigError(
            f"buckets.coarse and buckets.fine must be objects keyed by {list(SERIES)}"
        )
    for level, raw in (("coarse", coarse_raw), ("fine", fine_raw)):
        unknown = sorted(set(raw) - set(SERIES))
        if unknown:
            raise ConfigError(f"buckets.{level} has unknown series {unknown}")
        missing = [n for n in SERIES if n not in raw]
        if missing:
            raise ConfigError(f"buckets.{level} needs edges for {missing}")
    return Buckets(
        coarse={n: _declared_edges(coarse_raw[n], f"buckets.coarse.{n}") for n in SERIES},
        fine={n: _declared_edges(fine_raw[n], f"buckets.fine.{n}") for n in SERIES},
        source="declared",
    )


def bucket(values: np.ndarray, edges: Sequence[float]) -> np.ndarray:
    """Bucket index per value: the number of edges strictly below it (an edge value stays low)."""
    return np.searchsorted(np.asarray(edges, dtype=float), values, side="left")


def state_key(labels: Mapping[str, str]) -> str:
    return "|".join(f"{name}={labels[name]}" for name in SERIES)


def _level_states(
    window: Window, edges: Mapping[str, Edges]
) -> tuple[list[str], list[dict[str, str]]]:
    table = {name: edges[name].labels() for name in SERIES}
    index = {name: bucket(window.series[name], edges[name].values) for name in SERIES}
    labels = [
        {name: table[name][int(index[name][i])] for name in SERIES} for i in range(window.samples)
    ]
    return [state_key(label) for label in labels], labels


def build_sequence(
    window: Window, buckets: Buckets, decomposed: frozenset[str]
) -> tuple[list[str], dict[str, dict[str, str]]]:
    """State keys per sample: coarse everywhere except inside decomposed clusters, which use the
    fine bands. Returns the sequence and the per-series labels of every state key seen."""
    coarse_keys, coarse_labels = _level_states(window, buckets.coarse)
    fine_keys, fine_labels = (
        _level_states(window, buckets.fine) if decomposed else (coarse_keys, coarse_labels)
    )
    sequence: list[str] = []
    labels: dict[str, dict[str, str]] = {}
    for i, key in enumerate(coarse_keys):
        if key in decomposed:
            sequence.append(fine_keys[i])
            labels[fine_keys[i]] = fine_labels[i]
        else:
            sequence.append(key)
            labels[key] = coarse_labels[i]
    return sequence, labels


# --------------------------------------------------------------------------------------------
# Matrices
# --------------------------------------------------------------------------------------------


def encode(states: Sequence[str], space: Sequence[str]) -> np.ndarray:
    index = {key: i for i, key in enumerate(space)}
    return np.fromiter((index[s] for s in states), dtype=np.int64, count=len(states))


def transition_counts_from_codes(codes: np.ndarray, size: int) -> np.ndarray:
    """(S, S) counts of consecutive pairs: row = from, column = to."""
    counts = np.zeros((size, size), dtype=float)
    if codes.shape[0] >= 2:
        np.add.at(counts, (codes[:-1], codes[1:]), 1.0)
    return counts


def transition_counts(states: Sequence[str], space: Sequence[str]) -> np.ndarray:
    return transition_counts_from_codes(encode(states, space), len(space))


def transition_matrix(counts: np.ndarray) -> np.ndarray:
    """Row-normalised probabilities; a state with no outgoing transition keeps an all-zero row."""
    totals = counts.sum(axis=1, keepdims=True)
    return np.divide(counts, totals, out=np.zeros_like(counts), where=totals > 0)


def transition_mass(counts: np.ndarray) -> np.ndarray:
    """Share of all transitions that leave each state."""
    total = counts.sum()
    return counts.sum(axis=1) / total if total > 0 else np.zeros(counts.shape[0])


def bootstrap_probabilities(
    codes: np.ndarray,
    size: int,
    cells: Sequence[tuple[int, int]],
    *,
    samples: int,
    seed: int | np.random.SeedSequence,
    block: int | None = None,
) -> np.ndarray:
    """Moving-block bootstrap of a window's transitions.

    The n - 1 transitions (consecutive state pairs) of the coded sequence are resampled in blocks
    of `block` consecutive transitions (default: the square root of their number), so every
    replicate keeps the short-range dependence of the series and no transition is invented where
    two blocks meet. Returns an array of shape (samples, len(cells)): per replicate, the
    conditional probability of each (from, to) cell, NaN where the replicate never left `from`.
    """
    out = np.full((samples, len(cells)), np.nan)
    sources, targets = codes[:-1], codes[1:]
    m = int(sources.shape[0])
    if m == 0 or not cells:
        return out
    width = min(m, block if block is not None else max(1, round(math.sqrt(m))))
    if width < 1:
        raise ConfigError("bootstrap block must be positive")
    blocks = math.ceil(m / width)
    pair_codes = sources * size + targets
    rows = np.asarray([i for i, _ in cells], dtype=np.int64)
    flat = np.asarray([i * size + j for i, j in cells], dtype=np.int64)
    offsets = np.arange(width)
    rng = np.random.default_rng(seed)
    for r in range(samples):
        starts = rng.integers(0, m - width + 1, size=blocks)
        picked = (starts[:, None] + offsets[None, :]).reshape(-1)[:m]
        counts = np.bincount(pair_codes[picked], minlength=size * size)
        totals = np.bincount(sources[picked], minlength=size)[rows]
        out[r] = np.where(totals > 0, counts[flat] / np.maximum(totals, 1), np.nan)
    return out


# --------------------------------------------------------------------------------------------
# The gate
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Candidate:
    source: int
    target: int
    runner_up: int


def _percentile(values: np.ndarray, q: float) -> float | None:
    """`q`-th percentile of the defined (non-NaN) values; None when there are none."""
    defined = values[~np.isnan(values)]
    return float(np.percentile(defined, q)) if defined.size else None


def gate_signals(
    live_codes: np.ndarray,
    baseline_codes: np.ndarray,
    space: Sequence[str],
    labels: Mapping[str, Mapping[str, str]],
    *,
    percentile: float,
    min_transitions: int,
    bootstrap_samples: int,
    seed: int,
) -> tuple[list[dict[str, Any]], int]:
    """Transitions that were improbable in the baseline and are now, decisively, the most likely
    successor of their state. Returns the signals and the number of states with enough live
    support to be tested.

    Both windows are bootstrapped the same way (moving blocks of transitions), because bucketed
    operational series are autocorrelated and not Markov at the bucket level: transitions out of
    a band come in runs, and a bound that treats them as independent draws is too narrow.
    """
    size = len(space)
    live_counts = transition_counts_from_codes(live_codes, size)
    baseline_counts = transition_counts_from_codes(baseline_codes, size)
    baseline = transition_matrix(baseline_counts)
    tested = 0
    candidates: list[_Candidate] = []
    for i in range(size):
        row = live_counts[i]
        if float(row.sum()) < min_transitions:
            continue
        tested += 1
        if size < 2:
            continue
        order = np.argsort(-row, kind="stable")
        j, k = int(order[0]), int(order[1])
        if baseline_counts[i].sum() > 0 and int(np.argmax(baseline[i])) == j:
            continue  # already the baseline's most likely successor: not improbable there
        candidates.append(_Candidate(i, j, k))
    if not candidates:
        return [], tested

    live_seed, baseline_seed = np.random.SeedSequence(seed).spawn(2)
    live_boot = bootstrap_probabilities(
        live_codes,
        size,
        [(c.source, c.target) for c in candidates] + [(c.source, c.runner_up) for c in candidates],
        samples=bootstrap_samples,
        seed=live_seed,
    )
    baseline_boot = bootstrap_probabilities(
        baseline_codes,
        size,
        [(c.source, c.target) for c in candidates],
        samples=bootstrap_samples,
        seed=baseline_seed,
    )
    # The live side is held to a family-wise level across the states tested (Bonferroni): testing
    # more states must not raise the chance that one of them fires on noise.
    low = (100.0 - percentile) / tested
    signals: list[dict[str, Any]] = []
    for column, c in enumerate(candidates):
        top = live_boot[:, column]
        second = live_boot[:, len(candidates) + column]
        margin = _percentile(top - second, low)
        if margin is None or margin <= 0:
            continue  # no decisive most likely successor
        lower = _percentile(top, low)
        if lower is None:
            continue
        threshold = _percentile(baseline_boot[:, column], percentile)
        median = _percentile(baseline_boot[:, column], 50.0)
        if threshold is None or median is None:
            # The baseline never left this state: it has no probability for any transition out of
            # it, so every one of them was improbable before the release.
            threshold, median = 0.0, 0.0
        if lower <= threshold:
            continue
        source, target = space[c.source], space[c.target]
        live_out = float(live_counts[c.source].sum())
        baseline_out = float(baseline_counts[c.source].sum())
        signals.append(
            {
                "from": source,
                "to": target,
                "fromLabel": dict(labels[source]),
                "toLabel": dict(labels[target]),
                "liveProbability": float(live_counts[c.source, c.target]) / live_out,
                "liveLowerBound": lower,
                "runnerUpProbability": float(live_counts[c.source, c.runner_up]) / live_out,
                "marginLowerBound": margin,
                "liveTransitions": int(live_out),
                "baselineProbability": median,
                "baselinePercentileValue": threshold,
                "baselineTransitions": int(baseline_out),
                "baselineSuccessor": (
                    space[int(np.argmax(baseline[c.source]))] if baseline_out > 0 else None
                ),
            }
        )
    return signals, tested


def _now_iso() -> str:
    now = datetime.now(UTC)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def live_window_gate(
    baseline: Window,
    live: Window,
    *,
    buckets: Buckets | None = None,
    percentile: float = DEFAULT_PERCENTILE,
    decompose_above: float = DEFAULT_DECOMPOSE_ABOVE,
    bootstrap_samples: int = DEFAULT_BOOTSTRAP_SAMPLES,
    seed: int = 0,
    min_transitions: int = DEFAULT_MIN_TRANSITIONS,
    computed_at: str | None = None,
) -> dict[str, Any]:
    """The measurement: a spec `LiveWindowReport` (camelCase keys), `kind: measurement`."""
    if baseline.capacity != live.capacity:
        raise ConfigError(
            f"baseline capacity {baseline.capacity!r} does not match live capacity "
            f"{live.capacity!r}: the baseline must be recorded at matched capacity"
        )
    if baseline.grain_ms != live.grain_ms:
        raise ConfigError(
            f"baseline grain {baseline.grain_ms} ms does not match live grain {live.grain_ms} ms"
        )
    if not 50.0 <= percentile < 100.0:
        raise ConfigError("percentile must be in [50, 100)")
    if not 0.0 <= decompose_above <= 1.0:
        raise ConfigError("decompose_above must be in [0, 1]")
    if bootstrap_samples < 1:
        raise ConfigError("bootstrap_samples must be positive")
    if seed < 0:
        raise ConfigError("seed must be non-negative")
    if min_transitions < 1:
        raise ConfigError("min_transitions must be positive")
    buckets = buckets or default_buckets(baseline)

    # Coarse pass: which clusters carry enough of the live transition mass to be worth refining.
    coarse_live, _ = build_sequence(live, buckets, frozenset())
    coarse_space = sorted(set(coarse_live))
    mass = transition_mass(transition_counts(coarse_live, coarse_space))
    decomposed = frozenset(
        key for key, share in zip(coarse_space, mass, strict=True) if share > decompose_above
    )

    live_states, live_labels = build_sequence(live, buckets, decomposed)
    baseline_states, baseline_labels = build_sequence(baseline, buckets, decomposed)
    labels = {**baseline_labels, **live_labels}
    space = sorted(labels)
    signals, tested = gate_signals(
        encode(live_states, space),
        encode(baseline_states, space),
        space,
        labels,
        percentile=percentile,
        min_transitions=min_transitions,
        bootstrap_samples=bootstrap_samples,
        seed=seed,
    )
    status: GateStatus = "fired" if signals else "passed" if tested > 0 else "insufficient"
    live_level = 100.0 - (100.0 - percentile) / tested if tested > 0 else None
    return {
        "kind": "measurement",
        "schemaVersion": SCHEMA_VERSION,
        "capacity": live.capacity,
        "grainMs": live.grain_ms,
        "baseline": {"samples": baseline.samples},
        "live": {"samples": live.samples},
        "parameters": {
            "percentile": percentile,
            "decomposeAbove": decompose_above,
            "minTransitions": min_transitions,
            "bootstrapSamples": bootstrap_samples,
            "seed": seed,
            "buckets": buckets.source,
        },
        "states": len(space),
        "decomposed": sorted(decomposed),
        "gate": {
            "status": status,
            "statesTested": tested,
            "liveLevel": live_level,
            "signals": signals,
        },
        "computedAt": computed_at or _now_iso(),
        "engine": {"name": "agon-stats", "version": __version__},
    }

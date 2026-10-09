from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from agon_stats.cli import main
from agon_stats.errors import ConfigError, ValidationError
from agon_stats.transitions import (
    SERIES,
    Buckets,
    Edges,
    Window,
    bucket,
    build_sequence,
    default_buckets,
    encode,
    gate_signals,
    live_window_gate,
    parse_buckets,
    parse_window,
    transition_counts,
    transition_mass,
)

REPORT_KEYS = {
    "kind",
    "schemaVersion",
    "capacity",
    "grainMs",
    "baseline",
    "live",
    "parameters",
    "states",
    "decomposed",
    "gate",
    "computedAt",
    "engine",
}
SIGNAL_KEYS = {
    "from",
    "to",
    "fromLabel",
    "toLabel",
    "liveProbability",
    "liveLowerBound",
    "runnerUpProbability",
    "marginLowerBound",
    "liveTransitions",
    "baselineProbability",
    "baselinePercentileValue",
    "baselineTransitions",
    "baselineSuccessor",
}


def window(series: dict[str, Any]) -> dict[str, Any]:
    return {"capacity": "4 replicas", "grainMs": 10_000, "series": series}


def iid(seed: int, n: int = 600) -> dict[str, Any]:
    """A healthy service at matched capacity: independent noise around a flat level."""
    rng = np.random.default_rng(seed)
    return window(
        {
            "latencyMs": np.clip(rng.normal(100, 8, n), 1, None).tolist(),
            "retryRate": np.clip(rng.normal(0.01, 0.004, n), 0, 1).tolist(),
            "abandonmentRate": np.clip(rng.normal(0.02, 0.005, n), 0, 1).tolist(),
            "queueDepth": rng.poisson(3, n).astype(float).tolist(),
        }
    )


def ar1(seed: int, n: int = 600, phi: float = 0.8) -> dict[str, Any]:
    """A healthy service whose series wander: autocorrelated noise, as real latency is."""
    rng = np.random.default_rng(seed)

    def wander() -> np.ndarray:
        shocks = rng.normal(0, np.sqrt(1 - phi * phi), n)
        x = np.empty(n)
        x[0] = rng.normal()
        for t in range(1, n):
            x[t] = phi * x[t - 1] + shocks[t]
        return x

    return window(
        {
            "latencyMs": np.clip(100 + 8 * wander(), 1, None).tolist(),
            "retryRate": np.clip(0.01 + 0.004 * wander(), 0, 1).tolist(),
            "abandonmentRate": np.clip(0.02 + 0.005 * wander(), 0, 1).tolist(),
            "queueDepth": np.clip(np.round(3 + 1.7 * wander()), 0, None).tolist(),
        }
    )


# One cycle of the loop: latency up, then retries up, then the queue up, then again.
LOOP = (
    # latency, retry rate, abandonment, queue depth
    (300.0, 0.005, 0.015, 2.0),
    (350.0, 0.30, 0.015, 2.0),
    (420.0, 0.40, 0.05, 40.0),
)


def retry_storm(seed: int, calm: int = 200, cycles: int = 40) -> dict[str, Any]:
    """Calm traffic, then the loop, one phase per grain interval."""
    data = iid(seed, calm)
    series = {name: list(data["series"][name]) for name in SERIES}
    rng = np.random.default_rng(seed + 1000)
    for _ in range(cycles):
        for latency, retry, abandonment, queue in LOOP:
            series["latencyMs"].append(float(latency + rng.normal(0, 5)))
            series["retryRate"].append(float(retry + abs(rng.normal(0, 0.002))))
            series["abandonmentRate"].append(abandonment)
            series["queueDepth"].append(queue)
    return window(series)


def above_p90(label: str) -> bool:
    """A band above the baseline's 90th percentile: coarse `p90..`, fine `p90..p99` or `p99..`."""
    return label.startswith(("p90", "p99"))


def coarse_mass(live: Window, buckets: Buckets) -> dict[str, float]:
    states, _ = build_sequence(live, buckets, frozenset())
    space = sorted(set(states))
    mass = transition_mass(transition_counts(states, space))
    return dict(zip(space, (float(m) for m in mass), strict=True))


# --- input and buckets ---------------------------------------------------------------------------


def test_parse_window_validates_alignment_and_ranges() -> None:
    w = parse_window(iid(1, 10))
    assert w.samples == 10 and w.capacity == "4 replicas" and w.grain_ms == 10_000
    bad = iid(1, 10)
    bad["series"]["retryRate"] = bad["series"]["retryRate"][:5]
    with pytest.raises(ValidationError, match="aligned"):
        parse_window(bad)
    rate = iid(1, 10)
    rate["series"]["retryRate"][0] = 1.5
    with pytest.raises(ValidationError, match="rate"):
        parse_window(rate)
    with pytest.raises(ValidationError, match="capacity"):
        parse_window({"grainMs": 1, "series": {}})
    with pytest.raises(ValidationError, match="grainMs"):
        parse_window({**iid(1, 10), "grainMs": 2.5})
    with pytest.raises(ValidationError, match="two samples"):
        parse_window(iid(1, 1))


def test_default_buckets_are_nested_bands_and_a_flat_series_collapses() -> None:
    buckets = default_buckets(parse_window(iid(1)))
    assert buckets.source == "baseline-quantiles"
    for name in SERIES:
        assert set(buckets.coarse[name].values) <= set(buckets.fine[name].values)
        assert buckets.coarse[name].labels() == ("..p90", "p90..")
        assert buckets.fine[name].labels() == ("..p50", "p50..p90", "p90..p99", "p99..")
    flat = iid(1, 50)
    flat["series"]["retryRate"] = [0.0] * 50
    collapsed = default_buckets(parse_window(flat))
    # 50th, 90th and 99th percentiles of a flat series are one edge, named after the largest
    assert collapsed.fine["retryRate"] == Edges(values=(0.0,), names=("p99",))
    assert bucket(np.array([0.0, 0.01]), collapsed.coarse["retryRate"].values).tolist() == [0, 1]


def test_declared_buckets_must_refine_and_cover_every_series() -> None:
    declared = parse_buckets(
        {
            "coarse": {
                "latencyMs": [250],
                "retryRate": [0.05],
                "abandonmentRate": [0.1],
                "queueDepth": [10],
            },
            "fine": {
                "latencyMs": [120, 250, 800],
                "retryRate": [0.01, 0.05],
                "abandonmentRate": [0.1],
                "queueDepth": [5, 10, 50],
            },
        }
    )
    assert declared.source == "declared"
    assert declared.fine["latencyMs"].labels() == ("..120", "120..250", "250..800", "800..")
    coarse_only = parse_buckets({"coarse": {name: [1] for name in SERIES}})
    assert coarse_only.fine == coarse_only.coarse
    with pytest.raises(ConfigError, match="refine"):
        parse_buckets({"coarse": {n: [1] for n in SERIES}, "fine": {n: [2] for n in SERIES}})
    with pytest.raises(ConfigError, match="needs edges"):
        parse_buckets({"coarse": {"latencyMs": [1]}})
    with pytest.raises(ConfigError, match="increase"):
        parse_buckets({"coarse": {n: [2, 1] for n in SERIES}})


# --- the gate ------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("make", "seeds"),
    [(iid, (1, 2)), (iid, (3, 4)), (iid, (5, 6)), (ar1, (1, 2)), (ar1, (3, 4)), (ar1, (5, 6))],
)
def test_a_stationary_live_window_passes(make: Any, seeds: tuple[int, int]) -> None:
    baseline, live = (parse_window(make(seed)) for seed in seeds)
    report = live_window_gate(baseline, live)
    assert set(report) == REPORT_KEYS
    assert report["kind"] == "measurement"
    assert report["gate"]["signals"] == []
    assert report["gate"]["status"] == "passed"
    # the pass is not vacuous: states were tested, fine ones included
    assert report["gate"]["statesTested"] >= 5
    assert report["decomposed"]
    assert report["parameters"] == {
        "percentile": 95.0,
        "decomposeAbove": 0.25,
        "minTransitions": 20,
        "bootstrapSamples": 1000,
        "seed": 0,
        "buckets": "baseline-quantiles",
    }


def test_a_sparse_state_never_fires_and_a_thin_row_is_not_decisive() -> None:
    """The regression behind the stationary false alarm: a decomposed fine state reached a few
    dozen times spreads its transitions thinly, and the largest cell of a thin row is noise."""
    space = ["calm", "x", "y", "z"]
    labels = {key: dict.fromkeys(SERIES, key) for key in space}
    # y and z are known before the release and always settle back to calm; x is new
    baseline = encode(["calm"] * 300 + ["y", "calm", "z", "calm"] * 25, space)

    def gate(states: list[str], min_transitions: int) -> tuple[list[tuple[str, str]], int]:
        signals, tested = gate_signals(
            encode(states, space),
            baseline,
            space,
            labels,
            percentile=95,
            min_transitions=min_transitions,
            bootstrap_samples=200,
            seed=0,
        )
        return [(s["from"], s["to"]) for s in signals], tested

    # x is always followed by y, which is decisive, but x is seen only 5 times
    sparse = ["calm"] * 300 + ["x", "y", "calm"] * 5
    assert gate(sparse, min_transitions=20) == ([], 1)  # only calm has the support to be tested
    assert gate(sparse, min_transitions=5) == ([("x", "y")], 3)
    # x seen 60 times, followed by y and by z alike: no decisive most likely successor
    thin = ["calm"] * 300 + ["x", "y", "calm", "x", "z", "calm"] * 30
    assert gate(thin, min_transitions=20) == ([], 4)
    # the same support with one successor clearly ahead fires, in that direction
    leaning = ["calm"] * 300 + ["x", "y", "calm"] * 45 + ["x", "z", "calm"] * 15
    assert gate(leaning, min_transitions=20) == ([("x", "y")], 3)  # z: 15 transitions, untested


def test_an_injected_retry_storm_fires_with_the_direction_of_the_loop() -> None:
    report = live_window_gate(parse_window(iid(1)), parse_window(retry_storm(2)))
    assert report["gate"]["status"] == "fired"
    signals = report["gate"]["signals"]
    assert signals and all(set(s) == SIGNAL_KEYS for s in signals)

    def phase(label: dict[str, str]) -> str:
        up = tuple(above_p90(label[name]) for name in SERIES)
        return {
            (True, False, False, False): "latency up",
            (True, True, False, False): "retries up",
            (True, True, True, True): "queue up",
        }.get(up, "other")

    edges = {(phase(s["fromLabel"]), phase(s["toLabel"])) for s in signals}
    assert edges == {
        ("latency up", "retries up"),
        ("retries up", "queue up"),
        ("queue up", "latency up"),
    }
    for s in signals:
        assert s["liveLowerBound"] > s["baselinePercentileValue"]
        assert s["liveProbability"] > s["runnerUpProbability"]
        assert s["marginLowerBound"] > 0
        assert s["liveTransitions"] >= 20
        assert s["baselineSuccessor"] != s["to"]
    # the saturated state never occurred before the release: no baseline successor at all
    novel = [s for s in signals if phase(s["fromLabel"]) == "queue up"]
    assert novel[0]["baselineTransitions"] == 0 and novel[0]["baselineSuccessor"] is None


def test_decomposition_only_where_the_live_mass_is_concentrated() -> None:
    baseline = parse_window(iid(1))
    live = parse_window(iid(2))
    buckets = default_buckets(baseline)
    mass = coarse_mass(live, buckets)
    heavy = sorted(key for key, share in mass.items() if share > 0.25)
    calm = "|".join(f"{name}=..p90" for name in SERIES)
    assert heavy == [calm]  # two thirds of a healthy window sit in the all-calm cluster

    report = live_window_gate(baseline, live)
    assert report["decomposed"] == heavy
    states, labels = build_sequence(live, buckets, frozenset(report["decomposed"]))
    for key in set(states):
        fine = any(label not in ("..p90", "p90..") for label in labels[key].values())
        inside = all(not above_p90(label) for label in labels[key].values())
        assert fine == inside, key  # fine bands inside the heavy cluster, coarse ones elsewhere

    lower = live_window_gate(baseline, live, decompose_above=0.05)
    assert set(lower["decomposed"]) == {k for k, share in mass.items() if share > 0.05}
    assert set(heavy) < set(lower["decomposed"])
    coarse_only = live_window_gate(baseline, live, decompose_above=1.0)
    assert coarse_only["decomposed"] == []
    assert coarse_only["states"] < report["states"] < lower["states"]


def test_deterministic_for_a_seed_and_refuses_mismatched_windows() -> None:
    baseline = parse_window(iid(1))
    live = parse_window(retry_storm(2))
    a = live_window_gate(baseline, live, seed=3, computed_at="2026-10-09T12:00:00.000Z")
    b = live_window_gate(baseline, live, seed=3, computed_at="2026-10-09T12:00:00.000Z")
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
    other = Window(capacity="8 replicas", grain_ms=10_000, series=live.series)
    with pytest.raises(ConfigError, match="matched capacity"):
        live_window_gate(baseline, other)
    coarser = Window(capacity=live.capacity, grain_ms=20_000, series=live.series)
    with pytest.raises(ConfigError, match="grain"):
        live_window_gate(baseline, coarser)
    with pytest.raises(ConfigError, match="percentile"):
        live_window_gate(baseline, live, percentile=100)


def test_a_window_too_short_to_judge_is_insufficient_not_passed() -> None:
    report = live_window_gate(parse_window(iid(1)), parse_window(iid(2, 15)))
    assert report["gate"] == {
        "status": "insufficient",
        "statesTested": 0,
        "liveLevel": None,
        "signals": [],
    }


def test_cli_live_window_writes_a_measurement(tmp_path: Path) -> None:
    baseline_path = tmp_path / "baseline.json"
    live_path = tmp_path / "live.json"
    baseline_path.write_text(json.dumps(iid(1)))
    live_path.write_text(json.dumps(retry_storm(2)))
    out = tmp_path / "live-window.json"
    args = ["live-window", "--baseline", str(baseline_path), "--live", str(live_path)]
    code = main([*args, "--percentile", "99", "--seed", "7", "--out", str(out)])
    assert code == 0
    report = json.loads(out.read_text())
    assert set(report) == REPORT_KEYS
    assert report["kind"] == "measurement"
    assert report["parameters"]["percentile"] == 99.0
    assert report["parameters"]["seed"] == 7
    assert report["gate"]["status"] == "fired"

    buckets = json.dumps(
        {
            "coarse": {
                "latencyMs": [200],
                "retryRate": [0.1],
                "abandonmentRate": [0.04],
                "queueDepth": [20],
            }
        }
    )
    assert main([*args, "--buckets", buckets, "--out", str(out)]) == 0
    declared = json.loads(out.read_text())
    assert declared["parameters"]["buckets"] == "declared"
    assert declared["gate"]["status"] == "fired"

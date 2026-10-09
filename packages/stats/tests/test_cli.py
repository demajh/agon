from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any

import pytest
from conftest import make_rows, write_jsonl, write_parquet_flat

from agon_stats import __version__
from agon_stats.cli import main

RESULT_KEYS = {
    "id",
    "runId",
    "method",
    "control",
    "primaryMetricId",
    "metrics",
    "decision",
    "calibration",
    "sessionsAnalyzed",
    "computedAt",
    "engine",
    "kind",
    "assumptions",
    "requirementsDigest",
}
METRIC_RESULT_KEYS = {
    "metricId",
    "direction",
    "variants",
    "comparisons",
    "varianceDecomposition",
    "warnings",
}
VARIANT_STATS_KEYS = {"variant", "sessions", "mean", "stderr", "ci95", "effectiveSampleSize"}
COMPARISON_KEYS = {
    "variant",
    "control",
    "lift",
    "liftCi95",
    "pBest",
    "pBeatControl",
    "expectedLoss",
}
ISO_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")

METRICS = [
    {"id": "activation", "type": "conversion", "event": "project_created", "primary": True},
    {
        "id": "time_to_activate",
        "type": "duration",
        "from": "session_start",
        "to": "project_created",
    },
    {"id": "steps", "type": "steps"},
    {"id": "frustration", "type": "score", "source": "judge", "score": "frustration"},
]


def analysis_config(**overrides: Any) -> dict[str, Any]:
    config: dict[str, Any] = {
        "runId": "run_k7f2m9x1",
        "control": "control",
        "method": "bayesian",
        "minSessionsPerVariant": 30,
        "decision": {"shipIf": 0.95, "killIf": 0.05},
        "alpha": 0.05,
        "clusterBy": ["persona", "model"],
        "calibrationProfile": "uncalibrated-v0",
        "seed": 0,
        "metrics": METRICS,
        "requirementsDigest": "9c1e" * 16,
    }
    config.update(overrides)
    return config


def fixture_rows():  # type: ignore[no-untyped-def]
    return make_rows(
        {"control": 0.35, "treatment": 0.5},
        n=120,
        exact=False,
        seed=11,
        duration={"control": 60, "treatment": 50},
        frustration={"control": 3.2, "treatment": 2.4},
        run_id="run_k7f2m9x1",
    )


def run_analyze(tmp_path: Path, config: dict[str, Any], sessions: Path) -> dict[str, Any]:
    config_path = tmp_path / "analysis.json"
    config_path.write_text(json.dumps(config))
    out = tmp_path / "result.json"
    code = main(
        ["analyze", "--sessions", str(sessions), "--config", str(config_path), "--out", str(out)]
    )
    assert code == 0
    return json.loads(out.read_text())


def assert_no_nulls_or_non_finite(value: Any, path: str = "$") -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            assert item is not None, f"{path}.{key} is null"
            assert_no_nulls_or_non_finite(item, f"{path}.{key}")
    elif isinstance(value, list):
        for i, item in enumerate(value):
            assert_no_nulls_or_non_finite(item, f"{path}[{i}]")
    elif isinstance(value, float):
        assert math.isfinite(value), f"{path} is not finite"


def test_main_returns_zero(capsys: pytest.CaptureFixture[str]) -> None:
    assert main([]) == 0
    out = capsys.readouterr().out
    assert __version__ in out


def test_version_flag(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exit_info:
        main(["--version"])
    assert exit_info.value.code == 0
    assert f"agon-stats {__version__}" in capsys.readouterr().out


def test_analyze_end_to_end_matches_the_result_schema_keys(tmp_path: Path) -> None:
    rows = fixture_rows()
    sessions = write_jsonl(tmp_path / "sessions.jsonl", rows, run_id="run_k7f2m9x1")
    result = run_analyze(tmp_path, analysis_config(), sessions)

    assert set(result) == RESULT_KEYS
    assert result["id"] == "res_k7f2m9x1"
    assert result["runId"] == "run_k7f2m9x1"
    assert result["method"] == "bayesian"
    assert result["control"] == "control"
    assert result["primaryMetricId"] == "activation"
    assert result["sessionsAnalyzed"] == len(rows)
    assert ISO_Z.match(result["computedAt"])
    assert result["engine"] == {"name": "agon-stats", "version": __version__}
    assert result["kind"] == "model"
    assert result["requirementsDigest"] == "9c1e" * 16
    assert any("simulated" in a for a in result["assumptions"])
    assert set(result["decision"]) <= {"verdict", "variant", "rationale"}
    assert result["decision"]["verdict"] in {"ship", "kill", "continue", "inconclusive"}
    assert set(result["calibration"]) == {"profile", "note"}
    assert result["calibration"]["profile"] == "uncalibrated-v0"
    assert result["calibration"]["note"].startswith("Simulated forecast.")

    assert [m["metricId"] for m in result["metrics"]] == [
        "scenario_success",
        "activation",
        "time_to_activate",
        "steps",
        "frustration",
    ]
    for metric in result["metrics"]:
        assert set(metric) == METRIC_RESULT_KEYS
        assert metric["direction"] in {"increase", "decrease"}
        binary = metric["metricId"] in {"scenario_success", "activation"}
        for variant in metric["variants"]:
            expected = VARIANT_STATS_KEYS | ({"successes"} if binary else set())
            assert set(variant) == expected
            assert variant["ci95"][0] <= variant["mean"] <= variant["ci95"][1]
            assert 0 <= variant["effectiveSampleSize"] <= variant["sessions"]
        assert [c["variant"] for c in metric["comparisons"]] == ["treatment"]
        for comparison in metric["comparisons"]:
            assert set(comparison) == COMPARISON_KEYS
            assert comparison["control"] == "control"
            assert 0 <= comparison["pBest"] <= 1 and 0 <= comparison["pBeatControl"] <= 1
            assert comparison["expectedLoss"] >= 0
            assert comparison["liftCi95"][0] <= comparison["liftCi95"][1]
        assert set(metric["varianceDecomposition"]) == {"persona", "model", "residual"}
        assert sum(metric["varianceDecomposition"].values()) == pytest.approx(1.0)
    assert_no_nulls_or_non_finite(result)
    assert json.dumps(result, allow_nan=False)


def test_analyze_fixed_method_adds_p_value_to_comparisons(tmp_path: Path) -> None:
    sessions = write_jsonl(tmp_path / "sessions.jsonl", fixture_rows(), run_id="run_k7f2m9x1")
    for method in ("fixed", "sequential"):
        result = run_analyze(tmp_path, analysis_config(method=method), sessions)
        assert result["method"] == method
        for metric in result["metrics"]:
            for comparison in metric["comparisons"]:
                assert set(comparison) == COMPARISON_KEYS | {"pValue", "zStat"}
                assert 0 <= comparison["pValue"] <= 1


def test_analyze_reads_parquet_and_matches_jsonl(tmp_path: Path) -> None:
    rows = fixture_rows()
    jsonl = write_jsonl(tmp_path / "sessions.jsonl", rows, run_id="run_k7f2m9x1")
    parquet = write_parquet_flat(tmp_path / "sessions.parquet", rows, run_id="run_k7f2m9x1")
    from_jsonl = run_analyze(tmp_path, analysis_config(), jsonl)
    from_parquet = run_analyze(tmp_path, analysis_config(), parquet)
    from_jsonl.pop("computedAt")
    from_parquet.pop("computedAt")
    assert from_jsonl == from_parquet


def test_analyze_writes_to_stdout_and_honours_overrides(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    sessions = write_jsonl(
        tmp_path / "sessions.jsonl", make_rows({"control": 0.3, "treatment": 0.6}, n=60)
    )
    config_path = tmp_path / "analysis.json"
    config_path.write_text(json.dumps(analysis_config(runId="run_abc", metrics=[], clusterBy=[])))
    code = main(
        [
            "analyze",
            "--sessions",
            str(sessions),
            "--config",
            str(config_path),
            "--result-id",
            "res_custom",
            "--computed-at",
            "2026-10-04T17:00:00.000Z",
        ]
    )
    assert code == 0
    result = json.loads(capsys.readouterr().out)
    assert result["id"] == "res_custom"
    assert result["computedAt"] == "2026-10-04T17:00:00.000Z"
    assert result["primaryMetricId"] == "scenario_success"
    assert result["decision"]["verdict"] == "ship"


def test_analyze_excludes_unfinished_sessions_with_a_warning(tmp_path: Path) -> None:
    rows = make_rows({"control": 0.3, "treatment": 0.6}, n=60)
    unfinished = [
        {**json.loads(line)}
        for line in write_jsonl(tmp_path / "s.jsonl", rows).read_text().splitlines()
    ]
    for session in unfinished[:5]:
        session.pop("outcome")
        session["status"] = "running"
    sessions = tmp_path / "sessions.jsonl"
    sessions.write_text("\n".join(json.dumps(s) for s in unfinished) + "\n")
    result = run_analyze(tmp_path, analysis_config(metrics=[], clusterBy=[]), sessions)
    assert result["sessionsAnalyzed"] == len(rows) - 5
    assert any("5 session(s) without an outcome" in w for w in result["metrics"][0]["warnings"])


def test_analyze_errors_are_json_on_stderr_with_exit_code_one(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    config_path = tmp_path / "analysis.json"
    config_path.write_text(json.dumps(analysis_config()))
    assert (
        main(
            ["analyze", "--sessions", str(tmp_path / "missing.jsonl"), "--config", str(config_path)]
        )
        == 1
    )
    captured = capsys.readouterr()
    assert captured.out == ""
    error = json.loads(captured.err)
    assert error["error"]["code"] == "not_found"
    assert "missing.jsonl" in error["error"]["message"]

    sessions = write_jsonl(
        tmp_path / "sessions.jsonl", make_rows({"control": 0.5, "treatment": 0.5}, n=10)
    )
    config_path.write_text(json.dumps(analysis_config(method="frequentist")))
    assert main(["analyze", "--sessions", str(sessions), "--config", str(config_path)]) == 1
    assert json.loads(capsys.readouterr().err)["error"]["code"] == "config_error"

    config_path.write_text(json.dumps(analysis_config(control="missing-variant")))
    assert main(["analyze", "--sessions", str(sessions), "--config", str(config_path)]) == 1
    assert json.loads(capsys.readouterr().err)["error"]["code"] == "config_error"

    without_digest = analysis_config()
    del without_digest["requirementsDigest"]
    config_path.write_text(json.dumps(without_digest))
    assert main(["analyze", "--sessions", str(sessions), "--config", str(config_path)]) == 1
    assert "requirementsDigest" in json.loads(capsys.readouterr().err)["error"]["message"]


def test_allocate_sums_to_one_and_respects_floor(capsys: pytest.CaptureFixture[str]) -> None:
    scores = json.dumps(
        [
            {"squad": "blue", "wins": 8, "runs": 10},
            {"squad": "red", "wins": 2, "runs": 10},
            {"squad": "green", "wins": 0, "runs": 0},
        ]
    )
    assert main(["allocate", "--scores", scores, "--floor", "0.1", "--seed", "0"]) == 0
    allocation = json.loads(capsys.readouterr().out)["allocation"]
    assert set(allocation) == {"blue", "red", "green"}
    assert sum(allocation.values()) == pytest.approx(1.0)
    assert all(share >= 0.1 - 1e-12 for share in allocation.values())
    assert allocation["blue"] > allocation["green"] > allocation["red"]


def test_allocate_reads_a_scores_file_and_rejects_an_infeasible_floor(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    scores_path = tmp_path / "scores.json"
    scores_path.write_text(json.dumps({"scores": [{"squad": "a", "wins": 1, "runs": 2}]}))
    assert main(["allocate", "--scores", str(scores_path)]) == 0
    assert json.loads(capsys.readouterr().out) == {"allocation": {"a": 1.0}}

    many = json.dumps([{"squad": f"s{i}", "wins": 1, "runs": 2} for i in range(11)])
    assert main(["allocate", "--scores", many, "--floor", "0.1"]) == 1
    assert json.loads(capsys.readouterr().err)["error"]["code"] == "config_error"

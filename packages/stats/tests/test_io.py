from __future__ import annotations

import json
import math
from dataclasses import replace
from pathlib import Path

import pytest
from conftest import FIXTURES, make_rows, write_jsonl, write_parquet_flat, write_parquet_nested

from agon_stats.errors import NotFoundError, ValidationError
from agon_stats.io import SessionRow, load_sessions, row_from_mapping


def test_fixture_jsonl_follows_session_schema() -> None:
    rows = load_sessions(FIXTURES / "sessions.jsonl")
    assert len(rows) == 4
    first = rows[0]
    assert first == SessionRow(
        session_id="ses_fix_00000",
        variant="control",
        scenario_id="first-project",
        persona_id="smb-owner",
        model="anthropic/claude-sonnet-5-5",
        outcome="success",
        steps=12,
        cost_usd=0.12,
        metrics={"activation": 1.0, "time_to_activate": 42.5},
        judgement={
            "success": True,
            "satisfaction": 4,
            "frustration": 2,
            "confidence": 0.8,
            "summary": "Signed up and created a project.",
        },
    )
    assert rows[1].outcome == "gave_up"
    assert rows[1].judgement is not None and rows[1].judgement["frustration"] == 4
    assert rows[2].judgement is None
    running = rows[3]
    assert running.outcome is None
    assert running.metrics == {}


def test_jsonl_and_flat_parquet_load_identical_rows(tmp_path: Path) -> None:
    rows = make_rows(
        {"control": 0.4, "treatment": 0.5}, n=30, duration={"control": 60, "treatment": 50}
    )
    rows[5] = replace(rows[5], outcome=None)  # one unfinished session
    frustrated = make_rows({"control": 0.4}, n=3, frustration={"control": 3.0})
    rows.extend(frustrated)
    from_jsonl = load_sessions(write_jsonl(tmp_path / "sessions.jsonl", rows))
    from_parquet = load_sessions(write_parquet_flat(tmp_path / "sessions.parquet", rows))
    assert from_jsonl == rows
    assert from_parquet == from_jsonl


def test_jsonl_and_nested_parquet_load_identical_rows(tmp_path: Path) -> None:
    rows = make_rows(
        {"control": 0.4, "treatment": 0.5}, n=24, frustration={"control": 3, "treatment": 2}
    )
    from_jsonl = load_sessions(write_jsonl(tmp_path / "sessions.jsonl", rows))
    from_parquet = load_sessions(write_parquet_nested(tmp_path / "sessions.parquet", rows))
    assert from_parquet == from_jsonl == rows


def test_json_array_and_wrapped_object_inputs(tmp_path: Path) -> None:
    rows = make_rows({"control": 0.5}, n=4)
    jsonl = write_jsonl(tmp_path / "sessions.jsonl", rows)
    records = [json.loads(line) for line in jsonl.read_text().splitlines()]
    array_path = tmp_path / "array.json"
    array_path.write_text(json.dumps(records))
    wrapped_path = tmp_path / "wrapped.json"
    wrapped_path.write_text(json.dumps({"sessions": records}))
    assert load_sessions(array_path) == rows
    assert load_sessions(wrapped_path) == rows


def test_flat_row_accepts_camel_case_and_map_metrics() -> None:
    row = row_from_mapping(
        {
            "id": "ses_1",
            "variant": "treatment",
            "scenarioId": "s",
            "personaId": "p",
            "model": "openai/gpt-5",
            "outcome": "success",
            "steps": 4.0,
            "costUsd": "0.25",
            "metrics": [("activation", 1), ("nan_metric", math.nan), ("none", None)],
            "judgementSatisfaction": 5,
        }
    )
    assert row.scenario_id == "s" and row.persona_id == "p"
    assert row.steps == 4 and row.cost_usd == 0.25
    assert row.metrics == {"activation": 1.0}
    assert row.judgement == {"satisfaction": 5}


def test_missing_variant_is_a_validation_error() -> None:
    with pytest.raises(ValidationError):
        row_from_mapping({"id": "ses_1", "outcome": "success"}, index=7)


def test_missing_file_and_unsupported_suffix(tmp_path: Path) -> None:
    with pytest.raises(NotFoundError):
        load_sessions(tmp_path / "nope.jsonl")
    csv = tmp_path / "sessions.csv"
    csv.write_text("a,b\n")
    with pytest.raises(ValidationError):
        load_sessions(csv)


def test_invalid_jsonl_line_reports_line_number(tmp_path: Path) -> None:
    bad = tmp_path / "bad.jsonl"
    bad.write_text('{"id": "a", "variant": "control"}\n{not json}\n')
    with pytest.raises(ValidationError, match="bad.jsonl:2"):
        load_sessions(bad)

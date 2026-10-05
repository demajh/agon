"""Shared fixtures: deterministic synthetic sessions and writers for every supported format."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from agon_stats.config import AnalysisConfig, parse_config
from agon_stats.io import SessionRow

PERSONAS: tuple[str, ...] = ("smb-owner", "developer-evaluator", "skeptical-cfo")
MODELS: tuple[str, ...] = ("anthropic/claude-sonnet-5-5", "openai/gpt-5")
FIXTURES = Path(__file__).parent / "__fixtures__"


def make_rows(
    rates: Mapping[str, float],
    *,
    n: int = 200,
    exact: bool = True,
    seed: int = 0,
    personas: Sequence[str] = PERSONAS,
    models: Sequence[str] = MODELS,
    scenarios: Sequence[str] = ("first-project",),
    persona_shift: Mapping[str, float] | None = None,
    duration: Mapping[str, float] | None = None,
    duration_persona_shift: Mapping[str, float] | None = None,
    frustration: Mapping[str, float] | None = None,
    run_id: str = "run_test",
) -> list[SessionRow]:
    """Synthetic sessions, `n` per variant, personas x models cycled so arms are balanced.

    With ``exact=True`` (and no persona shift) exactly ``round(rate * n)`` sessions succeed, so two
    variants with the same rate have identical data. Otherwise success is Bernoulli with the
    variant's rate plus the persona's shift.
    """
    rng = np.random.default_rng(seed)
    rows: list[SessionRow] = []
    index = 0
    for variant, rate in rates.items():
        successes = round(rate * n)
        for j in range(n):
            persona = personas[j % len(personas)]
            model = models[(j // len(personas)) % len(models)]
            scenario = scenarios[j % len(scenarios)]
            if exact and persona_shift is None:
                success = j < successes
            else:
                p = rate + (persona_shift or {}).get(persona, 0.0)
                success = bool(rng.random() < min(max(p, 0.02), 0.98))
            metrics: dict[str, float] = {
                "activation": 1.0 if success else 0.0,
                "clicks": float(rng.integers(0, 6)),
            }
            if duration is not None:
                mean = duration[variant] + (duration_persona_shift or {}).get(persona, 0.0)
                metrics["time_to_activate"] = float(max(1.0, rng.normal(mean, 10.0)))
            judgement: dict[str, Any] | None = None
            if frustration is not None:
                level = int(np.clip(round(rng.normal(frustration[variant], 0.8)), 1, 5))
                judgement = {
                    "success": success,
                    "satisfaction": 6 - level,
                    "frustration": level,
                    "confidence": 0.8,
                    "summary": "ok",
                }
            rows.append(
                SessionRow(
                    session_id=f"ses_{run_id.split('_', 1)[-1]}_{index:05d}",
                    variant=variant,
                    scenario_id=scenario,
                    persona_id=persona,
                    model=model,
                    outcome="success" if success else "gave_up",
                    steps=int(rng.integers(5, 30)),
                    cost_usd=0.05,
                    metrics=metrics,
                    judgement=judgement,
                )
            )
            index += 1
    return rows


def make_config(**overrides: Any) -> AnalysisConfig:
    """An `analysis.json` document run through the real parser; iid (no clustering) by default."""
    document: dict[str, Any] = {
        "runId": "run_test",
        "control": "control",
        "method": "bayesian",
        "minSessionsPerVariant": 30,
        "decision": {"shipIf": 0.95, "killIf": 0.05},
        "alpha": 0.05,
        "clusterBy": [],
        "calibrationProfile": "uncalibrated-v0",
        "seed": 0,
        "metrics": [],
    }
    document.update(overrides)
    return parse_config(document)


def session_json(row: SessionRow, run_id: str, index: int) -> dict[str, Any]:
    """The nested @agon/spec Session shape for one row."""
    session: dict[str, Any] = {
        "id": row.session_id,
        "runId": run_id,
        "index": index,
        "variant": row.variant,
        "scenarioId": row.scenario_id,
        "persona": {
            "personaId": row.persona_id,
            "name": row.persona_id.replace("-", " "),
            "summary": "You are a simulated user.",
            "traits": {
                "role": "tester",
                "techProficiency": "intermediate",
                "patience": 0.5,
                "attention": 0.5,
                "domainFamiliarity": 0.5,
                "riskTolerance": 0.5,
                "priceSensitivity": 0.5,
            },
            "goals": [],
            "frustrations": [],
            "device": "desktop",
            "locale": "en-US",
            "model": row.model,
            "seed": index,
            "distinctId": f"sim_{index}",
        },
        "status": "finished" if row.outcome is not None else "running",
        "steps": row.steps,
        "costUsd": row.cost_usd,
        "inputTokens": 0,
        "outputTokens": 0,
        "metrics": dict(row.metrics),
    }
    if row.outcome is not None:
        session["outcome"] = row.outcome
    if row.judgement is not None:
        session["judgement"] = dict(row.judgement)
    return session


def write_jsonl(path: Path, rows: Sequence[SessionRow], run_id: str = "run_test") -> Path:
    lines = [json.dumps(session_json(row, run_id, i)) for i, row in enumerate(rows)]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def write_parquet_flat(path: Path, rows: Sequence[SessionRow], run_id: str = "run_test") -> Path:
    """Flat columns as the Parquet exporter writes them (metrics as JSON, judgement_* columns)."""

    def judged(row: SessionRow, key: str) -> Any:
        return row.judgement.get(key) if row.judgement is not None else None

    table = pa.table(
        {
            "id": [r.session_id for r in rows],
            "run_id": [run_id] * len(rows),
            "variant": [r.variant for r in rows],
            "scenario_id": [r.scenario_id for r in rows],
            "persona_id": [r.persona_id for r in rows],
            "model": [r.model for r in rows],
            "outcome": [r.outcome for r in rows],
            "steps": pa.array([r.steps for r in rows], type=pa.int64()),
            "cost_usd": pa.array([r.cost_usd for r in rows], type=pa.float64()),
            "metrics": [json.dumps(r.metrics) for r in rows],
            "judgement_success": [judged(r, "success") for r in rows],
            "judgement_satisfaction": [judged(r, "satisfaction") for r in rows],
            "judgement_frustration": [judged(r, "frustration") for r in rows],
            "judgement_confidence": [judged(r, "confidence") for r in rows],
            "judgement_summary": [judged(r, "summary") for r in rows],
        }
    )
    pq.write_table(table, path)
    return path


def write_parquet_nested(path: Path, rows: Sequence[SessionRow], run_id: str = "run_test") -> Path:
    """Session objects written as-is: persona / metrics / judgement become struct columns."""
    table = pa.Table.from_pylist([session_json(row, run_id, i) for i, row in enumerate(rows)])
    pq.write_table(table, path)
    return path

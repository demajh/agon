"""Assemble the @agon/spec `Result` JSON for a run from its sessions and analysis config."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from agon_stats import __version__
from agon_stats.analysis import analyze_sessions
from agon_stats.calibration import calibration_note
from agon_stats.config import AnalysisConfig
from agon_stats.decision import decide
from agon_stats.errors import ValidationError
from agon_stats.io import SessionRow

ENGINE_NAME = "agon-stats"


def model_assumptions(config: AnalysisConfig, sessions: int) -> list[str]:
    """What a pre-release result assumes. Every `analyze` result is a model, never a measurement."""
    units = (
        "sessions sharing a " + " x ".join(config.cluster_by) + " cell are treated as one cluster"
        if config.cluster_by
        else "every session is treated as an independent user"
    )
    return [
        "Sessions were simulated by LLM-driven personas against a fixed scenario set; the result "
        "forecasts user behaviour and is not an observation of it.",
        f"Calibration profile {config.calibration_profile!r} supplies the benchmark status of that "
        "forecast; see calibration.note.",
        f"Uncertainty: {units} ({sessions} sessions analyzed).",
        f"Trials: M={max(1, config.trials)} variant(s) counted against the sample; the count is as "
        "complete as the evaluation ledger that supplied it.",
    ]


def result_id_for(run_id: str) -> str:
    """``res_<suffix>``: the run id without its prefix (``run_abc`` -> ``res_abc``)."""
    suffix = run_id.split("_", 1)[1] if "_" in run_id else run_id
    return f"res_{suffix or run_id}"


def now_iso() -> str:
    """ISO-8601 UTC timestamp with milliseconds and a ``Z`` suffix (like JS toISOString)."""
    now = datetime.now(UTC)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def build_result(
    rows: Sequence[SessionRow],
    config: AnalysisConfig,
    *,
    result_id: str | None = None,
    computed_at: str | None = None,
) -> dict[str, Any]:
    """Analyze finished sessions and return a spec-shaped Result (camelCase keys)."""
    usable = [row for row in rows if row.outcome is not None]
    skipped = len(rows) - len(usable)
    if not usable:
        raise ValidationError("no sessions with an outcome to analyze")

    output = analyze_sessions(usable, config)
    if skipped:
        output.metrics[0].warnings.append(
            f"{skipped} session(s) without an outcome were excluded from the analysis"
        )
    primary = output.primary()
    decision = decide(primary, config, output.control)

    return {
        "id": result_id or result_id_for(config.run_id),
        "runId": config.run_id,
        "method": config.method,
        "control": output.control,
        "primaryMetricId": primary.metric.id,
        "metrics": [analysis.to_json() for analysis in output.metrics],
        "decision": decision.to_json(),
        "calibration": calibration_note(config.calibration_profile, config.change_category),
        "sessionsAnalyzed": len(usable),
        "computedAt": computed_at or now_iso(),
        "engine": {"name": ENGINE_NAME, "version": __version__},
        "kind": "model",
        "assumptions": model_assumptions(config, len(usable)),
        "requirementsDigest": config.requirements_digest,
    }

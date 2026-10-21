"""Write ``sessions.jsonl`` for the aggregation fixture. Deterministic; no randomness.

Two variants, 100 sessions each, one duration metric (``seconds_to_first_project``) that some
sessions never reach, so those sessions have no value for it and agon-stats excludes them for
that metric. The partition sizes are deliberately lopsided so that a merge which averages
partition means, or treats an all-excluded partition as a zero, gives a visibly wrong number.

    uv run --project packages/stats python examples/aggregation-fixture/make_sessions.py

Per variant the rows are, in file order (``value`` is the metric; ``None`` means no value; a
block "around 60" alternates 50 and 70 so the arm has some variance but an exact sum):

control    smb-owner            50 around 60.0, then 10 x None
control    developer-evaluator  30 around 60.0
control    skeptical-cfo        10 x None          (an all-excluded partition under `persona`)
treatment  developer-evaluator  90 around 30.0, then 8 x None
treatment  smb-owner             1 x 940.0
treatment  skeptical-cfo         1 x None

So the merged truth is: control sum 4800 over 80 valid sessions (mean 60, 20 excluded) and
treatment sum 3640 over 91 valid sessions (mean 40, 9 excluded). A mean of the per-persona means
for treatment is (30 + 940) / 2 = 485, or 323.3 with the empty persona counted as a zero.
"""

from __future__ import annotations

import json
from pathlib import Path

RUN_ID = "run_aggfix"
METRIC_ID = "seconds_to_first_project"
SCENARIO_ID = "first-project"
MODELS = ("anthropic/claude-sonnet-5-5", "openai/gpt-5")

# (variant, persona, count, value or None)
BLOCKS: tuple[tuple[str, str, int, float | None], ...] = (
    ("control", "smb-owner", 50, 60.0),
    ("control", "smb-owner", 10, None),
    ("control", "developer-evaluator", 30, 60.0),
    ("control", "skeptical-cfo", 10, None),
    ("treatment", "developer-evaluator", 90, 30.0),
    ("treatment", "developer-evaluator", 8, None),
    ("treatment", "smb-owner", 1, 940.0),
    ("treatment", "skeptical-cfo", 1, None),
)


def sessions() -> list[dict[str, object]]:
    """The fixture's sessions, in the subset of the @agon/spec Session shape agon-stats reads."""
    rows: list[dict[str, object]] = []
    index = 0
    for variant, persona, count, value in BLOCKS:
        for position in range(count):
            # Every 19th session runs on the second model: 11 of 200, another unequal split.
            model = MODELS[1] if index % 19 == 0 else MODELS[0]
            reached = value is not None
            metrics: dict[str, float] = {"activation": 1.0 if reached else 0.0}
            if value is not None:
                # Blocks of even size alternate value -10 / value +10 around the block value.
                spread = 10.0 if count % 2 == 0 else 0.0
                metrics[METRIC_ID] = value + (spread if position % 2 else -spread)
            rows.append(
                {
                    "id": f"ses_aggfix_{index:03d}",
                    "runId": RUN_ID,
                    "index": index,
                    "variant": variant,
                    "scenarioId": SCENARIO_ID,
                    "persona": {"personaId": persona, "model": model},
                    "status": "finished",
                    "outcome": "success" if reached else "gave_up",
                    "steps": 12 if reached else 7,
                    "costUsd": 0.05,
                    "metrics": metrics,
                }
            )
            index += 1
    return rows


def main() -> None:
    out = Path(__file__).with_name("sessions.jsonl")
    out.write_text("".join(json.dumps(row) + "\n" for row in sessions()), encoding="utf-8")
    print(f"wrote {len(sessions())} sessions to {out}")


if __name__ == "__main__":
    main()

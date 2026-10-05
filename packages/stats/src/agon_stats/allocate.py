"""Thompson-sampling allocation of effort across squads (or variants).

Each squad's win rate gets a ``Beta(wins + 1, losses + 1)`` posterior. We draw from every
posterior ``draws`` times and record how often each squad has the highest draw; that share is then
mixed with a uniform floor so every squad keeps at least ``floor`` of the allocation::

    allocation = floor + (1 - n_squads * floor) * share

The result sums to 1 and is deterministic for a given seed.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np

from agon_stats.errors import ConfigError

DEFAULT_FLOOR = 0.1
DEFAULT_DRAWS = 10_000


@dataclass(frozen=True, slots=True)
class SquadScore:
    squad: str
    wins: int
    runs: int

    @property
    def losses(self) -> int:
        return self.runs - self.wins


def parse_scores(obj: Any) -> list[SquadScore]:
    """Parse ``[{"squad": "blue", "wins": 3, "runs": 5}, ...]`` (or ``{"scores": [...]}``)."""
    if isinstance(obj, Mapping) and isinstance(obj.get("scores"), list):
        obj = obj["scores"]
    if not isinstance(obj, list):
        raise ConfigError("scores must be a JSON array of {squad, wins, runs} objects")
    scores: list[SquadScore] = []
    seen: set[str] = set()
    for i, item in enumerate(obj):
        if not isinstance(item, Mapping):
            raise ConfigError(f"scores[{i}] must be an object")
        squad = item.get("squad", item.get("id"))
        if not isinstance(squad, str) or not squad:
            raise ConfigError(f"scores[{i}].squad must be a non-empty string")
        if squad in seen:
            raise ConfigError(f"duplicate squad {squad!r}")
        seen.add(squad)
        wins = _count(item.get("wins", 0), f"scores[{i}].wins")
        runs = _count(item.get("runs", wins), f"scores[{i}].runs")
        if wins > runs:
            raise ConfigError(f"scores[{i}]: wins ({wins}) exceed runs ({runs})")
        scores.append(SquadScore(squad=squad, wins=wins, runs=runs))
    if not scores:
        raise ConfigError("scores must contain at least one squad")
    return scores


def thompson_allocation(
    scores: Sequence[SquadScore],
    *,
    floor: float = DEFAULT_FLOOR,
    seed: int = 0,
    draws: int = DEFAULT_DRAWS,
) -> dict[str, float]:
    """Allocation shares by squad; sums to 1, every squad gets at least ``floor``."""
    n_squads = len(scores)
    if n_squads == 0:
        raise ConfigError("scores must contain at least one squad")
    if not 0.0 <= floor <= 1.0:
        raise ConfigError("floor must be in [0, 1]")
    if floor * n_squads > 1.0 + 1e-12:
        raise ConfigError(f"floor {floor:g} x {n_squads} squads exceeds 1; lower the floor")
    if draws < 1:
        raise ConfigError("draws must be positive")

    rng = np.random.default_rng(seed)
    samples = np.empty((draws, n_squads))
    for j, score in enumerate(scores):
        samples[:, j] = rng.beta(score.wins + 1.0, score.losses + 1.0, size=draws)
    is_best = samples == samples.max(axis=1, keepdims=True)
    share = (is_best / is_best.sum(axis=1, keepdims=True)).mean(axis=0)

    allocation = floor + (1.0 - n_squads * floor) * share
    allocation = allocation / allocation.sum()
    return {score.squad: float(value) for score, value in zip(scores, allocation, strict=True)}


def _count(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int | float) or value != int(value):
        raise ConfigError(f"{name} must be a non-negative integer")
    number = int(value)
    if number < 0:
        raise ConfigError(f"{name} must be a non-negative integer")
    return number

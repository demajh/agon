from __future__ import annotations

import pytest

from agon_stats.allocate import SquadScore, parse_scores, thompson_allocation
from agon_stats.errors import ConfigError


def test_allocation_sums_to_one_and_respects_floor() -> None:
    scores = [SquadScore("blue", 9, 10), SquadScore("red", 1, 10), SquadScore("green", 5, 10)]
    allocation = thompson_allocation(scores, floor=0.1, seed=0)
    assert set(allocation) == {"blue", "red", "green"}
    assert sum(allocation.values()) == pytest.approx(1.0)
    assert min(allocation.values()) >= 0.1 - 1e-12
    assert allocation["blue"] > allocation["green"] > allocation["red"]
    assert allocation["red"] == pytest.approx(0.1, abs=0.01)


def test_allocation_is_deterministic_for_a_seed() -> None:
    scores = [SquadScore("a", 3, 5), SquadScore("b", 2, 5)]
    assert thompson_allocation(scores, seed=42) == thompson_allocation(scores, seed=42)
    assert thompson_allocation(scores, seed=42) != thompson_allocation(scores, seed=43)


def test_unplayed_squads_share_evenly() -> None:
    scores = [SquadScore("a", 0, 0), SquadScore("b", 0, 0)]
    allocation = thompson_allocation(scores, floor=0.0, seed=0)
    assert allocation["a"] == pytest.approx(0.5, abs=0.02)
    assert allocation["b"] == pytest.approx(0.5, abs=0.02)


def test_zero_floor_lets_a_dominant_squad_take_almost_everything() -> None:
    allocation = thompson_allocation([SquadScore("a", 50, 50), SquadScore("b", 0, 50)], floor=0.0)
    assert allocation["a"] > 0.99


def test_infeasible_floor_and_bad_inputs_raise_config_errors() -> None:
    scores = [SquadScore(f"s{i}", 1, 2) for i in range(11)]
    with pytest.raises(ConfigError, match="exceeds 1"):
        thompson_allocation(scores, floor=0.1)
    with pytest.raises(ConfigError):
        thompson_allocation([], floor=0.1)
    with pytest.raises(ConfigError):
        thompson_allocation(scores[:2], floor=-0.1)


def test_parse_scores_validates_shape() -> None:
    parsed = parse_scores([{"squad": "blue", "wins": 3, "runs": 5}, {"squad": "red", "wins": 0}])
    assert parsed == [SquadScore("blue", 3, 5), SquadScore("red", 0, 0)]
    assert parse_scores({"scores": [{"squad": "x", "wins": 1, "runs": 1}]}) == [
        SquadScore("x", 1, 1)
    ]
    with pytest.raises(ConfigError, match="exceed"):
        parse_scores([{"squad": "blue", "wins": 6, "runs": 5}])
    with pytest.raises(ConfigError, match="duplicate"):
        parse_scores(
            [{"squad": "blue", "wins": 1, "runs": 5}, {"squad": "blue", "wins": 1, "runs": 5}]
        )
    with pytest.raises(ConfigError):
        parse_scores([{"wins": 1, "runs": 5}])
    with pytest.raises(ConfigError):
        parse_scores({"squad": "blue"})

"""Calibration provenance: the note every Result carries next to its lifts and p-values.

Profiles live in the bundled ``profiles.json`` registry. A profile records its benchmark
direction accuracy (overall and per change category) once the calibration loop in PLAN.md section
7 has produced one; until then ``directionAccuracy`` is null and the note says so.
"""

from __future__ import annotations

import json
from functools import lru_cache
from importlib import resources
from typing import Any

UNKNOWN_PROFILE_NOTE = (
    "Unknown calibration profile {profile!r}. No benchmark calibration is available for it; "
    "treat direction and lift as hypotheses, not measurements."
)


@lru_cache(maxsize=1)
def load_profiles() -> dict[str, dict[str, Any]]:
    """The bundled registry, keyed by profile name."""
    text = resources.files("agon_stats").joinpath("profiles.json").read_text(encoding="utf-8")
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("profiles.json must be an object keyed by profile name")
    return data


def calibration_note(profile: str, change_category: str | None = None) -> dict[str, Any]:
    """A spec `CalibrationNote`: profile, changeCategory?, directionAccuracy?, note.

    Unknown profiles never fail: the note states that the profile is unknown.
    """
    entry = load_profiles().get(profile)
    out: dict[str, Any] = {"profile": profile}
    if change_category:
        out["changeCategory"] = change_category
    if entry is None:
        out["note"] = UNKNOWN_PROFILE_NOTE.format(profile=profile)
        return out

    accuracy = _unit_or_none(entry.get("directionAccuracy"))
    note = str(entry.get("note") or "")
    categories = entry.get("categories")
    if change_category and isinstance(categories, dict):
        category = categories.get(change_category)
        if isinstance(category, dict):
            category_accuracy = _unit_or_none(category.get("directionAccuracy"))
            if category_accuracy is not None:
                accuracy = category_accuracy
            if category.get("note"):
                note = str(category["note"])
    if accuracy is not None:
        out["directionAccuracy"] = accuracy
        if not note:
            note = (
                f"Simulated forecast. Profile {profile} agreed with real outcomes on direction in "
                f"{accuracy:.0%} of benchmark experiments"
                + (f" in the {change_category} category." if change_category else ".")
            )
    if not note:
        note = (
            "Simulated forecast. This profile has no benchmark calibration yet; treat direction "
            "and lift as hypotheses, not measurements."
        )
    out["note"] = note
    return out


def _unit_or_none(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    number = float(value)
    if not 0.0 <= number <= 1.0:
        return None
    return number

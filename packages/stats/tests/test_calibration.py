from __future__ import annotations

from agon_stats.calibration import calibration_note, load_profiles


def test_registry_ships_the_uncalibrated_profile() -> None:
    profiles = load_profiles()
    assert "uncalibrated-v0" in profiles
    assert profiles["uncalibrated-v0"]["directionAccuracy"] is None


def test_uncalibrated_note_has_no_accuracy_and_the_spec_wording() -> None:
    note = calibration_note("uncalibrated-v0")
    assert note == {
        "profile": "uncalibrated-v0",
        "note": (
            "Simulated forecast. This profile has no benchmark calibration yet; treat direction "
            "and lift as hypotheses, not measurements."
        ),
    }


def test_change_category_is_passed_through() -> None:
    note = calibration_note("uncalibrated-v0", "pricing")
    assert note["changeCategory"] == "pricing"
    assert "directionAccuracy" not in note
    assert set(note) == {"profile", "changeCategory", "note"}


def test_unknown_profile_does_not_fail() -> None:
    note = calibration_note("fitted-v9", "copy")
    assert note["profile"] == "fitted-v9"
    assert note["changeCategory"] == "copy"
    assert "Unknown calibration profile 'fitted-v9'" in note["note"]
    assert "hypotheses" in note["note"]

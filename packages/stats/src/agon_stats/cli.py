"""Command-line entry point.

    agon-stats analyze --sessions <sessions.jsonl|.parquet> --config <analysis.json> [--out <path>]
                       [--result-id <id>] [--computed-at <iso>]
    agon-stats allocate --scores <json-or-path> [--floor 0.1] [--seed 0] [--draws 10000]
                        [--out <path>]
    agon-stats --version

`analyze` prints a spec `Result` JSON; `allocate` prints ``{"allocation": {squad: share}}``.
Both exit 0 on success. Any failure prints ``{"error": {"code", "message"}}`` to stderr and exits 1.
With no sub-command the CLI prints ``{"ok": true, "version": ...}`` as a health check.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from agon_stats import __version__
from agon_stats.allocate import parse_scores, thompson_allocation
from agon_stats.config import parse_config
from agon_stats.errors import ConfigError, NotFoundError, StatsError
from agon_stats.io import load_sessions
from agon_stats.result import build_result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agon-stats", description="Agon statistics engine")
    parser.add_argument("--version", action="version", version=f"agon-stats {__version__}")
    commands = parser.add_subparsers(dest="command")

    analyze = commands.add_parser(
        "analyze", help="analyze simulated sessions as an experiment and print a Result JSON"
    )
    analyze.add_argument(
        "--sessions", required=True, help="sessions file (.jsonl, .json, .parquet)"
    )
    analyze.add_argument("--config", required=True, help="analysis.json")
    analyze.add_argument("--out", help="write the Result here instead of stdout")
    analyze.add_argument("--result-id", help="override the generated res_<runId-suffix> id")
    analyze.add_argument("--computed-at", help="override the computedAt timestamp (ISO-8601)")

    allocate = commands.add_parser(
        "allocate", help="Thompson-sampling allocation across squads from their win/run counts"
    )
    allocate.add_argument(
        "--scores",
        required=True,
        help='JSON array [{"squad","wins","runs"}, ...], a path to one, or "-" for stdin',
    )
    allocate.add_argument("--floor", type=float, default=0.1, help="minimum share per squad")
    allocate.add_argument("--seed", type=int, default=0)
    allocate.add_argument("--draws", type=int, default=10_000)
    allocate.add_argument("--out", help="write the allocation here instead of stdout")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "analyze":
            payload = run_analyze(args)
        elif args.command == "allocate":
            payload = run_allocate(args)
        else:
            payload = {"ok": True, "version": __version__}
        _emit(payload, args.out if args.command else None)
        return 0
    except StatsError as exc:
        _emit_error(exc.to_json())
        return 1
    except Exception as exc:  # noqa: BLE001 - the CLI contract is "JSON error, exit 1"
        _emit_error(
            {"error": {"code": "internal_error", "message": f"{type(exc).__name__}: {exc}"}}
        )
        return 1


def run_analyze(args: argparse.Namespace) -> dict[str, Any]:
    config = parse_config(_read_json_file(Path(args.config), "config"))
    rows = load_sessions(args.sessions)
    return build_result(rows, config, result_id=args.result_id, computed_at=args.computed_at)


def run_allocate(args: argparse.Namespace) -> dict[str, Any]:
    scores = parse_scores(_read_json_arg(args.scores, "scores"))
    allocation = thompson_allocation(scores, floor=args.floor, seed=args.seed, draws=args.draws)
    return {"allocation": allocation}


def _read_json_arg(value: str, what: str) -> Any:
    text = value.strip()
    if text == "-":
        text = sys.stdin.read()
    elif not text.startswith(("[", "{")):
        return _read_json_file(Path(text), what)
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise ConfigError(f"{what} is not valid JSON: {exc.msg}") from exc


def _read_json_file(path: Path, what: str) -> Any:
    if not path.exists():
        raise NotFoundError(f"{what} file not found: {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ConfigError(f"{what} file {path} is not valid JSON: {exc.msg}") from exc


def _emit(payload: dict[str, Any], out: str | None) -> None:
    text = json.dumps(payload, indent=2, allow_nan=False) + "\n"
    if out:
        Path(out).write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)


def _emit_error(payload: dict[str, Any]) -> None:
    sys.stderr.write(json.dumps(payload) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())

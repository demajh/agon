"""Command-line entry point for agon-stats (scaffold)."""

from __future__ import annotations

import argparse
import json
import sys

from agon_stats import __version__


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agon-stats", description="Agon statistics engine")
    parser.add_argument("--version", action="version", version=f"agon-stats {__version__}")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    parser.parse_args(argv)
    json.dump({"ok": True, "version": __version__}, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

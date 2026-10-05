from agon_stats import __version__
from agon_stats.cli import main


def test_main_returns_zero(capsys) -> None:
    assert main([]) == 0
    out = capsys.readouterr().out
    assert __version__ in out

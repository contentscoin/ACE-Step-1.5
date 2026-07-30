#!/usr/bin/env python3
"""Fail if any Python module under ``musicstudio/`` imports the engine package.

Enforces the coupling invariant of design §1.4.4 on the Python side, mirroring
the ESLint rules that cover TypeScript (see ``musicstudio/eslint.boundary.mjs``).
Tracked as §14 risk #9: the only sanctioned coupling point to ACE-Step is the
HTTP interface used by ``ACE_Engine_Adapter`` (§3.1, §3.6). No exemptions.

Usage:
    python dsp/scripts/check_import_boundary.py [ROOT ...]

Exit status: 0 when clean, 1 when a violation is found, 2 on a usage error.
"""

from __future__ import annotations

import argparse
import ast
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator, Sequence

FORBIDDEN_ROOT = "acestep"
SKIP_DIR_NAMES = {
    ".git",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "venv",
}
MESSAGE = (
    "coupling invariant violation (design §1.4.4): musicstudio/ must not import "
    "acestep. Reach the engine only through the ACE_Engine_Adapter HTTP interface."
)


@dataclass(frozen=True)
class Violation:
    """A single forbidden import occurrence."""

    path: Path
    line: int
    statement: str

    def render(self, base: Path) -> str:
        location = _relative_to(self.path, base)
        return f"{location}:{self.line}: {self.statement} -> {MESSAGE}"


def _relative_to(path: Path, base: Path) -> str:
    try:
        return str(path.relative_to(base))
    except ValueError:
        return str(path)


def _is_forbidden(module: str | None) -> bool:
    if not module:
        return False
    return module.split(".")[0] == FORBIDDEN_ROOT


def iter_python_files(roots: Iterable[Path]) -> Iterator[Path]:
    """Yield every ``*.py`` file under ``roots``, skipping vendored trees."""
    for root in roots:
        if root.is_file():
            if root.suffix == ".py":
                yield root
            continue
        for path in sorted(root.rglob("*.py")):
            if SKIP_DIR_NAMES.isdisjoint(path.parts):
                yield path


def find_violations_in_source(source: str, path: Path) -> list[Violation]:
    """Return forbidden imports found in ``source``, parsed as Python."""
    tree = ast.parse(source, filename=str(path))
    violations: list[Violation] = []

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if _is_forbidden(alias.name):
                    violations.append(
                        Violation(path, node.lineno, f"import {alias.name}")
                    )
        elif isinstance(node, ast.ImportFrom) and _is_forbidden(node.module):
            violations.append(Violation(path, node.lineno, f"from {node.module} import ..."))

    return violations


def find_violations(roots: Sequence[Path]) -> list[Violation]:
    """Scan ``roots`` and return every forbidden import found."""
    violations: list[Violation] = []
    for path in iter_python_files(roots):
        try:
            source = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        try:
            violations.extend(find_violations_in_source(source, path))
        except SyntaxError as error:
            print(f"{path}: skipped, not parseable as Python ({error})", file=sys.stderr)
    return violations


def main(argv: Sequence[str] | None = None) -> int:
    default_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "roots",
        nargs="*",
        type=Path,
        default=[default_root],
        help="directories or files to scan (default: the musicstudio/ tree)",
    )
    args = parser.parse_args(argv)
    roots = [root.resolve() for root in (args.roots or [default_root])]

    for root in roots:
        if not root.exists():
            print(f"error: {root} does not exist", file=sys.stderr)
            return 2

    violations = find_violations(roots)
    if not violations:
        scanned = ", ".join(_relative_to(root, default_root.parent) for root in roots)
        print(f"import boundary clean: no acestep imports under {scanned}")
        return 0

    print(f"{len(violations)} import boundary violation(s):", file=sys.stderr)
    for violation in violations:
        print(f"  {violation.render(default_root.parent)}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

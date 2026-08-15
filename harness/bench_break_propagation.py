#!/usr/bin/env python3
"""Benchmark Rust and JavaScript formatting across JSON size and depth.

The generated trees are deterministic, valid corpus-format trees. Flat arrays
vary document size with one layout group; unary nested arrays vary group depth
while keeping breadth fixed. Every timed command formats exactly the same tree
at a width large enough to keep every group flat, making `fits` inspect the
whole remaining line.

Run from the repository root after `./build.sh`:

    ./harness/bench_break_propagation.py
"""

import argparse
import json
import platform
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
RUNTIMES = (("rust", ROOT / "fmt-rust"), ("js", ROOT / "fmt-js"))
BENCH_DRIVERS = (
    ("rust", ROOT / "rust" / "target" / "release" / "bench_format"),
    ("js", ROOT / "harness" / "bench_format_js.js"),
)
WIDTH = 1_000_000


@dataclass(frozen=True)
class Case:
    axis: str
    value: int

    @property
    def name(self) -> str:
        return f"{self.axis}-{self.value}"


class TreeBuilder:
    def __init__(self) -> None:
        self.parts: list[str] = []
        self.offset = 0
        self.nodes = 0

    def token(self, kind: str, text: str, field: str | None = None) -> dict:
        start = self.offset
        self.parts.append(text)
        self.offset += len(text.encode())
        node = {"type": kind, "start": start, "end": self.offset, "text": text}
        if field is not None:
            node["field"] = field
        self.nodes += 1
        return node

    def string(self) -> dict:
        start = self.offset
        children = [
            self.token('"', '"'),
            self.token("string_content", "x"),
            self.token('"', '"'),
        ]
        self.nodes += 1
        return {"type": "string", "start": start, "end": self.offset, "children": children}

    def array(self, depth: int) -> dict:
        start = self.offset
        children = [self.token("[", "[")]
        if depth == 0:
            value = self.string()
        else:
            value = self.array(depth - 1)
        children.append(value)
        children.append(self.token("]", "]"))
        self.nodes += 1
        return {"type": "array", "start": start, "end": self.offset, "children": children}

    def flat_array(self, size: int) -> dict:
        start = self.offset
        children = [self.token("[", "[")]
        for index in range(size):
            if index:
                children.append(self.token(",", ","))
            children.append(self.string())
        children.append(self.token("]", "]"))
        self.nodes += 1
        return {"type": "array", "start": start, "end": self.offset, "children": children}

    def tree(self, case: Case) -> tuple[dict, int]:
        if case.axis == "size":
            root_child = self.flat_array(case.value)
        else:
            root_child = self.array(depth=case.value - 1)
        self.nodes += 1
        root = {"type": "document", "start": 0, "end": self.offset, "children": [root_child]}
        return {"language": "json", "source": "".join(self.parts), "root": root}, self.nodes


def invoke(executable: Path, tree: Path, capture: bool) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        [str(executable), str(tree), str(WIDTH)],
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        check=False,
    )


def checked_output(executable: Path, tree: Path) -> bytes:
    run = invoke(executable, tree, capture=True)
    if run.returncode:
        raise SystemExit(f"{executable.name} refused {tree.name}: {run.stderr.decode().strip()}")
    return run.stdout


def elapsed(driver: Path, tree: Path, iterations: int) -> float:
    run = subprocess.run(
        [str(driver), str(tree), str(WIDTH), str(iterations)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if run.returncode:
        raise SystemExit(f"{driver.name} refused {tree.name}: {run.stderr.decode().strip()}")
    try:
        return int(run.stdout) / 1_000_000_000
    except ValueError as error:
        raise SystemExit(f"{driver.name} returned an invalid duration: {run.stdout!r}") from error


def calibrate(driver: Path, tree: Path, minimum: float) -> int:
    iterations = 1
    while elapsed(driver, tree, iterations) < minimum:
        iterations *= 2
    return iterations


def measure(driver: Path, tree: Path, iterations: int, samples: int) -> float:
    times = sorted(elapsed(driver, tree, iterations) / iterations for _ in range(samples))
    return times[len(times) // 2] * 1_000


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=7, help="timing samples per runtime and case")
    parser.add_argument(
        "--min-sample-seconds",
        type=float,
        default=0.15,
        help="calibrate iterations until one sample lasts at least this long",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    cases = [
        *(Case("size", value) for value in (32, 256, 2_048, 8_192)),
        *(Case("depth", value) for value in (4, 16, 32, 56)),
    ]
    print(f"host: {platform.platform()} | {platform.processor() or 'unknown CPU'}")
    print(
        f"width: {WIDTH} | statistic: median of {args.samples} | "
        f"minimum sample: {args.min_sample_seconds}s"
    )
    print("| axis | value | tree nodes | tree bytes | iterations | rust ms | js ms | rust/js |")
    print("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")

    with tempfile.TemporaryDirectory(prefix="docfmt-break-bench-") as tmp:
        for case in cases:
            builder = TreeBuilder()
            tree, nodes = builder.tree(case)
            encoded = json.dumps(tree, separators=(",", ":")).encode()
            tree_path = Path(tmp) / f"{case.name}.tree.json"
            tree_path.write_bytes(encoded)

            outputs = [checked_output(executable, tree_path) for _, executable in RUNTIMES]
            if outputs[0] != outputs[1]:
                raise SystemExit(f"runtimes disagree for {case.name}")

            iterations = max(calibrate(driver, tree_path, args.min_sample_seconds) for _, driver in BENCH_DRIVERS)
            timings = {
                name: measure(driver, tree_path, iterations, args.samples)
                for name, driver in BENCH_DRIVERS
            }
            ratio = timings["rust"] / timings["js"]
            print(
                f"| {case.axis} | {case.value} | {nodes} | {len(encoded)} | "
                f"{iterations} | {timings['rust']:.3f} | {timings['js']:.3f} | {ratio:.2f}x |",
                flush=True,
            )


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Run one command with a hard wall-clock timeout and kill its process group."""

import os
import signal
import subprocess
import sys


def terminate_group(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: timeout_exec.py SECONDS COMMAND [ARG ...]", file=sys.stderr)
        return 2
    try:
        timeout = float(sys.argv[1])
    except ValueError:
        print("timeout must be numeric", file=sys.stderr)
        return 2
    if timeout <= 0:
        return 124
    process = subprocess.Popen(sys.argv[2:], start_new_session=True)
    previous_handlers = {}

    def forward_shutdown(signum, _frame):
        terminate_group(process)
        raise SystemExit(128 + signum)

    for signum in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[signum] = signal.signal(signum, forward_shutdown)
    try:
        return process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        terminate_group(process)
        return 124
    finally:
        terminate_group(process)
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


if __name__ == "__main__":
    raise SystemExit(main())

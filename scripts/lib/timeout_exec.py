#!/usr/bin/env python3
"""Run one command with a hard wall-clock timeout and kill its process group."""

import os
import signal
import subprocess
import sys


def child_process_group(process: subprocess.Popen):
    if process.poll() is not None:
        return None
    try:
        pgid = os.getpgid(process.pid)
    except ProcessLookupError:
        return None
    if pgid <= 0 or pgid != process.pid or pgid == os.getpgrp():
        raise RuntimeError("refusing to signal an untrusted process group")
    return pgid


def signal_child_group(process: subprocess.Popen, sig) -> bool:
    pgid = child_process_group(process)
    if pgid is None:
        return False
    # start_new_session=True establishes process.pid as the dedicated child PGID;
    # the checks above prevent signaling this runner or a different process group.
    os.killpg(pgid, sig)
    return True


def terminate_group(process: subprocess.Popen) -> None:
    if not signal_child_group(process, signal.SIGTERM):
        return
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        signal_child_group(process, signal.SIGKILL)
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

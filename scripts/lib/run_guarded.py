#!/usr/bin/env python3
"""Portable guarded command runner for macOS/Linux (no GNU timeout dependency)."""
from __future__ import print_function

import argparse
import datetime as dt
import errno
import json
import os
import re
import selectors
import shlex
import signal
import subprocess
import sys
import tempfile
import time

EXIT = {
    "PASS": 0,
    "FAILED": 1,
    "INTERNAL_ERROR": 2,
    "BUDGET_EXCEEDED": 3,
    "IDLE_TIMEOUT": 124,
    "HARD_TIMEOUT": 125,
    "INTERRUPTED": 130,
}


def iso_now():
    return dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="milliseconds")


def atomic_json(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".%s." % os.path.basename(path), dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def safe_name(value):
    value = re.sub(r"[^A-Za-z0-9_.-]+", "-", value.strip()).strip("-.")
    return value[:80] or "task"


def parse_args(argv):
    p = argparse.ArgumentParser(add_help=True)
    p.add_argument("--name", required=True)
    p.add_argument("--budget", type=float, required=True)
    p.add_argument("--diagnose-after", type=float, default=120.0)
    p.add_argument("--idle-timeout", type=float, default=180.0)
    p.add_argument("--hard-timeout", type=float, default=210.0)
    p.add_argument("--heartbeat", type=float, default=30.0, help=argparse.SUPPRESS)
    p.add_argument("--progress-file", action="append", default=[])
    p.add_argument("command", nargs=argparse.REMAINDER)
    ns = p.parse_args(argv)
    if ns.command and ns.command[0] == "--":
        ns.command = ns.command[1:]
    if not ns.command:
        p.error("missing command after --")
    for label in ("budget", "diagnose_after", "idle_timeout", "hard_timeout", "heartbeat"):
        if getattr(ns, label) <= 0:
            p.error("--%s must be > 0" % label.replace("_", "-"))
    if ns.hard_timeout < ns.idle_timeout:
        p.error("--hard-timeout must be >= --idle-timeout")
    return ns


def file_signature(paths):
    sig = []
    for path in paths:
        try:
            st = os.stat(path)
            sig.append((path, st.st_mtime_ns, st.st_size))
        except OSError:
            sig.append((path, None, None))
    return tuple(sig)


def group_rows(pgid):
    try:
        out = subprocess.check_output(
            ["ps", "-axo", "pid=,ppid=,pgid=,stat=,etime=,command="],
            stderr=subprocess.STDOUT,
            universal_newlines=True,
        )
    except Exception as exc:
        return ["ps failed: %s" % exc]
    rows = []
    for line in out.splitlines():
        fields = line.strip().split(None, 5)
        if len(fields) >= 4:
            try:
                if int(fields[2]) == int(pgid) and not fields[3].startswith("Z"):
                    rows.append(line)
            except ValueError:
                pass
    return rows


def write_process_tree(path, pgid, reason):
    rows = group_rows(pgid)
    with open(path, "a") as fh:
        fh.write("\n=== %s reason=%s pgid=%s ===\n" % (iso_now(), reason, pgid))
        fh.write("\n".join(rows) + ("\n" if rows else "(no processes)\n"))
    return rows


def signal_group(pgid, sig):
    try:
        os.killpg(pgid, sig)
    except OSError as exc:
        if exc.errno != errno.ESRCH:
            raise


def cleanup_group(proc, pgid, tree_path, reason):
    write_process_tree(tree_path, pgid, reason + "-before-term")
    signal_group(pgid, signal.SIGTERM)
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        if not group_rows(pgid):
            return
        time.sleep(0.1)
    write_process_tree(tree_path, pgid, reason + "-before-kill")
    signal_group(pgid, signal.SIGKILL)
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        if not group_rows(pgid):
            return
        time.sleep(0.1)
    write_process_tree(tree_path, pgid, reason + "-residual")


def main(argv):
    args = parse_args(argv)
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    incident_dir = os.path.join(root, ".harness", "runtime-incidents", "%s-%s" % (stamp, safe_name(args.name)))
    os.makedirs(incident_dir, exist_ok=True)
    stdout_path = os.path.join(incident_dir, "stdout.log")
    stderr_path = os.path.join(incident_dir, "stderr.log")
    tree_path = os.path.join(incident_dir, "process-tree.txt")
    result_path = os.path.join(incident_dir, "result.json")
    runtime_path = os.path.join(root, ".harness", "task-runtime.json")
    command_path = os.path.join(incident_dir, "command.txt")
    with open(command_path, "w") as fh:
        fh.write(" ".join(shlex.quote(x) for x in args.command) + "\n")

    started_wall = iso_now()
    started = time.monotonic()
    last_progress = started
    last_progress_wall = started_wall
    last_heartbeat = started
    diagnosed = False
    progress_sig = file_signature(args.progress_file)
    proc = None
    pgid = None
    termination_signal = None
    status = None
    interrupted = {"signal": None}

    def on_signal(signum, _frame):
        interrupted["signal"] = signum

    old_int = signal.signal(signal.SIGINT, on_signal)
    old_term = signal.signal(signal.SIGTERM, on_signal)
    try:
        proc = subprocess.Popen(
            args.command,
            cwd=root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            preexec_fn=os.setsid,
        )
        pgid = os.getpgid(proc.pid)
        print("[GUARD] name=%s pid=%s pgid=%s started=%s budget=%.3fs diagnose=%.3fs idle=%.3fs hard=%.3fs" % (
            args.name, proc.pid, pgid, started_wall, args.budget, args.diagnose_after, args.idle_timeout, args.hard_timeout
        ), flush=True)
        atomic_json(runtime_path, {
            "schema_version": 1, "task": args.name, "step": args.name, "status": "RUNNING",
            "pid": proc.pid, "command": args.command, "started_at": started_wall,
            "last_progress_at": last_progress_wall, "completed_steps": [], "evidence": [incident_dir], "retry_count": 0,
        })

        sel = selectors.DefaultSelector()
        sel.register(proc.stdout, selectors.EVENT_READ, (sys.stdout.buffer, stdout_path))
        sel.register(proc.stderr, selectors.EVENT_READ, (sys.stderr.buffer, stderr_path))
        out_files = {stdout_path: open(stdout_path, "ab"), stderr_path: open(stderr_path, "ab")}
        open_streams = 2
        while True:
            now = time.monotonic()
            if interrupted["signal"] is not None:
                termination_signal = signal.Signals(interrupted["signal"]).name
                status = "INTERRUPTED"
                cleanup_group(proc, pgid, tree_path, "interrupted")
                break

            elapsed = now - started
            progress_age = now - last_progress
            new_sig = file_signature(args.progress_file)
            if new_sig != progress_sig:
                progress_sig = new_sig
                last_progress = now
                last_progress_wall = iso_now()
                diagnosed = False
                progress_age = 0.0

            if progress_age >= args.diagnose_after and not diagnosed:
                write_process_tree(tree_path, pgid, "diagnose-after")
                diagnosed = True
                print("[GUARD][DIAGNOSE] name=%s elapsed=%.1fs last_progress_age=%.1fs" % (args.name, elapsed, progress_age), flush=True)

            if elapsed >= args.hard_timeout:
                status = "HARD_TIMEOUT"
                termination_signal = "SIGTERM/SIGKILL"
                cleanup_group(proc, pgid, tree_path, "hard-timeout")
                break
            if progress_age >= args.idle_timeout:
                status = "IDLE_TIMEOUT"
                termination_signal = "SIGTERM/SIGKILL"
                cleanup_group(proc, pgid, tree_path, "idle-timeout")
                break

            if now - last_heartbeat >= args.heartbeat:
                print("[GUARD][HEARTBEAT] name=%s elapsed=%.1fs last_progress_age=%.1fs" % (args.name, elapsed, progress_age), flush=True)
                last_heartbeat = now

            events = sel.select(timeout=min(0.2, max(0.01, args.hard_timeout - elapsed)))
            for key, _ in events:
                stream = key.fileobj
                try:
                    chunk = os.read(stream.fileno(), 65536)
                except OSError:
                    chunk = b""
                if chunk:
                    target, log_path = key.data
                    out_files[log_path].write(chunk)
                    out_files[log_path].flush()
                    target.write(chunk)
                    target.flush()
                    last_progress = time.monotonic()
                    last_progress_wall = iso_now()
                    diagnosed = False
                else:
                    try:
                        sel.unregister(stream)
                    except Exception:
                        pass
                    open_streams -= 1

            rc = proc.poll()
            if rc is not None and open_streams <= 0:
                elapsed = time.monotonic() - started
                if rc != 0:
                    status = "FAILED"
                elif elapsed > args.budget:
                    status = "BUDGET_EXCEEDED"
                else:
                    status = "PASS"
                break

        for fh in out_files.values():
            fh.close()
        if proc.poll() is None:
            try:
                proc.wait(timeout=0.5)
            except Exception:
                pass
        child_rc = proc.poll()
        elapsed_ms = int(round((time.monotonic() - started) * 1000))
        ended_wall = iso_now()
        result = {
            "schema_version": 1,
            "name": args.name,
            "command": args.command,
            "started_at": started_wall,
            "ended_at": ended_wall,
            "elapsed_ms": elapsed_ms,
            "budget_ms": int(args.budget * 1000),
            "diagnose_after_ms": int(args.diagnose_after * 1000),
            "idle_timeout_ms": int(args.idle_timeout * 1000),
            "hard_timeout_ms": int(args.hard_timeout * 1000),
            "last_progress_at": last_progress_wall,
            "status": status,
            "runner_exit_code": EXIT[status],
            "child_exit_code": child_rc,
            "termination_signal": termination_signal,
            "incident_dir": incident_dir,
        }
        atomic_json(result_path, result)
        atomic_json(runtime_path, {
            "schema_version": 1, "task": args.name, "step": args.name, "status": status,
            "pid": proc.pid, "command": args.command, "started_at": started_wall,
            "last_progress_at": last_progress_wall, "ended_at": ended_wall,
            "completed_steps": [args.name] if status == "PASS" else [],
            "evidence": [result_path], "retry_count": 0,
        })
        print("[GUARD][%s] name=%s elapsed_ms=%s child_exit=%s evidence=%s" % (
            status, args.name, elapsed_ms, child_rc, incident_dir
        ), flush=True)
        return EXIT[status]
    except Exception as exc:
        if proc is not None and pgid is not None:
            try:
                cleanup_group(proc, pgid, tree_path, "internal-error")
            except Exception:
                pass
        print("[GUARD][INTERNAL_ERROR] %s" % exc, file=sys.stderr)
        return EXIT["INTERNAL_ERROR"]
    finally:
        signal.signal(signal.SIGINT, old_int)
        signal.signal(signal.SIGTERM, old_term)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

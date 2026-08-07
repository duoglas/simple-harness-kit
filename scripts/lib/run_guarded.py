#!/usr/bin/env python3
"""Portable guarded command runner for macOS/Linux (no GNU timeout dependency)."""
from __future__ import print_function

import argparse
import ctypes
import datetime as dt
import errno
import json
import os
import re
import selectors
import shlex
import signal
import struct
import subprocess
import sys
import tempfile
import time
import uuid

EXIT = {
    "PASS": 0,
    "FAILED": 1,
    "INTERNAL_ERROR": 2,
    "BUDGET_EXCEEDED": 3,
    "IDLE_TIMEOUT": 124,
    "HARD_TIMEOUT": 125,
    "INTERRUPTED": 130,
}

TERMINATION_SEQUENCE = "SIGTERM/SIGKILL"
RESIDUAL_TERMINATION_SEQUENCE = TERMINATION_SEQUENCE + "(residual-descendants)"
GROUP_SAMPLE_INTERVAL = 0.02


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


def _ps_snapshot(include_env=False):
    """Return parsed process rows as (pid, ppid, pgid, stat, raw_line)."""
    command = ["ps"]
    if include_env:
        command.append("eww")
    command.extend(["-axo", "pid=,ppid=,pgid=,stat=,etime=,command="])
    out = subprocess.check_output(
        command,
        stderr=subprocess.STDOUT,
        universal_newlines=True,
    )
    parsed = []
    for line in out.splitlines():
        fields = line.strip().split(None, 5)
        if len(fields) < 4:
            continue
        try:
            parsed.append((int(fields[0]), int(fields[1]), int(fields[2]), fields[3], line))
        except ValueError:
            continue
    return parsed


def group_members(pgid):
    """Return the live process tree rooted in the guarded process group."""
    parsed = _ps_snapshot()
    members = {
        pid for pid, _ppid, member_pgid, stat, _line in parsed
        if member_pgid == int(pgid) and not stat.startswith("Z")
    }
    changed = True
    while changed:
        changed = False
        for pid, ppid, _member_pgid, stat, _line in parsed:
            if pid in members or stat.startswith("Z"):
                continue
            if ppid in members:
                members.add(pid)
                changed = True
    return [
        (pid, member_pgid, line)
        for pid, _ppid, member_pgid, stat, line in parsed
        if pid in members and not stat.startswith("Z")
    ]


def darwin_pipe_handles(pid, fd):
    """Return (handle, peer_handle) for a Darwin pipe fd, or an empty tuple."""
    if sys.platform != "darwin":
        return ()
    try:
        libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
        buf = ctypes.create_string_buffer(184)  # sizeof(struct pipe_fdinfo), Darwin 23+
        size = libproc.proc_pidfdinfo(int(pid), int(fd), 6, buf, len(buf))
        if size < 176:
            return ()
        return struct.unpack_from("QQ", buf.raw, 160)
    except Exception:
        return ()


def guarded_pipe_handles(proc):
    handles = set()
    for stream in (proc.stdout, proc.stderr):
        if stream is None:
            continue
        handles.update(darwin_pipe_handles(os.getpid(), stream.fileno()))
    handles.discard(0)
    return handles


def mark_discovery_uncertain(discovery_state):
    if discovery_state is not None:
        discovery_state["uncertain"] = True


def process_holds_guarded_pipe(libproc, pid, pipe_handles):
    fd_buf = ctypes.create_string_buffer(65536)
    size = libproc.proc_pidinfo(int(pid), 1, 0, fd_buf, len(fd_buf))
    if size <= 0:
        return False
    for offset in range(0, size - 7, 8):
        fd, fd_type = struct.unpack_from("iI", fd_buf.raw, offset)
        if fd_type != 6:  # PROX_FDTYPE_PIPE
            continue
        handles = darwin_pipe_handles(pid, fd)
        if handles and pipe_handles.intersection(handles):
            return True
    return False


def pipe_group_ids(pipe_handles, discovery_state=None):
    """Darwin fallback: find groups still holding a guarded stdout/stderr pipe."""
    if sys.platform != "darwin" or not pipe_handles:
        return []
    try:
        libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
        return sorted({
            pgid for pid, _ppid, pgid, stat, _line in _ps_snapshot()
            if not stat.startswith("Z")
            and pid != os.getpid()
            and process_holds_guarded_pipe(libproc, pid, pipe_handles)
        })
    except Exception:
        mark_discovery_uncertain(discovery_state)
        return []


def token_group_ids(guard_token, discovery_state=None):
    """Find descendant groups that retained the per-run environment marker.

    The marker closes the common race where the direct child exits before a ps
    ancestry sample and a setsid descendant is immediately reparented. It is a
    fallback to persistent ancestry observations, not a security boundary.
    """
    if not guard_token:
        return []
    marker = "SHK_GUARD_TOKEN=%s" % guard_token
    try:
        return sorted({
            member_pgid for _pid, _ppid, member_pgid, stat, line in _ps_snapshot(include_env=True)
            if marker in line and not stat.startswith("Z")
        })
    except Exception:
        if discovery_state is not None:
            discovery_state["uncertain"] = True
        return []


def refresh_guarded_groups(root_pgid, observed_pgids, guard_token=None, scan_token=False, pipe_handles=None, scan_pipes=False, discovery_state=None):
    """Persist every process group ever observed as part of this guarded run."""
    observed_pgids.add(int(root_pgid))
    try:
        for _pid, member_pgid, _line in group_members(root_pgid):
            observed_pgids.add(member_pgid)
    except Exception:
        if discovery_state is not None:
            discovery_state["uncertain"] = True
    if scan_token:
        for member_pgid in token_group_ids(guard_token, discovery_state):
            observed_pgids.add(member_pgid)
    if scan_pipes:
        for member_pgid in pipe_group_ids(pipe_handles, discovery_state):
            observed_pgids.add(member_pgid)
    try:
        own_pgid = os.getpgrp()
    except OSError:
        own_pgid = None
    observed_pgids.difference_update({item for item in observed_pgids if item <= 0 or item == own_pgid})
    return sorted(observed_pgids)


def rows_for_groups(pgids):
    """Return live rows belonging to captured groups, without relying on ancestry."""
    wanted = {int(pgid) for pgid in pgids}
    if not wanted:
        return []
    return [
        line for _pid, _ppid, member_pgid, stat, line in _ps_snapshot()
        if member_pgid in wanted and not stat.startswith("Z")
    ]


def group_rows_state(pgids):
    """Return (rows, uncertain). Process discovery failure is not proof of exit."""
    try:
        return rows_for_groups(pgids), False
    except Exception:
        return [], True


def live_group_ids():
    try:
        return {
            member_pgid for _pid, _ppid, member_pgid, stat, _line in _ps_snapshot()
            if not stat.startswith("Z")
        }, False
    except Exception:
        return None, True


def group_is_gone(target):
    try:
        return not rows_for_groups([target])
    except Exception:
        return False


def signal_group(target, sig):
    try:
        # Targets are positive, live PGIDs collected from the guarded child tree;
        # refresh_guarded_groups also removes this runner's own process group.
        os.killpg(target, sig)
        return False
    except OSError as exc:
        if exc.errno == errno.ESRCH:
            return False
        if exc.errno == errno.EPERM and group_is_gone(target):
            return False
        return True


def signal_groups(pgids, sig):
    """Signal every observed group and report whether any outcome was uncertain."""
    alive, uncertain = live_group_ids()
    for target in pgids:
        if alive is not None and target not in alive:
            continue
        signal_uncertain = signal_group(target, sig)
        uncertain = uncertain or signal_uncertain
    return uncertain


def write_group_rows(path, pgid, pgids, reason, discovery_state=None):
    try:
        rows = rows_for_groups(pgids)
    except Exception as exc:
        if discovery_state is not None:
            discovery_state["uncertain"] = True
        rows = ["ps failed: %s" % exc]
    with open(path, "a") as fh:
        fh.write("\n=== %s reason=%s pgid=%s target_pgids=%s ===\n" % (
            iso_now(), reason, pgid, ",".join(str(x) for x in pgids)
        ))
        fh.write("\n".join(rows) + ("\n" if rows else "(no processes)\n"))
    return rows


def cleanup_phase(
    pgid, observed_pgids, guard_token, pipe_handles, discovery_state,
    sig, timeout, already_signaled,
):
    uncertain = False
    deadline = time.monotonic() + timeout
    while True:
        target_pgids = refresh_guarded_groups(
            pgid, observed_pgids, guard_token, scan_token=True,
            pipe_handles=pipe_handles, scan_pipes=True, discovery_state=discovery_state,
        )
        new_targets = [item for item in target_pgids if item not in already_signaled]
        if new_targets:
            signal_uncertain = signal_groups(new_targets, sig)
            uncertain = uncertain or signal_uncertain
            already_signaled.update(new_targets)
        rows, unknown = group_rows_state(target_pgids)
        uncertain = uncertain or unknown
        if not unknown and not rows:
            return {"clean": True, "uncertain": uncertain, "target_pgids": []}
        if time.monotonic() >= deadline:
            return {"clean": False, "uncertain": uncertain, "target_pgids": target_pgids}
        time.sleep(0.1)


def cleanup_group(pgid, tree_path, reason, observed_pgids, guard_token=None, pipe_handles=None, discovery_state=None):
    """Terminate observed groups; discovery failure still escalates to KILL."""
    target_pgids = refresh_guarded_groups(
        pgid, observed_pgids, guard_token, scan_token=True,
        pipe_handles=pipe_handles, scan_pipes=True, discovery_state=discovery_state,
    )
    write_group_rows(tree_path, pgid, target_pgids, reason + "-before-term", discovery_state)
    term_result = cleanup_phase(
        pgid, observed_pgids, guard_token, pipe_handles, discovery_state,
        signal.SIGTERM, 5.0, set(),
    )
    if term_result["clean"]:
        return {"clean": True, "uncertain": term_result["uncertain"], "residual_pgids": []}

    target_pgids = refresh_guarded_groups(
        pgid, observed_pgids, guard_token, scan_token=True,
        pipe_handles=pipe_handles, scan_pipes=True, discovery_state=discovery_state,
    )
    write_group_rows(tree_path, pgid, target_pgids, reason + "-before-kill", discovery_state)
    kill_result = cleanup_phase(
        pgid, observed_pgids, guard_token, pipe_handles, discovery_state,
        signal.SIGKILL, 2.0, set(),
    )
    uncertain = term_result["uncertain"] or kill_result["uncertain"]
    residual_pgids = kill_result["target_pgids"]
    write_group_rows(tree_path, pgid, residual_pgids, reason + "-residual", discovery_state)
    return {
        "clean": kill_result["clean"],
        "uncertain": uncertain,
        "residual_pgids": list(residual_pgids),
    }


class GuardRun:
    def __init__(self, args):
        self.args = args
        self.root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        self.incident_dir = os.path.join(
            self.root, ".harness", "runtime-incidents", "%s-%s" % (stamp, safe_name(args.name))
        )
        os.makedirs(self.incident_dir, exist_ok=True)
        self.stdout_path = os.path.join(self.incident_dir, "stdout.log")
        self.stderr_path = os.path.join(self.incident_dir, "stderr.log")
        self.tree_path = os.path.join(self.incident_dir, "process-tree.txt")
        self.result_path = os.path.join(self.incident_dir, "result.json")
        self.runtime_path = os.path.join(self.root, ".harness", "task-runtime.json")
        self.command_path = os.path.join(self.incident_dir, "command.txt")
        with open(self.command_path, "w") as fh:
            fh.write(" ".join(shlex.quote(x) for x in args.command) + "\n")

        self.started_wall = iso_now()
        self.started = time.monotonic()
        self.last_progress = self.started
        self.last_progress_wall = self.started_wall
        self.last_heartbeat = self.started
        self.last_group_sample = self.started
        self.diagnosed = False
        self.progress_sig = file_signature(args.progress_file)
        self.proc = None
        self.pgid = None
        self.selector = None
        self.open_streams = 0
        self.out_files = {}
        self.termination_signal = None
        self.interrupted = {"signal": None}
        self.guard_token = uuid.uuid4().hex
        self.observed_pgids = set()
        self.cleanup_performed = False
        self.cleanup_uncertain = False
        self.discovery_state = {"uncertain": False}
        self.residual_pgids = []
        self.pipe_handles = set()

    def mark_progress(self, now=None):
        self.last_progress = time.monotonic() if now is None else now
        self.last_progress_wall = iso_now()
        self.diagnosed = False

    def close_outputs(self):
        for fh in self.out_files.values():
            try:
                fh.close()
            except Exception:
                pass


def running_runtime_payload(run):
    return {
        "schema_version": 1,
        "task": run.args.name,
        "step": run.args.name,
        "status": "RUNNING",
        "pid": run.proc.pid,
        "command": run.args.command,
        "started_at": run.started_wall,
        "last_progress_at": run.last_progress_wall,
        "completed_steps": [],
        "evidence": [run.incident_dir],
        "retry_count": 0,
    }


def launch_guarded_process(run):
    child_env = os.environ.copy()
    child_env["SHK_GUARD_TOKEN"] = run.guard_token
    run.proc = subprocess.Popen(
        run.args.command,
        cwd=run.root,
        env=child_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
        preexec_fn=os.setsid,
    )
    # preexec_fn=os.setsid creates a new session whose PGID is exactly the child
    # PID. Reading it back races an immediate child exit on macOS/Linux.
    run.pgid = run.proc.pid
    run.pipe_handles = guarded_pipe_handles(run.proc)
    refresh_guarded_groups(
        run.pgid, run.observed_pgids, run.guard_token, discovery_state=run.discovery_state
    )
    print(
        "[GUARD] name=%s pid=%s pgid=%s started=%s budget=%.3fs diagnose=%.3fs idle=%.3fs hard=%.3fs"
        % (
            run.args.name, run.proc.pid, run.pgid, run.started_wall,
            run.args.budget, run.args.diagnose_after,
            run.args.idle_timeout, run.args.hard_timeout,
        ),
        flush=True,
    )
    atomic_json(run.runtime_path, running_runtime_payload(run))
    run.selector = selectors.DefaultSelector()
    run.selector.register(run.proc.stdout, selectors.EVENT_READ, (sys.stdout.buffer, run.stdout_path))
    run.selector.register(run.proc.stderr, selectors.EVENT_READ, (sys.stderr.buffer, run.stderr_path))
    run.out_files = {
        run.stdout_path: open(run.stdout_path, "ab"),
        run.stderr_path: open(run.stderr_path, "ab"),
    }
    run.open_streams = 2


def refresh_progress_file(run, now):
    new_sig = file_signature(run.args.progress_file)
    if new_sig != run.progress_sig:
        run.progress_sig = new_sig
        run.mark_progress(now)
    return now - run.last_progress


def sample_guarded_groups(run, now):
    if now - run.last_group_sample < GROUP_SAMPLE_INTERVAL:
        return
    refresh_guarded_groups(
        run.pgid, run.observed_pgids, run.guard_token, discovery_state=run.discovery_state
    )
    run.last_group_sample = now


def cleanup_for_stop(run, status, termination_signal, reason, include_discovery=False):
    run.termination_signal = termination_signal
    cleanup = cleanup_group(
        run.pgid, run.tree_path, reason, run.observed_pgids,
        run.guard_token, run.pipe_handles, run.discovery_state,
    )
    run.cleanup_performed = True
    run.cleanup_uncertain = cleanup["uncertain"]
    if include_discovery:
        run.cleanup_uncertain = run.cleanup_uncertain or run.discovery_state["uncertain"]
    run.residual_pgids = cleanup["residual_pgids"]
    return status if cleanup["clean"] else "INTERNAL_ERROR"


def forced_stop_status(run, elapsed, progress_age):
    if run.interrupted["signal"] is not None:
        signal_name = signal.Signals(run.interrupted["signal"]).name
        return cleanup_for_stop(run, "INTERRUPTED", signal_name, "interrupted", include_discovery=True)
    if elapsed >= run.args.hard_timeout:
        return cleanup_for_stop(run, "HARD_TIMEOUT", TERMINATION_SEQUENCE, "hard-timeout")
    if progress_age >= run.args.idle_timeout:
        return cleanup_for_stop(run, "IDLE_TIMEOUT", TERMINATION_SEQUENCE, "idle-timeout")
    return None


def maybe_diagnose(run, elapsed, progress_age):
    if progress_age < run.args.diagnose_after or run.diagnosed:
        return
    targets = refresh_guarded_groups(
        run.pgid, run.observed_pgids, run.guard_token, discovery_state=run.discovery_state
    )
    write_group_rows(run.tree_path, run.pgid, targets, "diagnose-after", run.discovery_state)
    run.diagnosed = True
    print(
        "[GUARD][DIAGNOSE] name=%s elapsed=%.1fs last_progress_age=%.1fs"
        % (run.args.name, elapsed, progress_age),
        flush=True,
    )


def maybe_heartbeat(run, now, elapsed, progress_age):
    if now - run.last_heartbeat < run.args.heartbeat:
        return
    print(
        "[GUARD][HEARTBEAT] name=%s elapsed=%.1fs last_progress_age=%.1fs"
        % (run.args.name, elapsed, progress_age),
        flush=True,
    )
    run.last_heartbeat = now


def relay_ready_output(run, events):
    for key, _ in events:
        stream = key.fileobj
        try:
            chunk = os.read(stream.fileno(), 65536)
        except OSError:
            chunk = b""
        if chunk:
            target, log_path = key.data
            run.out_files[log_path].write(chunk)
            run.out_files[log_path].flush()
            target.write(chunk)
            target.flush()
            run.mark_progress()
            refresh_guarded_groups(
                run.pgid, run.observed_pgids, run.guard_token,
                discovery_state=run.discovery_state,
            )
            continue
        try:
            run.selector.unregister(stream)
        except Exception:
            pass
        run.open_streams -= 1


def completed_child_status(run):
    rc = run.proc.poll()
    if rc is None or run.open_streams > 0:
        return None
    elapsed = time.monotonic() - run.started
    if rc != 0:
        return "FAILED"
    if elapsed > run.args.budget:
        return "BUDGET_EXCEEDED"
    return "PASS"


def monitor_iteration(run):
    now = time.monotonic()
    sample_guarded_groups(run, now)
    elapsed = now - run.started
    progress_age = refresh_progress_file(run, now)
    status = forced_stop_status(run, elapsed, progress_age)
    if status is not None:
        return status
    maybe_diagnose(run, elapsed, progress_age)
    maybe_heartbeat(run, now, elapsed, progress_age)
    timeout = min(GROUP_SAMPLE_INTERVAL, max(0.005, run.args.hard_timeout - elapsed))
    relay_ready_output(run, run.selector.select(timeout=timeout))
    return completed_child_status(run)


def monitor_guarded_process(run):
    while True:
        status = monitor_iteration(run)
        if status is not None:
            return status


def reclaim_terminal_descendants(run, status):
    if run.cleanup_performed:
        return status
    targets = refresh_guarded_groups(
        run.pgid, run.observed_pgids, run.guard_token, scan_token=True,
        pipe_handles=run.pipe_handles, scan_pipes=True,
        discovery_state=run.discovery_state,
    )
    rows, discovery_uncertain = group_rows_state(targets)
    if not rows and not discovery_uncertain:
        return status
    reason = "terminal-%s" % status.lower()
    status = cleanup_for_stop(run, status, run.termination_signal, reason)
    run.cleanup_uncertain = discovery_uncertain or run.cleanup_uncertain
    if run.termination_signal is None:
        run.termination_signal = RESIDUAL_TERMINATION_SEQUENCE
    return status


def settle_child(run):
    run.close_outputs()
    if run.proc.poll() is None:
        try:
            run.proc.wait(timeout=0.5)
        except Exception:
            pass
    return run.proc.poll()


def completed_runtime_payload(run, status, ended_wall):
    return {
        "schema_version": 1,
        "task": run.args.name,
        "step": run.args.name,
        "status": status,
        "pid": run.proc.pid,
        "command": run.args.command,
        "started_at": run.started_wall,
        "last_progress_at": run.last_progress_wall,
        "ended_at": ended_wall,
        "completed_steps": [run.args.name] if status == "PASS" else [],
        "evidence": [run.result_path],
        "retry_count": 0,
    }


def result_payload(run, status, child_rc, ended_wall, elapsed_ms):
    return {
        "schema_version": 1,
        "name": run.args.name,
        "command": run.args.command,
        "started_at": run.started_wall,
        "ended_at": ended_wall,
        "elapsed_ms": elapsed_ms,
        "budget_ms": int(run.args.budget * 1000),
        "diagnose_after_ms": int(run.args.diagnose_after * 1000),
        "idle_timeout_ms": int(run.args.idle_timeout * 1000),
        "hard_timeout_ms": int(run.args.hard_timeout * 1000),
        "last_progress_at": run.last_progress_wall,
        "status": status,
        "runner_exit_code": EXIT[status],
        "child_exit_code": child_rc,
        "termination_signal": run.termination_signal,
        "cleanup_uncertain": run.cleanup_uncertain,
        "residual_pgids": run.residual_pgids,
        "incident_dir": run.incident_dir,
    }


def finish_run(run, status):
    status = reclaim_terminal_descendants(run, status)
    run.cleanup_uncertain = run.cleanup_uncertain or run.discovery_state["uncertain"]
    if run.cleanup_uncertain:
        status = "INTERNAL_ERROR"
    child_rc = settle_child(run)
    elapsed_ms = int(round((time.monotonic() - run.started) * 1000))
    ended_wall = iso_now()
    atomic_json(run.result_path, result_payload(run, status, child_rc, ended_wall, elapsed_ms))
    atomic_json(run.runtime_path, completed_runtime_payload(run, status, ended_wall))
    print(
        "[GUARD][%s] name=%s elapsed_ms=%s child_exit=%s evidence=%s"
        % (status, run.args.name, elapsed_ms, child_rc, run.incident_dir),
        flush=True,
    )
    return EXIT[status]


def cleanup_internal_error(run):
    if run.proc is None or run.pgid is None:
        return
    try:
        cleanup = cleanup_group(
            run.pgid, run.tree_path, "internal-error", run.observed_pgids,
            run.guard_token, run.pipe_handles, run.discovery_state,
        )
        run.cleanup_uncertain = cleanup["uncertain"]
        run.residual_pgids = cleanup["residual_pgids"]
    except Exception:
        run.cleanup_uncertain = True
        run.residual_pgids = sorted(run.observed_pgids)


def error_runtime_payload(run, ended_wall, error):
    return {
        "schema_version": 1,
        "task": run.args.name,
        "step": run.args.name,
        "status": "INTERNAL_ERROR",
        "pid": run.proc.pid if run.proc is not None else None,
        "command": run.args.command,
        "started_at": run.started_wall,
        "last_progress_at": run.last_progress_wall,
        "ended_at": ended_wall,
        "completed_steps": [],
        "evidence": [run.result_path],
        "retry_count": 0,
        "error": str(error),
    }


def handle_internal_error(run, error):
    cleanup_internal_error(run)
    run.close_outputs()
    ended_wall = iso_now()
    elapsed_ms = int(round((time.monotonic() - run.started) * 1000))
    child_rc = run.proc.poll() if run.proc is not None else None
    payload = result_payload(run, "INTERNAL_ERROR", child_rc, ended_wall, elapsed_ms)
    payload["termination_signal"] = TERMINATION_SEQUENCE if run.proc is not None else None
    payload["error"] = str(error)
    try:
        atomic_json(run.result_path, payload)
        atomic_json(run.runtime_path, error_runtime_payload(run, ended_wall, error))
    except Exception:
        pass
    print("[GUARD][INTERNAL_ERROR] %s evidence=%s" % (error, run.incident_dir), file=sys.stderr)
    return EXIT["INTERNAL_ERROR"]


def main(argv):
    run = GuardRun(parse_args(argv))

    def on_signal(signum, _frame):
        run.interrupted["signal"] = signum

    old_int = signal.signal(signal.SIGINT, on_signal)
    old_term = signal.signal(signal.SIGTERM, on_signal)
    try:
        launch_guarded_process(run)
        return finish_run(run, monitor_guarded_process(run))
    except Exception as exc:
        return handle_internal_error(run, exc)
    finally:
        signal.signal(signal.SIGINT, old_int)
        signal.signal(signal.SIGTERM, old_term)

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

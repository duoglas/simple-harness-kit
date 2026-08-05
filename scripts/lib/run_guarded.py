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


def pipe_group_ids(pipe_handles, discovery_state=None):
    """Darwin fallback: find groups still holding a guarded stdout/stderr pipe.

    This closes the reparenting race even when a detached descendant clears the
    environment marker, provided it still owns one of the command pipes.
    """
    if sys.platform != "darwin" or not pipe_handles:
        return []
    try:
        libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
        groups = set()
        rows = _ps_snapshot()
        for pid, _ppid, pgid, stat, _line in rows:
            if stat.startswith("Z") or pid == os.getpid():
                continue
            fd_buf = ctypes.create_string_buffer(65536)
            size = libproc.proc_pidinfo(int(pid), 1, 0, fd_buf, len(fd_buf))
            if size <= 0:
                continue
            for offset in range(0, size - 7, 8):
                fd, fd_type = struct.unpack_from("iI", fd_buf.raw, offset)
                if fd_type != 6:  # PROX_FDTYPE_PIPE
                    continue
                handles = darwin_pipe_handles(pid, fd)
                if handles and pipe_handles.intersection(handles):
                    groups.add(pgid)
                    break
        return sorted(groups)
    except Exception:
        if discovery_state is not None:
            discovery_state["uncertain"] = True
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
    wanted = set(int(pgid) for pgid in pgids)
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


def signal_groups(pgids, sig):
    """Signal every observed group and report whether any outcome was uncertain.

    A stale/inaccessible PGID must not abort the loop before later groups receive
    SIGKILL. Callers combine this uncertainty with residual discovery and keep the
    terminal result fail-closed when cleanup cannot be proven complete.
    """
    uncertain = False
    try:
        alive = {
            member_pgid for _pid, _ppid, member_pgid, stat, _line in _ps_snapshot()
            if not stat.startswith("Z")
        }
    except Exception:
        alive = None
        uncertain = True
    for target in pgids:
        if alive is not None and target not in alive:
            continue
        try:
            os.killpg(target, sig)
        except OSError as exc:
            if exc.errno == errno.ESRCH:
                continue
            if exc.errno == errno.EPERM:
                try:
                    if not rows_for_groups([target]):
                        continue
                except Exception:
                    pass
            # Continue through the complete observed set so one stale or
            # inaccessible group cannot suppress signaling a later child group.
            uncertain = True
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


def cleanup_group(proc, pgid, tree_path, reason, observed_pgids, guard_token=None, pipe_handles=None, discovery_state=None):
    """Terminate observed groups; discovery failure still escalates to unconditional KILL."""
    target_pgids = refresh_guarded_groups(
        pgid, observed_pgids, guard_token, scan_token=True,
        pipe_handles=pipe_handles, scan_pipes=True, discovery_state=discovery_state,
    )
    write_group_rows(tree_path, pgid, target_pgids, reason + "-before-term", discovery_state)
    uncertain = False
    term_signaled = set()
    deadline = time.monotonic() + 5.0
    while True:
        target_pgids = refresh_guarded_groups(
            pgid, observed_pgids, guard_token, scan_token=True,
            pipe_handles=pipe_handles, scan_pipes=True, discovery_state=discovery_state,
        )
        new_targets = [item for item in target_pgids if item not in term_signaled]
        if new_targets:
            signal_uncertain = signal_groups(new_targets, signal.SIGTERM)
            uncertain = uncertain or signal_uncertain
            term_signaled.update(new_targets)
        rows, unknown = group_rows_state(target_pgids)
        uncertain = uncertain or unknown
        if not unknown and not rows:
            return {"clean": True, "uncertain": uncertain, "residual_pgids": []}
        if time.monotonic() >= deadline:
            break
        time.sleep(0.1)

    target_pgids = refresh_guarded_groups(
        pgid, observed_pgids, guard_token, scan_token=True,
        pipe_handles=pipe_handles, scan_pipes=True, discovery_state=discovery_state,
    )
    write_group_rows(tree_path, pgid, target_pgids, reason + "-before-kill", discovery_state)
    kill_signaled = set()
    deadline = time.monotonic() + 2.0
    while True:
        target_pgids = refresh_guarded_groups(
            pgid, observed_pgids, guard_token, scan_token=True,
            pipe_handles=pipe_handles, scan_pipes=True, discovery_state=discovery_state,
        )
        new_targets = [item for item in target_pgids if item not in kill_signaled]
        if new_targets:
            # signal_groups deliberately sends to every observed PGID when ps is
            # unavailable, so a discovery outage cannot suppress SIGKILL.
            signal_uncertain = signal_groups(new_targets, signal.SIGKILL)
            uncertain = uncertain or signal_uncertain
            kill_signaled.update(new_targets)
        rows, unknown = group_rows_state(target_pgids)
        uncertain = uncertain or unknown
        if not unknown and not rows:
            return {"clean": True, "uncertain": uncertain, "residual_pgids": []}
        if time.monotonic() >= deadline:
            break
        time.sleep(0.1)
    rows, unknown = group_rows_state(target_pgids)
    uncertain = uncertain or unknown
    write_group_rows(tree_path, pgid, target_pgids, reason + "-residual", discovery_state)
    return {
        "clean": not unknown and not rows,
        "uncertain": uncertain,
        "residual_pgids": list(target_pgids) if unknown or rows else [],
    }

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
    last_group_sample = started
    group_sample_interval = 0.02
    diagnosed = False
    progress_sig = file_signature(args.progress_file)
    proc = None
    pgid = None
    out_files = {}
    termination_signal = None
    status = None
    interrupted = {"signal": None}
    guard_token = uuid.uuid4().hex
    observed_pgids = set()
    cleanup_performed = False
    cleanup_uncertain = False
    discovery_state = {"uncertain": False}
    residual_pgids = []
    pipe_handles = set()

    def on_signal(signum, _frame):
        interrupted["signal"] = signum

    old_int = signal.signal(signal.SIGINT, on_signal)
    old_term = signal.signal(signal.SIGTERM, on_signal)
    try:
        child_env = os.environ.copy()
        child_env["SHK_GUARD_TOKEN"] = guard_token
        proc = subprocess.Popen(
            args.command,
            cwd=root,
            env=child_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            preexec_fn=os.setsid,
        )
        pgid = os.getpgid(proc.pid)
        pipe_handles = guarded_pipe_handles(proc)
        refresh_guarded_groups(pgid, observed_pgids, guard_token, discovery_state=discovery_state)
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
            if now - last_group_sample >= group_sample_interval:
                refresh_guarded_groups(pgid, observed_pgids, guard_token, discovery_state=discovery_state)
                last_group_sample = now
            if interrupted["signal"] is not None:
                termination_signal = signal.Signals(interrupted["signal"]).name
                status = "INTERRUPTED"
                cleanup = cleanup_group(proc, pgid, tree_path, "interrupted", observed_pgids, guard_token, pipe_handles, discovery_state)
                cleanup_performed = True
                cleanup_uncertain = cleanup["uncertain"] or discovery_state["uncertain"]
                residual_pgids = cleanup["residual_pgids"]
                if not cleanup["clean"]:
                    status = "INTERNAL_ERROR"
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
                write_group_rows(tree_path, pgid, refresh_guarded_groups(pgid, observed_pgids, guard_token, discovery_state=discovery_state), "diagnose-after", discovery_state)
                diagnosed = True
                print("[GUARD][DIAGNOSE] name=%s elapsed=%.1fs last_progress_age=%.1fs" % (args.name, elapsed, progress_age), flush=True)

            if elapsed >= args.hard_timeout:
                status = "HARD_TIMEOUT"
                termination_signal = "SIGTERM/SIGKILL"
                cleanup = cleanup_group(proc, pgid, tree_path, "hard-timeout", observed_pgids, guard_token, pipe_handles, discovery_state)
                cleanup_performed = True
                cleanup_uncertain = cleanup["uncertain"]
                residual_pgids = cleanup["residual_pgids"]
                if not cleanup["clean"]:
                    status = "INTERNAL_ERROR"
                break
            if progress_age >= args.idle_timeout:
                status = "IDLE_TIMEOUT"
                termination_signal = "SIGTERM/SIGKILL"
                cleanup = cleanup_group(proc, pgid, tree_path, "idle-timeout", observed_pgids, guard_token, pipe_handles, discovery_state)
                cleanup_performed = True
                cleanup_uncertain = cleanup["uncertain"]
                residual_pgids = cleanup["residual_pgids"]
                if not cleanup["clean"]:
                    status = "INTERNAL_ERROR"
                break

            if now - last_heartbeat >= args.heartbeat:
                print("[GUARD][HEARTBEAT] name=%s elapsed=%.1fs last_progress_age=%.1fs" % (args.name, elapsed, progress_age), flush=True)
                last_heartbeat = now

            events = sel.select(timeout=min(group_sample_interval, max(0.005, args.hard_timeout - elapsed)))
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
                    refresh_guarded_groups(pgid, observed_pgids, guard_token, discovery_state=discovery_state)
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

        # A successful direct child is not permission to leave daemons behind. Before
        # reporting any terminal status, reclaim every still-live observed/token group.
        if not cleanup_performed:
            targets = refresh_guarded_groups(pgid, observed_pgids, guard_token, scan_token=True, pipe_handles=pipe_handles, scan_pipes=True, discovery_state=discovery_state)
            rows, discovery_uncertain = group_rows_state(targets)
            if rows or discovery_uncertain:
                cleanup = cleanup_group(proc, pgid, tree_path, "terminal-%s" % status.lower(), observed_pgids, guard_token, pipe_handles, discovery_state)
                cleanup_performed = True
                cleanup_uncertain = discovery_uncertain or cleanup["uncertain"]
                residual_pgids = cleanup["residual_pgids"]
                if termination_signal is None:
                    termination_signal = "SIGTERM/SIGKILL(residual-descendants)"
                if not cleanup["clean"]:
                    status = "INTERNAL_ERROR"

        # C-GATE-30: any cleanup/discovery uncertainty is terminal. A later clean
        # sample cannot prove no descendant escaped during the observation gap.
        cleanup_uncertain = cleanup_uncertain or discovery_state["uncertain"]
        if cleanup_uncertain:
            status = "INTERNAL_ERROR"

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
            "cleanup_uncertain": cleanup_uncertain,
            "residual_pgids": residual_pgids,
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
                cleanup = cleanup_group(
                    proc, pgid, tree_path, "internal-error", observed_pgids, guard_token, pipe_handles, discovery_state
                )
                cleanup_uncertain = cleanup["uncertain"]
                residual_pgids = cleanup["residual_pgids"]
            except Exception:
                cleanup_uncertain = True
                residual_pgids = sorted(observed_pgids)
        for fh in out_files.values():
            try:
                fh.close()
            except Exception:
                pass
        ended_wall = iso_now()
        elapsed_ms = int(round((time.monotonic() - started) * 1000))
        payload = {
            "schema_version": 1, "name": args.name, "command": args.command,
            "started_at": started_wall, "ended_at": ended_wall,
            "elapsed_ms": elapsed_ms, "budget_ms": int(args.budget * 1000),
            "diagnose_after_ms": int(args.diagnose_after * 1000),
            "idle_timeout_ms": int(args.idle_timeout * 1000),
            "hard_timeout_ms": int(args.hard_timeout * 1000),
            "last_progress_at": last_progress_wall, "status": "INTERNAL_ERROR",
            "runner_exit_code": EXIT["INTERNAL_ERROR"],
            "child_exit_code": proc.poll() if proc is not None else None,
            "termination_signal": "SIGTERM/SIGKILL" if proc is not None else None,
            "cleanup_uncertain": cleanup_uncertain,
            "residual_pgids": residual_pgids,
            "incident_dir": incident_dir, "error": str(exc),
        }
        try:
            atomic_json(result_path, payload)
            atomic_json(runtime_path, {
                "schema_version": 1, "task": args.name, "step": args.name,
                "status": "INTERNAL_ERROR", "pid": proc.pid if proc is not None else None,
                "command": args.command, "started_at": started_wall,
                "last_progress_at": last_progress_wall, "ended_at": ended_wall,
                "completed_steps": [], "evidence": [result_path], "retry_count": 0,
                "error": str(exc),
            })
        except Exception:
            pass
        print("[GUARD][INTERNAL_ERROR] %s evidence=%s" % (exc, incident_dir), file=sys.stderr)
        return EXIT["INTERNAL_ERROR"]
    finally:
        signal.signal(signal.SIGINT, old_int)
        signal.signal(signal.SIGTERM, old_term)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

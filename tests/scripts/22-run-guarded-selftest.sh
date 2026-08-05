#!/usr/bin/env bash
set -u
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
RUNNER="$ROOT/scripts/run-guarded.sh"
TMP="$(mktemp -d /tmp/run-guarded-selftest.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
pass=0
fail=0

record() {
  if [ "$1" -eq 0 ]; then
    pass=$((pass + 1)); echo "[PASS] $2"
  else
    fail=$((fail + 1)); echo "[FAIL] $2"; [ -n "${3:-}" ] && printf '%s\n' "$3" | sed 's/^/    /'
  fi
}

run_case() {
  name="$1"; expected_rc="$2"; expected_status="$3"; shift 3
  out="$TMP/$name.out"
  set +e
  "$RUNNER" --name "selftest-$name" "$@" >"$out" 2>&1
  rc=$?
  set -e
  evidence="$(sed -n 's/.* evidence=//p' "$out" | tail -1)"
  actual_status=""
  if [ -n "$evidence" ] && [ -f "$evidence/result.json" ]; then
    actual_status="$(python3 - "$evidence/result.json" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))['status'])
PY
)"
  fi
  if [ "$rc" -eq "$expected_rc" ] && [ "$actual_status" = "$expected_status" ]; then
    record 0 "$name"
  else
    record 1 "$name expected rc=$expected_rc/status=$expected_status got rc=$rc/status=$actual_status" "$(cat "$out")"
  fi
}

set -e
run_case immediate-success 0 PASS --budget 1 --diagnose-after .5 --idle-timeout 1 --hard-timeout 2 --heartbeat .2 -- sh -c 'echo ok'
run_case immediate-failure 1 FAILED --budget 1 --diagnose-after .5 --idle-timeout 1 --hard-timeout 2 --heartbeat .2 -- sh -c 'echo failed >&2; exit 7'
run_case silent-idle 124 IDLE_TIMEOUT --budget 1 --diagnose-after .2 --idle-timeout .45 --hard-timeout 1.2 --heartbeat .15 -- sh -c 'sleep 5'
run_case output-hard 125 HARD_TIMEOUT --budget 1 --diagnose-after .4 --idle-timeout .6 --hard-timeout .65 --heartbeat .15 -- sh -c 'while :; do echo tick; sleep .08; done'
run_case budget-exceeded 3 BUDGET_EXCEEDED --budget .15 --diagnose-after .5 --idle-timeout 1 --hard-timeout 1.5 --heartbeat .2 -- sh -c 'sleep .3; echo done'

child_pid_file="$TMP/child.pid"
run_case descendant-cleanup 124 IDLE_TIMEOUT --budget 1 --diagnose-after .2 --idle-timeout .45 --hard-timeout 1.2 --heartbeat .15 -- sh -c 'sleep 30 & echo $! > "$1"; wait' sh "$child_pid_file"
if [ -s "$child_pid_file" ] && ! kill -0 "$(cat "$child_pid_file")" 2>/dev/null; then
  record 0 "descendant process removed"
else
  record 1 "descendant process removed" "pid=$(cat "$child_pid_file" 2>/dev/null || echo missing) still alive"
fi

# A descendant can create a new session/process group. The guard must still show
# it in diagnostics and terminate it on timeout instead of leaking an orphan.
setsid_pid_file="$TMP/setsid-child.pid"
run_case setsid-descendant-cleanup 124 IDLE_TIMEOUT --budget 1 --diagnose-after .2 --idle-timeout .45 --hard-timeout 1.2 --heartbeat .15 \
  -- python3 -c 'import os,subprocess,sys,time
p=subprocess.Popen([sys.executable,"-c","import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"],preexec_fn=os.setsid)
open(sys.argv[1],"w").write(str(p.pid))
time.sleep(30)' "$setsid_pid_file"
setsid_child_pid="$(cat "$setsid_pid_file" 2>/dev/null || true)"
case "$setsid_child_pid" in
  ''|*[!0-9]*) record 1 "setsid descendant removed" "fixture did not write a safe pid" ;;
  *)
    if kill -0 "$setsid_child_pid" 2>/dev/null; then
      record 1 "setsid descendant removed" "pid=$setsid_child_pid is still alive"
      kill -9 "$setsid_child_pid" 2>/dev/null || true
    else
      record 0 "setsid descendant removed"
    fi ;;
esac
setsid_tree="$(sed -n 's/.* evidence=//p' "$TMP/setsid-descendant-cleanup.out" | tail -1)/process-tree.txt"
if case "$setsid_child_pid" in ''|*[!0-9]*) false;; *) true;; esac \
   && [ -f "$setsid_tree" ] \
   && awk -v want="$setsid_child_pid" '$1 == want { found = 1 } END { exit found ? 0 : 1 }' "$setsid_tree"; then
  record 0 "process tree includes setsid descendant"
else
  record 1 "process tree includes setsid descendant" "pid=${setsid_child_pid:-missing}; tree=$setsid_tree"
fi

# The direct child may exit before teardown while its setsid descendant keeps the
# output pipes open. Persistent observations plus the per-run marker must still
# find and kill that now-orphaned process group.
orphan_pid_file="$TMP/setsid-orphan.pid"
run_case setsid-orphan-cleanup 124 IDLE_TIMEOUT --budget 1 --diagnose-after .2 --idle-timeout .45 --hard-timeout 1.2 --heartbeat .1 \
  -- python3 -c 'import os,subprocess,sys
p=subprocess.Popen([sys.executable,"-c","import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"],preexec_fn=os.setsid)
open(sys.argv[1],"w").write(str(p.pid))' "$orphan_pid_file"
orphan_pid="$(cat "$orphan_pid_file" 2>/dev/null || true)"
case "$orphan_pid" in
  ''|*[!0-9]*) record 1 "setsid orphan removed after parent exit" "fixture did not write a safe pid" ;;
  *)
    if kill -0 "$orphan_pid" 2>/dev/null; then
      record 1 "setsid orphan removed after parent exit" "pid=$orphan_pid is still alive"
      kill -9 "$orphan_pid" 2>/dev/null || true
    else
      record 0 "setsid orphan removed after parent exit"
    fi ;;
esac

# Fault-inject an exception after the guarded command starts. The INTERNAL_ERROR
# path must still terminate both the root process group and a detached setsid child.
internal_parent_pid_file="$TMP/internal-parent.pid"
internal_child_pid_file="$TMP/internal-child.pid"
internal_out="$TMP/internal-error.out"
set +e
python3 - "$ROOT/scripts/lib/run_guarded.py" "$internal_parent_pid_file" "$internal_child_pid_file" >"$internal_out" 2>&1 <<'PY'
import importlib.util
import os
import sys
import time

sys.dont_write_bytecode = True

runner_path, parent_pid_file, child_pid_file = sys.argv[1:]
spec = importlib.util.spec_from_file_location("shk_run_guarded_fault_test", runner_path)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
real_selector = runner.selectors.DefaultSelector

class ExplodingSelector:
    def __init__(self):
        self.inner = real_selector()
        self.exploded = False

    def register(self, *args, **kwargs):
        return self.inner.register(*args, **kwargs)

    def unregister(self, *args, **kwargs):
        return self.inner.unregister(*args, **kwargs)

    def select(self, timeout=None):
        if not self.exploded:
            self.exploded = True
            time.sleep(0.4)
            raise RuntimeError("injected selector failure")
        return self.inner.select(timeout)

runner.selectors.DefaultSelector = ExplodingSelector
child = (
    'import os,subprocess,sys,time; '
    'open(sys.argv[1],"w").write(str(os.getpid())); '
    'p=subprocess.Popen([sys.executable,"-c",'
    '"import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"],'
    'preexec_fn=os.setsid); '
    'open(sys.argv[2],"w").write(str(p.pid)); '
    'time.sleep(30)'
)
raise SystemExit(runner.main([
    "--name", "selftest-internal-error", "--budget", "2",
    "--diagnose-after", "1", "--idle-timeout", "2", "--hard-timeout", "3",
    "--heartbeat", ".2", "--", sys.executable, "-c", child,
    parent_pid_file, child_pid_file,
]))
PY
internal_rc=$?
set -e
if [ "$internal_rc" -eq 2 ] && grep -q '^\[GUARD\]\[INTERNAL_ERROR\] injected selector failure' "$internal_out"; then
  record 0 "internal-error returns controlled failure"
else
  record 1 "internal-error returns controlled failure" "rc=$internal_rc $(cat "$internal_out")"
fi
for label_and_file in "root process:$internal_parent_pid_file" "setsid descendant:$internal_child_pid_file"; do
  label=${label_and_file%%:*}
  pid_file=${label_and_file#*:}
  pid=$(cat "$pid_file" 2>/dev/null || true)
  attempts=0
  case "$pid" in
    ''|*[!0-9]*) record 1 "internal-error removes $label" "fixture did not write a safe pid" ;;
    *)
      while kill -0 "$pid" 2>/dev/null && [ "$attempts" -lt 20 ]; do
        attempts=$((attempts + 1))
        sleep .1
      done
      if kill -0 "$pid" 2>/dev/null; then
        record 1 "internal-error removes $label" "pid=$pid is still alive"
        kill -9 "$pid" 2>/dev/null || true
      else
        record 0 "internal-error removes $label"
      fi ;;
  esac
done
internal_evidence="$(sed -n 's/.* evidence=//p' "$internal_out" | tail -1)"
internal_status="$(python3 - "$internal_evidence/result.json" <<'PY2'
import json,sys
try:
    print(json.load(open(sys.argv[1]))['status'])
except Exception:
    print('MISSING')
PY2
)"
runtime_status="$(python3 - "$ROOT/.harness/task-runtime.json" <<'PY2'
import json,sys
try:
    print(json.load(open(sys.argv[1]))['status'])
except Exception:
    print('MISSING')
PY2
)"
if [ "$internal_status" = INTERNAL_ERROR ]; then
  record 0 "internal-error writes terminal result evidence"
else
  record 1 "internal-error writes terminal result evidence" "status=$internal_status evidence=$internal_evidence"
fi
if [ "$runtime_status" = INTERNAL_ERROR ]; then
  record 0 "internal-error replaces RUNNING runtime state"
else
  record 1 "internal-error replaces RUNNING runtime state" "status=$runtime_status"
fi

# Once a detached descendant has been observed, a persistent process-discovery
# outage must not suppress SIGKILL. Cleanup remains fail-closed because liveness
# cannot be confirmed even after all observed process groups are signaled.
ps_fault_parent_pid_file="$TMP/ps-fault-parent.pid"
ps_fault_child_pid_file="$TMP/ps-fault-child.pid"
ps_fault_out="$TMP/ps-fault.out"
set +e
python3 - "$ROOT/scripts/lib/run_guarded.py" "$ps_fault_parent_pid_file" "$ps_fault_child_pid_file" >"$ps_fault_out" 2>&1 <<'PYPS'
import importlib.util
import os
import sys

sys.dont_write_bytecode = True

runner_path, parent_pid_file, child_pid_file = sys.argv[1:]
spec = importlib.util.spec_from_file_location("shk_run_guarded_ps_fault_test", runner_path)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
real_ps_snapshot = runner._ps_snapshot
state = {"armed": False}

def persistent_ps_failure(include_env=False):
    if state["armed"]:
        raise RuntimeError("injected persistent ps failure")
    rows = real_ps_snapshot(include_env)
    try:
        child_pid = int(open(child_pid_file).read().strip())
    except Exception:
        return rows
    if any(pid == child_pid for pid, _ppid, _pgid, _stat, _line in rows):
        state["armed"] = True
    return rows

runner._ps_snapshot = persistent_ps_failure
child = (
    'import os,subprocess,sys,time; '
    'open(sys.argv[1],"w").write(str(os.getpid())); '
    'p=subprocess.Popen([sys.executable,"-c",'
    '"import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"],'
    'preexec_fn=os.setsid); '
    'open(sys.argv[2],"w").write(str(p.pid)); '
    'time.sleep(30)'
)
raise SystemExit(runner.main([
    "--name", "selftest-persistent-ps-failure", "--budget", "2",
    "--diagnose-after", ".3", "--idle-timeout", ".8", "--hard-timeout", "1.2",
    "--heartbeat", ".2", "--", sys.executable, "-c", child,
    parent_pid_file, child_pid_file,
]))
PYPS
ps_fault_rc=$?
set -e
ps_fault_evidence="$(sed -n 's/.* evidence=//p' "$ps_fault_out" | tail -1)"
read -r ps_fault_status ps_fault_uncertain ps_fault_has_child <<EOF
$(python3 - "$ps_fault_evidence/result.json" "$ps_fault_child_pid_file" <<'PYPS2'
import json, sys
try:
    result = json.load(open(sys.argv[1]))
    child = int(open(sys.argv[2]).read().strip())
    residual = [int(item) for item in result.get("residual_pgids", [])]
    print(result.get("status", "MISSING"), str(bool(result.get("cleanup_uncertain"))).lower(), str(child in residual).lower())
except Exception:
    print("MISSING false false")
PYPS2
)
EOF
if [ "$ps_fault_rc" -eq 2 ] && [ "$ps_fault_status" = INTERNAL_ERROR ] && [ "$ps_fault_uncertain" = true ]; then
  record 0 "persistent discovery failure is terminal and uncertain"
else
  record 1 "persistent discovery failure is terminal and uncertain" "rc=$ps_fault_rc status=$ps_fault_status uncertain=$ps_fault_uncertain $(cat "$ps_fault_out")"
fi
if [ "$ps_fault_has_child" = true ]; then
  record 0 "persistent discovery failure records observed detached group"
else
  record 1 "persistent discovery failure records observed detached group" "evidence=$ps_fault_evidence child=$(cat "$ps_fault_child_pid_file" 2>/dev/null || echo missing)"
fi
for label_and_file in "root process:$ps_fault_parent_pid_file" "setsid descendant:$ps_fault_child_pid_file"; do
  label=${label_and_file%%:*}
  pid_file=${label_and_file#*:}
  pid=$(cat "$pid_file" 2>/dev/null || true)
  attempts=0
  case "$pid" in
    ''|*[!0-9]*) record 1 "persistent discovery failure removes $label" "fixture did not write a safe pid" ;;
    *)
      while kill -0 "$pid" 2>/dev/null && [ "$attempts" -lt 20 ]; do
        attempts=$((attempts + 1))
        sleep .1
      done
      if kill -0 "$pid" 2>/dev/null; then
        record 1 "persistent discovery failure removes $label" "pid=$pid is still alive"
        kill -9 "$pid" 2>/dev/null || true
      else
        record 0 "persistent discovery failure removes $label"
      fi ;;
  esac
done

# A parent that exits 0 after spawning a detached child with closed stdio must not
# turn into a false PASS that leaves the child behind.
pass_detached_pid_file="$TMP/pass-detached.pid"
pass_detached_out="$TMP/pass-detached.out"
set +e
"$RUNNER" --name selftest-pass-detached --budget 7 --diagnose-after 2 --idle-timeout 7 --hard-timeout 8 --heartbeat .2 -- \
  python3 -c 'import os,subprocess,sys; p=subprocess.Popen([sys.executable,"-c","import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"],preexec_fn=os.setsid,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); open(sys.argv[1],"w").write(str(p.pid))' \
  "$pass_detached_pid_file" >"$pass_detached_out" 2>&1
pass_detached_rc=$?
set -e
pass_detached_pid=$(cat "$pass_detached_pid_file" 2>/dev/null || true)
if [ "$pass_detached_rc" -eq 0 ]; then
  record 0 "PASS terminal remains successful after descendant cleanup"
else
  record 1 "PASS terminal remains successful after descendant cleanup" "rc=$pass_detached_rc $(cat "$pass_detached_out")"
fi
case "$pass_detached_pid" in
  ''|*[!0-9]*) record 1 "PASS terminal removes detached descendant" "fixture did not write a safe pid" ;;
  *)
    attempts=0
    while kill -0 "$pass_detached_pid" 2>/dev/null && [ "$attempts" -lt 20 ]; do attempts=$((attempts + 1)); sleep .1; done
    if kill -0 "$pass_detached_pid" 2>/dev/null; then
      record 1 "PASS terminal removes detached descendant" "pid=$pass_detached_pid is still alive"
      kill -9 "$pass_detached_pid" 2>/dev/null || true
    else
      record 0 "PASS terminal removes detached descendant"
    fi ;;
esac

# Exercise the narrow daemonization race: the setsid child clears the marker and
# its parent exits before the historical 250ms ancestry sample.
cleared_pid_file="$TMP/cleared-token.pid"
cleared_out="$TMP/cleared-token.out"
set +e
"$RUNNER" --name selftest-cleared-token --budget 1 --diagnose-after .3 --idle-timeout .8 --hard-timeout 1.2 --heartbeat .2 -- \
  python3 -c 'import os,subprocess,sys,time; time.sleep(.05); env=dict(os.environ); env.pop("SHK_GUARD_TOKEN",None); p=subprocess.Popen([sys.executable,"-c","import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"],preexec_fn=os.setsid,env=env); open(sys.argv[1],"w").write(str(p.pid))' \
  "$cleared_pid_file" >"$cleared_out" 2>&1
cleared_rc=$?
set -e
cleared_pid=$(cat "$cleared_pid_file" 2>/dev/null || true)
if [ "$cleared_rc" -eq 124 ]; then
  record 0 "cleared-token orphan reaches controlled timeout"
else
  record 1 "cleared-token orphan reaches controlled timeout" "rc=$cleared_rc $(cat "$cleared_out")"
fi
case "$cleared_pid" in
  ''|*[!0-9]*) record 1 "cleared-token orphan is sampled and removed" "fixture did not write a safe pid" ;;
  *)
    attempts=0
    while kill -0 "$cleared_pid" 2>/dev/null && [ "$attempts" -lt 20 ]; do attempts=$((attempts + 1)); sleep .1; done
    if kill -0 "$cleared_pid" 2>/dev/null; then
      record 1 "cleared-token orphan is sampled and removed" "pid=$cleared_pid is still alive"
      kill -9 "$cleared_pid" 2>/dev/null || true
    else
      record 0 "cleared-token orphan is sampled and removed"
    fi ;;
esac

# TERM the runner itself; it must translate to INTERRUPTED/130 and clean its group.
interrupt_out="$TMP/interrupted.out"
"$RUNNER" --name selftest-interrupted --budget 2 --diagnose-after 1 --idle-timeout 2 --hard-timeout 3 --heartbeat .2 -- sh -c 'sleep 30' >"$interrupt_out" 2>&1 &
guard_pid=$!
i=0
while ! grep -q '^\[GUARD\]' "$interrupt_out" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -ge 30 ] && break
  sleep .1
done
kill -TERM "$guard_pid"
set +e
wait "$guard_pid"
interrupt_rc=$?
set -e
interrupt_evidence="$(sed -n 's/.* evidence=//p' "$interrupt_out" | tail -1)"
interrupt_status="$(python3 - "$interrupt_evidence/result.json" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))['status'])
PY
)"
if [ "$interrupt_rc" -eq 130 ] && [ "$interrupt_status" = INTERRUPTED ]; then
  record 0 "runner TERM becomes INTERRUPTED"
else
  record 1 "runner TERM becomes INTERRUPTED" "rc=$interrupt_rc status=$interrupt_status $(cat "$interrupt_out")"
fi

# A transient terminal discovery failure that later recovers clean must still
# produce a non-PASS result: the observation gap cannot be retroactively proven safe.
transient_out="$TMP/transient-discovery.out"
set +e
python3 - "$ROOT/scripts/lib/run_guarded.py" >"$transient_out" 2>&1 <<'PYTRANSIENT'
import importlib.util
import sys
sys.dont_write_bytecode = True
runner_path = sys.argv[1]
spec = importlib.util.spec_from_file_location("shk_run_guarded_transient_test", runner_path)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
real_group_rows_state = runner.group_rows_state
state = {"first": True}
def transient_group_rows_state(pgids):
    if state["first"]:
        state["first"] = False
        return [], True
    return real_group_rows_state(pgids)
runner.group_rows_state = transient_group_rows_state
raise SystemExit(runner.main([
    "--name", "selftest-transient-discovery", "--budget", "2",
    "--diagnose-after", "1", "--idle-timeout", "2", "--hard-timeout", "3",
    "--heartbeat", ".2", "--", sys.executable, "-c", "print('done')",
]))
PYTRANSIENT
transient_rc=$?
set -e
transient_evidence="$(sed -n 's/.* evidence=//p' "$transient_out" | tail -1)"
read -r transient_status transient_uncertain transient_completed <<EOF
$(python3 - "$transient_evidence/result.json" "$ROOT/.harness/task-runtime.json" <<'PYTRANSIENT2'
import json, sys
try:
    result = json.load(open(sys.argv[1]))
    runtime = json.load(open(sys.argv[2]))
    print(result.get("status", "MISSING"), str(bool(result.get("cleanup_uncertain"))).lower(), len(runtime.get("completed_steps", [])))
except Exception:
    print("MISSING false -1")
PYTRANSIENT2
)
EOF
if [ "$transient_rc" -eq 2 ] && [ "$transient_status" = INTERNAL_ERROR ] && [ "$transient_uncertain" = true ] && [ "$transient_completed" -eq 0 ]; then
  record 0 "transient discovery uncertainty cannot become PASS"
else
  record 1 "transient discovery uncertainty cannot become PASS" "rc=$transient_rc status=$transient_status uncertain=$transient_uncertain completed=$transient_completed $(cat "$transient_out")"
fi

# A periodic ancestry refresh can fail once and recover before terminal cleanup.
# The observation gap must remain sticky and downgrade an otherwise successful child.
refresh_out="$TMP/transient-refresh.out"
set +e
python3 - "$ROOT/scripts/lib/run_guarded.py" >"$refresh_out" 2>&1 <<'PYREFRESH'
import importlib.util
import sys
sys.dont_write_bytecode = True
runner_path = sys.argv[1]
spec = importlib.util.spec_from_file_location("shk_run_guarded_refresh_test", runner_path)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
real_snapshot = runner._ps_snapshot
state = {"calls": 0, "injected": False}
def transient_snapshot(*args, **kwargs):
    state["calls"] += 1
    if state["calls"] == 2:
        state["injected"] = True
        raise RuntimeError("injected periodic discovery failure")
    return real_snapshot(*args, **kwargs)
runner._ps_snapshot = transient_snapshot
rc = runner.main([
    "--name", "selftest-transient-refresh", "--budget", "2",
    "--diagnose-after", "1", "--idle-timeout", "2", "--hard-timeout", "3",
    "--heartbeat", ".2", "--", sys.executable, "-c", "import time; time.sleep(.12)",
])
print("TRANSIENT_REFRESH_INJECTED=%s" % str(state["injected"]).lower(), file=sys.stderr)
raise SystemExit(rc)
PYREFRESH
refresh_rc=$?
set -e
refresh_evidence="$(sed -n 's/.* evidence=//p' "$refresh_out" | tail -1)"
read -r refresh_status refresh_uncertain refresh_completed <<EOF
$(python3 - "$refresh_evidence/result.json" "$ROOT/.harness/task-runtime.json" <<'PYREFRESH2'
import json, sys
try:
    result = json.load(open(sys.argv[1]))
    runtime = json.load(open(sys.argv[2]))
    print(result.get("status", "MISSING"), str(bool(result.get("cleanup_uncertain"))).lower(), len(runtime.get("completed_steps", [])))
except Exception:
    print("MISSING false -1")
PYREFRESH2
)
EOF
if [ "$refresh_rc" -eq 2 ] && [ "$refresh_status" = INTERNAL_ERROR ] && [ "$refresh_uncertain" = true ] && [ "$refresh_completed" -eq 0 ] && grep -q 'TRANSIENT_REFRESH_INJECTED=true' "$refresh_out"; then
  record 0 "periodic discovery uncertainty cannot become PASS"
else
  record 1 "periodic discovery uncertainty cannot become PASS" "rc=$refresh_rc status=$refresh_status uncertain=$refresh_uncertain completed=$refresh_completed $(cat "$refresh_out")"
fi

run_case diagnose-recovers 0 PASS --budget 1.5 --diagnose-after .2 --idle-timeout .75 --hard-timeout 1.5 --heartbeat .15 -- sh -c 'sleep .35; echo recovered; sleep .2; echo done'

echo "----"
echo "run-guarded selftest: $pass passed, $fail failed"
[ "$fail" -eq 0 ]

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

run_case diagnose-recovers 0 PASS --budget 1.5 --diagnose-after .2 --idle-timeout .75 --hard-timeout 1.5 --heartbeat .15 -- sh -c 'sleep .35; echo recovered; sleep .2; echo done'

echo "----"
echo "run-guarded selftest: $pass passed, $fail failed"
[ "$fail" -eq 0 ]

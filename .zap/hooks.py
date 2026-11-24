"""Hooks for zap-api-scan.py in dast.yml (loaded with --hook).

- Authentication: the scanner logs in as the seeded member and sends the
  access token through a Replacer rule restricted to the API. A thread logs in
  again every ten minutes, before the token expires (15 minutes), so a scan of
  any length stays authenticated. A failed first login fails the scan: an
  unauthenticated scan would only see 401s.
- Policy: DAST_POLICY is a policy file (pull requests) or "all" (the full
  scan, every installed rule).
- Coverage: before ZAP shuts down, record what every rule did, the status
  code of every active scan response and the renewals, for the job summary and
  for scripts/zap-coverage.ts, which fails the job unless every rule
  completed. Recording errors are logged and never fail the scan on their own.

zap-api-scan.py does not catch exceptions raised by hooks.

Environment: DAST_API (base URL), DAST_EMAIL, DAST_PASSWORD, DAST_POLICY.
"""

import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.request
from collections import Counter

SUMMARY = "/zap/wrk/active-scan.md"
DETAILS = "/zap/wrk/active-scan.json"
BATCH = 500
RENEW_EVERY_SECONDS = 600
LOGIN_ATTEMPTS = 6

_state = {"renewals": 0, "renewal_failures": 0}
_stop = threading.Event()


def _login():
    """A fresh access token for the seeded member, waiting out 429s."""
    api = os.environ["DAST_API"]
    body = json.dumps(
        {"email": os.environ["DAST_EMAIL"], "password": os.environ["DAST_PASSWORD"]}
    ).encode()
    for attempt in range(LOGIN_ATTEMPTS):
        request = urllib.request.Request(
            f"{api}/v1/auth/login",
            data=body,
            headers={"content-type": "application/json", "accept": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.load(response)["accessToken"]
        except urllib.error.HTTPError as error:
            if error.code != 429 or attempt == LOGIN_ATTEMPTS - 1:
                raise
            time.sleep(min(int(error.headers.get("retry-after", "10")), 60))
    raise RuntimeError("unreachable")


def _authorize(zap, token, generation):
    """Send the token on every request to the API, then drop the previous rule."""
    url = "^" + re.escape(os.environ["DAST_API"]) + "/.*"
    zap.replacer.add_rule(
        description=f"dast-auth-{generation}",
        enabled="true",
        matchtype="REQ_HEADER",
        matchregex="false",
        matchstring="Authorization",
        replacement=f"Bearer {token}",
        url=url,
    )
    if generation > 0:
        zap.replacer.remove_rule(description=f"dast-auth-{generation - 1}")


def _renew(zap):
    generation = 0
    while not _stop.wait(RENEW_EVERY_SECONDS):
        try:
            generation += 1
            _authorize(zap, _login(), generation)
            _state["renewals"] += 1
        except Exception:  # the next attempt may succeed before the token expires
            generation -= 1
            _state["renewal_failures"] += 1
            logging.exception("Could not renew the access token")


def _use_policy(zap):
    policy = os.environ.get("DAST_POLICY", "all")
    if policy == "all":
        name = "Default Policy"
        zap.ascan.enable_all_scanners(scanpolicyname=name)
    else:
        zap.ascan.import_scan_policy(path=policy)
        name = re.search(r"<policy>(.+?)</policy>", open(policy, encoding="utf-8").read())[1]
    enabled = [s for s in zap.ascan.scanners(scanpolicyname=name) if s["enabled"] == "true"]
    _state.update(policy=name, expected=sorted(s["id"] for s in enabled))


def zap_started(zap, target):
    _authorize(zap, _login(), 0)
    threading.Thread(target=_renew, args=(zap,), daemon=True).start()
    _use_policy(zap)


def zap_active_scan(zap, target, policy):
    _state["started"] = time.monotonic()
    return zap, target, _state.get("policy", policy)


def zap_active_scan_wrap(_return_data):
    _state["seconds"] = round(time.monotonic() - _state.get("started", time.monotonic()))


def zap_pre_shutdown(zap):
    _stop.set()
    try:
        _record(zap)
    except Exception:  # coverage reporting must never fail the scan
        logging.exception("Could not record the active scan coverage")


def _rules(zap, scans):
    """One [name, id, quality, status, ms, requests, alerts] list per rule."""
    rules = []
    for scan in scans:
        # [host, {"HostProcess": [{"Plugin": [...]}, ...]}, host, ...]
        for host in zap.ascan.scan_progress(scan["id"])[1::2]:
            rules.extend(entry["Plugin"] for entry in host.get("HostProcess", []))
    return rules


def _status_codes(zap, scans):
    """Status code of every response the active scan received ("none": no response)."""
    codes = Counter()
    for scan in scans:
        ids = zap.ascan.messages_ids(scan["id"])
        for start in range(0, len(ids), BATCH):
            for message in zap.core.messages_by_id(",".join(ids[start : start + BATCH])):
                status_line = message.get("responseHeader", "").split(" ", 2)
                codes[status_line[1] if len(status_line) > 1 else "none"] += 1
    return dict(sorted(codes.items()))


def _record(zap):
    scans = zap.ascan.scans
    rules = _rules(zap, scans)
    codes = _status_codes(zap, scans)
    details = {key: value for key, value in _state.items() if key != "started"}
    with open(DETAILS, "w", encoding="utf-8") as out:
        json.dump({**details, "scans": scans, "codes": codes, "rules": rules}, out, indent=2)

    complete = [r for r in rules if r[3] == "Complete"]
    unfinished = [r for r in rules if r[3] != "Complete"]
    missing = sorted(set(_state.get("expected", [])) - {r[1] for r in rules})
    requests = sum(int(r[5]) for r in rules)
    verdict = "complete" if not unfinished and not missing else "incomplete"

    lines = [
        "### Active scan coverage",
        "",
        f"The active scan is **{verdict}**: {len(complete)} of {len(rules)} rules"
        f" complete, {len(unfinished)} not complete, {len(missing)} expected but"
        f" not run, {requests} requests in {_state.get('seconds', '?')} s"
        f" (policy {_state.get('policy', '?')}, token renewals"
        f" {_state['renewals']}, failed {_state['renewal_failures']}).",
        "",
        "Responses by status: "
        + ", ".join(f"{code}: {count}" for code, count in codes.items())
        + ".",
        "",
        "| Rule | Id | Status | Seconds | Requests | Alerts |",
        "| ---- | -- | ------ | ------: | -------: | -----: |",
    ]
    for name, rule_id, _quality, status, ms, reqs, alerts in rules:
        lines.append(
            f"| {name} | {rule_id} | {status} | {int(ms) / 1000:.0f} | {reqs} | {alerts} |"
        )
    with open(SUMMARY, "w", encoding="utf-8") as out:
        out.write("\n".join(lines) + "\n")
    print(lines[2])
    print(lines[4])

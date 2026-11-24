"""Hooks for zap-api-scan.py in dast.yml (loaded with --hook).

The active scan is time-boxed by scanner.maxScanDurationInMins. Before ZAP
shuts down, record what every active scan rule did within that budget and
which status codes the API answered, so a scan cut short, or one that spent
its budget on 401 and 429 responses, shows in the job summary instead of
passing as if complete. Errors are logged and never fail the scan:
zap-api-scan.py does not catch exceptions raised by hooks.
"""

import json
import logging
import time
from collections import Counter

SUMMARY = "/zap/wrk/active-scan.md"
DETAILS = "/zap/wrk/active-scan.json"
BATCH = 500

_scan = {}


def zap_active_scan(zap, target, policy):
    _scan.update(policy=policy, started=time.monotonic())


def zap_active_scan_wrap(_return_data):
    _scan["seconds"] = round(time.monotonic() - _scan.get("started", time.monotonic()))


def zap_pre_shutdown(zap):
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
    with open(DETAILS, "w", encoding="utf-8") as out:
        json.dump({**_scan, "scans": scans, "codes": codes, "rules": rules}, out, indent=2)

    complete = [r for r in rules if r[3] == "Complete"]
    skipped = [r for r in rules if r[3].startswith("Skipped")]
    unfinished = [r for r in rules if r not in complete and r not in skipped]
    requests = sum(int(r[5]) for r in rules)
    verdict = "finished" if not unfinished else "cut short by its time budget"

    lines = [
        "### Active scan coverage",
        "",
        f"The active scan is **{verdict}**: {len(complete)} of {len(rules)} rules"
        f" complete, {len(skipped)} skipped, {len(unfinished)} not finished,"
        f" {requests} requests in {_scan.get('seconds', '?')} s"
        f" (policy {_scan.get('policy', '?')}).",
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

"""Hooks for zap-api-scan.py in dast.yml (loaded with --hook).

The active scan is time-boxed by scanner.maxScanDurationInMins. Before ZAP
shuts down, record what every active scan rule did within that budget, so a
scan cut short shows in the job summary instead of passing as if complete.
Errors are logged and never fail the scan: zap-api-scan.py does not catch
exceptions raised by hooks.
"""

import json
import logging

SUMMARY = "/zap/wrk/active-scan.md"
DETAILS = "/zap/wrk/active-scan.json"


def zap_pre_shutdown(zap):
    try:
        _record(zap)
    except Exception:  # coverage reporting must never fail the scan
        logging.exception("Could not record the active scan coverage")


def _rules(zap):
    """One [name, id, quality, status, ms, requests, alerts] list per rule."""
    rules = []
    for scan in zap.ascan.scans:
        # [host, {"HostProcess": [{"Plugin": [...]}, ...]}, host, ...]
        for host in zap.ascan.scan_progress(scan["id"])[1::2]:
            rules.extend(entry["Plugin"] for entry in host.get("HostProcess", []))
    return rules


def _record(zap):
    rules = _rules(zap)
    with open(DETAILS, "w", encoding="utf-8") as out:
        json.dump({"scans": zap.ascan.scans, "rules": rules}, out, indent=2)

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
        f" {requests} requests.",
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

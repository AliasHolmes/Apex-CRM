"""Focused reliability + TPS diagnostic: captures HTTP status and error bodies.

The concurrency sweep in tps_bench.py showed an inverted failure pattern (worse at
concurrency 1-2 than at 4-8), which is not how a rate limit behaves. This isolates the
cause by recording the status code and response body of every attempt.
"""

import json
import os
import statistics
import subprocess
import sys
import time

URL = "https://api.atria-asi.ai/v1/chat/completions"
KEY = os.environ.get("ATRIA_API_KEY", "")
MODEL = os.environ.get("ATRIA_MODEL", "Atria-Dawn-Preview")
PIN_IP = os.environ.get("ATRIA_PIN_IP", "47.236.72.31")

if not KEY:
    sys.exit("ATRIA_API_KEY is not set.")

PROMPT = (
    "Write a detailed technical explanation of how B-tree indexes work, covering "
    "node splitting, fanout, and why they favour disk access patterns. Be thorough."
)


def once(max_tokens: int):
    payload = json.dumps(
        {
            "model": MODEL,
            "messages": [{"role": "user", "content": PROMPT}],
            "max_tokens": max_tokens,
            "temperature": 0,
        }
    )
    cmd = [
        "curl", "-s", "-w", "\n%{http_code}", "--noproxy", "*",
        "--resolve", f"api.atria-asi.ai:443:{PIN_IP}",
        "-X", "POST", URL,
        "-H", f"Authorization: Bearer {KEY}",
        "-H", "Content-Type: application/json",
        "-d", payload,
        "--max-time", "300",
    ]
    t0 = time.time()
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=320)
    dt = time.time() - t0
    body, _, status = out.stdout.rpartition("\n")
    status = status.strip()
    ctok = 0
    finish = None
    if status == "200":
        try:
            d = json.loads(body)
            u = d.get("usage") or {}
            ctok = u.get("completion_tokens") or 0
            finish = (d.get("choices") or [{}])[0].get("finish_reason")
        except json.JSONDecodeError:
            status = "200-unparseable"
    return {"status": status, "dt": dt, "ctok": ctok, "finish": finish, "body": body[:180]}


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 12
    max_tokens = int(sys.argv[2]) if len(sys.argv) > 2 else 900
    print(f"{n} sequential requests, concurrency 1, max_tokens={max_tokens}\n")
    rows = []
    for i in range(n):
        r = once(max_tokens)
        rows.append(r)
        tps = r["ctok"] / r["dt"] if r["dt"] > 0 else 0
        print(
            f"  #{i+1:02d} status={r['status']:<4} {r['dt']:6.2f}s  "
            f"ctok={r['ctok']:<5} tps={tps:6.1f}  finish={r['finish']}"
            + ("" if r["status"] == "200" else f"  body={r['body']}")
        )

    print()
    ok = [r for r in rows if r["status"] == "200" and r["ctok"]]
    bad = [r for r in rows if r not in ok]
    print(f"success: {len(ok)}/{n}   failures: {len(bad)}/{n}")
    if bad:
        codes: dict[str, int] = {}
        for r in bad:
            codes[r["status"]] = codes.get(r["status"], 0) + 1
        print(f"failure status codes: {codes}")
        print("sample failure bodies:")
        seen = set()
        for r in bad:
            key = r["body"][:60]
            if key in seen:
                continue
            seen.add(key)
            print(f"  [{r['status']}] {r['body']}")
    if ok:
        tps = [r["ctok"] / r["dt"] for r in ok]
        print(f"\nTPS on successful runs: median {statistics.median(tps):.1f} "
              f"(min {min(tps):.1f}, max {max(tps):.1f})")
        print(f"wall: median {statistics.median([r['dt'] for r in ok]):.2f}s")
        # Retry behaviour: if failures cluster early, it is not a rate limit.
        print(f"failure positions: {[i+1 for i, r in enumerate(rows) if r not in ok]}")

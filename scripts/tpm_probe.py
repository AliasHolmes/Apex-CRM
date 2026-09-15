"""Empirically probe the TPM (tokens-per-minute) limit of an OpenAI-compatible endpoint.

There are no rate-limit headers and no /limits endpoint on this gateway, so the
only way to find the ceiling is to push traffic and watch for 429s.
"""

import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

URL = "https://api.atria-asi.ai/v1/chat/completions"
KEY = os.environ.get("ATRIA_API_KEY", "")
MODEL = os.environ.get("ATRIA_MODEL", "Atria-Dawn-Preview")
PIN_IP = os.environ.get("ATRIA_PIN_IP", "47.236.72.31")

if not KEY:
    sys.exit(
        "ATRIA_API_KEY is not set.\n"
        "Export it first, e.g.  ATRIA_API_KEY=atr_... python scripts/tpm_probe.py large\n"
        "The key is deliberately not stored in this file."
    )


def call(max_tokens: int, prompt: str = "hi"):
    """Fire one request, return (status, completion_tokens, elapsed, body_head)."""
    payload = json.dumps(
        {
            "model": MODEL,
            "messages": [{"role": "user", "content": prompt}],
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
        "--max-time", "120",
    ]
    t0 = time.time()
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=140)
    except subprocess.TimeoutExpired:
        return (0, 0, time.time() - t0, "client timeout")
    dt = time.time() - t0
    raw = out.stdout
    body, _, status = raw.rpartition("\n")
    status = status.strip()
    try:
        code = int(status)
    except ValueError:
        code = 0
    ctok = 0
    head = body[:200]
    if code == 200:
        try:
            d = json.loads(body)
            ctok = d.get("usage", {}).get("completion_tokens", 0) or 0
        except json.JSONDecodeError:
            head = "unparseable: " + head
    return (code, ctok, dt, head)


def burst(label: str, n: int, max_tokens: int, workers: int, prompt: str = "hi"):
    print(f"\n{'='*66}\n{label}: {n} requests x max_tokens={max_tokens}, concurrency={workers}\n{'='*66}")
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        results = list(ex.map(lambda _: call(max_tokens, prompt), range(n)))
    wall = time.time() - t0

    codes: dict[int, int] = {}
    for c, _, _, _ in results:
        codes[c] = codes.get(c, 0) + 1
    total_ctok = sum(r[1] for r in results)
    lat = sorted(r[2] for r in results)

    print(f"wall time      : {wall:.1f}s")
    print(f"status codes   : {dict(sorted(codes.items()))}")
    print(f"completion toks: {total_ctok}")
    print(f"throughput     : {total_ctok / (wall/60):.0f} output tok/min "
          f"({total_ctok/wall:.1f} tok/s)")
    print(f"latency p50/p95: {lat[len(lat)//2]:.2f}s / {lat[int(len(lat)*0.95)-1]:.2f}s")
    for c, _, _, head in results:
        if c != 200:
            print(f"  non-200 sample [{c}]: {head[:180]}")
            break
    return codes, total_ctok, wall


if __name__ == "__main__":
    stage = sys.argv[1] if len(sys.argv) > 1 else "small"
    if stage == "small":
        burst("STAGE 1 - small burst", 60, 1, 10)
    elif stage == "medium":
        burst("STAGE 2 - medium burst", 40, 100, 10,
              "Write a short paragraph about distributed systems.")
    elif stage == "large":
        burst("STAGE 3 - heavy burst", 24, 600, 12,
              "Write a detailed technical essay about database indexing.")
    elif stage == "max":
        burst("STAGE 5 - decisive high volume", 50, 1500, 20,
              "Write a detailed technical essay about database indexing strategies.")
    elif stage == "serial":
        # Realistic regime for Apex CRM: withSequentialLLMExecution serializes all calls.
        burst("STAGE 6 - serial (concurrency=1), app-like payload", 5, 2000, 1,
              "Extract structured prospect data and return a JSON object.")
    elif stage == "sustained":
        # ~40 requests of ~250 tokens each, spread over ~60s -> probes TPM ceiling
        print(f"\n{'='*66}\nSTAGE 4 - sustained load over 60s\n{'='*66}")
        t0 = time.time()
        results = []
        with ThreadPoolExecutor(max_workers=4) as ex:
            futs = []
            for i in range(40):
                futs.append(ex.submit(call, 250, "Explain consensus algorithms briefly."))
                time.sleep(1.2)
            results = [f.result() for f in futs]
        wall = time.time() - t0
        codes: dict[int, int] = {}
        for c, _, _, _ in results:
            codes[c] = codes.get(c, 0) + 1
        total = sum(r[1] for r in results)
        print(f"wall time      : {wall:.1f}s")
        print(f"status codes   : {dict(sorted(codes.items()))}")
        print(f"completion toks: {total}")
        print(f"throughput     : {total/(wall/60):.0f} output tok/min")
        for c, _, _, head in results:
            if c != 200:
                print(f"  non-200 sample [{c}]: {head[:200]}")
                break

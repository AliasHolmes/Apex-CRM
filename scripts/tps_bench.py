"""Measure TPS (tokens per second) of an OpenAI-compatible endpoint.

TPM answers "how much can I push before throttling"; TPS answers "how fast does it
generate". They are independent, and TPS is the one that decides whether a model can
serve as a serialized pipeline's primary provider.

Measures, in order:
  1. Streaming, concurrency 1  -> TTFT, steady-state TPS, end-to-end TPS
  2. Non-streaming, concurrency 1 -> end-to-end TPS over repeated runs
  3. Concurrency sweep -> aggregate TPS scaling (does throughput actually rise?)

Usage is taken from the API's own `usage` block, not from counting SSE deltas, so the
token counts are exact even though the timing comes from delta arrival.

Set ATRIA_API_KEY before running. The key is deliberately not stored here.
"""

import json
import os
import statistics
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

URL = "https://api.atria-asi.ai/v1/chat/completions"
KEY = os.environ.get("ATRIA_API_KEY", "")
MODEL = os.environ.get("ATRIA_MODEL", "Atria-Dawn-Preview")
PIN_IP = os.environ.get("ATRIA_PIN_IP", "47.236.72.31")

if not KEY:
    sys.exit("ATRIA_API_KEY is not set. Export it first; it is not stored in this file.")

BASE_CMD = [
    "curl", "-s", "--noproxy", "*",
    "--resolve", f"api.atria-asi.ai:443:{PIN_IP}",
    "-X", "POST", URL,
    "-H", f"Authorization: Bearer {KEY}",
    "-H", "Content-Type: application/json",
]

LONG_PROMPT = (
    "Write a detailed technical explanation of how B-tree indexes work, covering "
    "node splitting, fanout, and why they favour disk access patterns. Be thorough."
)


def _payload(max_tokens: int, stream: bool, prompt: str) -> str:
    body = {
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0,
    }
    if stream:
        body["stream"] = True
        body["stream_options"] = {"include_usage": True}
    return json.dumps(body)


def stream_once(max_tokens: int, prompt: str = LONG_PROMPT):
    """One streaming call. Returns timing + exact token counts."""
    cmd = BASE_CMD + ["-N", "-d", _payload(max_tokens, True, prompt), "--max-time", "300"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
    t0 = time.time()
    ttft = None
    delta_times: list[float] = []
    content_chars = 0
    reasoning_chars = 0
    usage = None
    for line in proc.stdout:
        line = line.strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            obj = json.loads(data)
        except json.JSONDecodeError:
            continue
        if obj.get("usage"):
            usage = obj["usage"]
        for ch in obj.get("choices") or []:
            d = ch.get("delta") or {}
            txt = d.get("content") or ""
            rc = d.get("reasoning_content") or ""
            if txt or rc:
                now = time.time()
                if ttft is None:
                    ttft = now - t0
                delta_times.append(now)
            content_chars += len(txt)
            reasoning_chars += len(rc)
    proc.wait()
    total = time.time() - t0

    ctok = (usage or {}).get("completion_tokens") or 0
    rtok = ((usage or {}).get("completion_tokens_details") or {}).get("reasoning_tokens")
    gen_window = (delta_times[-1] - delta_times[0]) if len(delta_times) > 1 else 0.0
    steady = (ctok - 1) / gen_window if gen_window > 0 and ctok > 1 else None
    return {
        "ttft": ttft,
        "total": total,
        "ctok": ctok,
        "rtok": rtok,
        "ptok": (usage or {}).get("prompt_tokens") or 0,
        "steady_tps": steady,
        "e2e_tps": ctok / total if total > 0 else 0.0,
        "reasoning_chars": reasoning_chars,
        "content_chars": content_chars,
    }


def nonstream_once(max_tokens: int, prompt: str = LONG_PROMPT):
    cmd = BASE_CMD + ["-d", _payload(max_tokens, False, prompt), "--max-time", "300"]
    t0 = time.time()
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=320)
    dt = time.time() - t0
    try:
        d = json.loads(out.stdout)
    except json.JSONDecodeError:
        return {"error": out.stdout[:200], "total": dt}
    u = d.get("usage") or {}
    ctok = u.get("completion_tokens") or 0
    return {
        "total": dt,
        "ctok": ctok,
        "ptok": u.get("prompt_tokens") or 0,
        "e2e_tps": ctok / dt if dt > 0 else 0.0,
        "finish": (d.get("choices") or [{}])[0].get("finish_reason"),
    }


def summarize(label: str, rows: list[dict]):
    print(f"\n{'='*70}\n{label}\n{'='*70}")
    ok = [r for r in rows if r.get("ctok")]
    if not ok:
        print("  no successful rows")
        return
    ctoks = [r["ctok"] for r in ok]
    totals = [r["total"] for r in ok]
    e2e = [r["e2e_tps"] for r in ok]
    print(f"  runs             : {len(ok)}/{len(rows)}")
    print(f"  completion tokens: min {min(ctoks)} / median {int(statistics.median(ctoks))} / max {max(ctoks)}")
    print(f"  wall per request : median {statistics.median(totals):.2f}s")
    print(f"  end-to-end TPS   : median {statistics.median(e2e):.1f} tok/s  (min {min(e2e):.1f}, max {max(e2e):.1f})")
    steady = [r["steady_tps"] for r in ok if r.get("steady_tps")]
    if steady:
        print(f"  steady-state TPS : median {statistics.median(steady):.1f} tok/s  (min {min(steady):.1f}, max {max(steady):.1f})")
    ttfts = [r["ttft"] for r in ok if r.get("ttft")]
    if ttfts:
        print(f"  TTFT             : median {statistics.median(ttfts):.2f}s  (min {min(ttfts):.2f}, max {max(ttfts):.2f})")
    agg = sum(ctoks) / sum(totals)
    print(f"  aggregate TPS    : {agg:.1f} tok/s across all runs in the batch")
    rt = [r["rtok"] for r in ok if r.get("rtok") is not None]
    if rt:
        med_rt = int(statistics.median(rt))
        med_ct = int(statistics.median(ctoks))
        share = (med_rt / med_ct * 100) if med_ct else 0
        print(f"  reasoning tokens : median {med_rt} of {med_ct} completion tokens ({share:.0f}% reasoning)")
        print(f"  visible content  : ~{med_ct - med_rt} tokens")
    rc = [r.get("reasoning_chars", 0) for r in ok]
    cc = [r.get("content_chars", 0) for r in ok]
    if any(rc) or any(cc):
        print(f"  chars            : reasoning {int(statistics.median(rc))} / content {int(statistics.median(cc))}")


def sweep(label: str, n: int, max_tokens: int, workers: int):
    print(f"\n{'='*70}\n{label}: {n} requests x max_tokens={max_tokens}, concurrency={workers}\n{'='*70}")
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        rows = list(ex.map(lambda _: nonstream_once(max_tokens), range(n)))
    wall = time.time() - t0
    ok = [r for r in rows if r.get("ctok")]
    if not ok:
        print("  all failed:", rows[0].get("error", "")[:160] if rows else "")
        return
    ctoks = [r["ctok"] for r in ok]
    print(f"  wall time        : {wall:.1f}s")
    print(f"  ok               : {len(ok)}/{n}")
    print(f"  completion tokens: {sum(ctoks)}")
    print(f"  aggregate TPS    : {sum(ctoks)/wall:.1f} tok/s")
    per_stream = [r["e2e_tps"] for r in ok]
    print(f"  per-stream TPS   : median {statistics.median(per_stream):.1f} tok/s")
    finishes = {}
    for r in ok:
        finishes[r.get("finish")] = finishes.get(r.get("finish"), 0) + 1
    print(f"  finish_reason    : {finishes}")


def effort_once(max_tokens: int, effort: str | None, prompt: str = LONG_PROMPT):
    """Non-streaming call, optionally sending reasoning_effort. Returns the token split."""
    body = {
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0,
    }
    if effort:
        body["reasoning_effort"] = effort
    cmd = BASE_CMD + ["-d", json.dumps(body), "--max-time", "300"]
    t0 = time.time()
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=320)
    dt = time.time() - t0
    try:
        d = json.loads(out.stdout)
    except json.JSONDecodeError:
        return {"err": out.stdout[:150], "dt": dt}
    if "error" in d:
        return {"err": json.dumps(d["error"])[:150], "dt": dt}
    u = d.get("usage") or {}
    ch = (d.get("choices") or [{}])[0]
    msg = ch.get("message") or {}
    return {
        "dt": dt,
        "ctok": u.get("completion_tokens") or 0,
        "rtok": ((u.get("completion_tokens_details") or {}).get("reasoning_tokens")),
        "reasoning_chars": len(msg.get("reasoning_content") or ""),
        "content_chars": len(msg.get("content") or ""),
        "finish": ch.get("finish_reason"),
    }


def stage_effort():
    """Does the endpoint honour reasoning_effort? The engine passes "low" for extraction
    but only when isReasoningCapable() is true, which it currently is NOT for Atria.

    Retries on the endpoint's intermittent 502s, otherwise a bad window makes the whole
    comparison inconclusive (all three configurations failing tells you nothing).
    """
    print("STAGE C - does the endpoint honour reasoning_effort?")
    print("(same prompt, max_tokens=900; reasoning chars vs visible content chars)")
    print("(retries up to 4x per configuration to survive the intermittent 502s)\n")
    for effort in (None, "low", "high"):
        label = f"reasoning_effort={effort or '(not sent)'}"
        r = None
        for attempt in range(4):
            r = effort_once(900, effort)
            if not r.get("err"):
                break
            time.sleep(1.5)
        if r is None or r.get("err"):
            print(f"  {label:<28} all attempts failed: {(r or {}).get('err', '?')}")
            continue
        print(
            f"  {label:<28} {r['dt']:6.2f}s  ctok={r['ctok']:<4} "
            f"reasoning_chars={r['reasoning_chars']:<6} content_chars={r['content_chars']:<5} "
            f"finish={r['finish']}"
        )


if __name__ == "__main__":
    stage = sys.argv[1] if len(sys.argv) > 1 else "all"

    if stage == "effort":
        stage_effort()
        sys.exit(0)

    if stage in ("all", "stream"):
        print("STAGE A - streaming, concurrency 1 (measures TTFT + steady-state TPS)")
        rows = [stream_once(900) for _ in range(5)]
        summarize("STREAMING (conc 1, max_tokens=900)", rows)

    if stage in ("all", "serial"):
        print("\n\nSTAGE B - non-streaming, concurrency 1")
        rows = [nonstream_once(900) for _ in range(5)]
        summarize("NON-STREAMING (conc 1, max_tokens=900)", rows)

    if stage in ("all", "sweep"):
        for workers in (1, 2, 4, 8):
            sweep(f"CONCURRENCY SWEEP c={workers}", max(workers * 3, 6), 900, workers)

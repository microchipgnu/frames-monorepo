#!/usr/bin/env python3
"""Assemble raw_results.json from per-call workspace files."""
import json
import os

WORKSPACE = os.path.dirname(os.path.abspath(__file__))
CALLS = os.path.join(WORKSPACE, "calls")

# Mapping of query id -> (tool, settled, paid_usd, rail, body_path or None, error or None)
PLAN = [
    ("q01", "exa_search", True, 0.01, {"chain": "solana-mainnet", "currency": "CASH"}, "q01.json", None),
    ("q02", "exa_search", True, 0.01, {"chain": "solana-mainnet", "currency": "CASH"}, "q02.json", None),
    ("q03", "exa_search", True, 0.01, {"chain": "solana-mainnet", "currency": "CASH"}, "q03.json", None),
    ("q04", "exa_search", False, 0.0, None, None, {
        "kind": "unknown",
        "message": "no rail succeeded across 5 payment options; agentwallet 500 on every rail (base/USDC, base/USDT, solana-mainnet/USDC, solana-mainnet/USDT, solana-mainnet/CASH). Inner payment claimed paid=true but seller upstream returned 500.",
        "retryable": False,
        "details_truncated": "[option 0 x402v2/base/USDC] agentwallet 500: paid=true; [option 1 x402v2/base/USDT] agentwallet 500: paid=true; [option 2 x402v2/solana-mainnet/USDC] agentwallet 500: paid=true; [option 3 x402v2/solana-mainnet/USDT] agentwallet 500: paid=true; [option 4 x402v2/solana-mainnet/CASH] agentwallet 500: paid=true"
    }),
    ("q05", "exa_search", True, 0.01, {"chain": "solana-mainnet", "currency": "CASH"}, "q05.json", None),
    ("q06", "exa_search", True, 0.01, {"chain": "solana-mainnet", "currency": "CASH"}, "q06.json", None),
    ("q07", "exa_search", True, 0.01, {"chain": "solana-mainnet", "currency": "CASH"}, "q07.json", None),
    ("q08", "exa_search", True, 0.01, {"chain": "solana-mainnet", "currency": "CASH"}, "q08.json", None),
    ("q09", "twitter_search", True, 0.01, {"chain": "solana-mainnet", "currency": "CASH"}, "q09.json", None),
    ("q10", "twitter_search", True, 0.01, {"chain": "solana-mainnet", "currency": "CASH"}, "q10.json", None),
    ("q11", "twitter_search", True, 0.01, {"chain": "solana-mainnet", "currency": "CASH"}, "q11.json", None),
    ("q12", "twitter_search", True, 0.01, {"chain": "solana-mainnet", "currency": "CASH"}, "q12.json", None),
]

raw_results = []
spent_usd = 0.0
for qid, tool, settled, paid_usd, rail, body_path, error in PLAN:
    entry = {
        "query_id": qid,
        "tool": tool,
        "settled": settled,
        "paid_usd": paid_usd,
    }
    if settled:
        with open(os.path.join(CALLS, body_path), "r") as f:
            entry["body"] = json.load(f)
        entry["rail"] = rail
        spent_usd += paid_usd
    else:
        entry["error"] = error
    raw_results.append(entry)

out = {
    "raw_results": raw_results,
    "spent_usd": round(spent_usd, 4),
    "budget_usd": 0.20,
    "queries_planned": len(PLAN),
    "queries_settled": sum(1 for r in raw_results if r["settled"]),
    "queries_failed": sum(1 for r in raw_results if not r["settled"]),
}
with open(os.path.join(WORKSPACE, "raw_results.json"), "w") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
print("wrote raw_results.json")
print("size:", os.path.getsize(os.path.join(WORKSPACE, "raw_results.json")))
print(f"settled: {out['queries_settled']}/{out['queries_planned']}, spent: ${out['spent_usd']:.2f}")

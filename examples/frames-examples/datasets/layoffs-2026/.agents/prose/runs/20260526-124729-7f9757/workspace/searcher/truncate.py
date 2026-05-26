#!/usr/bin/env python3
"""Truncate a raw pay_tool response into the compact shape required by the searcher.

Usage: truncate.py <raw_file> <tool_name> [--first-call]

Outputs a compact JSON body to stdout. If --first-call, preserves full structure.
"""
import json
import sys


def truncate_text(s, max_len):
    if not isinstance(s, str):
        return s
    if len(s) <= max_len:
        return s
    return s[:max_len] + "..."


def truncate_exa_body(raw, first_call=False):
    # raw should be either { body: {...} } or top-level body
    body = raw.get("body", raw) if isinstance(raw, dict) else raw
    if not isinstance(body, dict):
        return body
    out = {
        "success": body.get("success"),
        "requestId": body.get("requestId"),
        "resolvedSearchType": body.get("resolvedSearchType"),
        "results": [],
        "costDollars": body.get("costDollars"),
    }
    for r in body.get("results", []) or []:
        if not isinstance(r, dict):
            continue
        compact = {
            "id": r.get("id"),
            "url": r.get("url"),
            "title": r.get("title"),
            "publishedDate": r.get("publishedDate") or r.get("published_date"),
            "author": r.get("author"),
            "score": r.get("score"),
            "text": truncate_text(r.get("text"), 1500),
            "summary": r.get("summary"),
        }
        hl = r.get("highlights")
        if isinstance(hl, list):
            compact["highlights"] = [truncate_text(h, 400) for h in hl]
        out["results"].append(compact)
    return out


def truncate_twitter_body(raw, first_call=False):
    body = raw.get("body", raw) if isinstance(raw, dict) else raw
    if not isinstance(body, dict):
        return body
    # Twitter / X search payloads vary. Try to find the tweet list.
    tweets = (
        body.get("tweets")
        or body.get("data")
        or body.get("results")
        or body.get("statuses")
        or []
    )
    if isinstance(tweets, dict):
        # Sometimes nested under .data.tweets
        tweets = tweets.get("tweets") or tweets.get("data") or []
    out = {
        "success": body.get("success", True),
        "has_next_page": body.get("has_next_page"),
        "next_cursor": body.get("next_cursor"),
        "tweets": [],
    }
    if first_call:
        # Preserve the raw envelope keys (minus the tweets list) for schema inspection
        out["_envelope_keys"] = sorted(list(body.keys()))
    for t in tweets:
        if not isinstance(t, dict):
            continue
        author = t.get("author") or t.get("user") or {}
        if isinstance(author, dict):
            author_compact = {
                "username": author.get("userName")
                or author.get("username")
                or author.get("screen_name"),
                "name": author.get("name") or author.get("display_name"),
            }
        else:
            author_compact = author
        compact = {
            "id": t.get("id") or t.get("id_str") or t.get("tweet_id"),
            "url": t.get("url"),
            "text": truncate_text(t.get("text") or t.get("full_text"), 800),
            "created_at": t.get("createdAt") or t.get("created_at"),
            "author": author_compact,
            "retweet_count": t.get("retweetCount") or t.get("retweet_count"),
            "like_count": t.get("likeCount") or t.get("favorite_count") or t.get("like_count"),
            "reply_count": t.get("replyCount") or t.get("reply_count"),
            "quote_count": t.get("quoteCount") or t.get("quote_count"),
            "view_count": t.get("viewCount") or t.get("view_count"),
            "lang": t.get("lang"),
        }
        out["tweets"].append(compact)
    return out


def main():
    raw_path = sys.argv[1]
    tool = sys.argv[2]
    first_call = "--first-call" in sys.argv[3:]

    with open(raw_path, "r") as f:
        raw = json.load(f)

    if tool == "exa_search":
        compact = truncate_exa_body(raw, first_call=first_call)
    elif tool == "twitter_search":
        compact = truncate_twitter_body(raw, first_call=first_call)
    else:
        compact = raw

    json.dump(compact, sys.stdout, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()

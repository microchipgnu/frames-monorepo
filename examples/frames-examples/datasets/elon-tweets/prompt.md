# elon-tweets — daily tick

You are maintaining a tracker of recent posts from @elonmusk on X. Each
tweet becomes one entity, classified by topic. Schema and scope in
`datasets/elon-tweets/schema.yml` and `datasets/elon-tweets/README.md` —
read both first.

Tools wired in:
- `frame-elon-tweets` — write to the dataset
- Frames registry (Twitter service) — paid via x402 / agentwallet

## Loop

1. **Read state.** Use `frame-elon-tweets_query` mode=sql:
   `SELECT MAX(posted_at) AS last FROM rows`
   to find the newest stored `posted_at`. If empty, default to
   "7 days ago".

2. **Fetch new tweets.** Call the Twitter service through agentwallet's
   `x402/fetch`:
   - URL: `https://registry.frames.ag/api/service/twitter/api/search-tweets`
   - Method: POST
   - Body: `{"query": "from:elonmusk since:<YYYY-MM-DD>", "searchMode": "Latest"}`
   - Pay with `CASH` on `solana` (or default).

   Page through `next_cursor` until the response overlaps the stored set or
   no more results. Cap at **40 new tweets per run** to bound cost.

3. **Skip duplicates.** Before adding each tweet, query whether
   `tweet_id` already exists. If yes, skip.

4. **Classify and write.** For each new tweet, pick exactly one `topic`
   from the schema enum based on the text. Use these heuristics:
   - Tesla cars / production / FSD → `tesla`
   - Starship / Falcon / launches → `spacex`
   - Grok / xAI training / Colossus → `xai`
   - X (formerly Twitter) features, policy, takedowns → `x-platform`
   - General AI commentary → `ai`
   - Government / elections / policy → `politics`
   - DOGE department / federal spending → `doge`
   - Brain-computer interfaces → `neuralink`
   - Tunnels / Boring Co. → `boring-co`
   - Family, health, hobbies → `personal`
   - Image macros, jokes with no clear topic → `meme`
   - Short reply with no standalone substance → `reply`
   - Reacting to a news article → `news-commentary`
   - Earnings / SEC / corporate → `business`
   - Physics, astronomy, math → `science`
   - Anything else → `other`

   Then call `add_entity_with_facts`:
   - `entity_id`: the tweet's numeric id (slugify if needed)
   - `source.url`: the tweet permalink (`https://x.com/elonmusk/status/<id>`)
   - `source.retrieved_at`: now (ISO 8601)
   - `facts`: tweet_id, text, posted_at, url, topic,
     is_reply, is_retweet, like_count, retweet_count, reply_count,
     view_count

5. **Stop.** Print a summary: how many added, topic histogram, oldest +
   newest `posted_at`.

## Constraints

- Never invent engagement counts. If the API doesn't return a count, omit
  the field rather than write 0.
- `topic` must be exactly one enum value — do not invent new categories.
- For retweets/quote-tweets, store the visible text; mark `is_retweet=true`.
- Do not refresh engagement counts on existing entities.
- ≤ 40 entity additions per run.

## Done when

- The newest tweet from the API is already in the dataset (no overlap to
  scan further), OR the 40-tweet cap is hit.
- Summary printed.

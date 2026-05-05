# elon-tweets

Recent posts from [@elonmusk](https://x.com/elonmusk) on X, with each tweet
classified into a topic taxonomy. One entity per tweet; the dataset grows
forward in time.

## In scope

- Original posts and quote-tweets by @elonmusk.
- Replies he authored where the reply text stands on its own.
- Topic classification across: `tesla`, `spacex`, `xai`, `x-platform`, `ai`,
  `politics`, `doge`, `neuralink`, `boring-co`, `personal`, `meme`, `reply`,
  `news-commentary`, `business`, `science`, `other`.

## Out of scope

- Likes / bookmarks (no content payload).
- Tweets older than 30 days at first ingest (the catalog grows forward).
- Tweets from accounts other than @elonmusk.

## Refresh policy

Daily. Each tick fetches new tweets since the most recently stored
`posted_at` and stops when it overlaps with what's already in the dataset.
Engagement counts (`like_count`, etc.) are *not* refreshed — they're a
snapshot at ingestion time, not a moving target.

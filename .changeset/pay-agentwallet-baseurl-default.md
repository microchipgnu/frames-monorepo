---
"@frames-ag/pay": patch
---

fix(pay): agentwallet loader defaults `baseUrl` when missing from `~/.agentwallet/config.json`; detect surfaces the default instead of masking

`pay wallet init --auto` could leave the pay config in a broken state when the user's `~/.agentwallet/config.json` was written by an older onboarding that did not include the `baseUrl` field. The detector silently labelled the wallet `agentwallet @ frames.ag` (using `cfg.baseUrl ?? "frames.ag"` for display only), so the user saw a successful detection — but the loader strictly required `baseUrl` from the file and threw at first use:

```
pay: wallets.base (agentwallet): /Users/<user>/.agentwallet/config.json missing baseUrl
```

Two changes close the gap:

**`src/config.ts`** — `agentwallet` loader resolves `baseUrl` from, in order:

1. `base_url` set in the pay config stanza (override; allows self-hosted agentwallet)
2. `baseUrl` in `~/.agentwallet/config.json` (current onboarding writes this)
3. `AGENTWALLET_BASE_URL` env var
4. `https://frames.ag` (canonical hosted default — same string the detector already used for the display label)

`apiToken` and `username` checks remain strict; there is no sensible default for those.

**`src/cli/detect.ts`** — when `~/.agentwallet/config.json` lacks `baseUrl`, the detector now:

- labels the wallet `agentwallet @ https://frames.ag (defaulted)` so the user sees that a default was applied
- emits an explicit `base_url: https://frames.ag  # defaulted — <path> missing baseUrl` line in the generated yaml stanza
- includes `base_url` in the structured `entries[].config` so `pay wallet init --auto` writes the override into the pay config

No behavior change for users whose agentwallet config already includes `baseUrl`.

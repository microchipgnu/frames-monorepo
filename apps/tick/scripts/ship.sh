#!/usr/bin/env bash
#
# ship.sh — operator ship script for tick v0.0.5
#
# What it does (in order):
#   1. Verifies the working tree is clean and on `main`
#   2. Runs typecheck + tests + build to confirm pre-flight
#   3. Flips `"private": false` on @frames-ag/tick + @frames-ag/tick-types
#      so CI's release workflow can publish them to npm
#   4. Commits the flag flips
#   5. Rebases onto origin/main (fetches first; shows conflicts if any)
#   6. Pushes to origin/main → triggers Release workflow (npm) +
#      Deploy workflow (Cloudflare Workers) automatically
#   7. Provisions Cloudflare secrets for the deployed `tick` Worker:
#      audit signing key, allowlist, bearer-token API key for the first
#      alpha customer
#   8. Prints the bearer key + the diff to drop into the customer's
#      frames-examples workflow
#
# Inputs (env vars or prompted):
#   CF_CUSTOMER_NAME           — short slug for the alpha customer
#                                (default: "frames-examples")
#   CF_ANTHROPIC_API_KEY       — sk-ant-... (passthrough LLM auth; alt: BYOK)
#   CF_AI_GATEWAY_URL          — optional, BYOK mode
#   CF_AI_GATEWAY_BYOK_ALIAS   — optional, BYOK mode
#   SKIP_REBASE=1              — skip step 5 (already in sync)
#   DRY_RUN=1                  — print every command but don't execute
#
# Reentrancy: safe to re-run. Each step checks current state before acting.
#
# Run from monorepo root:
#   bash apps/tick/scripts/ship.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

readonly TICK_DIR="apps/tick"
readonly TYPES_DIR="packages/tick-types"
readonly REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

cd "$REPO_ROOT"

C_RESET='\033[0m'; C_BOLD='\033[1m'; C_GREEN='\033[32m'; C_YELLOW='\033[33m'
C_BLUE='\033[34m'; C_RED='\033[31m'; C_DIM='\033[2m'

step() {
  printf "\n${C_BOLD}${C_BLUE}» %s${C_RESET}\n" "$1"
}
ok() {
  printf "${C_GREEN}✓ %s${C_RESET}\n" "$1"
}
warn() {
  printf "${C_YELLOW}! %s${C_RESET}\n" "$1"
}
fail() {
  printf "${C_RED}✗ %s${C_RESET}\n" "$1" >&2
  exit 1
}
run() {
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    printf "${C_DIM}[dry-run] %s${C_RESET}\n" "$*"
  else
    eval "$@"
  fi
}

prompt_secret() {
  local var="$1" message="$2"
  if [[ -n "${!var:-}" ]]; then
    ok "$var already set in environment"
    return 0
  fi
  printf "${C_BOLD}? %s${C_RESET}\n" "$message"
  printf "  (input hidden; press Enter to skip): "
  read -r -s value
  printf "\n"
  if [[ -n "$value" ]]; then
    export "$var=$value"
    ok "$var captured"
  else
    warn "$var skipped"
  fi
}

confirm() {
  local message="$1"
  printf "${C_YELLOW}? %s [y/N] ${C_RESET}" "$message"
  read -r answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

# ---------------------------------------------------------------------------
# 1. Working tree + branch sanity
# ---------------------------------------------------------------------------

step "1. Pre-flight: working tree + branch"

current_branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$current_branch" != "main" ]]; then
  fail "Expected to be on 'main' branch; currently on '$current_branch'."
fi
ok "On 'main'"

if [[ -n "$(git status --short)" ]]; then
  fail "Working tree dirty. Commit or stash changes first."
fi
ok "Working tree clean"

# ---------------------------------------------------------------------------
# 2. Pre-flight: typecheck, tests, build
# ---------------------------------------------------------------------------

step "2. Pre-flight: typecheck + tests + build"

run "bun run --cwd $TICK_DIR typecheck"
ok "typecheck clean"
run "bun run --cwd $TICK_DIR test"
ok "tests passing"
run "bun run --cwd $TICK_DIR build"
ok "build produces dist/cli.js + dist/types/lib.d.ts"

# ---------------------------------------------------------------------------
# 3. Flip private flags so CI Release workflow can publish
# ---------------------------------------------------------------------------

step "3. Flip 'private: true' → 'private: false' on publishable packages"

flip_private() {
  local pkg_json="$1" name="$2"
  if grep -q '"private": true' "$pkg_json"; then
    if [[ "${DRY_RUN:-0}" == "1" ]]; then
      printf "${C_DIM}[dry-run] would flip $pkg_json${C_RESET}\n"
    else
      # macOS sed needs '' after -i
      if [[ "$(uname)" == "Darwin" ]]; then
        sed -i '' 's/"private": true/"private": false/' "$pkg_json"
      else
        sed -i 's/"private": true/"private": false/' "$pkg_json"
      fi
      ok "$name → public"
    fi
  else
    ok "$name already public (no change)"
  fi
}

flip_private "$TICK_DIR/package.json" "@frames-ag/tick"
flip_private "$TYPES_DIR/package.json" "@frames-ag/tick-types"

# ---------------------------------------------------------------------------
# 4. Commit the flag flips (idempotent — skip if nothing changed)
# ---------------------------------------------------------------------------

step "4. Commit the flag flips"

if [[ -n "$(git status --short)" ]]; then
  run "git add $TICK_DIR/package.json $TYPES_DIR/package.json"
  run "git commit -m \"chore(release): flip @frames-ag/tick + tick-types to public

Lets the Changesets release workflow auto-publish to npm on next push to main.
@frames-ag/tick v0.0.5; @frames-ag/tick-types v0.0.0 → first publish.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>\""
  ok "flag-flip commit landed"
else
  ok "No private-flag changes to commit"
fi

# ---------------------------------------------------------------------------
# 5. Rebase onto origin/main (idempotent — skip if up-to-date or SKIP_REBASE=1)
# ---------------------------------------------------------------------------

step "5. Rebase onto origin/main"

if [[ "${SKIP_REBASE:-0}" == "1" ]]; then
  warn "SKIP_REBASE=1 — skipping rebase. Make sure your branch is in sync."
else
  run "git fetch origin main"
  ahead=$(git rev-list --count origin/main..HEAD)
  behind=$(git rev-list --count HEAD..origin/main)
  printf "  Local is %d commits ahead, %d commits behind origin/main\n" "$ahead" "$behind"

  if [[ "$behind" -eq 0 ]]; then
    ok "Already up-to-date with origin/main"
  elif confirm "Rebase $ahead local commits onto $behind remote commits?"; then
    if [[ "${DRY_RUN:-0}" == "1" ]]; then
      printf "${C_DIM}[dry-run] git rebase origin/main${C_RESET}\n"
    else
      if ! git rebase origin/main; then
        fail "Rebase hit conflicts. Resolve them, then 'git rebase --continue' and re-run this script with SKIP_REBASE=1."
      fi
      ok "Rebase clean"
    fi
  else
    fail "Aborted by user (rebase declined). Re-run with SKIP_REBASE=1 once you've handled the divergence."
  fi
fi

# ---------------------------------------------------------------------------
# 6. Push to origin → triggers Release + Deploy workflows
# ---------------------------------------------------------------------------

step "6. Push to origin/main (triggers CI: npm publish + wrangler deploy)"

if confirm "Push to origin/main now?"; then
  run "git push origin main"
  ok "Pushed. Watch the Actions tab: https://github.com/$(git remote get-url origin | sed 's|.*github.com[:/]||; s|\\.git$||')/actions"
  printf "\n  Expected runs:\n"
  printf "    - Release workflow → publishes @frames-ag/tick v0.0.5 + tick-types v0.0.0 to npm\n"
  printf "    - Deploy workflow  → wrangler deploy for apps/tick (tick.frames.ag)\n\n"
else
  warn "Push skipped. When you're ready: git push origin main"
fi

# ---------------------------------------------------------------------------
# 7. Provision Cloudflare secrets for the deployed tick Worker
# ---------------------------------------------------------------------------

step "7. Cloudflare secrets for the tick Worker"

if ! command -v bunx >/dev/null 2>&1; then
  warn "bunx not found in PATH — skipping wrangler secret setup. Install bun + re-run."
elif ! confirm "Run 'wrangler secret put' commands now? (requires CF login in this shell)"; then
  warn "Skipped. See DEPLOY.md §1 for the secret list."
else
  # Generate keys
  AUDIT_KEY=$(openssl rand -hex 32)
  CUSTOMER_NAME="${CF_CUSTOMER_NAME:-frames-examples}"
  CUSTOMER_KEY=$(openssl rand -hex 32)
  CUSTOMER_AGENT="frames-runtime:${CUSTOMER_NAME}"

  # Prompt for LLM auth if not in env
  prompt_secret CF_ANTHROPIC_API_KEY "Anthropic API key (sk-ant-...) — leave blank if using BYOK"

  cd "$TICK_DIR"

  echo "$AUDIT_KEY" | run "bunx wrangler secret put AUDIT_PRIVATE_KEY"
  ok "AUDIT_PRIVATE_KEY set (ed25519, 32-byte hex)"

  echo "${CUSTOMER_KEY}:${CUSTOMER_AGENT}" | run "bunx wrangler secret put TICK_API_KEYS"
  ok "TICK_API_KEYS set (1 entry for $CUSTOMER_NAME)"

  echo "$CUSTOMER_AGENT" | run "bunx wrangler secret put TICK_ALLOWED_AGENTS"
  ok "TICK_ALLOWED_AGENTS set (allowlist: $CUSTOMER_AGENT)"

  if [[ -n "${CF_ANTHROPIC_API_KEY:-}" ]]; then
    echo "$CF_ANTHROPIC_API_KEY" | run "bunx wrangler secret put ANTHROPIC_API_KEY"
    ok "ANTHROPIC_API_KEY set (passthrough mode)"
  fi
  if [[ -n "${CF_AI_GATEWAY_URL:-}" ]]; then
    echo "$CF_AI_GATEWAY_URL" | run "bunx wrangler secret put AI_GATEWAY_URL"
    ok "AI_GATEWAY_URL set"
  fi
  if [[ -n "${CF_AI_GATEWAY_BYOK_ALIAS:-}" ]]; then
    echo "$CF_AI_GATEWAY_BYOK_ALIAS" | run "bunx wrangler secret put AI_GATEWAY_BYOK_ALIAS"
    ok "AI_GATEWAY_BYOK_ALIAS set (BYOK mode preferred)"
  fi

  cd "$REPO_ROOT"

  # ---------------------------------------------------------------------------
  # 8. Print follow-up instructions for the operator
  # ---------------------------------------------------------------------------

  printf "\n${C_BOLD}${C_GREEN}══ Tick is configured ══${C_RESET}\n\n"
  printf "${C_BOLD}Customer bearer key${C_RESET} (share with $CUSTOMER_NAME, add to their GitHub repo secrets as TICK_API_KEY):\n\n"
  printf "  ${C_BOLD}${CUSTOMER_KEY}${C_RESET}\n\n"
  printf "${C_DIM}This is the only time the key will be shown. Save it now.${C_RESET}\n\n"

  printf "${C_BOLD}Smoke check the deploy:${C_RESET}\n"
  printf "  curl https://tick.frames.ag/health | jq\n\n"
  printf "  Expect:\n"
  printf "    hosted.closed_by_default: false\n"
  printf "    hosted.api_key_count: 1\n"
  printf "    payments.audit_key_configured: true\n"
  printf "    llm.{ai_gateway,anthropic_passthrough}_configured: true (at least one)\n\n"

  printf "${C_BOLD}Next: push the frames-examples migration PR${C_RESET}\n"
  printf "  See apps/tick/drafts/frames-examples-migration-pr.md for the full body.\n"
  printf "  Repo: https://github.com/microchipgnu/frames-examples\n\n"
fi

step "Done."

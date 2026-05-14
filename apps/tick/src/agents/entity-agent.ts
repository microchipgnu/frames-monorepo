// EntityAgent — Durable Object hosting one bounded sub-loop per entity.
//
// Why a DO (Phase C):
//   Phase B introduced `refreshEntity()` as a pure-function sub-loop. That
//   gives us bounded context per entity, but every sub-loop runs sequentially
//   inside the parent's Worker invocation — and CF Workers cap CPU time at
//   30s for paid plans. A 13-entity frame doing serial sub-loops (each
//   maybe 10s) hits the wall.
//
// Durable Objects fix this:
//   - Each DO instance is a SEPARATE Worker isolate with its own 30s budget
//   - The parent can `Promise.all([refresh(A), refresh(B), refresh(C)...])`
//     and the sub-agents run truly concurrently in different isolates
//   - Naming by `${run_id}:${entity_id}` makes each call idempotent — retries
//     hit the same instance
//   - Future: persist iteration_log + partial state across CPU resets so a
//     sub-agent can survive a long Anthropic 529 retry without losing work
//
// Trade-offs (worth knowing):
//   - DO startup cost is ~1-3ms per cold instance. Negligible vs LLM latency.
//   - DOs have their own egress cost per call (~negligible).
//   - This adds wrangler.toml complexity (migration tag, new_sqlite_classes).
//
// The DO surfaces the same RefreshEntityResult as the function, so
// dispatchRefreshEntity in curate.ts swaps one for the other transparently
// — local Bun dev falls back to the direct function call (no DO binding).

// IMPORTANT: arktype-init must be imported BEFORE anything that pulls in
// @faremeter/* (which `pickWalletStack` transitively does). Each DO instance
// runs in its own isolate with its own module graph, so the worker.ts-level
// configure() call doesn't carry over — we have to set it here too.
import "../arktype-init";

import { DurableObject } from "cloudflare:workers";
import { CatalogClient } from "../catalog/client";
import type { Bindings } from "../env";
import { FrameClient } from "../frame-client";
import { LlmClient } from "../llm/client";
import { refreshEntity, type RefreshEntityResult } from "../ops/refresh-entity";
import { discoverEntity, type DiscoverEntityResult } from "../ops/discover-entity";
import { pickWalletStack } from "../wallet";

/** Serializable input to the DO. Excludes class instances (LlmClient / Refetcher
 *  are constructed inside the DO from env). */
export interface RefreshEntityRequest {
  entity_id: string;
  entity_state: Record<string, unknown>;
  /** Full FrameSchema — small JSON, serializes fine. */
  schema: Parameters<typeof refreshEntity>[0]["schema"];
  focus?: string[];
  budget?: string;
  max_iters?: number;
  run_id: string;
  agent: string;
}

export interface DiscoverEntityRequest {
  hypothesis: string;
  seed_urls?: string[];
  schema: Parameters<typeof discoverEntity>[0]["schema"];
  known_entity_ids: string[];
  fields_to_find?: string[];
  budget?: string;
  max_iters?: number;
  run_id: string;
  agent: string;
}

export class EntityAgent extends DurableObject<Bindings> {
  /**
   * Run one bounded refresh-entity sub-loop inside this DO's isolate.
   * Called via RPC from the parent Worker:
   *
   *   const stub = env.ENTITY_AGENT.get(env.ENTITY_AGENT.idFromName(name));
   *   const result = await stub.refresh(req);
   *
   * Idempotent within a single run by naming the DO `${run_id}:${entity_id}`.
   * Concurrent across entities — different names = different DO isolates =
   * separate CPU budgets.
   */
  async refresh(req: RefreshEntityRequest): Promise<RefreshEntityResult> {
    // Construct an LlmClient + paid wallet stack + CatalogClient INSIDE the
    // DO from its env. The parent's instances aren't serializable, but the
    // DO has the same env bindings and can build equivalent ones. Booting
    // the paid stack here means sub-agents can call paid catalog tools and
    // settle 402s — previously the DO used the FREE refetcher and had no
    // catalog client, so every paid path was inaccessible.
    const llm = new LlmClient({
      gatewayUrl: this.env.AI_GATEWAY_URL,
      gatewayToken: this.env.AI_GATEWAY_TOKEN,
      byokAlias: this.env.AI_GATEWAY_BYOK_ALIAS,
      anthropicApiKey: this.env.ANTHROPIC_API_KEY,
      gatewayMetadata: { runId: req.run_id, entity_id: req.entity_id, wallet: req.agent, source: "EntityAgent" },
      workersAiModel: this.env.WORKERS_AI_MODEL,
      aiGatewaySlug: this.env.AI_GATEWAY_SLUG,
    });

    // Boot the paid stack inside the DO. Each isolate has its own cache so
    // the boot runs at most once per isolate lifetime. Falls back to a free
    // refetcher when wallet secrets are missing (local dev).
    const { refetcher, paidFetch, walletCapability } = await pickWalletStack(this.env);

    // CatalogClient — uses the service binding when running on CF (avoids
    // Worker→Worker 404+1042 over public *.workers.dev URLs); falls back to
    // global fetch against CATALOG_BASE for local dev / external catalog.
    const catalog = new CatalogClient({
      base: this.env.CATALOG_BASE,
      fetch: this.env.CATALOG ? this.env.CATALOG.fetch.bind(this.env.CATALOG) : undefined,
    });

    // The DO doesn't need its own FrameClient (entity_state was already
    // loaded by the parent and passed in). Pure compute from here.
    void FrameClient;

    return await refreshEntity({
      entity_id: req.entity_id,
      entity_state: req.entity_state,
      schema: req.schema,
      focus: req.focus,
      llm,
      refetcher,
      paidFetch,
      walletCapability,
      catalog,
      env: this.env,
      budget: req.budget,
      max_iters: req.max_iters,
      run_id: req.run_id,
      agent: req.agent,
    });
  }

  /**
   * Run one bounded discover-entity sub-loop inside this DO's isolate.
   * Symmetric to `refresh` for dataset EXPAND mode. Keyed in curate.ts by
   * `${run_id}:discover:${hash(hypothesis)}` so concurrent discovery calls
   * for different hypotheses run in parallel isolates.
   */
  async discover(req: DiscoverEntityRequest): Promise<DiscoverEntityResult> {
    const llm = new LlmClient({
      gatewayUrl: this.env.AI_GATEWAY_URL,
      gatewayToken: this.env.AI_GATEWAY_TOKEN,
      byokAlias: this.env.AI_GATEWAY_BYOK_ALIAS,
      anthropicApiKey: this.env.ANTHROPIC_API_KEY,
      gatewayMetadata: { runId: req.run_id, wallet: req.agent, source: "EntityAgent/discover" },
      workersAiModel: this.env.WORKERS_AI_MODEL,
      aiGatewaySlug: this.env.AI_GATEWAY_SLUG,
    });

    const { refetcher, paidFetch, walletCapability } = await pickWalletStack(this.env);
    const catalog = new CatalogClient({
      base: this.env.CATALOG_BASE,
      fetch: this.env.CATALOG ? this.env.CATALOG.fetch.bind(this.env.CATALOG) : undefined,
    });
    void FrameClient;

    return await discoverEntity({
      hypothesis: req.hypothesis,
      seed_urls: req.seed_urls,
      schema: req.schema,
      known_entity_ids: req.known_entity_ids,
      fields_to_find: req.fields_to_find,
      llm,
      refetcher,
      paidFetch,
      walletCapability,
      catalog,
      env: this.env,
      budget: req.budget,
      max_iters: req.max_iters,
      run_id: req.run_id,
      agent: req.agent,
    });
  }
}

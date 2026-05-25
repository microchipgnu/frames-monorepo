// Mirrors pay/SPEC.md ToolDescriptor. SPEC is authoritative.

// Full signals — present on content/tools/<id>.json (full descriptors),
// merged from MerchantEntity at projection time.
export interface ToolSignals {
  host: string;
  is_active_14d: boolean;
  is_infra: boolean;
  is_recognized: boolean;
  is_mass_lister: boolean;
  category: string;
  network_count: number;
  network_names: string;
  listed_on_count: number;
  total_calls_30d: number;
  x402_volume_usd_30d: number;
  x_guidance: string | null;
  observed_at: string;
  quality: "curated" | "long-tail";
}

// Slim signals — what the list index (`content/index.ndjson`) carries on each
// entry. Strict subset of ToolSignals: only the fields the list-route filters
// (q, capability, rail, active, recognized, quality, includeInfra) actually
// touch. Agents who need richer signals fetch /merchants/<host>.
export interface SlimSignals {
  host: string;
  is_active_14d: boolean;
  is_infra: boolean;
  is_recognized: boolean;
  category: string;
  network_names: string;
  quality: "curated" | "long-tail";
}

// Alternate settlement options a seller advertises. Mirrors pay's
// PaymentOption (pay/SPEC.md v0.0.1). A descriptor may carry multiple rails
// here — typically the primary in `payment.{protocol,network,currency,...}`
// plus alternates here. Clients pick the first option they can settle.
export interface PaymentOption {
  protocol: string;
  network: string;
  currency?: string;
  asset?: string;
  amount?: string;
  price_hint?: string;
  pay_to?: string;
  [k: string]: unknown;
}

export interface ToolDescriptor {
  pay_protocol: string;
  id: string;
  title: string;
  description: string;
  capabilities: string[];
  invocation: {
    method: string;
    url: string;
    params_schema?: unknown;
  };
  payment: {
    protocol: string;
    network?: string;
    currency?: string;
    price_hint?: string;
    asset?: string;
    pay_to?: string;
    /**
     * Alternate settlement options. The top-level (protocol, network, currency, …)
     * trio is the canonical first option. Clients filter by `?rail=` should
     * match if any rail in {primary} ∪ {accepts[].network} matches.
     */
    accepts?: PaymentOption[];
    [k: string]: unknown;
  };
  schemas?: Record<string, unknown>;
  // /tools/:id carries the full ToolSignals; the list index does not stamp
  // signals — instead each entry has `host`, and the server joins to the
  // merchant entity at request time for filtering.
  _signals?: ToolSignals;
  _meta?: { catalog?: "bazaar" | "mpp" | "frames-registry" | string };
  host?: string | null;
  /**
   * Comma-separated network names this descriptor accepts (primary + any
   * `payment.accepts[]` alternates), derived at projection time. Lets the
   * /catalog rail filter match descriptors whose alternates include the
   * requested network even when the merchant's primary `network_names`
   * doesn't. Stamped onto slim index entries; not on /tools/:id full
   * descriptors (which already carry `payment.accepts[]`).
   */
  accepts_networks?: string;
  [k: string]: unknown;
}

// Per-host merchant entity. Produced by scripts/merge.ts, written to
// content/merchants/<host>.json + content/merchants.ndjson.
export interface MerchantEntity {
  catalog_protocol: "0.0.1";
  host: string;
  display_name: string;
  description: string | null;
  category: string;
  category_source: string;
  x_guidance: string | null;

  networks_accepted: string;
  network_names: string;
  primary_network: string;
  network_count: number;
  network_tiers: string;

  on_bazaar: boolean;
  on_agentic_market: boolean;
  on_pay_sh: boolean;
  on_mpp_directory: boolean;
  on_mppscan: boolean;
  on_frames_registry: boolean;
  listed_on_count: number;

  advertises_mpp: boolean;
  advertises_x402: boolean;
  advertises_siwx: boolean;
  advertised_methods: string;
  advertised_networks: string;
  probe_status: string;
  has_openapi: boolean;
  per_route_schemas: number;
  mpp_source: "none" | "mppscan" | "probe" | "both";

  bazaar_resource_count: number;
  bazaar_last_updated: string | null;
  total_calls_30d: number;
  tempo_tx_count: number;
  tempo_volume_usd: number;
  tempo_latest_tx: string | null;
  volume_usd_base: number;
  volume_usd_solana: number;
  tx_count_base: number;
  tx_count_solana: number;
  x402_tx_count_30d: number;
  x402_volume_usd_30d: number;
  x402_buyers_30d: number;
  x402_facilitators: string;

  is_active_14d: boolean;
  is_mass_lister: boolean;
  is_infra: boolean;
  is_recognized: boolean;

  min_price_usd: number | null;
  max_price_usd: number | null;

  endpoint_count: number;
  paid_endpoint_count: number;
  siwx_endpoint_count: number;

  tools: string[];
  observed_at: string;
  evidence: Record<string, string | undefined>;
}

export interface ListResponse {
  pay_protocol: string;
  tools: ToolDescriptor[];
  cursor?: string | null;
}

export interface MerchantListResponse {
  catalog_protocol: "0.0.1";
  merchants: MerchantEntity[];
  cursor?: string | null;
}

export interface SearchResponse {
  catalog_protocol: "0.0.1";
  merchants: MerchantEntity[];
  tools: ToolDescriptor[];
  cursor?: string | null;
}

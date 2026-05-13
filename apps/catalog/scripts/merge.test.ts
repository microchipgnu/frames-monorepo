import { test, expect, describe } from "bun:test";
import { mergeMerchants, type MergeInputs } from "./merge.ts";
import type { BazaarMerchant } from "./scrape-bazaar.ts";
import type { AgenticMerchant } from "./scrape-agentic-market.ts";
import type { PayshMerchant } from "./scrape-paysh.ts";
import type { MppDirectoryMerchant } from "./scrape-mpp-directory.ts";
import type { MppscanMerchant } from "./scrape-mppscan.ts";
import type { X402scanRecord } from "./scrape-x402scan.ts";
import type { FramesRegistryMerchant } from "./scrape-frames-registry.ts";
import type { ProbeRow } from "./probe-discovery.ts";

const NOW = "2026-05-13T12:00:00.000Z";
const RECENT = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
const OLD = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

function bazaar(host: string, overrides: Partial<BazaarMerchant> = {}): BazaarMerchant {
  return {
    host,
    bazaar_resource_count: 5,
    networks: ["eip155:8453"],
    x402_versions: [2],
    bazaar_last_updated: RECENT,
    description: null,
    sample_resources: [],
    amounts_usd: [],
    pay_to: [],
    total_calls_30d: 100,
    source_url: `https://bazaar/${host}`,
    observed_at: NOW,
    ...overrides,
  };
}

function agentic(host: string, overrides: Partial<AgenticMerchant> = {}): AgenticMerchant {
  return {
    host,
    service_id: host,
    display_name: null,
    description: null,
    category: null,
    networks: [],
    endpoint_count: 0,
    min_price_usd: null,
    max_price_usd: null,
    source_url: `https://agentic/${host}`,
    observed_at: NOW,
    ...overrides,
  };
}

function paysh(host: string, overrides: Partial<PayshMerchant> = {}): PayshMerchant {
  return {
    host,
    fqn: `vendor/${host}`,
    display_name: null,
    description: null,
    category: null,
    endpoint_count: 0,
    has_metering: false,
    has_free_tier: false,
    min_price_usd: null,
    max_price_usd: null,
    source_url: `https://pay.sh/${host}`,
    observed_at: NOW,
    ...overrides,
  };
}

function emptyInputs(): MergeInputs {
  return {
    bazaar: [],
    agentic: [],
    paysh: [],
    mppDir: [],
    mppscan: [],
    x402scan: [],
    frames: [],
    probe: [],
    overrides: {},
  };
}

describe("mergeMerchants: alias rollup", () => {
  test("x402.api.foo.com + api.foo.com + mpp.api.foo.com → api.foo.com (when no foo.com seed)", () => {
    const inputs = emptyInputs();
    inputs.bazaar = [bazaar("api.foo.com", { bazaar_resource_count: 10, pay_to: ["0xabc"] })];
    inputs.paysh = [paysh("x402.api.foo.com", { display_name: "Foo" })];
    inputs.mppDir = [
      {
        host: "mpp.api.foo.com",
        service_id: "foo-mpp",
        display_name: "Foo",
        description: "Foo's MPP edge",
        categories: [],
        tags: [],
        endpoint_count: 3,
        paid_endpoint_count: 3,
        networks: ["tempo"],
        has_dynamic_pricing: false,
        min_price_usd: null,
        max_price_usd: null,
        source_url: "https://mpp.dev/foo",
        observed_at: NOW,
      },
    ];

    const merged = mergeMerchants(inputs);

    // One merged entity, hosted at api.foo.com (the bare parent isn't known).
    expect(merged).toHaveLength(1);
    expect(merged[0].host).toBe("api.foo.com");
    expect(merged[0].on_bazaar).toBe(true);
    expect(merged[0].on_pay_sh).toBe(true);
    expect(merged[0].on_mpp_directory).toBe(true);
    expect(merged[0].listed_on_count).toBe(3);
  });

  test("transitive: x402.api.foo.com + foo.com → foo.com (api.foo.com isn't in any source)", () => {
    const inputs = emptyInputs();
    inputs.bazaar = [bazaar("foo.com", { bazaar_resource_count: 7 })];
    inputs.paysh = [paysh("x402.api.foo.com", { display_name: "Foo" })];

    const merged = mergeMerchants(inputs);
    expect(merged).toHaveLength(1);
    expect(merged[0].host).toBe("foo.com");
    expect(merged[0].listed_on_count).toBe(2);
  });

  test("does NOT invent a parent — if no parent host appears in any source, child stays", () => {
    const inputs = emptyInputs();
    inputs.bazaar = [bazaar("api.standalone.com")];

    const merged = mergeMerchants(inputs);
    expect(merged).toHaveLength(1);
    expect(merged[0].host).toBe("api.standalone.com");
  });
});

describe("mergeMerchants: signal computation", () => {
  test("is_active_14d: true when bazaar_last_updated within 14d", () => {
    const inputs = emptyInputs();
    inputs.bazaar = [bazaar("a.com", { bazaar_last_updated: RECENT })];
    expect(mergeMerchants(inputs)[0].is_active_14d).toBe(true);
  });

  test("is_active_14d: false when bazaar_last_updated > 14d ago", () => {
    const inputs = emptyInputs();
    inputs.bazaar = [bazaar("a.com", { bazaar_last_updated: OLD })];
    expect(mergeMerchants(inputs)[0].is_active_14d).toBe(false);
  });

  test("is_mass_lister: bazaar_resource_count > 500", () => {
    const inputs = emptyInputs();
    inputs.bazaar = [
      bazaar("big.com", { bazaar_resource_count: 600 }),
      bazaar("small.com", { bazaar_resource_count: 50 }),
    ];
    const merged = mergeMerchants(inputs);
    expect(merged.find((m) => m.host === "big.com")!.is_mass_lister).toBe(true);
    expect(merged.find((m) => m.host === "small.com")!.is_mass_lister).toBe(false);
  });

  test("is_infra: detected by host suffix", () => {
    const inputs = emptyInputs();
    inputs.bazaar = [bazaar("thing.vercel.app"), bazaar("openai.com")];
    const merged = mergeMerchants(inputs);
    expect(merged.find((m) => m.host === "thing.vercel.app")!.is_infra).toBe(true);
    expect(merged.find((m) => m.host === "openai.com")!.is_infra).toBe(false);
  });

  test("is_recognized: requires curated display_name AND !infra AND !mass_lister", () => {
    const inputs = emptyInputs();
    // (a) recognized: curated name, not infra, not mass-lister
    // (b) not recognized: curated name but infra
    // (c) not recognized: curated name but mass-lister
    // (d) not recognized: no curated name
    inputs.bazaar = [
      bazaar("real.com"),
      bazaar("real-infra.vercel.app"),
      bazaar("real-mass.com", { bazaar_resource_count: 9999 }),
      bazaar("anonymous.com"),
    ];
    inputs.agentic = [
      agentic("real.com", { display_name: "Real" }),
      agentic("real-infra.vercel.app", { display_name: "Real Infra" }),
      agentic("real-mass.com", { display_name: "Real Mass" }),
      // anonymous.com: no curation
    ];

    const merged = mergeMerchants(inputs);
    const byHost = new Map(merged.map((m) => [m.host, m]));
    expect(byHost.get("real.com")!.is_recognized).toBe(true);
    expect(byHost.get("real-infra.vercel.app")!.is_recognized).toBe(false);
    expect(byHost.get("real-mass.com")!.is_recognized).toBe(false);
    expect(byHost.get("anonymous.com")!.is_recognized).toBe(false);
  });
});

describe("mergeMerchants: listed_on_count math", () => {
  test("counts each source presence (bazaar + agentic + paysh + mpp-dir + mppscan + frames)", () => {
    const inputs = emptyInputs();
    const host = "everywhere.com";
    inputs.bazaar = [bazaar(host)];
    inputs.agentic = [agentic(host, { display_name: "Everywhere" })];
    inputs.paysh = [paysh(host, { display_name: "Everywhere" })];
    inputs.mppDir = [
      {
        host,
        service_id: "ev",
        display_name: "Everywhere",
        description: null,
        categories: [],
        tags: [],
        endpoint_count: 1,
        paid_endpoint_count: 1,
        networks: [],
        has_dynamic_pricing: false,
        min_price_usd: null,
        max_price_usd: null,
        source_url: "x",
        observed_at: NOW,
      },
    ];
    inputs.mppscan = [
      {
        host,
        display_name: "Everywhere",
        description: null,
        tempo_tx_count: 5,
        tempo_volume_usd: 100,
        tempo_buyers: 2,
        tempo_latest_tx: NOW,
        mpp_resource_count: 1,
        rank: 1,
        source_url: "x",
        observed_at: NOW,
      },
    ];
    inputs.frames = [
      {
        host,
        service_slug: "ev",
        display_name: "Everywhere",
        description: null,
        x_guidance: null,
        tags: [],
        paid_endpoint_count: 1,
        siwx_endpoint_count: 0,
        free_endpoint_count: 0,
        has_dynamic_pricing: false,
        min_price_usd: null,
        max_price_usd: null,
        openapi_url: "x",
        source_url: "x",
        observed_at: NOW,
      },
    ];

    const m = mergeMerchants(inputs)[0];
    expect(m.listed_on_count).toBe(6);
    expect(m.tempo_tx_count).toBe(5);
    expect(m.tempo_volume_usd).toBe(100);
  });
});

describe("mergeMerchants: x402scan join via pay_to[]", () => {
  test("sums per-chain volume by joining bazaar.pay_to → x402scan.recipient", () => {
    const inputs = emptyInputs();
    inputs.bazaar = [bazaar("merchant.com", { pay_to: ["0xabc", "AbCdEf"] })];
    inputs.x402scan = [
      {
        recipient: "0xabc",
        chain: "base",
        facilitator_ids: ["coinbase"],
        tx_count: 100,
        volume_usd_30d: 250.5,
        unique_buyers: 30,
        source_url: "x402scan",
        observed_at: NOW,
      },
      {
        recipient: "abcdef", // lowercased; check casing-insensitive lookup
        chain: "solana",
        facilitator_ids: ["payAI"],
        tx_count: 20,
        volume_usd_30d: 75,
        unique_buyers: 10,
        source_url: "x402scan",
        observed_at: NOW,
      },
    ];

    const m = mergeMerchants(inputs)[0];
    expect(m.volume_usd_base).toBe(250.5);
    expect(m.tx_count_base).toBe(100);
    expect(m.volume_usd_solana).toBe(75);
    expect(m.tx_count_solana).toBe(20);
    expect(m.x402_volume_usd_30d).toBeCloseTo(325.5, 1);
    expect(m.x402_buyers_30d).toBe(40);
    expect(m.x402_facilitators).toContain("coinbase");
    expect(m.x402_facilitators).toContain("payAI");
  });
});

describe("mergeMerchants: MPP signal fusion", () => {
  function probe(host: string, methods: string[], sibling: string | null = null): ProbeRow {
    return {
      host,
      probe_origin: `https://${host}`,
      probe_status: "ok",
      http_status: null,
      has_openapi: false,
      x_guidance: null,
      resource_count: 1,
      paid_resource_count: 1,
      siwx_resource_count: 0,
      advertised_methods: methods,
      advertised_networks: methods,
      advertised_recipients: [],
      per_route_schemas: 0,
      sample_routes: [],
      sibling_of: sibling,
      observed_at: NOW,
    };
  }

  test("mpp_source=mppscan when only mppscan saw it", () => {
    const inputs = emptyInputs();
    inputs.bazaar = [bazaar("m.com")];
    inputs.mppscan = [
      {
        host: "m.com",
        display_name: null,
        description: null,
        tempo_tx_count: 1,
        tempo_volume_usd: 1,
        tempo_buyers: 1,
        tempo_latest_tx: NOW,
        mpp_resource_count: 1,
        rank: null,
        source_url: "x",
        observed_at: NOW,
      },
    ];
    expect(mergeMerchants(inputs)[0].mpp_source).toBe("mppscan");
  });

  test("mpp_source=probe when probe advertised mpp but mppscan didn't see it yet", () => {
    const inputs = emptyInputs();
    inputs.bazaar = [bazaar("m.com")];
    inputs.probe = [probe("m.com", ["mpp"])];
    expect(mergeMerchants(inputs)[0].mpp_source).toBe("probe");
  });

  test("mpp_source=both when both fired", () => {
    const inputs = emptyInputs();
    inputs.bazaar = [bazaar("m.com")];
    inputs.probe = [probe("m.com", ["mpp", "tempo"])];
    inputs.mppscan = [
      {
        host: "m.com",
        display_name: null,
        description: null,
        tempo_tx_count: 1,
        tempo_volume_usd: 1,
        tempo_buyers: 1,
        tempo_latest_tx: NOW,
        mpp_resource_count: 1,
        rank: null,
        source_url: "x",
        observed_at: NOW,
      },
    ];
    expect(mergeMerchants(inputs)[0].mpp_source).toBe("both");
  });

  test("mpp_source=none when neither fired", () => {
    const inputs = emptyInputs();
    inputs.bazaar = [bazaar("m.com")];
    expect(mergeMerchants(inputs)[0].mpp_source).toBe("none");
  });

  test("sibling-host probe (mpp.foo.com) credits seed host (api.foo.com)", () => {
    const inputs = emptyInputs();
    inputs.bazaar = [bazaar("api.foo.com")];
    // probe at mpp.foo.com found MPP advertising; sibling_of points back to seed.
    inputs.probe = [probe("mpp.foo.com", ["mpp"], "api.foo.com")];

    const m = mergeMerchants(inputs)[0];
    expect(m.advertises_mpp).toBe(true);
  });
});

describe("mergeMerchants: category priority", () => {
  test("pay.sh wins over agentic.market when both classify", () => {
    const inputs = emptyInputs();
    inputs.bazaar = [bazaar("a.com")];
    inputs.paysh = [paysh("a.com", { category: "search" })];
    inputs.agentic = [agentic("a.com", { category: "data" })];

    const m = mergeMerchants(inputs)[0];
    expect(m.category).toBe("search");
    expect(m.category_source).toBe("pay_sh");
  });

  test("agentic.market is used when pay.sh has nothing", () => {
    const inputs = emptyInputs();
    inputs.bazaar = [bazaar("a.com")];
    inputs.agentic = [agentic("a.com", { category: "Inference" })];

    const m = mergeMerchants(inputs)[0];
    expect(m.category).toBe("ai_ml"); // normalized from "Inference"
    expect(m.category_source).toBe("agentic_market");
  });

  test("falls back to 'other' with category_source=none when nothing classifies", () => {
    const inputs = emptyInputs();
    inputs.bazaar = [bazaar("a.com")];
    const m = mergeMerchants(inputs)[0];
    expect(m.category).toBe("other");
    expect(m.category_source).toBe("none");
  });
});

describe("mergeMerchants: empty inputs", () => {
  test("returns [] when nothing supplied", () => {
    expect(mergeMerchants(emptyInputs())).toEqual([]);
  });
});

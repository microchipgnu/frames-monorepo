// Shared host normalization + CAIP-2 network mapping.
// Pure helpers, no I/O.

export function canonicalHost(input: string | null | undefined): string | null {
  if (!input) return null;
  let h = input.trim().toLowerCase();
  try {
    // Accept either a hostname or a full URL
    if (h.includes("://")) h = new URL(h).hostname;
    else if (h.startsWith("//")) h = new URL(`http:${h}`).hostname;
  } catch {
    // not a parseable URL; treat as bare host
  }
  // Strip path/port if leaked through
  h = h.split("/")[0].split(":")[0];
  if (!h || h === "localhost" || h.startsWith("127.") || h.endsWith(".local"))
    return null;
  return h;
}

export function entityIdFromHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
}

// CAIP-2 → friendly name + tier.
// Tiers: evm_rollup | evm_l1 | solana | alt_l1 | testnet | unknown
const CHAIN_REGISTRY: Record<
  string,
  { name: string; tier: string; mainnet: boolean }
> = {
  // EVM mainnets
  "eip155:1": { name: "Ethereum", tier: "evm_l1", mainnet: true },
  "eip155:8453": { name: "Base", tier: "evm_rollup", mainnet: true },
  "eip155:42161": { name: "Arbitrum", tier: "evm_rollup", mainnet: true },
  "eip155:10": { name: "Optimism", tier: "evm_rollup", mainnet: true },
  "eip155:137": { name: "Polygon", tier: "evm_rollup", mainnet: true },
  "eip155:196": { name: "X Layer", tier: "evm_rollup", mainnet: true },
  "eip155:43114": { name: "Avalanche", tier: "evm_l1", mainnet: true },
  "eip155:143": { name: "Monad", tier: "evm_l1", mainnet: true },
  "eip155:480": { name: "World Chain", tier: "evm_rollup", mainnet: true },
  "eip155:34443": { name: "Mode", tier: "evm_rollup", mainnet: true },
  "eip155:7777777": { name: "Zora", tier: "evm_rollup", mainnet: true },
  // Tempo Mainnet Presto — Stripe + Tempo's stablecoin-native EVM chain.
  // chainId 4217 per ethereum-lists/chains; this is where MPP "tempo" method
  // settles. Renaming it from "Chain 4217" to "Tempo" makes the partner pitch
  // legible.
  "eip155:4217": { name: "Tempo", tier: "alt_l1", mainnet: true },
  // SKALE Base — the SKALE chain branded as "skale" by SKALE Foundation.
  // Mainnet, ETH-compatible.
  "eip155:1187947933": { name: "SKALE Base", tier: "alt_l1", mainnet: true },
  // Arc Network Testnet (Circle) — not counted as mainnet.
  "eip155:5042002": { name: "Arc Network (testnet)", tier: "testnet", mainnet: false },
  // Solana
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpgttKVHvjz4w": {
    name: "Solana",
    tier: "solana",
    mainnet: true,
  },
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": {
    name: "Solana",
    tier: "solana",
    mainnet: true,
  },
  // Alt-L1 / non-EVM
  "stellar:pubnet": { name: "Stellar", tier: "alt_l1", mainnet: true },
  "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=": {
    name: "Algorand",
    tier: "alt_l1",
    mainnet: true,
  },
  "keeta:main": { name: "Keeta", tier: "alt_l1", mainnet: true },
  // Testnets — useful to flag, not to count
  "eip155:84532": { name: "Base Sepolia", tier: "testnet", mainnet: false },
  "eip155:80002": { name: "Polygon Amoy", tier: "testnet", mainnet: false },
  "eip155:11155111": { name: "Sepolia", tier: "testnet", mainnet: false },
  // v1 friendly aliases — still in the wild. Also catches bare method names
  // from MPP probes (WWW-Authenticate Payment method="X") which we normalize
  // through describeNetwork.
  base: { name: "Base", tier: "evm_rollup", mainnet: true },
  solana: { name: "Solana", tier: "solana", mainnet: true },
  ethereum: { name: "Ethereum", tier: "evm_l1", mainnet: true },
  tempo: { name: "Tempo", tier: "alt_l1", mainnet: true },
  monad: { name: "Monad", tier: "evm_l1", mainnet: true },
  stellar: { name: "Stellar", tier: "alt_l1", mainnet: true },
  keeta: { name: "Keeta", tier: "alt_l1", mainnet: true },
  "x-layer": { name: "X Layer", tier: "evm_rollup", mainnet: true },
  arbitrum: { name: "Arbitrum", tier: "evm_rollup", mainnet: true },
  optimism: { name: "Optimism", tier: "evm_rollup", mainnet: true },
  polygon: { name: "Polygon", tier: "evm_rollup", mainnet: true },
  avalanche: { name: "Avalanche", tier: "evm_l1", mainnet: true },
  "world-chain": { name: "World Chain", tier: "evm_rollup", mainnet: true },
  worldchain: { name: "World Chain", tier: "evm_rollup", mainnet: true },
  "skale-base": { name: "SKALE Base", tier: "alt_l1", mainnet: true },
  "lightning:mainnet": { name: "Lightning", tier: "alt_l1", mainnet: true },
  "base-sepolia": { name: "Base Sepolia", tier: "testnet", mainnet: false },
};

export type ChainInfo = {
  caip2: string;
  name: string;
  tier: string;
  mainnet: boolean;
};

// Case-insensitive index over CHAIN_REGISTRY. agentic.market sends
// Title-case names ("Base", "Solana") while the bazaar uses CAIP-2 IDs
// and v1 friendly names are lowercase — same chain, different casing.
const CHAIN_REGISTRY_LC: Record<string, { name: string; tier: string; mainnet: boolean }> =
  Object.fromEntries(
    Object.entries(CHAIN_REGISTRY).map(([k, v]) => [k.toLowerCase(), v]),
  );

export function describeNetwork(raw: string): ChainInfo {
  const lc = raw.toLowerCase();
  const reg = CHAIN_REGISTRY_LC[lc];
  if (reg) return { caip2: raw, ...reg };
  // Heuristic fallback
  if (lc.startsWith("solana:"))
    return { caip2: raw, name: "Solana", tier: "solana", mainnet: true };
  if (lc.startsWith("eip155:")) {
    const chainId = raw.split(":")[1] ?? raw;
    return { caip2: raw, name: `Chain ${chainId}`, tier: "evm_l1", mainnet: true };
  }
  return { caip2: raw, name: raw, tier: "unknown", mainnet: false };
}

// Hostnames that are auto-generated infrastructure URLs, not real merchant
// brands. We keep them in the dataset (the underlying business may be real)
// but flag them so the dashboard can filter them out of the prospect view.
const INFRA_SUFFIXES = [
  ".amazonaws.com",
  ".vercel.app",
  ".workers.dev",
  ".netlify.app",
  ".fly.dev",
  ".run.app",
  ".azurewebsites.net",
  ".herokuapp.com",
  ".ngrok.io",
  ".ngrok-free.app",
  ".tunnel.app",
  ".cloudfront.net",
  ".replit.dev",
  ".repl.co",
];

export function isInfraHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return INFRA_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

// Probe well-known paths + env vars for existing wallets.
//
// Used by:
//   - `pay wallet detect`    (print-only)
//   - `pay wallet init`      (suggest detected wallets at the end)
//   - `pay wallet init --auto` (write all detected)
//   - `pay wallet init --use <kind>` (write a specific one)
//
// Each probe returns null if nothing's there, else a Detection with enough
// info to display + bake into config.yaml.

import { existsSync, readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { homedir } from "node:os";

export interface Detection {
  kind:
    | "evm-env"
    | "solana-env"
    | "solana-cli"
    | "agentcash"
    | "agentwallet"
    | "frames"
    | "ows";
  /** What the user sees in `pay wallet detect` output. */
  label: string;
  /** Where the wallet was found. */
  source: string;
  /** A representative address (EVM hex, Solana base58, or vault name). */
  address?: string;
  /** Suggested YAML stanza to add to wallets:. Multiple networks possible. */
  yamlSnippet: string;
  /**
   * Structured per-network entries. Used by `wallet init --auto` to write
   * config.yaml in the multi-wallet list form (one network → many entries).
   * yamlSnippet is for human display only.
   */
  entries: Array<{ network: string; config: Record<string, unknown> }>;
  /** The network keys this entry would register under (for `--auto` to dedupe). */
  networks: string[];
}

const home = (): string => process.env["HOME"] ?? homedir();

export function detectAll(): Detection[] {
  const out: Detection[] = [];
  for (const probe of PROBES) {
    const r = probe();
    if (r) out.push(r);
  }
  return out;
}

const PROBES: Array<() => Detection | null> = [
  detectAgentwallet,
  detectAgentcash,
  detectFrames,
  detectOws,
  detectSolanaCli,
  detectEvmEnv,
  detectSolanaEnv,
];

// ---------------------------------------------------------------------------
// agentwallet (frames.ag hosted) — ~/.agentwallet/config.json
// ---------------------------------------------------------------------------

function detectAgentwallet(): Detection | null {
  const path = pathResolve(home(), ".agentwallet", "config.json");
  if (!existsSync(path)) return null;
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8")) as {
      apiToken?: string;
      baseUrl?: string;
      username?: string;
      evmAddress?: string;
      solanaAddress?: string;
    };
    if (!cfg.apiToken || !cfg.username) return null;
    const networks: string[] = [];
    const stanzas: string[] = [];
    const entries: Detection["entries"] = [];
    if (cfg.evmAddress) {
      networks.push("base");
      stanzas.push(
        `  base:
    kind: agentwallet
    label: my-agentwallet`,
      );
      entries.push({
        network: "base",
        config: { kind: "agentwallet", label: "my-agentwallet" },
      });
    }
    if (cfg.solanaAddress) {
      networks.push("solana-mainnet");
      stanzas.push(
        `  solana-mainnet:
    kind: agentwallet
    label: my-agentwallet`,
      );
      entries.push({
        network: "solana-mainnet",
        config: { kind: "agentwallet", label: "my-agentwallet" },
      });
    }
    return {
      kind: "agentwallet",
      label: `agentwallet @ ${cfg.baseUrl ?? "frames.ag"}`,
      source: path,
      address: cfg.evmAddress ?? cfg.solanaAddress,
      yamlSnippet: stanzas.join("\n"),
      entries,
      networks,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// agentcash — ~/.agentcash/wallet.json (EVM) and solana-wallet.json
// ---------------------------------------------------------------------------

function detectAgentcash(): Detection | null {
  const dir = pathResolve(home(), ".agentcash");
  const evmPath = pathResolve(dir, "wallet.json");
  const solPath = pathResolve(dir, "solana-wallet.json");
  const hasEvm = existsSync(evmPath);
  const hasSol = existsSync(solPath);
  if (!hasEvm && !hasSol) return null;

  let evmAddr: string | undefined;
  let solAddr: string | undefined;
  if (hasEvm) {
    try {
      const w = JSON.parse(readFileSync(evmPath, "utf8")) as { address?: string };
      evmAddr = w.address;
    } catch {}
  }
  if (hasSol) {
    try {
      const w = JSON.parse(readFileSync(solPath, "utf8")) as { address?: string };
      solAddr = w.address;
    } catch {}
  }

  const networks: string[] = [];
  const stanzas: string[] = [];
  const entries: Detection["entries"] = [];
  if (hasEvm && evmAddr) {
    networks.push("base");
    stanzas.push(
      `  base:
    kind: agentcash
    label: my-agentcash
    evm: { chain: { id: 8453, name: Base } }`,
    );
    entries.push({
      network: "base",
      config: {
        kind: "agentcash",
        label: "my-agentcash",
        evm: { chain: { id: 8453, name: "Base" } },
      },
    });
  }
  if (hasSol && solAddr) {
    networks.push("solana-mainnet");
    stanzas.push(
      `  solana-mainnet:
    kind: agentcash
    label: my-agentcash
    solana: { network: solana }`,
    );
    entries.push({
      network: "solana-mainnet",
      config: {
        kind: "agentcash",
        label: "my-agentcash",
        solana: { network: "solana" },
      },
    });
  }

  return {
    kind: "agentcash",
    label: `agentcash CLI`,
    source: dir,
    address: evmAddr ?? solAddr,
    yamlSnippet: stanzas.join("\n"),
    entries,
    networks,
  };
}

// ---------------------------------------------------------------------------
// frames — ~/.frames/secrets/org_default/x402.json (OWS pointer)
// ---------------------------------------------------------------------------

function detectFrames(): Detection | null {
  const framesDir = process.env["FRAMES_HOME"] ?? pathResolve(home(), ".frames");
  const secretsPath = pathResolve(framesDir, "secrets", "org_default", "x402.json");
  if (!existsSync(secretsPath)) return null;
  try {
    const stored = JSON.parse(readFileSync(secretsPath, "utf8")) as {
      provider_name?: string;
      credential?: string;
    };
    if (stored.provider_name !== "open-wallet-standard" || !stored.credential) {
      return null;
    }
    return {
      kind: "frames",
      label: `frames OWS wallet "${stored.credential}"`,
      source: secretsPath,
      address: stored.credential,
      yamlSnippet: `  base:
    kind: frames
    label: frames-shared
    evm: { chain: { id: 8453, name: Base } }
    # passphrase: env:OWS_PASSPHRASE`,
      entries: [
        {
          network: "base",
          config: {
            kind: "frames",
            label: "frames-shared",
            evm: { chain: { id: 8453, name: "Base" } },
          },
        },
      ],
      networks: ["base"],
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// OWS vault directly — ~/.ows/wallets/*.json
// ---------------------------------------------------------------------------

function detectOws(): Detection | null {
  const owsDir = process.env["FRAMES_OWS_VAULT"] ?? pathResolve(home(), ".ows", "wallets");
  if (!existsSync(owsDir)) return null;
  // We don't list / parse vault files (they're encrypted); just announce
  // that the directory is there. User picks the wallet name themselves.
  // Suppress this detection if frames already pointed at OWS — avoid duplicates.
  if (detectFrames()) return null;
  return {
    kind: "ows",
    label: "OWS vault directory",
    source: owsDir,
    yamlSnippet: `  base:
    kind: ows
    label: my-ows-wallet
    wallet_name: <the wallet name in your vault>
    passphrase: env:OWS_PASSPHRASE
    evm: { chain: { id: 8453, name: Base } }`,
    // OWS detection is informational — we don't know the wallet name yet,
    // so we can't write a valid config. --auto skips this kind.
    entries: [],
    networks: [],
  };
}

// ---------------------------------------------------------------------------
// Solana CLI keypair — ~/.config/solana/id.json
// ---------------------------------------------------------------------------

function detectSolanaCli(): Detection | null {
  const path = pathResolve(home(), ".config", "solana", "id.json");
  if (!existsSync(path)) return null;
  return {
    kind: "solana-cli",
    label: "Solana CLI keypair",
    source: path,
    yamlSnippet: `  solana-mainnet:
    kind: solana
    label: solana-cli
    network: solana
    keypair_path: ${path}`,
    entries: [
      {
        network: "solana-mainnet",
        config: {
          kind: "solana",
          label: "solana-cli",
          network: "solana",
          keypair_path: path,
        },
      },
    ],
    networks: ["solana-mainnet"],
  };
}

// ---------------------------------------------------------------------------
// env-var keys (X402_PRIVATE_KEY, X402_SOLANA_PRIVATE_KEY)
// ---------------------------------------------------------------------------

function detectEvmEnv(): Detection | null {
  const v = process.env["X402_PRIVATE_KEY"];
  if (!v) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) return null;
  return {
    kind: "evm-env",
    label: "X402_PRIVATE_KEY env var",
    source: "$X402_PRIVATE_KEY",
    yamlSnippet: `  base:
    kind: evm
    label: env-key
    private_key: env:X402_PRIVATE_KEY
    chain: { id: 8453, name: Base }`,
    entries: [
      {
        network: "base",
        config: {
          kind: "evm",
          label: "env-key",
          private_key: "env:X402_PRIVATE_KEY",
          chain: { id: 8453, name: "Base" },
        },
      },
    ],
    networks: ["base"],
  };
}

function detectSolanaEnv(): Detection | null {
  const v = process.env["X402_SOLANA_PRIVATE_KEY"];
  if (!v) return null;
  return {
    kind: "solana-env",
    label: "X402_SOLANA_PRIVATE_KEY env var",
    source: "$X402_SOLANA_PRIVATE_KEY",
    yamlSnippet: `  solana-mainnet:
    kind: solana
    label: env-key
    network: solana
    secret_key_b58: env:X402_SOLANA_PRIVATE_KEY`,
    entries: [
      {
        network: "solana-mainnet",
        config: {
          kind: "solana",
          label: "env-key",
          network: "solana",
          secret_key_b58: "env:X402_SOLANA_PRIVATE_KEY",
        },
      },
    ],
    networks: ["solana-mainnet"],
  };
}

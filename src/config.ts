// Read ~/.frames/pay/config.yaml and turn it into a runtime config.
//
// Wallet kinds dispatched via the WALLET_FACTORIES table at the bottom.
// New providers (agentcash, frames-agentwallet, sponge-wallet, …) slot in
// by adding a row — pay's bridge / dispatch / MCP layer doesn't change.
//
// Today's supported `kind` values:
//   evm        — local EVM private key (always available; no extra deps)
//   solana     — local Solana keypair (needs @faremeter/wallet-solana + @solana/web3.js)
//   crossmint  — Crossmint custodial Solana wallet (needs @faremeter/wallet-crossmint)
//   ows        — Open Wallet Standard vault, EVM or Solana (needs @faremeter/wallet-ows + @open-wallet-standard/core)
//
// Config-shape examples for each are at the bottom of this file.

import { existsSync, readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { WalletRegistry } from "./wallet/wallet-registry.ts";
import type { WalletEntry } from "./wallet/wallet-registry.ts";
import type { AuditKeyPair } from "./wallet/audit-key.ts";
import { loadOrCreateAuditKey } from "./wallet/audit-key.ts";
import { HttpCatalog } from "./catalog/http.ts";
import type { CatalogSource } from "./types.ts";

export const DEFAULT_CONFIG_PATH = pathResolve(
  homedir(),
  ".frames",
  "pay",
  "config.yaml",
);
export const DEFAULT_CATALOG_URL = "https://catalog.frames.ag";

export interface RuntimeConfig {
  registry: WalletRegistry;
  auditKey: AuditKeyPair;
  defaultCatalog: CatalogSource;
  manifestPath: string;
  lockPath: string;
  agent: string;
  /** The path config was loaded from, or null if defaults were used. */
  configPath: string | null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export async function loadRuntimeConfig(
  configPath: string = DEFAULT_CONFIG_PATH,
): Promise<RuntimeConfig> {
  const fileExists = existsSync(configPath);
  const raw: unknown = fileExists
    ? parseYaml(readFileSync(configPath, "utf8"))
    : {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`config must be a YAML object: ${configPath}`);
  }
  const obj = raw as Record<string, unknown>;

  const agent =
    typeof obj["agent"] === "string" ? (obj["agent"] as string) : "system:cli";

  const catalogObj = (obj["catalog"] ?? {}) as Record<string, unknown>;
  const catalogUrl =
    typeof catalogObj["default"] === "string"
      ? (catalogObj["default"] as string)
      : DEFAULT_CATALOG_URL;
  const defaultCatalog = new HttpCatalog({ baseUrl: catalogUrl });

  const manifestPath =
    typeof obj["manifest_path"] === "string"
      ? (obj["manifest_path"] as string)
      : "./tools.yml";
  const lockPath =
    typeof obj["lock_path"] === "string"
      ? (obj["lock_path"] as string)
      : "./tools.lock";

  const wallets = (obj["wallets"] ?? {}) as Record<string, unknown>;
  const byNetwork: Record<string, WalletEntry> = {};
  for (const [network, entryRaw] of Object.entries(wallets)) {
    if (typeof entryRaw !== "object" || entryRaw === null) {
      throw new ConfigError(`wallets.${network} must be an object`);
    }
    const cfg = entryRaw as Record<string, unknown>;
    const kind = cfg["kind"];
    if (typeof kind !== "string") {
      throw new ConfigError(`wallets.${network}.kind must be a string`);
    }
    const factory = WALLET_FACTORIES[kind];
    if (!factory) {
      throw new ConfigError(
        `wallets.${network}.kind="${kind}" not supported. Available: ${Object.keys(WALLET_FACTORIES).join(", ")}`,
      );
    }
    const label = typeof cfg["label"] === "string" ? cfg["label"] : "default";
    try {
      byNetwork[network] = await factory(cfg, label, network);
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      throw new ConfigError(
        `wallets.${network} (${kind}): ${(e as Error).message}`,
      );
    }
  }

  const registry = new WalletRegistry({ byNetwork, agent });
  const auditKey = await loadOrCreateAuditKey();

  return {
    registry,
    auditKey,
    defaultCatalog,
    manifestPath,
    lockPath,
    agent,
    configPath: fileExists ? configPath : null,
  };
}

// ---------------------------------------------------------------------------
// Wallet factories — one row per supported `kind`.
//
// Each factory:
//   - dynamically imports its faremeter package (so unused kinds don't bloat install)
//   - validates the relevant config block
//   - resolves env:VAR references for secrets
//   - returns a WalletEntry that the bridge can use
//
// To add a new provider (agentcash, frames-agentwallet, sponge-wallet, …):
//   1. The provider ships an `@<scope>/faremeter-wallet` npm package whose
//      factory returns the EVM or Solana wallet shape.
//   2. Add a row here with the dynamic import + validation.
//   3. Document the config.yaml shape in the example block at the bottom.
// ---------------------------------------------------------------------------

type WalletFactory = (
  cfg: Record<string, unknown>,
  label: string,
  network: string,
) => Promise<WalletEntry>;

const WALLET_FACTORIES: Record<string, WalletFactory> = {
  evm: async (cfg, label) => {
    const { createLocalWallet } = await loadOptionalPackage<{
      createLocalWallet: (
        chain: { id: number; name: string },
        privateKey: string,
      ) => Promise<import("@faremeter/wallet-evm").EvmWallet>;
    }>("@faremeter/wallet-evm");
    const chain = expectObject(cfg["chain"], "chain");
    const id = expectNumber(chain["id"], "chain.id");
    const name = expectString(chain["name"], "chain.name");
    const pk = resolveSecret(expectString(cfg["private_key"], "private_key"), "private_key");
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
      throw new Error("private_key must be 0x-prefixed 32-byte hex");
    }
    const wallet = await createLocalWallet({ id, name }, pk);
    return { kind: "evm", wallet, label, source: "evm" };
  },

  solana: async (cfg, label) => {
    // Dynamic-import shapes intentionally typed `any`: these packages are
    // optional and may not be installed at typecheck time. Runtime
    // validation via expectString/expectObject still applies.
    const sol = (await loadOptionalPackage<{
      createLocalWallet: (network: string, keypair: unknown) => Promise<unknown>;
    }>("@faremeter/wallet-solana")) as {
      createLocalWallet: (network: string, keypair: unknown) => Promise<unknown>;
    };
    const web3 = (await loadOptionalPackage<{
      Keypair: { fromSecretKey: (bytes: Uint8Array) => unknown };
    }>("@solana/web3.js")) as {
      Keypair: { fromSecretKey: (bytes: Uint8Array) => unknown };
    };
    const network = expectString(cfg["network"], "network");
    let keypair: unknown;
    if (typeof cfg["keypair_path"] === "string") {
      const arr = JSON.parse(
        readFileSync(cfg["keypair_path"] as string, "utf8"),
      ) as number[];
      keypair = web3.Keypair.fromSecretKey(Uint8Array.from(arr));
    } else if (typeof cfg["secret_key_b58"] === "string") {
      const bs58 = (await loadOptionalPackage<{
        default: { decode: (s: string) => Uint8Array };
      }>("bs58")) as { default: { decode: (s: string) => Uint8Array } };
      keypair = web3.Keypair.fromSecretKey(
        bs58.default.decode(cfg["secret_key_b58"] as string),
      );
    } else {
      throw new Error("solana wallet needs keypair_path or secret_key_b58");
    }
    const wallet = (await sol.createLocalWallet(network, keypair)) as import(
      "./wallet/wallet-registry.ts"
    ).SolanaWalletShape;
    return { kind: "solana", wallet, label, source: "solana" };
  },

  crossmint: async (cfg, label) => {
    const cm = (await loadOptionalPackage<{
      createCrossmintWallet: (
        network: string,
        apiKey: string,
        walletAddress: string,
      ) => Promise<unknown>;
    }>("@faremeter/wallet-crossmint")) as {
      createCrossmintWallet: (
        network: string,
        apiKey: string,
        walletAddress: string,
      ) => Promise<unknown>;
    };
    const network = expectString(cfg["network"], "network");
    const apiKey = resolveSecret(
      expectString(cfg["api_key"], "api_key"),
      "api_key",
    );
    const walletAddress = expectString(cfg["wallet_address"], "wallet_address");
    const wallet = (await cm.createCrossmintWallet(
      network,
      apiKey,
      walletAddress,
    )) as import("./wallet/wallet-registry.ts").SolanaWalletShape;
    return { kind: "solana", wallet, label, source: "crossmint" };
  },

  agentwallet: async (cfg, label) => {
    // The hosted agentwallet at frames.ag stores its CLI config at
    // ~/.agentwallet/config.json:
    //   { apiToken, baseUrl, username, evmAddress, solanaAddress, email }
    //
    // Pay reads that file and stores a "delegated" wallet entry. At dispatch
    // time, instead of calling faremeter to sign locally, pay POSTs to:
    //   {baseUrl}/api/wallets/{username}/actions/x402/fetch
    // which does the entire 402 detection + signing + retry flow server-side,
    // then returns the final response + settlement metadata. Pay just builds
    // a receipt from that response.
    //
    // Keys never leave agentwallet's servers. Funds are custodied by frames.ag.
    const home = process.env["HOME"] ?? homedir();
    const configPath =
      typeof cfg["config_path"] === "string"
        ? (cfg["config_path"] as string)
        : pathResolve(home, ".agentwallet", "config.json");

    if (!existsSync(configPath)) {
      throw new Error(
        `agentwallet config not found at ${configPath} — run agentwallet onboarding (visit https://frames.ag) first`,
      );
    }
    const stored = JSON.parse(readFileSync(configPath, "utf8")) as {
      apiToken?: string;
      baseUrl?: string;
      username?: string;
      evmAddress?: string;
      solanaAddress?: string;
    };
    if (!stored.apiToken) throw new Error(`${configPath} missing apiToken`);
    if (!stored.baseUrl) throw new Error(`${configPath} missing baseUrl`);
    if (!stored.username) throw new Error(`${configPath} missing username`);

    return {
      kind: "delegated",
      provider: "agentwallet",
      baseUrl: stored.baseUrl,
      apiToken: stored.apiToken,
      username: stored.username,
      addresses: {
        ...(stored.evmAddress !== undefined && { evm: stored.evmAddress }),
        ...(stored.solanaAddress !== undefined && { solana: stored.solanaAddress }),
      },
      label,
      source: "agentwallet",
    };
  },

  frames: async (cfg, label) => {
    // The "frames agentwallet" is an OWS vault. Frames stores a pointer to it
    // at ~/.frames/secrets/<org>/<protocol>.json:
    //   { "provider_name": "open-wallet-standard", "credential": "<wallet-name>" }
    // This factory reads that pointer and delegates to OWS.
    //
    // Same vault used by frames CLI, frames skill, and the websets-impl
    // gateway. Pay shares spending authority with all of them.
    const home = process.env["HOME"] ?? homedir();
    const framesDir =
      typeof cfg["dir"] === "string"
        ? (cfg["dir"] as string)
        : (process.env["FRAMES_HOME"] ?? pathResolve(home, ".frames"));
    const org = typeof cfg["org"] === "string" ? (cfg["org"] as string) : "org_default";
    // Either x402 or mpp — both typically point at the same wallet. Default x402.
    const protocol =
      typeof cfg["protocol"] === "string" ? (cfg["protocol"] as string) : "x402";
    const secretsPath = pathResolve(framesDir, "secrets", org, `${protocol}.json`);

    if (!existsSync(secretsPath)) {
      throw new Error(
        `frames secrets file not found at ${secretsPath} — has the frames wallet been provisioned?`,
      );
    }

    const stored = JSON.parse(readFileSync(secretsPath, "utf8")) as {
      provider_name?: string;
      credential?: string;
    };
    if (stored.provider_name !== "open-wallet-standard") {
      throw new Error(
        `frames wallet provider "${stored.provider_name}" not yet supported (only open-wallet-standard)`,
      );
    }
    if (typeof stored.credential !== "string" || !stored.credential) {
      throw new Error(`frames secrets file ${secretsPath} missing credential`);
    }
    const walletName = stored.credential;

    // Vault path: explicit > FRAMES_OWS_VAULT > $HOME/.ows
    const vaultPath =
      typeof cfg["vault_path"] === "string"
        ? (cfg["vault_path"] as string)
        : (process.env["FRAMES_OWS_VAULT"] ?? pathResolve(home, ".ows"));
    // Passphrase MUST come from env (we never want it hand-typed in YAML)
    const passphraseSpec =
      typeof cfg["passphrase"] === "string" ? (cfg["passphrase"] as string) : "env:OWS_PASSPHRASE";
    const passphrase = resolveSecret(passphraseSpec, "passphrase");

    const ows = (await loadOptionalPackage<{
      createOWSEvmWallet: (chain: { id: number; name: string }, opts: unknown) => unknown;
      createOWSSolanaWallet: (network: string, opts: unknown) => unknown;
    }>("@faremeter/wallet-ows")) as {
      createOWSEvmWallet: (chain: { id: number; name: string }, opts: unknown) => unknown;
      createOWSSolanaWallet: (network: string, opts: unknown) => unknown;
    };

    const opts = { walletNameOrId: walletName, passphrase, vaultPath };

    if (cfg["evm"]) {
      const evmCfg = expectObject(cfg["evm"], "evm");
      const chain = expectObject(evmCfg["chain"], "evm.chain");
      const id = expectNumber(chain["id"], "evm.chain.id");
      const name = expectString(chain["name"], "evm.chain.name");
      const wallet = ows.createOWSEvmWallet({ id, name }, opts) as import(
        "@faremeter/wallet-evm"
      ).EvmWallet;
      return { kind: "evm", wallet, label, source: `frames:${walletName}` };
    }
    if (cfg["solana"]) {
      const solCfg = expectObject(cfg["solana"], "solana");
      const network = expectString(solCfg["network"], "solana.network");
      const wallet = ows.createOWSSolanaWallet(network, opts) as import(
        "./wallet/wallet-registry.ts"
      ).SolanaWalletShape;
      return { kind: "solana", wallet, label, source: `frames:${walletName}` };
    }
    throw new Error("frames wallet needs `evm:` or `solana:` block");
  },

  agentcash: async (cfg, label) => {
    // agentcash (npx agentcash@latest) stores a plain private key at
    // ~/.agentcash/wallet.json (EVM) or ~/.agentcash/solana-wallet.json
    // (Solana). It's not a hosted wallet — just a local key file.
    // Pay reads the same file and wraps it via faremeter's local wallet.
    //
    // Security note: pay sharing this wallet means agentcash CLI and pay
    // sign with the same private key. Funds are co-mingled across both
    // tools. That's intentional — most users want one wallet identity.
    //
    // Env vars X402_PRIVATE_KEY and X402_SOLANA_PRIVATE_KEY override the
    // file (matches agentcash's own precedence).
    // Resolve agentcash data dir: explicit dir > $AGENTCASH_DIR > $HOME/.agentcash > os.homedir()
    // Reading process.env.HOME directly (rather than os.homedir()) avoids
    // Bun's first-call cache so tests can set HOME in-process.
    const explicitDir =
      typeof cfg["dir"] === "string" ? (cfg["dir"] as string) : undefined;
    const home = process.env["HOME"] ?? homedir();
    const agentcashDir =
      explicitDir ??
      process.env["AGENTCASH_DIR"] ??
      pathResolve(home, ".agentcash");

    if (cfg["evm"]) {
      const evmCfg = expectObject(cfg["evm"], "evm");
      const chain = expectObject(evmCfg["chain"], "evm.chain");
      const id = expectNumber(chain["id"], "evm.chain.id");
      const name = expectString(chain["name"], "evm.chain.name");

      let privateKey: `0x${string}`;
      const envOverride = process.env["X402_PRIVATE_KEY"];
      if (envOverride) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(envOverride)) {
          throw new Error("X402_PRIVATE_KEY must be 0x + 64 hex chars");
        }
        privateKey = envOverride as `0x${string}`;
      } else {
        const walletPath = pathResolve(agentcashDir, "wallet.json");
        if (!existsSync(walletPath)) {
          throw new Error(
            `agentcash EVM wallet not found at ${walletPath} — run \`npx agentcash@latest accounts\` first`,
          );
        }
        const stored = JSON.parse(readFileSync(walletPath, "utf8")) as {
          privateKey?: string;
        };
        if (!stored.privateKey || !/^0x[0-9a-fA-F]{64}$/.test(stored.privateKey)) {
          throw new Error(
            `${walletPath} does not contain a valid 0x-hex privateKey`,
          );
        }
        privateKey = stored.privateKey as `0x${string}`;
      }

      const { createLocalWallet } = await loadOptionalPackage<{
        createLocalWallet: (
          chain: { id: number; name: string },
          privateKey: string,
        ) => Promise<import("@faremeter/wallet-evm").EvmWallet>;
      }>("@faremeter/wallet-evm");
      const wallet = await createLocalWallet({ id, name }, privateKey);
      return { kind: "evm", wallet, label, source: "agentcash" };
    }

    if (cfg["solana"]) {
      const solCfg = expectObject(cfg["solana"], "solana");
      const network = expectString(solCfg["network"], "solana.network");

      // Solana key is base58; faremeter/wallet-solana wants a Keypair.
      const sol = (await loadOptionalPackage<{
        createLocalWallet: (network: string, keypair: unknown) => Promise<unknown>;
      }>("@faremeter/wallet-solana")) as {
        createLocalWallet: (network: string, keypair: unknown) => Promise<unknown>;
      };
      const web3 = (await loadOptionalPackage<{
        Keypair: { fromSecretKey: (bytes: Uint8Array) => unknown };
      }>("@solana/web3.js")) as {
        Keypair: { fromSecretKey: (bytes: Uint8Array) => unknown };
      };
      const bs58 = (await loadOptionalPackage<{
        default: { decode: (s: string) => Uint8Array };
      }>("bs58")) as { default: { decode: (s: string) => Uint8Array } };

      let secretBytes: Uint8Array;
      const envOverride = process.env["X402_SOLANA_PRIVATE_KEY"];
      if (envOverride) {
        secretBytes = bs58.default.decode(envOverride);
      } else {
        const walletPath = pathResolve(agentcashDir, "solana-wallet.json");
        if (!existsSync(walletPath)) {
          throw new Error(
            `agentcash Solana wallet not found at ${walletPath} — run \`npx agentcash@latest accounts\` first`,
          );
        }
        const stored = JSON.parse(readFileSync(walletPath, "utf8")) as {
          privateKey?: string;
        };
        if (!stored.privateKey) {
          throw new Error(`${walletPath} missing privateKey`);
        }
        secretBytes = bs58.default.decode(stored.privateKey);
      }

      const keypair = web3.Keypair.fromSecretKey(secretBytes);
      const wallet = (await sol.createLocalWallet(network, keypair)) as import(
        "./wallet/wallet-registry.ts"
      ).SolanaWalletShape;
      return { kind: "solana", wallet, label, source: "agentcash" };
    }

    throw new Error("agentcash wallet needs `evm:` or `solana:` block");
  },

  ows: async (cfg, label) => {
    const ows = (await loadOptionalPackage<{
      createOWSEvmWallet: (chain: { id: number; name: string }, opts: unknown) => unknown;
      createOWSSolanaWallet: (network: string, opts: unknown) => unknown;
    }>("@faremeter/wallet-ows")) as {
      createOWSEvmWallet: (chain: { id: number; name: string }, opts: unknown) => unknown;
      createOWSSolanaWallet: (network: string, opts: unknown) => unknown;
    };
    const walletNameOrId = expectString(cfg["wallet_name"], "wallet_name");
    const passphrase = resolveSecret(
      expectString(cfg["passphrase"], "passphrase"),
      "passphrase",
    );
    const vaultPath =
      typeof cfg["vault_path"] === "string"
        ? (cfg["vault_path"] as string)
        : undefined;
    const opts = vaultPath
      ? { walletNameOrId, passphrase, vaultPath }
      : { walletNameOrId, passphrase };

    if (cfg["evm"]) {
      const evmCfg = expectObject(cfg["evm"], "evm");
      const chain = expectObject(evmCfg["chain"], "evm.chain");
      const id = expectNumber(chain["id"], "evm.chain.id");
      const name = expectString(chain["name"], "evm.chain.name");
      const wallet = ows.createOWSEvmWallet({ id, name }, opts) as import(
        "@faremeter/wallet-evm"
      ).EvmWallet;
      return { kind: "evm", wallet, label, source: "ows" };
    }
    if (cfg["solana"]) {
      const solCfg = expectObject(cfg["solana"], "solana");
      const network = expectString(solCfg["network"], "solana.network");
      const wallet = ows.createOWSSolanaWallet(network, opts) as import(
        "./wallet/wallet-registry.ts"
      ).SolanaWalletShape;
      return { kind: "solana", wallet, label, source: "ows" };
    }
    throw new Error("ows wallet needs `evm:` or `solana:` block");
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectObject(v: unknown, name: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`${name} must be an object`);
  }
  return v as Record<string, unknown>;
}
function expectString(v: unknown, name: string): string {
  if (typeof v !== "string") throw new Error(`${name} must be a string`);
  return v;
}
function expectNumber(v: unknown, name: string): number {
  if (typeof v !== "number") throw new Error(`${name} must be a number`);
  return v;
}

function resolveSecret(spec: string, fieldName: string): string {
  if (spec.startsWith("env:")) {
    const varName = spec.slice("env:".length);
    const v = process.env[varName];
    if (!v) {
      throw new Error(
        `${fieldName} references env var ${varName} which is not set`,
      );
    }
    return v;
  }
  return spec;
}

async function loadOptionalPackage<T>(pkg: string): Promise<T> {
  try {
    return (await import(pkg)) as T;
  } catch (e) {
    throw new Error(
      `package "${pkg}" is not installed. Add it with: bun add ${pkg}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Config-shape reference for each wallet kind. The walletInitCommand writes
// `evm`; users wanting other kinds hand-edit ~/.frames/pay/config.yaml.
//
//   wallets:
//     base:
//       kind: evm
//       label: prod
//       private_key: env:PAY_BASE_KEY      # or 0x-hex literal
//       chain: { id: 8453, name: Base }
//
//     base-with-crossmint:
//       kind: crossmint
//       label: treasury
//       network: solana                    # crossmint is Solana-only today
//       api_key: env:CROSSMINT_API_KEY
//       wallet_address: <crossmint-wallet-address>
//
//     base-with-ows:
//       kind: ows
//       label: prod
//       wallet_name: my-evm-vault          # OWS wallet name or id
//       passphrase: env:OWS_PASSPHRASE
//       vault_path: ~/.ows                 # optional, defaults to OWS standard
//       evm: { chain: { id: 8453, name: Base } }
//
//     solana:
//       kind: ows
//       label: prod
//       wallet_name: my-solana-vault
//       passphrase: env:OWS_PASSPHRASE
//       solana: { network: solana }
//
//     solana-local:
//       kind: solana
//       label: dev
//       network: solana                    # or solana-devnet
//       keypair_path: ~/.config/solana/id.json    # OR secret_key_b58: ...
//
//     base-via-frames:
//       kind: frames
//       label: shared-with-frames
//       evm: { chain: { id: 8453, name: Base } }
//       # passphrase: env:OWS_PASSPHRASE   (default; override if your env var differs)
//       # reads ~/.frames/secrets/org_default/x402.json → OWS wallet name
//       # then loads via OWS with $HOME/.ows as the vault.
//
//     base-via-agentcash:
//       kind: agentcash
//       label: shared-with-agentcash
//       evm: { chain: { id: 8453, name: Base } }
//       # reads ~/.agentcash/wallet.json (or X402_PRIVATE_KEY env override)
//       # SECURITY: pay and agentcash CLI both sign with the same key.
//
//     solana-via-agentcash:
//       kind: agentcash
//       label: shared-with-agentcash
//       solana: { network: solana }
//       # reads ~/.agentcash/solana-wallet.json (or X402_SOLANA_PRIVATE_KEY)
//
// ---------------------------------------------------------------------------

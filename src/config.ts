// Read ~/.frames/pay/config.yaml and turn it into a runtime config:
//   { walletRegistry, auditKey, defaultCatalog, manifestPath, lockPath, agent }
//
// File shape:
//
//   agent: claude:opus-4.7
//   catalog:
//     default: https://catalog.frames.ag
//   manifest_path: ./tools.yml          # default
//   lock_path: ./tools.lock             # default
//   wallets:
//     base-sepolia:
//       kind: evm
//       label: smoke
//       private_key: env:PAY_BASE_SEPOLIA_KEY     # or 0x-hex literal
//       chain:
//         id: 84532
//         name: Base Sepolia

import { existsSync, readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { createLocalWallet } from "@faremeter/wallet-evm";
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
    const e = entryRaw as Record<string, unknown>;
    const kind = e["kind"];
    const label = typeof e["label"] === "string" ? e["label"] : "default";
    if (kind === "evm") {
      const chainObj = (e["chain"] ?? {}) as Record<string, unknown>;
      const chainId = chainObj["id"];
      const chainName = chainObj["name"];
      if (typeof chainId !== "number" || typeof chainName !== "string") {
        throw new ConfigError(
          `wallets.${network}.chain must have numeric id + string name`,
        );
      }
      const pkSpec = e["private_key"];
      if (typeof pkSpec !== "string") {
        throw new ConfigError(
          `wallets.${network}.private_key must be a string (env:VAR or 0x...)`,
        );
      }
      const privateKey = resolvePrivateKey(pkSpec, network);
      const wallet = await createLocalWallet(
        { id: chainId, name: chainName },
        privateKey,
      );
      byNetwork[network] = { kind: "evm", wallet, label };
      continue;
    }
    throw new ConfigError(
      `wallets.${network}.kind="${kind}" not supported in v0.0.1 (supported: evm)`,
    );
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

function resolvePrivateKey(spec: string, network: string): `0x${string}` {
  if (spec.startsWith("env:")) {
    const varName = spec.slice("env:".length);
    const v = process.env[varName];
    if (!v) {
      throw new ConfigError(
        `wallets.${network}.private_key references env var ${varName} which is not set`,
      );
    }
    return ensureHex(v, `${network}.private_key (from env ${varName})`);
  }
  return ensureHex(spec, `${network}.private_key`);
}

function ensureHex(s: string, ctx: string): `0x${string}` {
  const trimmed = s.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new ConfigError(`${ctx} must be 0x-prefixed 32-byte hex`);
  }
  return trimmed as `0x${string}`;
}

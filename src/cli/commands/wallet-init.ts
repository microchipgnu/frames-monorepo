// `pay wallet init` — first-time wallet provisioning.
//
// Closes pre-mortem T2 ("OWS bootstrap UX missing"). Generates an EVM keypair
// (or imports one), picks sensible chain defaults, writes ~/.frames/pay/config.yaml
// with mode 0600, and prints faucet links + harness wiring instructions.

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  writeFileSync,
  existsSync,
  chmodSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { loadOrCreateAuditKey } from "../../wallet/audit-key.ts";
import { detectAll, type Detection } from "../detect.ts";

interface NetworkPreset {
  id: number;
  name: string;
  testnet: boolean;
  faucets?: { gas?: string; usdc?: string };
}

const NETWORK_PRESETS: Record<string, NetworkPreset> = {
  "base-sepolia": {
    id: 84532,
    name: "Base Sepolia",
    testnet: true,
    faucets: {
      gas: "https://www.alchemy.com/faucets/base-sepolia",
      usdc: "https://faucet.circle.com/",
    },
  },
  base: { id: 8453, name: "Base", testnet: false },
  ethereum: { id: 1, name: "Ethereum", testnet: false },
  optimism: { id: 10, name: "Optimism", testnet: false },
  arbitrum: { id: 42161, name: "Arbitrum One", testnet: false },
};

interface ParsedArgs {
  network: string;
  import?: string;
  label: string;
  agent: string;
  force: boolean;
  auto: boolean;
  use?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = {
    network: "base-sepolia",
    label: "default",
    agent: "claude:opus-4.7",
    force: false,
    auto: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--network") out.network = args[++i] ?? "";
    else if (a === "--import") out.import = args[++i] ?? "";
    else if (a === "--label") out.label = args[++i] ?? "";
    else if (a === "--agent") out.agent = args[++i] ?? "";
    else if (a === "--force") out.force = true;
    else if (a === "--auto") out.auto = true;
    else if (a === "--use") out.use = args[++i] ?? "";
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a !== undefined) {
      console.error(`unknown flag: ${a}`);
      printHelp();
      process.exit(1);
    }
  }
  return out;
}

function printHelp() {
  console.log(`pay wallet init — provision a wallet for paid tool calls

Usage:
  pay wallet init                                # generate a fresh EVM wallet (default)
  pay wallet init --auto                         # detect existing wallets, add all of them
  pay wallet init --use <kind>                   # add a specific detected wallet
  pay wallet init --network <name> [--import 0xHEX] [--label S] [--agent ID] [--force]

Detection-driven flags:
  --auto             Probe for existing wallets (agentwallet, agentcash, frames,
                     OWS, Solana CLI, X402_*_PRIVATE_KEY) and add every one to
                     config. Use \`pay wallet detect\` to preview first.
  --use <kind>       Add only the detected wallet matching <kind>. Run
                     \`pay wallet detect\` to list available kinds.

Generation flags:
  --network <name>   Chain preset. Default: base-sepolia.
                     Available: ${Object.keys(NETWORK_PRESETS).join(", ")}
  --import <hex>     Use an existing private key instead of generating one.
                     Must be 0x + 64 hex chars.
  --label <s>        Human label for receipts. Default: default.

Common:
  --agent <id>       Agent identity baked into receipts. Default: claude:opus-4.7.
  --force            Overwrite an existing config.yaml.
  --help             Show this help.

Writes ~/.frames/pay/config.yaml (mode 0600) and ~/.frames/pay/audit-key.json.
`);
}

export async function walletInitCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  // Auto-detect path: probe + write all (or one) detected wallets, no fresh keygen.
  if (parsed.auto || parsed.use) {
    return await initFromDetected(parsed);
  }

  const preset = NETWORK_PRESETS[parsed.network];
  if (!preset) {
    console.error(
      `Unknown --network "${parsed.network}". Available: ${Object.keys(NETWORK_PRESETS).join(", ")}`,
    );
    process.exit(1);
  }

  const configPath = resolve(homedir(), ".frames", "pay", "config.yaml");
  if (existsSync(configPath) && !parsed.force) {
    console.error(`Config already exists at ${configPath}`);
    console.error(`Pass --force to overwrite.`);
    process.exit(1);
  }

  console.log();
  console.log(`Provisioning pay wallet on ${preset.name} (${parsed.network})…`);

  // 1. EVM keypair
  let privateKey: `0x${string}`;
  if (parsed.import) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(parsed.import)) {
      console.error("--import must be 0x + 64 hex chars (32 bytes)");
      process.exit(1);
    }
    privateKey = parsed.import as `0x${string}`;
    console.log("  imported existing private key");
  } else {
    privateKey = generatePrivateKey();
    console.log("  generated fresh keypair");
  }
  const account = privateKeyToAccount(privateKey);
  console.log(`  address: ${account.address}`);

  // 2. Audit key (Ed25519) — generated if absent
  const auditKey = await loadOrCreateAuditKey();
  console.log(`  audit key: ed25519 ${auditKey.publicKeyHex.slice(0, 16)}…`);

  // 3. Write config.yaml
  const config = {
    agent: parsed.agent,
    catalog: { default: "https://catalog.frames.ag" },
    manifest_path: "./tools.yml",
    lock_path: "./tools.lock",
    wallets: {
      [parsed.network]: {
        kind: "evm",
        label: parsed.label,
        private_key: privateKey,
        chain: { id: preset.id, name: preset.name },
      },
    },
  };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, yamlStringify(config));
  chmodSync(configPath, 0o600);
  console.log(`  wrote ${configPath} (mode 0600)`);

  // 4. Next steps
  console.log();
  console.log("Next steps:");
  console.log();
  if (preset.testnet) {
    console.log(`  1. Fund the wallet (free testnet faucets):`);
    if (preset.faucets?.gas) console.log(`       gas:  ${preset.faucets.gas}`);
    if (preset.faucets?.usdc)
      console.log(`       USDC: ${preset.faucets.usdc}  → pick "${preset.name}"`);
    console.log(`     Address: ${account.address}`);
  } else {
    console.log(`  1. Fund the wallet (mainnet — real money):`);
    console.log(`       Send USDC + a small amount of native gas to`);
    console.log(`       ${account.address}`);
  }
  console.log();
  console.log(`  2. Wire pay-mcp into your harness's .mcp.json:`);
  console.log(`       { "mcpServers": { "pay": { "command": "bunx", "args": ["-y", "@frames-ag/pay-mcp"] } } }`);
  console.log();
  console.log(`     (Until @frames-ag/pay-mcp is published, point at the local source:`);
  console.log(`      "command": "bun", "args": ["run", "<path-to-pay>/src/mcp/bin.ts"])`);
  console.log();
  console.log(`  3. In a project directory, add tools and start paying:`);
  console.log(`       pay add https://catalog.frames.ag/tools/frames.test.post.api-echo --as test`);
  console.log(`       pay tool test --params '{"data":"hello"}'`);
  console.log();
  if (!preset.testnet) {
    console.log(
      `  ⚠  This is mainnet. Lose ~/.frames/pay/config.yaml = lose access to that wallet.`,
    );
    console.log(`     Back it up.`);
    console.log();
  }

  // Surface other detected wallets so users know they could plug those in too.
  const otherDetected = detectAll();
  if (otherDetected.length > 0) {
    console.log(
      `  ℹ  Detected ${otherDetected.length} existing wallet${otherDetected.length === 1 ? "" : "s"} you could also wire in:`,
    );
    for (const d of otherDetected) {
      console.log(`       • ${d.label}`);
    }
    console.log(`     Run \`pay wallet detect\` for snippets, or \`pay wallet init --auto\`.`);
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Detection-driven init: read existing wallets and write them into config.yaml
// ---------------------------------------------------------------------------

async function initFromDetected(parsed: ParsedArgs): Promise<void> {
  const detections = detectAll();
  if (detections.length === 0) {
    console.error("No existing wallets detected.");
    console.error("Run `pay wallet init --network base-sepolia` to generate a fresh EVM wallet,");
    console.error("or set up an external wallet first (agentcash, agentwallet, OWS, …).");
    process.exit(1);
  }

  const configPath = resolve(homedir(), ".frames", "pay", "config.yaml");
  // Read existing config if any (so we merge instead of overwrite when --force not set).
  let existingDoc: Record<string, unknown> | null = null;
  if (existsSync(configPath)) {
    if (!parsed.force) {
      console.error(`Config already exists at ${configPath}`);
      console.error(`Pass --force to overwrite, or hand-edit to add detected wallets.`);
      process.exit(1);
    }
    try {
      existingDoc = yamlParse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    } catch {}
  }

  let chosen: Detection[];
  if (parsed.auto) {
    // Only ONE wallet per network — first detection wins. Probe order
    // (in detect.ts) is the implicit priority: agentwallet > agentcash >
    // frames > ows > solana-cli > env vars.
    const claimed = new Set<string>();
    chosen = [];
    for (const d of detections) {
      const novel = d.networks.filter((n) => !claimed.has(n));
      if (novel.length === 0) {
        console.log(
          `  ↷ skipping ${d.label} — networks (${d.networks.join(", ")}) already claimed`,
        );
        continue;
      }
      // If d covers networks that overlap with an earlier detection, only
      // include the snippet portion for the novel networks. For simplicity
      // we accept the full snippet when at least one network is novel; in
      // practice this rarely matters since most detections are for one or two
      // networks and the priority order picks a good default.
      novel.forEach((n) => claimed.add(n));
      chosen.push(d);
    }
  } else if (parsed.use) {
    const match = detections.filter((d) => d.kind === parsed.use);
    if (match.length === 0) {
      console.error(
        `--use ${parsed.use} not found. Detected kinds: ${detections.map((d) => d.kind).join(", ")}`,
      );
      process.exit(1);
    }
    chosen = match;
  } else {
    // Should not reach here — parser sets --auto or --use before calling.
    process.exit(1);
    return;
  }

  console.log();
  console.log(`Provisioning pay from ${chosen.length} detected wallet${chosen.length === 1 ? "" : "s"}:`);
  for (const d of chosen) {
    console.log(`  • ${d.label} (${d.source})`);
  }

  // Audit key
  const auditKey = await loadOrCreateAuditKey();
  console.log(`  audit key: ed25519 ${auditKey.publicKeyHex.slice(0, 16)}…`);

  // Build YAML by concatenating snippets under wallets:
  // (We don't try to parse the user's stanza — yamlSnippet is the source of truth.)
  const head = `agent: ${parsed.agent}
catalog:
  default: https://catalog.frames.ag
manifest_path: ./tools.yml
lock_path: ./tools.lock
wallets:
`;
  const body = chosen.map((d) => d.yamlSnippet).filter((s) => s.length > 0).join("\n");

  // Preserve catalog override if present in existing config
  let finalDoc = head + body + "\n";
  if (existingDoc && typeof existingDoc["catalog"] === "object") {
    // Re-emit with original catalog block — leave for now; merging YAML
    // safely is tricky and out of scope for v0 detection UX.
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, finalDoc);
  chmodSync(configPath, 0o600);
  console.log(`  wrote ${configPath} (mode 0600)`);

  // Reminders for kinds that need extra setup
  console.log();
  for (const d of chosen) {
    if (d.kind === "frames" || d.kind === "ows") {
      console.log(`  ℹ  ${d.label} requires the OWS passphrase. Set it:`);
      console.log(`       export OWS_PASSPHRASE='<your-vault-passphrase>'`);
    }
    if (d.kind === "ows" && d.networks.length === 0) {
      console.log(`  ℹ  Edit ${configPath} to set wallet_name to one of the vaults in ${d.source}`);
    }
  }
  console.log();
  console.log(`  Next: bunx -y @frames-ag/pay-mcp  (or wire into .mcp.json)`);
  console.log();
}

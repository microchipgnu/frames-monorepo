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
} from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { stringify as yamlStringify } from "yaml";
import { loadOrCreateAuditKey } from "../../wallet/audit-key.ts";

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
}

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = {
    network: "base-sepolia",
    label: "default",
    agent: "claude:opus-4.7",
    force: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--network") out.network = args[++i] ?? "";
    else if (a === "--import") out.import = args[++i] ?? "";
    else if (a === "--label") out.label = args[++i] ?? "";
    else if (a === "--agent") out.agent = args[++i] ?? "";
    else if (a === "--force") out.force = true;
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
  pay wallet init [--network <name>] [--import <0xhex>] [--label <s>] [--agent <id>] [--force]

Options:
  --network <name>   Chain preset. Default: base-sepolia.
                     Available: ${Object.keys(NETWORK_PRESETS).join(", ")}
  --import <hex>     Use an existing private key instead of generating one.
                     Must be 0x + 64 hex chars.
  --label <s>        Human label for receipts. Default: default.
  --agent <id>       Agent identity baked into receipts. Default: claude:opus-4.7.
  --force            Overwrite an existing config.yaml.
  --help             Show this help.

Writes ~/.frames/pay/config.yaml (mode 0600) and ~/.frames/pay/audit-key.json.
The private key is written into config.yaml — keep that file private.
`);
}

export async function walletInitCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

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
}

// `pay wallet detect` — read-only probe for existing wallets in the environment.

import { detectAll } from "../detect.ts";

export async function walletDetectCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`pay wallet detect — find existing wallets in this environment

Probes well-known paths and env vars for wallets you can plug into pay:
  ~/.agentwallet/config.json    (hosted at frames.ag)
  ~/.agentcash/{wallet,solana-wallet}.json
  ~/.frames/secrets/org_default/x402.json
  ~/.ows/wallets/
  ~/.config/solana/id.json
  X402_PRIVATE_KEY, X402_SOLANA_PRIVATE_KEY env vars

To wire one in: copy the YAML snippet under "Suggested config:" into
~/.frames/pay/config.yaml under "wallets:". Or run:
  pay wallet init --use <kind>     (specific kind)
  pay wallet init --auto           (write all detected)
`);
    return;
  }

  const detections = detectAll();
  if (detections.length === 0) {
    console.log();
    console.log("No existing wallets detected.");
    console.log();
    console.log("Run `pay wallet init` to generate a fresh EVM wallet,");
    console.log("or set up an external one (agentcash, agentwallet, OWS, etc.).");
    console.log();
    return;
  }

  console.log();
  console.log(`Found ${detections.length} wallet${detections.length === 1 ? "" : "s"}:`);
  console.log();
  for (const d of detections) {
    console.log(`  • ${d.label}`);
    console.log(`    source:  ${d.source}`);
    if (d.address) console.log(`    address: ${d.address}`);
    if (d.networks.length > 0) {
      console.log(`    networks: ${d.networks.join(", ")}`);
    }
    console.log();
  }
  console.log("Suggested configs (you can stack multiple wallets per network — pay");
  console.log("tries them in declaration order and falls through on failure. Or copy a");
  console.log("single block into ~/.frames/pay/config.yaml under `wallets:`):");
  console.log();
  for (const d of detections) {
    if (d.yamlSnippet) {
      console.log(`# ${d.label}`);
      console.log("wallets:");
      console.log(d.yamlSnippet);
      console.log();
    }
  }
  console.log("Or run:");
  console.log(`  pay wallet init --auto                  # write all detected`);
  for (const d of detections) {
    console.log(`  pay wallet init --use ${d.kind.padEnd(12)} # write only ${d.label}`);
  }
  console.log();
}

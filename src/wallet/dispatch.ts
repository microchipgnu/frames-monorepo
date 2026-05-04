// payForTool — the orchestrator. Implements the SPEC WalletAdapter.
//
//   1. Resolve the descriptor (lock → manifest → URL → catalog).
//   2. Validate params (deferred to Stage 1c — currently passthrough).
//   3. Check budget (deferred to Stage 1c).
//   4. Pick faremeter handler(s) from the protocol bridge.
//   5. Build the invocation, wrap fetch, call the seller.
//   6. Build a signed receipt from the response.
//   7. Return { body, receipt }.

import { wrap } from "@faremeter/fetch";
import type {
  PayForToolInput,
  PayForToolResult,
  Receipt,
  ToolDescriptor,
} from "../types.ts";
import { resolveTool } from "../manifest/resolve.ts";
import type { WalletRegistry } from "./wallet-registry.ts";
import { buildHandlers, BridgeError } from "./faremeter-bridge.ts";
import { buildReceipt } from "./receipt.ts";
import type { AuditKeyPair } from "./audit-key.ts";
import { canonicalize } from "../canonical.ts";
import { getBalanceForDescriptor, BalanceError } from "./balance.ts";

export class DispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchError";
  }
}

export interface DispatchContext {
  registry: WalletRegistry;
  auditKey: AuditKeyPair;
  /** Optional fetch override (test seam). */
  fetchImpl?: typeof fetch;
  /**
   * Pre-flight balance check policy:
   *   "off"     — never check balance before signing (fastest)
   *   "warn"    — log a warning if balance < price_hint, proceed anyway
   *   "block"   — throw InsufficientBalance if balance < price_hint (default)
   * Setting price_hint vs. actual settled cost: the seller's 402 challenge
   * is authoritative on price; this is a hint check.
   */
  balancePolicy?: "off" | "warn" | "block";
}

export class InsufficientBalanceError extends Error {
  constructor(
    message: string,
    public readonly balance: string,
    public readonly required: string,
    public readonly currency: string,
    public readonly network: string,
  ) {
    super(message);
    this.name = "InsufficientBalanceError";
  }
}

export async function payForTool(
  input: PayForToolInput,
  ctx: DispatchContext,
): Promise<PayForToolResult> {
  // 1. Resolve descriptor.
  const resolved = await resolveTool(input.name, {
    ...(input.manifest !== undefined && { manifest: input.manifest }),
    ...(input.lock !== undefined && { lock: input.lock }),
    ...(input.catalog !== undefined && { catalog: input.catalog }),
    ...(ctx.fetchImpl !== undefined && { fetchImpl: ctx.fetchImpl }),
  });
  const descriptor = resolved.descriptor;

  // 4. Pick handler(s) via the bridge.
  let bridge;
  try {
    bridge = buildHandlers(descriptor, ctx.registry);
  } catch (e) {
    if (e instanceof BridgeError) {
      throw new DispatchError(`bridge: ${e.message}`);
    }
    throw e;
  }

  // 4.5. Pre-flight balance check (skipped for free / delegated paths).
  const policy = ctx.balancePolicy ?? "block";
  if (policy !== "off" && bridge.walletEntry && !bridge.free) {
    const priceHint = descriptor.payment.price_hint;
    if (priceHint && priceHint !== "dynamic") {
      try {
        const bal = await getBalanceForDescriptor(descriptor, bridge.walletEntry);
        if (bal) {
          const requiredAmount = parseFloat(priceHint);
          const haveAmount = parseFloat(bal.formatted);
          if (
            !Number.isNaN(requiredAmount) &&
            !Number.isNaN(haveAmount) &&
            haveAmount < requiredAmount
          ) {
            const msg =
              `insufficient balance: have ${bal.formatted} ${descriptor.payment.currency ?? ""} on ${bal.network}, ` +
              `need at least ${priceHint} (per descriptor.payment.price_hint)`;
            if (policy === "warn") {
              console.warn(`[pay] ${msg} — proceeding (policy: warn)`);
            } else {
              throw new InsufficientBalanceError(
                msg,
                bal.formatted,
                priceHint,
                descriptor.payment.currency ?? "UNKNOWN",
                bal.network,
              );
            }
          }
        }
      } catch (e) {
        if (e instanceof InsufficientBalanceError) throw e;
        if (e instanceof BalanceError) {
          // Balance lookup failed — log and proceed; seller's 402 is authoritative.
          console.warn(`[pay] balance pre-flight failed (${e.message}) — proceeding`);
        } else {
          // Unexpected: surface to caller.
          throw e;
        }
      }
    }
  }

  // 5. Build invocation.
  const invocationUrl = descriptor.invocation.url;
  const method = descriptor.invocation.method.toUpperCase();
  const requestBody =
    method === "GET" || method === "HEAD" ? undefined : JSON.stringify(input.params);
  const requestHash = await sha256Of(requestBody ?? "");

  const fetchImpl = ctx.fetchImpl ?? fetch;

  // ---- Delegated provider path ----
  // The bridge returned a delegated wallet entry. Skip faremeter and POST
  // the entire request to the provider's hosted dispatcher.
  if (bridge.walletEntry?.kind === "delegated") {
    const entry = bridge.walletEntry;
    if (entry.provider === "agentwallet") {
      return await dispatchViaAgentwallet({
        descriptor,
        descriptor_id: resolved.descriptor_id,
        params: input.params,
        method,
        url: invocationUrl,
        requestHash,
        registry: ctx.registry,
        auditKey: ctx.auditKey,
        wallet: entry,
        fetchImpl,
        ...(input.name !== descriptor.id && resolved.via !== "url"
          ? { tool_local_name: input.name }
          : {}),
      });
    }
    throw new DispatchError(
      `delegated provider "${entry.provider}" not yet supported`,
    );
  }

  const fetcher = bridge.free
    ? fetchImpl
    : wrap(fetchImpl, {
        handlers: bridge.handlers,
        mppHandlers: bridge.mppHandlers,
      });

  const t0 = Date.now();
  const res = await fetcher(invocationUrl, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(requestBody !== undefined && { body: requestBody }),
  });
  const elapsedMs = Date.now() - t0;

  if (!res.ok) {
    const text = await res.text();
    throw new DispatchError(
      `seller returned ${res.status}: ${text.slice(0, 200)}`,
    );
  }

  const responseText = await res.text();
  const responseHash = await sha256Of(responseText);
  const body = JSON.parse(responseText) as unknown;

  // 6. Extract settled payment metadata.
  // The test endpoint at registry.frames.ag returns { ..., payment: { network, payer, txHash } }
  // Sniff that shape; otherwise fall back to descriptor hints.
  const settled = sniffSettlement(body, descriptor);

  // 7. Build receipt.
  const network = descriptor.payment.network ?? "unknown";
  const wallet_id = ctx.registry.walletId(network) ?? "unknown:unknown";
  const wallet_address =
    ctx.registry.addressFor(network) ?? settled.payer ?? "unknown";
  const amount = bridge.free ? "0" : settled.amount ?? descriptor.payment.price_hint ?? "0";
  const currency = bridge.free
    ? descriptor.payment.currency ?? "NONE"
    : descriptor.payment.currency ?? "UNKNOWN";

  const receiptInput = {
    descriptor,
    descriptor_id: resolved.descriptor_id,
    ...(input.name !== descriptor.id && resolved.via !== "url"
      ? { tool_local_name: input.name }
      : {}),
    params: input.params,
    wallet_id,
    wallet_address,
    amount,
    currency,
    network,
    ...(descriptor.payment.facilitator !== undefined && {
      facilitator_url: descriptor.payment.facilitator,
    }),
    ...(settled.tx_hash !== undefined && { tx_hash: settled.tx_hash }),
    request_hash: requestHash,
    response_hash: responseHash,
    agent: ctx.registry.agent(),
    auditKey: ctx.auditKey,
  };

  const receipt: Receipt = await buildReceipt(receiptInput);
  // elapsedMs is currently unused but kept locally for future timing receipts.
  void elapsedMs;
  return { body, receipt };
}

interface SettledMetadata {
  amount?: string;
  payer?: string;
  tx_hash?: string;
}

function sniffSettlement(body: unknown, descriptor: ToolDescriptor): SettledMetadata {
  // Frames Registry / x402v2 sellers commonly return a top-level "payment" object.
  if (typeof body === "object" && body !== null && "payment" in body) {
    const p = (body as { payment: unknown }).payment;
    if (typeof p === "object" && p !== null) {
      const obj = p as Record<string, unknown>;
      return {
        ...(typeof obj["amount"] === "string" && { amount: obj["amount"] }),
        ...(typeof obj["payer"] === "string" && { payer: obj["payer"] }),
        ...(typeof obj["txHash"] === "string" && { tx_hash: obj["txHash"] }),
      };
    }
  }
  // Fall back to descriptor's price_hint
  return {
    ...(descriptor.payment.price_hint !== undefined && {
      amount: descriptor.payment.price_hint,
    }),
  };
}

async function sha256Of(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  let s = "";
  for (const b of new Uint8Array(hash)) s += String.fromCharCode(b);
  const b64 = btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return "sha256-" + b64;
}

// Re-export canonicalize for any caller that wants it (params_hash etc.)
export { canonicalize };

// ---------------------------------------------------------------------------
// Delegated dispatch — agentwallet at frames.ag
// ---------------------------------------------------------------------------

import type { ToolDescriptor as ToolDescriptorAlias } from "../types.ts";
import type { WalletEntry } from "./wallet-registry.ts";

interface AgentwalletDispatchInput {
  descriptor: ToolDescriptorAlias;
  descriptor_id: string;
  params: unknown;
  method: string;
  url: string;
  requestHash: string;
  tool_local_name?: string;
  registry: import("./wallet-registry.ts").WalletRegistry;
  auditKey: import("./audit-key.ts").AuditKeyPair;
  wallet: Extract<WalletEntry, { kind: "delegated"; provider: "agentwallet" }>;
  fetchImpl: typeof fetch;
}

interface AgentwalletFetchResponse {
  success?: boolean;
  response?: {
    status?: number;
    body?: unknown;
    contentType?: string;
  };
  payment?: {
    chain?: string;
    amountFormatted?: string;
    recipient?: string;
    transactionHash?: string;
    txHash?: string;
  };
  paid?: boolean;
  attempts?: number;
  duration?: number;
  error?: string;
}

async function dispatchViaAgentwallet(
  input: AgentwalletDispatchInput,
): Promise<PayForToolResult> {
  const { wallet, descriptor, fetchImpl } = input;
  const fetchUrl = `${wallet.baseUrl.replace(/\/$/, "")}/api/wallets/${encodeURIComponent(wallet.username)}/actions/x402/fetch`;

  const reqBody = {
    url: input.url,
    method: input.method,
    body: input.method === "GET" || input.method === "HEAD" ? undefined : input.params,
  };

  const res = await fetchImpl(fetchUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${wallet.apiToken}`,
    },
    body: JSON.stringify(reqBody),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new DispatchError(
      `agentwallet ${res.status}: ${text.slice(0, 200)}`,
    );
  }

  const responseText = await res.text();
  const responseHash = await sha256Of(responseText);
  const aw = JSON.parse(responseText) as AgentwalletFetchResponse;

  if (aw.success === false) {
    throw new DispatchError(`agentwallet failed: ${aw.error ?? "(no error message)"}`);
  }

  const innerStatus = aw.response?.status ?? 0;
  if (innerStatus < 200 || innerStatus >= 300) {
    throw new DispatchError(
      `seller (via agentwallet) returned ${innerStatus}: ${JSON.stringify(aw.response?.body).slice(0, 200)}`,
    );
  }

  const body = aw.response?.body;

  // Parse "0.01 USDC" into amount + currency
  const { amount, currency } = parseAmountFormatted(
    aw.payment?.amountFormatted,
    descriptor.payment.currency,
  );
  const tx_hash = aw.payment?.transactionHash ?? aw.payment?.txHash;
  const network = mapChainToNetwork(aw.payment?.chain) ?? descriptor.payment.network ?? "unknown";
  const wallet_id = `agentwallet:${wallet.label}`;
  const wallet_address =
    network === "solana" || network.startsWith("solana")
      ? wallet.addresses.solana ?? "unknown"
      : wallet.addresses.evm ?? "unknown";

  const receipt = await buildReceipt({
    descriptor,
    descriptor_id: input.descriptor_id,
    ...(input.tool_local_name !== undefined && {
      tool_local_name: input.tool_local_name,
    }),
    params: input.params,
    wallet_id,
    wallet_address,
    amount,
    currency,
    network,
    ...(tx_hash !== undefined && { tx_hash }),
    request_hash: input.requestHash,
    response_hash: responseHash,
    agent: input.registry.agent(),
    auditKey: input.auditKey,
  });

  return { body, receipt };
}

function parseAmountFormatted(
  formatted: string | undefined,
  fallbackCurrency: string | undefined,
): { amount: string; currency: string } {
  if (!formatted) {
    return { amount: "0", currency: fallbackCurrency ?? "UNKNOWN" };
  }
  // "0.01 USDC" → ["0.01", "USDC"]
  const m = formatted.trim().match(/^([\d.]+)\s+(\S+)$/);
  if (m) return { amount: m[1]!, currency: m[2]! };
  return { amount: formatted, currency: fallbackCurrency ?? "UNKNOWN" };
}

function mapChainToNetwork(chain: string | undefined): string | undefined {
  if (!chain) return undefined;
  // CAIP-2 → human-readable network
  const map: Record<string, string> = {
    "eip155:1": "ethereum",
    "eip155:8453": "base",
    "eip155:84532": "base-sepolia",
    "eip155:10": "optimism",
    "eip155:137": "polygon",
    "eip155:42161": "arbitrum",
  };
  if (map[chain]) return map[chain];
  if (chain.startsWith("solana:")) return "solana-mainnet";
  return chain;
}

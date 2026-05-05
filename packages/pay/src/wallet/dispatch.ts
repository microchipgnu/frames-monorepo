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
  PaymentOption,
  Receipt,
  ToolDescriptor,
} from "../types.ts";
import { resolveTool } from "../manifest/resolve.ts";
import type { WalletEntry, WalletRegistry } from "./wallet-registry.ts";
import { addressOf, walletIdOf } from "./wallet-registry.ts";
import { buildHandlers, BridgeError } from "./faremeter-bridge.ts";
import { buildReceipt } from "./receipt.ts";
import type { AuditKeyPair } from "./audit-key.ts";
import { canonicalize } from "../canonical.ts";
import { getBalanceForDescriptor, BalanceError } from "./balance.ts";
import {
  FilesystemStore,
  defaultFallbackPath,
  type ReceiptStore,
} from "../stores/filesystem.ts";
import {
  detectFrameDataset,
  appendToolInvokedEvent,
  buildToolPayload,
} from "../frame/event.ts";
import type { ToolInvocationPayload } from "../types.ts";

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
  /**
   * Receipt persistence override. When omitted, dispatch uses a default
   * resolver:
   *   - If a frame dataset is detected (PAY_FRAME_DATASET env or cwd has
   *     schema.yml + events.ndjson): append tool.invoked event to that
   *     dataset's events.ndjson.
   *   - Else: append to ~/.frames/pay/events.ndjson (explicit-call fallback).
   *
   * Pass `{ frameDatasetPath: null, store: customStore }` to fully override.
   * Pass `{ skipPersistence: true }` to disable (used by smoke tests that
   * want to avoid filesystem side effects).
   */
  persistence?: {
    frameDatasetPath?: string | null;
    store?: ReceiptStore;
    skipPersistence?: boolean;
  };
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

  // 4. Select a viable payment option.
  // Walks descriptor.payment (canonical) + descriptor.payment.accepts[]
  // (alternates). For each, checks if a wallet is configured for that
  // network and (under "block" policy) that the wallet has sufficient
  // balance for the option's price_hint. Picks the first option that
  // passes — falls through to throw if none do.
  const policy = ctx.balancePolicy ?? "block";
  const selection = await selectPaymentOption(descriptor, ctx.registry, policy);
  const bridge = selection.bridge;
  // The "effective" descriptor reflects which option was chosen — used
  // for receipt fields (wallet_id, network, currency, …).
  const effectiveDescriptor = selection.effectiveDescriptor;

  // 5. Build invocation. Use the effective descriptor (chosen accept) so
  // receipt metadata reflects what was actually settled.
  const invocationUrl = effectiveDescriptor.invocation.url;
  const method = effectiveDescriptor.invocation.method.toUpperCase();
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
        descriptor: effectiveDescriptor,
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
  const settled = sniffSettlement(body, effectiveDescriptor);

  // 7. Build receipt.
  const network = effectiveDescriptor.payment.network ?? "unknown";
  // Use the entry that was *chosen* by selectPaymentOption — not just the
  // primary on this network — so receipts reflect the wallet that actually
  // signed.
  const chosenEntry = bridge.walletEntry;
  const wallet_id = chosenEntry
    ? walletIdOf(chosenEntry)
    : ctx.registry.walletId(network) ?? "unknown:unknown";
  const wallet_address =
    (chosenEntry ? addressOf(chosenEntry, network) : ctx.registry.addressFor(network)) ??
    settled.payer ??
    "unknown";
  const amount = bridge.free ? "0" : settled.amount ?? effectiveDescriptor.payment.price_hint ?? "0";
  const currency = bridge.free
    ? effectiveDescriptor.payment.currency ?? "NONE"
    : effectiveDescriptor.payment.currency ?? "UNKNOWN";

  const receiptInput = {
    descriptor: effectiveDescriptor,
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
    ...(effectiveDescriptor.payment.facilitator !== undefined && {
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
  const toolPayload = buildToolPayload(input.params, responseText);
  await persistReceipt(receipt, ctx, toolPayload);
  return { body, receipt };
}

/**
 * Persist a receipt per the dispatcher's two-tier policy:
 *   1. Frame dataset's events.ndjson — when frame context is detected
 *      (canonical per SPEC §"Frame integration").
 *   2. ~/.frames/pay/events.ndjson — fallback for explicit-call mode.
 *
 * Persistence failures are logged but do not fail the call: the in-memory
 * receipt has already been built and is being returned to the caller, who
 * can persist it themselves if they care. Sync-flush guarantee from SPEC
 * applies to the IN-PROCESS receipt — disk writes are best-effort cache.
 */
async function persistReceipt(
  receipt: Receipt,
  ctx: DispatchContext,
  toolPayload?: ToolInvocationPayload,
): Promise<void> {
  const policy = ctx.persistence ?? {};
  if (policy.skipPersistence) return;

  const datasetPath =
    policy.frameDatasetPath !== undefined
      ? policy.frameDatasetPath
      : detectFrameDataset();

  try {
    if (datasetPath) {
      await appendToolInvokedEvent(datasetPath, receipt, toolPayload);
      return;
    }
    const store = policy.store ?? new FilesystemStore(defaultFallbackPath());
    await store.append(receipt, toolPayload);
  } catch (e) {
    process.stderr.write(
      `pay: receipt persistence failed (non-fatal): ${(e as Error).message}\n`,
    );
  }
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
// Multi-option wallet selection
// ---------------------------------------------------------------------------

interface SelectionAttempt {
  option: PaymentOption;
  /**
   * Identifier of the wallet entry that was tried. "—" when the attempt
   * didn't get as far as picking an entry (free path, no wallets on network).
   */
  walletId: string;
  status:
    | "selected"
    | "no_handler"
    | "no_wallet_for_network"
    | "insufficient_balance"
    | "balance_check_failed"
    | "skipped";
  detail?: string;
}

interface SelectionResult {
  bridge: ReturnType<typeof buildHandlers>;
  effectiveDescriptor: ToolDescriptor;
  attempts: SelectionAttempt[];
  chosen: PaymentOption;
}

/**
 * Walk descriptor.payment (canonical option) + descriptor.payment.accepts[]
 * (alternates), and within each option iterate the wallet entries configured
 * for that network. Picks the first (option, entry) pair whose bridge builds
 * cleanly and (under "block" policy) whose balance covers the price_hint.
 *
 * Two axes of fallback:
 *   - Across options: descriptor offered Base + Solana, no Base wallet → try Solana.
 *   - Within an option: two wallets on Base, first has no USDC → try second.
 *
 * Throws DispatchError listing all attempts if nothing is viable.
 */
async function selectPaymentOption(
  descriptor: ToolDescriptor,
  registry: WalletRegistry,
  policy: "off" | "warn" | "block",
): Promise<SelectionResult> {
  const options: PaymentOption[] = [];
  options.push({
    protocol: descriptor.payment.protocol,
    ...(descriptor.payment.network !== undefined && { network: descriptor.payment.network }),
    ...(descriptor.payment.currency !== undefined && { currency: descriptor.payment.currency }),
    ...(descriptor.payment.asset !== undefined && { asset: descriptor.payment.asset }),
    ...(descriptor.payment.price_hint !== undefined && { price_hint: descriptor.payment.price_hint }),
  } as PaymentOption);
  if (Array.isArray(descriptor.payment.accepts)) {
    options.push(...descriptor.payment.accepts);
  }

  const attempts: SelectionAttempt[] = [];
  for (const option of options) {
    const effective = applyOption(descriptor, option);

    // Free path — proto === "none" — has no entry. Build once, return.
    if (effective.payment.protocol === "none") {
      // The bridge ignores its entry argument on the free path; pass any
      // entry as a placeholder. (We expect no networks with a free path
      // in practice; this is just defensive.)
      const placeholder = registry.entriesFor(effective.payment.network ?? "")[0];
      if (placeholder) {
        const bridge = buildHandlers(effective, placeholder);
        attempts.push({ option, walletId: walletIdOf(placeholder), status: "selected", detail: "free path" });
        return { bridge, effectiveDescriptor: effective, attempts, chosen: option };
      }
      // Even free paths need *some* entry to compose the receipt's wallet_id;
      // if there's nothing configured we report no_wallet_for_network.
    }

    const network = option.network;
    const entries = network ? registry.entriesFor(network) : [];
    if (entries.length === 0) {
      attempts.push({
        option,
        walletId: "—",
        status: "no_wallet_for_network",
        detail: `no wallet configured for network "${network ?? "(missing)"}"`,
      });
      continue;
    }

    // Walk through wallets configured for this network.
    let optionResolved = false;
    for (const entry of entries) {
      const result = await tryEntry(effective, entry, policy);
      attempts.push({ option, walletId: walletIdOf(entry), status: result.status, ...(result.detail !== undefined && { detail: result.detail }) });
      if (result.status === "selected") {
        return { bridge: result.bridge!, effectiveDescriptor: effective, attempts, chosen: option };
      }
      // status was no_handler / no_wallet_for_network / insufficient_balance
      // / balance_check_failed → try the next entry on this network.
    }
    void optionResolved;
  }

  const summary = attempts
    .map((a) => `[${a.option.protocol}/${a.option.network ?? "?"} via ${a.walletId}] ${a.status}${a.detail ? ` — ${a.detail}` : ""}`)
    .join("; ");
  throw new DispatchError(
    `no viable wallet across ${options.length} payment option${options.length === 1 ? "" : "s"}: ${summary}`,
  );
}

interface EntryAttemptResult {
  status:
    | "selected"
    | "no_handler"
    | "insufficient_balance"
    | "balance_check_failed";
  detail?: string;
  bridge?: ReturnType<typeof buildHandlers>;
}

/** Try one (option, entry) pair. Returns the outcome plus bridge if viable. */
async function tryEntry(
  effective: ToolDescriptor,
  entry: WalletEntry,
  policy: "off" | "warn" | "block",
): Promise<EntryAttemptResult> {
  let bridge: ReturnType<typeof buildHandlers>;
  try {
    bridge = buildHandlers(effective, entry);
  } catch (e) {
    if (e instanceof BridgeError) {
      return { status: "no_handler", detail: e.message };
    }
    throw e;
  }

  // Free / delegated paths bypass balance check.
  if (bridge.free || bridge.walletEntry?.kind === "delegated") {
    return { status: "selected", bridge };
  }
  if (!bridge.walletEntry) {
    return { status: "no_handler", detail: "bridge returned no walletEntry" };
  }
  if (policy === "off") {
    return { status: "selected", bridge, detail: "skipped balance check (policy: off)" };
  }
  const priceHint = effective.payment.price_hint;
  if (!priceHint || priceHint === "dynamic") {
    return { status: "selected", bridge, detail: "no price_hint to check" };
  }

  let bal;
  try {
    bal = await getBalanceForDescriptor(effective, bridge.walletEntry);
  } catch (e) {
    if (e instanceof BalanceError) {
      if (policy === "warn") {
        return { status: "selected", bridge, detail: `balance check failed (${e.message}) — proceeding (policy: warn)` };
      }
      return { status: "balance_check_failed", detail: e.message };
    }
    throw e;
  }
  if (!bal) {
    return { status: "selected", bridge, detail: "no balance shape" };
  }
  const required = parseFloat(priceHint);
  const have = parseFloat(bal.formatted);
  if (Number.isNaN(required) || Number.isNaN(have) || have >= required) {
    return { status: "selected", bridge, detail: `balance ${bal.formatted} ≥ ${priceHint}` };
  }
  if (policy === "warn") {
    console.warn(
      `[pay] balance ${bal.formatted} < ${priceHint} on ${bal.network} — proceeding (policy: warn)`,
    );
    return { status: "selected", bridge, detail: `insufficient balance (${bal.formatted} < ${priceHint}) — warned` };
  }
  return {
    status: "insufficient_balance",
    detail: `have ${bal.formatted} ${effective.payment.currency ?? ""} on ${bal.network}, need ${priceHint}`,
  };
}

/** Returns a copy of the descriptor with payment fields swapped to `option`. */
function applyOption(
  descriptor: ToolDescriptor,
  option: PaymentOption,
): ToolDescriptor {
  return {
    ...descriptor,
    payment: {
      ...descriptor.payment,
      protocol: option.protocol,
      ...(option.network !== undefined && { network: option.network }),
      ...(option.currency !== undefined && { currency: option.currency }),
      ...(option.asset !== undefined && { asset: option.asset }),
      ...(option.price_hint !== undefined && { price_hint: option.price_hint }),
    },
  };
}

// ---------------------------------------------------------------------------
// Delegated dispatch — agentwallet at frames.ag
// ---------------------------------------------------------------------------

import type { ToolDescriptor as ToolDescriptorAlias } from "../types.ts";

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

  // Same persistence policy as the regular path. The agentwallet-delegated
  // path doesn't currently get a DispatchContext — fall through to the
  // default detect-or-fallback behavior.
  //
  // IMPORTANT: pass the inner body, not responseText. Agentwallet wraps
  // the seller's response in `{ success, response: { status, headers, body } }`
  // — the wrapper is transport noise and would consume the excerpt budget.
  // We capture only the actual seller body so the excerpt is meaningful.
  const bodyText = body === undefined ? "" : JSON.stringify(body);
  const toolPayload = buildToolPayload(input.params, bodyText);
  await persistReceipt(
    receipt,
    { registry: input.registry, auditKey: input.auditKey },
    toolPayload,
  );

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

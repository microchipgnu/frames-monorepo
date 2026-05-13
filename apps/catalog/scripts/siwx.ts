// SIWX (Sign-In With X) client — minimal implementation for mppscan-style
// endpoints. Standard EIP-191 personal_sign of a SIWE-style canonical message.
//
// Flow:
//   1. GET the endpoint. If 402 with `extensions["sign-in-with-x"]` in body,
//      we have a challenge.
//   2. Build the canonical SIWE message from challenge.info (domain, uri,
//      version, chainId, nonce, issuedAt, expirationTime, statement, plus
//      address).
//   3. signMessage(message) with viem (EIP-191 personal_sign).
//   4. Retry the request with `Authorization: SIWX <base64(JSON)>` header
//      where JSON = { ...challenge.info, address, signature }.
//
// Spec reference: x402 v2 envelope + EIP-4361 / SIWE message format, with
// the difference that SIWX is wallet-agnostic (eip191, ed25519, etc.) — we
// only implement eip191 here because the sources we consume only advertise
// eip191 today.
//
// Ported from microchipgnu/merchants-watch.

import {
  type Hex,
  type Address,
  privateKeyToAccount,
} from "viem/accounts";

export type SiwxChallengeInfo = {
  domain: string;
  uri: string;
  version: string;
  chainId: string; // e.g. "eip155:8453"
  type: string; // "eip191"
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  notBefore?: string;
  statement?: string;
  requestId?: string;
  resources?: string[];
};

export type Siwx402Body = {
  x402Version?: number;
  error?: string;
  extensions?: {
    "sign-in-with-x"?: {
      info: SiwxChallengeInfo;
      supportedChains: { chainId: string; type: string }[];
    };
  };
};

// Build the canonical EIP-4361 / SIWE message that gets signed.
export function buildSiwxMessage(
  info: SiwxChallengeInfo,
  address: Address,
): string {
  // SIWE expects the chainId WITHOUT the "eip155:" prefix in the message body,
  // even though CAIP-2 form ("eip155:8453") is what's used in transport.
  const chainIdNumeric = info.chainId.replace(/^eip155:/, "");

  const lines: string[] = [];
  lines.push(`${info.domain} wants you to sign in with your Ethereum account:`);
  lines.push(address);
  lines.push("");
  if (info.statement) {
    lines.push(info.statement);
    lines.push("");
  }
  lines.push(`URI: ${info.uri}`);
  lines.push(`Version: ${info.version}`);
  lines.push(`Chain ID: ${chainIdNumeric}`);
  lines.push(`Nonce: ${info.nonce}`);
  lines.push(`Issued At: ${info.issuedAt}`);
  lines.push(`Expiration Time: ${info.expirationTime}`);
  if (info.notBefore) lines.push(`Not Before: ${info.notBefore}`);
  if (info.requestId) lines.push(`Request ID: ${info.requestId}`);
  if (info.resources && info.resources.length > 0) {
    lines.push("Resources:");
    for (const r of info.resources) lines.push(`- ${r}`);
  }
  return lines.join("\n");
}

export type SiwxClientOptions = {
  privateKey: Hex; // 0x-prefixed
  fetchImpl?: typeof fetch;
};

export class SiwxClient {
  private account: ReturnType<typeof privateKeyToAccount>;
  private fetchImpl: typeof fetch;
  // Cache of signed Authorization headers keyed by origin until the
  // challenge expires. Saves a round-trip per request after the first.
  private authCache = new Map<string, { header: string; expiresAt: number }>();

  constructor(opts: SiwxClientOptions) {
    this.account = privateKeyToAccount(opts.privateKey);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get address(): Address {
    return this.account.address;
  }

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const origin = new URL(url).origin;
    const cached = this.authCache.get(origin);
    const headers = new Headers(init.headers);
    if (cached && cached.expiresAt > Date.now() + 5000) {
      headers.set("Authorization", cached.header);
    }
    let res = await this.fetchImpl(url, { ...init, headers });
    if (res.status !== 402) return res;

    const body = (await res.clone().json().catch(() => null)) as
      | Siwx402Body
      | null;
    const challenge = body?.extensions?.["sign-in-with-x"];
    if (!challenge) return res;

    const info = challenge.info;
    if (info.type !== "eip191") {
      throw new Error(`SiwxClient: unsupported challenge type "${info.type}"`);
    }

    const message = buildSiwxMessage(info, this.account.address);
    const signature = await this.account.signMessage({ message });

    const authPayload = {
      ...info,
      address: this.account.address,
      signature,
    };
    const authHeader = `SIWX ${Buffer.from(JSON.stringify(authPayload)).toString("base64")}`;

    const expiresAt = Date.parse(info.expirationTime);
    this.authCache.set(origin, { header: authHeader, expiresAt });

    headers.set("Authorization", authHeader);
    res = await this.fetchImpl(url, { ...init, headers });
    return res;
  }
}

/**
 * Convenience: return a SiwxClient if the given env var holds a private key,
 * else null. Lets the caller fall back to a committed cache.
 */
export function siwxFromEnv(envVar = "MPPSCAN_WALLET_PRIVATE_KEY"): SiwxClient | null {
  const key = process.env[envVar];
  if (!key) return null;
  const hex = key.startsWith("0x") ? (key as Hex) : (`0x${key}` as Hex);
  return new SiwxClient({ privateKey: hex });
}

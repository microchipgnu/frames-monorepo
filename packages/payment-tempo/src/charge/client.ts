// MPP Tempo Charge client — adapts mppx's tempo.charge into a
// faremeter MPPPaymentHandler so it plugs into @faremeter/fetch's wrap().
//
// Architecturally analogous to @faremeter/payment-solana/charge/client.ts
// but for Tempo (Stripe's L2). All actual signing + tx building is done
// by mppx — this file is a ~80 LOC adapter between the two type vocabularies.
//
// Bridge:
//   faremeter mppChallengeParams (header-parsed, request: base64 string)
//     ↓ decode + reshape
//   mppx Challenge                (request: parsed object)
//     ↓ mppx tempo.charge.createCredential()
//   serialized credential string
//     ↓ mppx Credential.deserialize
//   mppx Credential                (challenge, payload, source?)
//     ↓ extract payload
//   faremeter mppCredential        (challenge, payload, source?)

import type {
  MPPPaymentHandler,
  MPPPaymentExecer,
  mppChallengeParams,
  mppCredential,
} from "@faremeter/types/mpp";
import { decodeBase64URL } from "@faremeter/types/mpp";
import { tempo as tempoMethods } from "mppx/client";
import { Credential as MppxCredential } from "mppx";
import type { Account } from "viem";

export type CreateMPPTempoChargeClientArgs = {
  /** viem Account (e.g. from `privateKeyToAccount` or any LocalAccount). */
  account: Account;
  /** Override push (broadcast) vs pull (sign only). Default: push for JSON-RPC accounts, pull for local. */
  mode?: "push" | "pull";
  /** Optional client identifier for attribution memos. */
  clientId?: string;
};

/**
 * Creates a faremeter MPPPaymentHandler for the Tempo charge method.
 *
 * Use with @faremeter/fetch's `wrap` via the `mppHandlers` option:
 *
 *   const fetchPaid = wrap(fetch, {
 *     handlers: [evmX402Handler, solanaX402Handler],
 *     mppHandlers: [createMPPTempoChargeClient({ account })],
 *   });
 */
export function createMPPTempoChargeClient(
  args: CreateMPPTempoChargeClientArgs,
): MPPPaymentHandler {
  const chargeClient = tempoMethods.charge({
    account: args.account,
    ...(args.mode && { mode: args.mode }),
    ...(args.clientId && { clientId: args.clientId }),
  });

  return async (
    challenge: mppChallengeParams,
  ): Promise<MPPPaymentExecer | null> => {
    if (challenge.method !== "tempo") return null;
    if (challenge.intent !== "charge") return null;

    let parsedRequest: Record<string, unknown>;
    try {
      parsedRequest = JSON.parse(decodeBase64URL(challenge.request));
    } catch {
      return null;
    }

    // Build the mppx-shaped challenge. The MPP spec is the same on both
    // sides; only the in-memory representation of `request` and `opaque`
    // differs (faremeter keeps them as encoded strings, mppx parses them).
    const mppxChallenge = {
      id: challenge.id,
      realm: challenge.realm,
      method: "tempo" as const,
      intent: "charge" as const,
      request: parsedRequest,
      ...(challenge.description !== undefined && {
        description: challenge.description,
      }),
      ...(challenge.digest !== undefined && { digest: challenge.digest }),
      ...(challenge.expires !== undefined && { expires: challenge.expires }),
      ...(challenge.opaque !== undefined && {
        opaque: parseOpaque(challenge.opaque),
      }),
    };

    return {
      challenge,
      exec: async (): Promise<mppCredential> => {
        // mppx returns a serialized credential string (the value that
        // would go in an `Authorization: Payment <value>` header).
        const credentialStr = await chargeClient.createCredential({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          challenge: mppxChallenge as any,
          context: {},
        });

        // Deserialize to lift out the payload — faremeter does its own
        // serialization downstream so we hand back the parsed shape.
        const parsed = MppxCredential.deserialize<Record<string, unknown>>(
          credentialStr,
        );

        return {
          challenge,
          payload: parsed.payload,
          ...(parsed.source !== undefined && { source: parsed.source }),
        };
      },
    };
  };
}

/**
 * faremeter encodes the `opaque` challenge parameter as a string (typically
 * base64-JSON of a flat string→string map). mppx wants the parsed map.
 * Returns {} on any decode failure — opaque is server-owned and the spec
 * forbids client-side modification, so worst case mppx sees an empty map
 * and the server's verification still has the original on the wire.
 */
function parseOpaque(opaque: string): Record<string, string> {
  try {
    const parsed = JSON.parse(decodeBase64URL(opaque));
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, string>;
    }
  } catch {
    // fall through
  }
  return {};
}

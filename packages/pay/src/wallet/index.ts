// `@frames-ag/pay/wallet` — wallet-only entry point.
//
// Consumers that just need wallet registry + paid-fetch helpers (e.g., the
// tick runtime) can import from this subpath instead of the package root,
// avoiding the full catalog/manifest/MCP type graph. Useful when the
// consumer's tsconfig has a different `lib`/`target` than pay's.

export {
  WalletRegistry,
  walletIdOf,
  addressOf,
  type WalletEntry,
  type WalletRegistryConfig,
  type SolanaWalletShape,
} from "./wallet-registry.ts";

export {
  createPaidFetch,
  type CreatePaidFetchOptions,
  type CreatePaidFetchResult,
} from "./paid-fetch.ts";

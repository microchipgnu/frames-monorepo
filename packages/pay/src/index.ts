// @frames-ag/pay — programmatic library entry.
//
// For agent harnesses use `pay-mcp` (the MCP server bin) instead.
// For shells use `pay` (the CLI bin).
// For embedding pay in your own TS code, import from this module.

export { canonicalize } from "./canonical.ts";
export { descriptorId } from "./descriptor-id.ts";
export type {
  ToolDescriptor,
  ToolInvocation,
  ToolPayment,
  PaymentOption,
  CatalogListResponse,
  CatalogShowResponse,
  CatalogSource,
  Manifest,
  ManifestEntry,
  Lockfile,
  LockEntry,
  Receipt,
  ToolInvokedEvent,
  PayForToolInput,
  PayForToolResult,
  WalletStateStore,
} from "./types.ts";
export { HttpCatalog, type HttpCatalogConfig } from "./catalog/http.ts";
export {
  parseManifest,
  loadManifestFile,
  ManifestParseError,
} from "./manifest/load.ts";
export {
  loadLock,
  saveLock,
  emptyLock,
  setLockEntry,
  removeLockEntry,
  verifyLockEntry,
  LockfileError,
} from "./manifest/lock.ts";
export { resolveTool, ResolveError } from "./manifest/resolve.ts";
export type { ResolveContext, ResolvedToolEntry } from "./manifest/resolve.ts";
export { installManifest } from "./manifest/install.ts";
export type { InstallContext } from "./manifest/install.ts";

export {
  WalletRegistry,
  type WalletEntry,
  type WalletRegistryConfig,
  type SolanaWalletShape,
} from "./wallet/wallet-registry.ts";
export {
  buildHandlers,
  BridgeError,
  type BridgeOutput,
} from "./wallet/faremeter-bridge.ts";
export {
  createPaidFetch,
  type CreatePaidFetchOptions,
  type CreatePaidFetchResult,
} from "./wallet/paid-fetch.ts";
export {
  buildReceipt,
  verifyReceipt,
} from "./wallet/receipt.ts";
export {
  loadOrCreateAuditKey,
  DEFAULT_AUDIT_KEY_PATH,
  type AuditKeyPair,
  type SerializedAuditKey,
} from "./wallet/audit-key.ts";
export {
  payForTool,
  DispatchError,
  type DispatchContext,
} from "./wallet/dispatch.ts";

export {
  loadRuntimeConfig,
  DEFAULT_CONFIG_PATH,
  DEFAULT_CATALOG_URL,
  ConfigError,
  type RuntimeConfig,
} from "./config.ts";

// Mirrors pay/SPEC.md ToolDescriptor. SPEC is authoritative.

export interface ToolDescriptor {
  pay_protocol: string;
  id: string;
  title: string;
  description: string;
  capabilities: string[];
  invocation: {
    method: string;
    url: string;
    params_schema?: unknown;
  };
  payment: {
    protocol: string;
    network?: string;
    currency?: string;
    price_hint?: string;
    [k: string]: unknown;
  };
  schemas?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface ListResponse {
  pay_protocol: string;
  tools: ToolDescriptor[];
  cursor?: string | null;
}

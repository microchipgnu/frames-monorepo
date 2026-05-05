export type Source = {
  url: string;
  retrieved_at: string;
  excerpt?: string;
  title?: string;
  archive_url?: string;
};

export type FrameEvent =
  | {
      id: string;
      ts: string;
      type: "entity.created";
      agent?: string;
      payload: { entity_id: string };
    }
  | {
      id: string;
      ts: string;
      type: "entity.removed";
      agent?: string;
      payload: { entity_id: string; reason?: string };
    }
  | {
      id: string;
      ts: string;
      type: "fact.set";
      agent?: string;
      payload: {
        fact_id: string;
        entity_id: string;
        field: string;
        value: unknown;
        source: Source;
        confidence?: number;
        observed_at?: string;
      };
    }
  | {
      id: string;
      ts: string;
      type: "fact.deprecated";
      agent?: string;
      payload: { fact_id: string; reason?: string };
    }
  | {
      id: string;
      ts: string;
      type: "fact.evidence_added";
      agent?: string;
      payload: { fact_id: string; source: Source };
    };

export type Fact = {
  fact_id: string;
  entity_id: string;
  field: string;
  value: unknown;
  source: Source;
  evidence: Source[];
  ts: string;
  confidence?: number;
  observed_at?: string;
  deprecated: boolean;
};

export type Entity = {
  entity_id: string;
  fields: Record<string, unknown>;
  evidence: Record<string, Source>;
  facts: Record<string, Fact>;
  /** Every fact ever set for a field, in event order. Includes deprecated. */
  history: Record<string, Fact[]>;
  removed: boolean;
};

export type SchemaField = {
  type: "string" | "url" | "enum" | "int" | "date" | "bool";
  required?: boolean;
  description?: string;
  values?: string[];
};

export type Schema = {
  frame_protocol: string;
  name: string;
  description?: string;
  entity_type?: string;
  fields: Record<string, SchemaField>;
  tests?: Array<{ name: string; field: string; rule: string; allowed?: string[] }>;
  allow_unknown_fields?: boolean;
};

export type RecentActivity =
  | {
      type: "created";
      entity_id: string;
      entity_name: string;
      ts: string;
    }
  | {
      type: "updated";
      entity_id: string;
      entity_name: string;
      field: string;
      value: unknown;
      previous?: unknown;
      ts: string;
      source: Source;
    };

export type Dataset = {
  user: string;
  repo: string;
  sha: string;
  /** path inside the repo to the frame directory; "" for repo root */
  frame_path: string;
  schema: Schema;
  readme: string;
  entities: Map<string, Entity>;
  max_ts: string;
};

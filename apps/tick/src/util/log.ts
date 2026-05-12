// Structured JSON logging for tick.
//
// Workers Logs picks up everything written to stdout/stderr via console.*.
// We emit one JSON object per event so log queries can filter on `op`,
// `run_id`, `agent`, `code`, etc.
//
// Logged events are also a useful seed for CF Analytics Engine when wired
// later — same shape, different sink.

type LogLevel = "debug" | "info" | "warn" | "error";

interface BaseFields {
  level: LogLevel;
  ts: string;
  event: string;
  [k: string]: unknown;
}

function emit(fields: BaseFields): void {
  const line = JSON.stringify(fields);
  if (fields.level === "error" || fields.level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const log = {
  info(event: string, fields: Record<string, unknown> = {}): void {
    emit({ level: "info", ts: new Date().toISOString(), event, ...fields });
  },
  warn(event: string, fields: Record<string, unknown> = {}): void {
    emit({ level: "warn", ts: new Date().toISOString(), event, ...fields });
  },
  error(event: string, fields: Record<string, unknown> = {}): void {
    emit({ level: "error", ts: new Date().toISOString(), event, ...fields });
  },
  debug(event: string, fields: Record<string, unknown> = {}): void {
    if (typeof process !== "undefined" && process.env?.TICK_LOG_DEBUG !== "1") return;
    emit({ level: "debug", ts: new Date().toISOString(), event, ...fields });
  },
};

// nbus configuration loader.
//
// Loads ~/.config/nbus/config.toml (all fields optional), applies env-var
// overrides, and resolves every field to a typed default. See PROTOCOL.md §8.
//
// ponytail: the TOML parser below handles ONLY the flat `[section] key = value`
// subset that PROTOCOL.md §8 uses (sections: server/limits/behavior; scalar
// string/int/bool values, `#` line comments). It does NOT support nested
// tables, arrays, multiline strings, or dotted keys. If the config ever needs
// nesting, replace this with a real TOML library.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SlowClientPolicy = "drop" | "block";

export interface ServerConfig {
  socket_path: string;
  http_port: number;
  tcp_port: number;
  tcp_bind: string;
}

export interface LimitsConfig {
  max_buckets: number;
  max_subscriptions_per_client: number;
  max_payload_bytes: number;
  buffer_size: number;
  bucket_ttl_seconds: number;
}

export interface BehaviorConfig {
  watch_on_equal: boolean;
  slow_client_policy: SlowClientPolicy;
}

export interface Config {
  server: ServerConfig;
  limits: LimitsConfig;
  behavior: BehaviorConfig;
}

/** A parsed TOML scalar: string, number, or boolean. */
type TomlValue = string | number | boolean;

/** Flat `section -> key -> value` map produced by the minimal parser. */
type TomlDocument = Record<string, Record<string, TomlValue>>;

const CONFIG_PATH = join(homedir(), ".config", "nbus", "config.toml");

function defaultConfig(): Config {
  return {
    server: {
      socket_path: "/tmp/nbus.sock",
      http_port: 7600,
      tcp_port: 0,
      tcp_bind: "127.0.0.1",
    },
    limits: {
      max_buckets: 1024,
      max_subscriptions_per_client: 64,
      max_payload_bytes: 262144,
      buffer_size: 64,
      bucket_ttl_seconds: 300,
    },
    behavior: {
      watch_on_equal: true,
      slow_client_policy: "drop",
    },
  };
}

/**
 * Parse the flat TOML subset described in the ponytail note above.
 * Throws on malformed input (bad section header, missing `=`, unterminated
 * string, key outside any section).
 */
function parseFlatToml(source: string): TomlDocument {
  const doc: TomlDocument = {};
  let currentSection: string | null = null;

  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = stripComment(raw).trim();
    if (line.length === 0) continue;

    if (line.startsWith("[")) {
      if (!line.endsWith("]")) {
        throw new Error(`malformed TOML: bad section header on line ${i + 1}: ${raw}`);
      }
      const name = line.slice(1, -1).trim();
      if (name.length === 0) {
        throw new Error(`malformed TOML: empty section name on line ${i + 1}`);
      }
      currentSection = name;
      if (doc[currentSection] === undefined) doc[currentSection] = {};
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) {
      throw new Error(`malformed TOML: expected 'key = value' on line ${i + 1}: ${raw}`);
    }
    if (currentSection === null) {
      throw new Error(`malformed TOML: key outside any [section] on line ${i + 1}: ${raw}`);
    }

    const key = line.slice(0, eq).trim();
    const valueText = line.slice(eq + 1).trim();
    if (key.length === 0) {
      throw new Error(`malformed TOML: empty key on line ${i + 1}: ${raw}`);
    }

    const section = doc[currentSection] ?? (doc[currentSection] = {});
    section[key] = parseValue(valueText, i + 1);
  }

  return doc;
}

/**
 * Remove a `#` line comment that is not inside a quoted string.
 * Only double-quoted strings are supported by this subset.
 */
function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inString = !inString;
    else if (ch === "#" && !inString) return line.slice(0, i);
  }
  return line;
}

function parseValue(text: string, lineNo: number): TomlValue {
  if (text.length === 0) {
    throw new Error(`malformed TOML: empty value on line ${lineNo}`);
  }

  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) {
      throw new Error(`malformed TOML: unterminated string on line ${lineNo}: ${text}`);
    }
    return text.slice(1, -1);
  }

  if (text === "true") return true;
  if (text === "false") return false;

  // Integer (the config only uses ints). Reject anything else.
  if (/^[+-]?\d+$/.test(text)) {
    const n = Number(text);
    if (!Number.isFinite(n)) {
      throw new Error(`malformed TOML: bad number on line ${lineNo}: ${text}`);
    }
    return n;
  }

  throw new Error(`malformed TOML: unrecognized value on line ${lineNo}: ${text}`);
}

function getString(
  section: Record<string, TomlValue> | undefined,
  key: string,
  fallback: string,
): string {
  const v = section?.[key];
  return typeof v === "string" ? v : fallback;
}

function getNumber(
  section: Record<string, TomlValue> | undefined,
  key: string,
  fallback: number,
): number {
  const v = section?.[key];
  return typeof v === "number" ? v : fallback;
}

function getBoolean(
  section: Record<string, TomlValue> | undefined,
  key: string,
  fallback: boolean,
): boolean {
  const v = section?.[key];
  return typeof v === "boolean" ? v : fallback;
}

function getSlowClientPolicy(
  section: Record<string, TomlValue> | undefined,
  fallback: SlowClientPolicy,
): SlowClientPolicy {
  const v = section?.slow_client_policy;
  return v === "drop" || v === "block" ? v : fallback;
}

/** Apply an env-var integer override if present and valid. */
function envInt(name: string, current: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return current;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? current : n;
}

/**
 * Load and resolve the full configuration.
 *
 * - Config file missing -> all defaults, no error.
 * - Malformed TOML -> throws a clear error.
 * - Env overrides (NBUS_SOCKET, NBUS_HTTP_PORT, NBUS_TCP_PORT) are applied
 *   AFTER the TOML values, matching existing daemon.ts / cli.ts behavior.
 */
export function loadConfig(): Config {
  const config = defaultConfig();

  const file = Bun.file(CONFIG_PATH);
  if (file.size > 0) {
    // Synchronous read keeps loadConfig() non-async.
    const text = readFileSync(CONFIG_PATH, "utf8");
    const doc = parseFlatToml(text);

    const server = doc.server;
    config.server.socket_path = getString(server, "socket_path", config.server.socket_path);
    config.server.http_port = getNumber(server, "http_port", config.server.http_port);
    config.server.tcp_port = getNumber(server, "tcp_port", config.server.tcp_port);
    config.server.tcp_bind = getString(server, "tcp_bind", config.server.tcp_bind);

    const limits = doc.limits;
    config.limits.max_buckets = getNumber(limits, "max_buckets", config.limits.max_buckets);
    config.limits.max_subscriptions_per_client = getNumber(
      limits,
      "max_subscriptions_per_client",
      config.limits.max_subscriptions_per_client,
    );
    config.limits.max_payload_bytes = getNumber(
      limits,
      "max_payload_bytes",
      config.limits.max_payload_bytes,
    );
    config.limits.buffer_size = getNumber(limits, "buffer_size", config.limits.buffer_size);
    config.limits.bucket_ttl_seconds = getNumber(
      limits,
      "bucket_ttl_seconds",
      config.limits.bucket_ttl_seconds,
    );

    const behavior = doc.behavior;
    config.behavior.watch_on_equal = getBoolean(
      behavior,
      "watch_on_equal",
      config.behavior.watch_on_equal,
    );
    config.behavior.slow_client_policy = getSlowClientPolicy(
      behavior,
      config.behavior.slow_client_policy,
    );
  }

  // Env overrides (applied after TOML, per field).
  const socketEnv = process.env.NBUS_SOCKET;
  if (socketEnv !== undefined && socketEnv.length > 0) {
    config.server.socket_path = socketEnv;
  }
  config.server.http_port = envInt("NBUS_HTTP_PORT", config.server.http_port);
  config.server.tcp_port = envInt("NBUS_TCP_PORT", config.server.tcp_port);

  return config;
}

// ponytail: self-check for parser + default resolution. Run with
// `bun run src/config.ts`.
if (import.meta.main) {
  const cfg = loadConfig();

  // Defaults present (when no config file / relevant env set).
  if (process.env.NBUS_SOCKET === undefined) {
    assert.equal(cfg.server.socket_path, "/tmp/nbus.sock");
  }
  if (process.env.NBUS_HTTP_PORT === undefined) {
    assert.equal(cfg.server.http_port, 7600);
  }
  if (process.env.NBUS_TCP_PORT === undefined) {
    assert.equal(cfg.server.tcp_port, 0);
  }
  assert.equal(cfg.server.tcp_bind, "127.0.0.1");
  assert.equal(cfg.limits.max_buckets, 1024);
  assert.equal(cfg.limits.max_subscriptions_per_client, 64);
  assert.equal(cfg.limits.max_payload_bytes, 262144);
  assert.equal(cfg.limits.buffer_size, 64);
  assert.equal(cfg.limits.bucket_ttl_seconds, 300);
  assert.equal(cfg.behavior.watch_on_equal, true);
  assert.equal(cfg.behavior.slow_client_policy, "drop");

  // Parser exercises: valid subset round-trips to expected types.
  const sample = [
    "[server]",
    'socket_path = "/tmp/x.sock"  # comment',
    "http_port = 8080",
    "[behavior]",
    "watch_on_equal = false",
    'slow_client_policy = "block"',
  ].join("\n");
  const doc = parseFlatToml(sample);
  assert.equal(doc.server?.socket_path, "/tmp/x.sock");
  assert.equal(doc.server?.http_port, 8080);
  assert.equal(doc.behavior?.watch_on_equal, false);
  assert.equal(doc.behavior?.slow_client_policy, "block");

  // Malformed input throws.
  assert.throws(() => parseFlatToml("key = 1"), /outside any \[section\]/);
  assert.throws(() => parseFlatToml("[server]\nhttp_port"), /expected 'key = value'/);
  assert.throws(() => parseFlatToml('[server]\nx = "oops'), /unterminated string/);

  console.log("config.ts self-check: OK");
}

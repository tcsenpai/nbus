#!/usr/bin/env bun
import { NBus } from "../sdk/typescript/src/client";

const args = process.argv.slice(2);
const cmd = args[0]?.toLowerCase();

const SOCKET = process.env.NBUS_SOCKET ?? "/tmp/nbus.sock";
const bus = new NBus({ socket: SOCKET });

function usage() {
  console.log(`nbus — local IPC bus

Usage:
  nbus emit <bucket> <event> [--data <json>]
  nbus listen <bucket> [event]
  nbus set <bucket> <key> <value>
  nbus get <bucket> <key>
  nbus watch <bucket> <key>
  nbus stats
  nbus buckets`);
  process.exit(0);
}

if (!cmd || cmd === "--help" || cmd === "-h") usage();

switch (cmd) {
  case "emit": {
    const bucket = args[1];
    const event = args[2] ?? "default";
    if (!bucket) { console.error("missing bucket"); process.exit(1); }
    const dataIdx = args.indexOf("--data");
    const rawData = dataIdx !== -1 ? args[dataIdx + 1] : undefined;
    const data = rawData !== undefined ? JSON.parse(rawData) : undefined;
    await bus.emit(bucket, event, data);
    bus.close();
    break;
  }

  case "listen": {
    const bucket = args[1];
    const event = args[2] ?? "*";
    if (!bucket) { console.error("missing bucket"); process.exit(1); }
    console.error(`[listening on ${bucket}/${event}, Ctrl+C to stop]`);
    for await (const ev of bus.listen(bucket, event)) {
      console.log(`[${ev.bucket}] ${ev.event}: ${JSON.stringify(ev.data)}`);
    }
    break;
  }

  case "set": {
    const [, bucket, key, ...rest] = args;
    if (!bucket || !key) { console.error("missing bucket or key"); process.exit(1); }
    const value = rest.join(" ");
    await bus.set(bucket, key, value);
    bus.close();
    break;
  }

  case "get": {
    const [, bucket, key] = args;
    if (!bucket || !key) { console.error("missing bucket or key"); process.exit(1); }
    const val = await bus.get(bucket, key);
    if (val === null) console.log("(nil)");
    else console.log(typeof val === "string" ? val : JSON.stringify(val));
    bus.close();
    break;
  }

  case "watch": {
    const [, bucket, key] = args;
    if (!bucket || !key) { console.error("missing bucket or key"); process.exit(1); }
    console.error(`[watching ${bucket}/${key}, Ctrl+C to stop]`);
    for await (const val of bus.watch(bucket, key)) {
      console.log(`[${bucket}/${key}] = ${typeof val === "string" ? val : JSON.stringify(val)}`);
    }
    break;
  }

  case "stats": {
    const resp = await fetch(`http://127.0.0.1:${process.env.NBUS_HTTP_PORT ?? "7600"}/stats`);
    console.log(JSON.stringify(await resp.json(), null, 2));
    bus.close();
    break;
  }

  case "buckets": {
    const resp = await fetch(`http://127.0.0.1:${process.env.NBUS_HTTP_PORT ?? "7600"}/buckets`);
    const names = await resp.json();
    if ((names as string[]).length === 0) console.log("(no buckets)");
    else for (const n of names as string[]) console.log(n);
    bus.close();
    break;
  }

  default:
    console.error(`unknown command: ${cmd}`);
    usage();
}

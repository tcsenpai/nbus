// Key-discovery convention (`_keys` bucket, CRYPTO.md §5) integration tests.
//
// These exercise the pure-convention helpers against a REAL daemon booted on a
// private Unix socket (spawn pattern mirrors tests/conformance.test.ts). The
// daemon is dumb: `_keys` is an ordinary bucket, no special-casing.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { NBus, Keypair, type KeyRecord } from "./src/client";

const SOCKET_PATH = `/tmp/nbus-keys-${process.pid}.sock`;
const HTTP_PORT = 18600 + (process.pid % 1000);

let daemon: ReturnType<typeof Bun.spawn> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function newBus(): NBus {
  return new NBus({ socket: SOCKET_PATH });
}

beforeAll(async () => {
  if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);

  daemon = Bun.spawn(["bun", "run", "src/daemon.ts"], {
    env: {
      ...process.env,
      NBUS_SOCKET: SOCKET_PATH,
      NBUS_HTTP_PORT: String(HTTP_PORT),
      NBUS_TCP_PORT: "0",
    },
    stdout: "ignore",
    stderr: "ignore",
    cwd: import.meta.dir,
  });

  const deadline = Date.now() + 3000;
  while (!existsSync(SOCKET_PATH)) {
    if (Date.now() > deadline) throw new Error("daemon did not create socket in time");
    await sleep(25);
  }
  await sleep(50);
});

afterAll(() => {
  daemon?.kill();
  if (existsSync(SOCKET_PATH)) {
    try {
      unlinkSync(SOCKET_PATH);
    } catch {}
  }
});

test("publishKeys (Keypair objects) → fetchKeys returns matching sign/box + ts", async () => {
  const bus = newBus();
  const signer = await Keypair.ed25519();
  const box = await Keypair.x25519();

  const before = Math.floor(Date.now() / 1000);
  await bus.publishKeys("alice", { sign: signer, box });
  const rec = await bus.fetchKeys("alice");

  expect(rec).not.toBeNull();
  expect(rec?.sign).toBe(signer.publicKeyB64);
  expect(rec?.box).toBe(box.publicKeyB64);
  expect(typeof rec?.ts).toBe("number");
  expect(rec!.ts).toBeGreaterThanOrEqual(before);
  bus.close();
});

test("publishKeys with raw base64url strings works", async () => {
  const bus = newBus();
  const signer = await Keypair.ed25519();
  const box = await Keypair.x25519();

  await bus.publishKeys("bob", {
    sign: signer.publicKeyB64,
    box: box.publicKeyB64,
  });
  const rec = await bus.fetchKeys("bob");

  expect(rec?.sign).toBe(signer.publicKeyB64);
  expect(rec?.box).toBe(box.publicKeyB64);
  bus.close();
});

test("publishKeys with only one half works", async () => {
  const bus = newBus();
  const box = await Keypair.x25519();

  await bus.publishKeys("boxonly", { box });
  const rec = await bus.fetchKeys("boxonly");

  expect(rec?.box).toBe(box.publicKeyB64);
  expect(rec?.sign).toBeUndefined();
  bus.close();
});

test("publishKeys with neither sign nor box → throws", async () => {
  const bus = newBus();
  await expect(bus.publishKeys("nobody", {})).rejects.toThrow(
    /at least one of sign\/box/,
  );
  bus.close();
});

test("fetchKeys on absent name → null", async () => {
  const bus = newBus();
  const rec = await bus.fetchKeys("does-not-exist");
  expect(rec).toBeNull();
  bus.close();
});

test("fetchKeys on a corrupted record → throws", async () => {
  const bus = newBus();
  // Directly SET a structurally invalid record into the ordinary _keys bucket.
  await bus.set("_keys", "corrupt", { junk: 1 });
  await expect(bus.fetchKeys("corrupt")).rejects.toThrow(/malformed key record/);
  bus.close();
});

test("watchKeys yields valid records across rotation", async () => {
  const bus = newBus();
  const writer = newBus();

  const k1 = await Keypair.x25519();
  const k2 = await Keypair.x25519();

  const seen: KeyRecord[] = [];
  const done = (async () => {
    for await (const rec of bus.watchKeys("rotor")) {
      seen.push(rec);
      if (seen.length >= 2) break;
    }
  })();

  // Let the WATCH register, then publish the initial key and a rotation.
  await sleep(100);
  await writer.publishKeys("rotor", { box: k1 });
  await sleep(60);
  await writer.publishKeys("rotor", { box: k2 });

  await done;

  expect(seen.length).toBe(2);
  expect(seen[0]?.box).toBe(k1.publicKeyB64);
  expect(seen[1]?.box).toBe(k2.publicKeyB64);
  bus.close();
  writer.close();
});

test("end-to-end: discover box key → encrypt → recipient decrypts", async () => {
  const alice = newBus();
  const bob = newBus();

  // Alice generates a box keypair and publishes only the public half.
  const aliceBox = await Keypair.x25519();
  await alice.publishKeys("alice-e2e", { box: aliceBox });

  // Alice listens for encrypted secrets addressed to her.
  const received: string[] = [];
  const listening = (async () => {
    for await (const ev of alice.listen("secrets", "drop", {
      decryptWith: aliceBox,
    })) {
      if (ev.error) throw new Error(`recv rejected: ${ev.error}`);
      if (ev.encrypted && ev.data !== undefined) {
        received.push((ev.data as { msg: string }).msg);
        break;
      }
    }
  })();

  await sleep(100);

  // Bob discovers Alice's box key and encrypts to it — no prior key exchange.
  const rec = await bob.fetchKeys("alice-e2e");
  expect(rec?.box).toBe(aliceBox.publicKeyB64);
  await bob.emit("secrets", "drop", { msg: "hello alice" }, {
    encryptTo: rec!.box!,
  });

  await listening;

  expect(received).toEqual(["hello alice"]);
  alice.close();
  bob.close();
});

import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import {
  NBus,
  Keypair,
  isEnvelope,
  type ListenItem,
  type Ed25519Keypair,
  type X25519Keypair,
} from "./src/client";

// Live-daemon integration tests for the optional SDK crypto layer. Boots the
// real daemon on a private socket (mirrors tests/conformance.test.ts) and drives
// emit/set/listen/get through the crypto send/recv options end-to-end.

const SOCKET_PATH = `/tmp/nbus-crypto-${process.pid}.sock`;
const HTTP_PORT = 18600 + (process.pid % 1000);

let daemon: ReturnType<typeof Bun.spawn> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeAll(async () => {
  if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
  daemon = Bun.spawn(["bun", "run", "../../src/daemon.ts"], {
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

/** Grab the first listen item matching `event`, with a timeout. */
async function firstItem<T>(
  bus: NBus,
  bucket: string,
  event: string,
  opts?: Parameters<NBus["listen"]>[2],
): Promise<ListenItem<T>> {
  const gen = bus.listen<T>(bucket, event, opts);
  const race = Promise.race([
    (async () => (await gen.next()).value as ListenItem<T>)(),
    sleep(2000).then(() => {
      throw new Error("listen timed out");
    }),
  ]);
  return race;
}

test("emit signed → listen verify(true) delivers payload with signedBy", async () => {
  const signer = await Keypair.ed25519();
  const rx = new NBus({ socket: SOCKET_PATH });
  const tx = new NBus({ socket: SOCKET_PATH });

  const p = firstItem<{ hi: string }>(rx, "b1", "e", {
    verify: (pub) => pub === signer.publicKeyB64,
  });
  await sleep(100);
  await tx.emit("b1", "e", { hi: "there" }, { sign: signer });

  const item = await p;
  expect(item.error).toBeUndefined();
  expect(item.data).toEqual({ hi: "there" });
  expect(item.signedBy).toBe(signer.publicKeyB64);

  rx.close();
  tx.close();
});

test("emit signed → listen verify(false) → rejected, no trusted data", async () => {
  const signer = await Keypair.ed25519();
  const rx = new NBus({ socket: SOCKET_PATH });
  const tx = new NBus({ socket: SOCKET_PATH });

  const p = firstItem<unknown>(rx, "b2", "e", { verify: () => false });
  await sleep(100);
  await tx.emit("b2", "e", { secret: 1 }, { sign: signer });

  const item = await p;
  expect(item.data).toBeUndefined();
  expect(item.signedBy).toBeUndefined();
  expect(item.error).toBeDefined();

  rx.close();
  tx.close();
});

test("s1 arrives but no verify predicate → fail closed (rejected)", async () => {
  const signer = await Keypair.ed25519();
  const rx = new NBus({ socket: SOCKET_PATH });
  const tx = new NBus({ socket: SOCKET_PATH });

  // decryptWith present but verify absent: signed payload must NOT be trusted.
  const kp = await Keypair.x25519();
  const p = firstItem<unknown>(rx, "b3", "e", { decryptWith: kp });
  await sleep(100);
  await tx.emit("b3", "e", { x: 1 }, { sign: signer });

  const item = await p;
  expect(item.data).toBeUndefined();
  expect(item.error).toContain("verify predicate");

  rx.close();
  tx.close();
});

test("emit encrypted → listen decryptWith delivers plaintext", async () => {
  const box = await Keypair.x25519();
  const rx = new NBus({ socket: SOCKET_PATH });
  const tx = new NBus({ socket: SOCKET_PATH });

  const p = firstItem<{ msg: string }>(rx, "b4", "e", { decryptWith: box });
  await sleep(100);
  await tx.emit("b4", "e", { msg: "hidden" }, { encryptTo: box.publicKeyB64 });

  const item = await p;
  expect(item.error).toBeUndefined();
  expect(item.data).toEqual({ msg: "hidden" });
  expect(item.encrypted).toBe(true);
  expect(item.signedBy).toBeUndefined();

  rx.close();
  tx.close();
});

test("emit sign-then-encrypt → listen verify+decryptWith delivers with signedBy", async () => {
  const signer = await Keypair.ed25519();
  const box = await Keypair.x25519();
  const rx = new NBus({ socket: SOCKET_PATH });
  const tx = new NBus({ socket: SOCKET_PATH });

  const p = firstItem<{ v: number }>(rx, "b5", "e", {
    verify: (pub) => pub === signer.publicKeyB64,
    decryptWith: box,
  });
  await sleep(100);
  await tx.emit("b5", "e", { v: 42 }, { sign: signer, encryptTo: box.publicKeyB64 });

  const item = await p;
  expect(item.error).toBeUndefined();
  expect(item.data).toEqual({ v: 42 });
  expect(item.encrypted).toBe(true);
  expect(item.signedBy).toBe(signer.publicKeyB64);

  rx.close();
  tx.close();
});

test("emit PLAIN → listen with NO opts → unchanged behavior (back-compat)", async () => {
  const rx = new NBus({ socket: SOCKET_PATH });
  const tx = new NBus({ socket: SOCKET_PATH });

  const p = firstItem<{ plain: boolean }>(rx, "b6", "e");
  await sleep(100);
  await tx.emit("b6", "e", { plain: true });

  const item = await p;
  expect(item).toEqual({ bucket: "b6", event: "e", data: { plain: true } });
  expect(item.signedBy).toBeUndefined();
  expect(item.encrypted).toBeUndefined();
  expect(item.error).toBeUndefined();

  rx.close();
  tx.close();
});

test("enveloped emit → listen with NO opts → raw envelope comes through as data", async () => {
  const signer = await Keypair.ed25519();
  const rx = new NBus({ socket: SOCKET_PATH });
  const tx = new NBus({ socket: SOCKET_PATH });

  const p = firstItem<unknown>(rx, "b7", "e"); // opt-out
  await sleep(100);
  await tx.emit("b7", "e", { a: 1 }, { sign: signer });

  const item = await p;
  // User opted out: they receive the raw envelope object and can detect it.
  expect(isEnvelope(item.data)).toBe(true);
  expect(item.error).toBeUndefined();

  rx.close();
  tx.close();
});

test("set/get signed round-trip", async () => {
  const signer = await Keypair.ed25519();
  const bus = new NBus({ socket: SOCKET_PATH });

  await bus.set("kv1", "k", { n: 7 }, { sign: signer });

  const res = await bus.get<{ n: number }>("kv1", "k", {
    verify: (pub) => pub === signer.publicKeyB64,
  });
  expect(res.error).toBeUndefined();
  expect(res.data).toEqual({ n: 7 });
  expect(res.signedBy).toBe(signer.publicKeyB64);

  bus.close();
});

test("get with NO opts → bare value (back-compat)", async () => {
  const bus = new NBus({ socket: SOCKET_PATH });
  await bus.set("kv2", "k", { plain: 1 });
  const val = await bus.get<{ plain: number }>("kv2", "k");
  expect(val).toEqual({ plain: 1 });
  bus.close();
});

test("get signed with verify(false) → rejected fail-closed", async () => {
  const signer = await Keypair.ed25519();
  const bus = new NBus({ socket: SOCKET_PATH });
  await bus.set("kv3", "k", { s: 1 }, { sign: signer });

  const res = await bus.get<{ s: number }>("kv3", "k", { verify: () => false });
  expect(res.data).toBeNull();
  expect(res.error).toBeDefined();
  bus.close();
});

test("encrypted set/get round-trip", async () => {
  const box = await Keypair.x25519();
  const bus = new NBus({ socket: SOCKET_PATH });
  await bus.set("kv4", "k", { m: "sekret" }, { encryptTo: box.publicKeyB64 });

  const res = await bus.get<{ m: string }>("kv4", "k", { decryptWith: box });
  expect(res.error).toBeUndefined();
  expect(res.data).toEqual({ m: "sekret" });
  expect(res.encrypted).toBe(true);
  bus.close();
});

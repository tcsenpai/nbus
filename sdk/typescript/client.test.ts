import { test, expect } from "bun:test";
import { NBus } from "./src/client";

// These tests exercise the single-consumer line-delivery path in isolation
// (no daemon), via the internal _feed/_readLine hooks. They deterministically
// cover BUG #3: exactly-once, in-order line delivery to awaiting callers.

test("lines split across chunks, one per readLine, in order", async () => {
  const bus = new NBus();
  bus._feed("OK\nVALUE ");
  bus._feed('"1.2.3"\nNIL\n');
  expect(await bus._readLine()).toBe("OK");
  expect(await bus._readLine()).toBe('VALUE "1.2.3"');
  expect(await bus._readLine()).toBe("NIL");
  bus.close();
});

test("reader parked before data still gets exactly one line", async () => {
  const bus = new NBus();
  const p = bus._readLine(); // waiter registered while queue empty
  bus._feed("PONG\n");
  expect(await p).toBe("PONG");
  bus.close();
});

test("SET's OK is not misassigned to a later GET (FIFO)", async () => {
  const bus = new NBus();
  // Simulate pipelined SET then GET responses arriving together.
  bus._feed('OK\nVALUE "hi"\n');
  const setResp = await bus._readLine();
  const getResp = await bus._readLine();
  expect(setResp).toBe("OK");
  expect(getResp).toBe('VALUE "hi"');
  bus.close();
});

test("multiple parked waiters resolve in FIFO order", async () => {
  const bus = new NBus();
  const a = bus._readLine();
  const b = bus._readLine();
  const c = bus._readLine();
  bus._feed("a\nb\nc\n");
  expect(await a).toBe("a");
  expect(await b).toBe("b");
  expect(await c).toBe("c");
  bus.close();
});

test("no line yielded until newline seen", async () => {
  const bus = new NBus();
  bus._feed("partial");
  let resolved = false;
  const p = bus._readLine().then((l) => {
    resolved = true;
    return l;
  });
  await Promise.resolve();
  expect(resolved).toBe(false);
  bus._feed(" complete\n");
  expect(await p).toBe("partial complete");
  bus.close();
});

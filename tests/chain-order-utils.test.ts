import { beforeEach, describe, expect, it } from "vitest";
import {
  getOrderLockQueueLength,
  isOrderLockHeld,
  resetOrderLock,
  withOrderLock,
} from "../src/chain/order-utils";

/** Flush microtask queue so lock acquisition / queue enrollment completes. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe("order-utils single-process lock", () => {
  beforeEach(() => {
    resetOrderLock();
  });

  it("lock is not held initially", () => {
    expect(isOrderLockHeld()).toBe(false);
    expect(getOrderLockQueueLength()).toBe(0);
  });

  it("lock is held during execution", async () => {
    let lockDuringExec = false;
    await withOrderLock(async () => {
      lockDuringExec = isOrderLockHeld();
    });
    expect(lockDuringExec).toBe(true);
    expect(isOrderLockHeld()).toBe(false);
  });

  it("serializes concurrent calls — second waits for first", async () => {
    const executionOrder: number[] = [];
    let resolveFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const first = withOrderLock(async () => {
      executionOrder.push(1);
      await firstBlocked;
      executionOrder.push(2);
      return "first";
    });

    await flushMicrotasks();
    expect(isOrderLockHeld()).toBe(true);
    expect(getOrderLockQueueLength()).toBe(0);

    const second = withOrderLock(async () => {
      executionOrder.push(3);
      return "second";
    });

    await flushMicrotasks();
    expect(getOrderLockQueueLength()).toBe(1);

    resolveFirst?.();

    const [r1, r2] = await Promise.all([first, second]);

    expect(r1).toBe("first");
    expect(r2).toBe("second");
    expect(executionOrder).toEqual([1, 2, 3]);
    expect(isOrderLockHeld()).toBe(false);
    expect(getOrderLockQueueLength()).toBe(0);
  });

  it("releases lock even when the inner function throws", async () => {
    const err = new Error("boom");
    await expect(
      withOrderLock(async () => {
        throw err;
      }),
    ).rejects.toThrow("boom");

    expect(isOrderLockHeld()).toBe(false);
    expect(getOrderLockQueueLength()).toBe(0);
  });

  it("queued caller proceeds after holder throws", async () => {
    let resolveFirst: (() => void) | undefined;
    const blocker = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const first = withOrderLock(async () => {
      await blocker;
      throw new Error("fail");
    });

    await flushMicrotasks();

    const second = withOrderLock(async () => "ok");

    resolveFirst?.();

    await expect(first).rejects.toThrow("fail");
    expect(await second).toBe("ok");
    expect(isOrderLockHeld()).toBe(false);
  });

  it("three concurrent calls execute in FIFO order", async () => {
    const order: string[] = [];
    let resolve1: (() => void) | undefined;
    let resolve2: (() => void) | undefined;
    const block1 = new Promise<void>((r) => {
      resolve1 = r;
    });
    const block2 = new Promise<void>((r) => {
      resolve2 = r;
    });

    const p1 = withOrderLock(async () => {
      order.push("A-start");
      await block1;
      order.push("A-end");
    });

    await flushMicrotasks();

    const p2 = withOrderLock(async () => {
      order.push("B-start");
      await block2;
      order.push("B-end");
    });

    const p3 = withOrderLock(async () => {
      order.push("C");
    });

    await flushMicrotasks();
    expect(getOrderLockQueueLength()).toBe(2);

    resolve1?.();
    await flushMicrotasks();
    resolve2?.();

    await Promise.all([p1, p2, p3]);

    expect(order).toEqual(["A-start", "A-end", "B-start", "B-end", "C"]);
  });

  it("resetOrderLock clears held lock and pending queue", async () => {
    let resolve1: (() => void) | undefined;
    const blocker = new Promise<void>((r) => {
      resolve1 = r;
    });

    const p1 = withOrderLock(async () => {
      await blocker;
    });

    await flushMicrotasks();
    expect(isOrderLockHeld()).toBe(true);

    resetOrderLock();
    expect(isOrderLockHeld()).toBe(false);
    expect(getOrderLockQueueLength()).toBe(0);

    resolve1?.();
    await p1;
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  sleep,
  withRetry,
  calculateRetryDelay,
  DEFAULT_RETRY_OPTIONS,
} from "./retry";
import { WorkflowCanceledError } from "./errors";

describe("sleep", () => {
  it("should resolve after the given time", async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it("should reject immediately if signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(sleep(1000, controller.signal)).rejects.toThrow(
      WorkflowCanceledError,
    );
  });

  it("should reject when signal is aborted during sleep", async () => {
    const controller = new AbortController();

    const promise = sleep(5000, controller.signal);
    setTimeout(() => controller.abort(), 20);

    await expect(promise).rejects.toThrow(WorkflowCanceledError);
  });
});

describe("calculateRetryDelay", () => {
  it("should return base delay for first attempt", () => {
    expect(calculateRetryDelay(1, 1000, 2)).toBe(1000);
  });

  it("should apply backoff multiplier", () => {
    expect(calculateRetryDelay(2, 1000, 2)).toBe(2000);
    expect(calculateRetryDelay(3, 1000, 2)).toBe(4000);
  });

  it("should work with non-integer backoff", () => {
    expect(calculateRetryDelay(2, 100, 1.5)).toBe(150);
  });
});

describe("DEFAULT_RETRY_OPTIONS", () => {
  it("should have expected defaults", () => {
    expect(DEFAULT_RETRY_OPTIONS.maxRetries).toBe(3);
    expect(DEFAULT_RETRY_OPTIONS.delay).toBe(1000);
    expect(DEFAULT_RETRY_OPTIONS.backoff).toBe(2);
  });
});

describe("withRetry", () => {
  it("should return result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, {
      maxRetries: 3,
      delay: 10,
      backoff: 1,
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should retry on failure and succeed", async () => {
    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt++;
      if (attempt < 3) throw new Error(`fail ${attempt}`);
      return "success";
    });

    const result = await withRetry(fn, {
      maxRetries: 3,
      delay: 10,
      backoff: 1,
    });

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("should throw after exhausting retries", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));

    await expect(
      withRetry(fn, { maxRetries: 2, delay: 10, backoff: 1 }),
    ).rejects.toThrow("always fails");

    // 1 initial + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("should call onRetry callback", async () => {
    let attempt = 0;
    const onRetryCalls: Array<{ attempt: number; delay: number }> = [];

    const fn = vi.fn(async () => {
      attempt++;
      if (attempt < 3) throw new Error("fail");
      return "ok";
    });

    await withRetry(fn, {
      maxRetries: 3,
      delay: 100,
      backoff: 2,
      onRetry: (a, _err, d) => onRetryCalls.push({ attempt: a, delay: d }),
    });

    expect(onRetryCalls).toHaveLength(2);
    expect(onRetryCalls[0]).toEqual({ attempt: 1, delay: 100 });
    expect(onRetryCalls[1]).toEqual({ attempt: 2, delay: 200 });
  });

  it("should respect abort signal before first attempt", async () => {
    const controller = new AbortController();
    controller.abort();

    const fn = vi.fn().mockResolvedValue("ok");

    await expect(
      withRetry(fn, {
        maxRetries: 3,
        delay: 10,
        backoff: 1,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Aborted");

    expect(fn).not.toHaveBeenCalled();
  });

  it("should respect abort signal during retry wait", async () => {
    const controller = new AbortController();

    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    const promise = withRetry(fn, {
      maxRetries: 5,
      delay: 5000,
      backoff: 1,
      signal: controller.signal,
    });

    // Abort during the retry delay
    setTimeout(() => controller.abort(), 50);

    await expect(promise).rejects.toThrow(WorkflowCanceledError);
  });

  it("should apply backoff between retries", async () => {
    const timestamps: number[] = [];
    let attempt = 0;

    const fn = vi.fn(async () => {
      timestamps.push(Date.now());
      attempt++;
      if (attempt <= 2) throw new Error("fail");
      return "ok";
    });

    await withRetry(fn, { maxRetries: 3, delay: 50, backoff: 2 });

    // Check that delay increases between retries
    const gap1 = timestamps[1] - timestamps[0];
    const gap2 = timestamps[2] - timestamps[1];

    expect(gap1).toBeGreaterThanOrEqual(40); // ~50ms first delay
    expect(gap2).toBeGreaterThanOrEqual(80); // ~100ms second delay (50*2)
  });

  it("should convert non-Error throws to Error", async () => {
    const fn = vi.fn(async () => {
      throw "string error";
    });

    await expect(
      withRetry(fn, { maxRetries: 0, delay: 10, backoff: 1 }),
    ).rejects.toThrow("string error");
  });

  it("should use default options when none provided", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);

    expect(result).toBe("ok");
  });
});

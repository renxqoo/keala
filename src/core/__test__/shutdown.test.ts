import { afterEach, expect, it, vi } from "vitest";
import { Keala } from "../../index.ts";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(["synchronous", "asynchronous"])(
  "does not leave a timeout or report a second failure after a %s shutdown error",
  async (mode) => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("shutdown failed");
    const completed: string[] = [];
    const app = new Keala({ env: "test" });
    app.onShutdown(() => {
      completed.push("failed");
      if (mode === "synchronous") throw failure;
      return Promise.reject(failure);
    });
    app.onShutdown(() => {
      completed.push("next");
    });

    expect(await app.close({ shutdownTimeout: 100 })).toEqual({
      timedOut: false,
      inFlight: 0,
    });
    expect(completed).toEqual(["failed", "next"]);
    expect(errors).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("onShutdown handler #1 failed"),
      expect.stringContaining("shutdown failed"),
    );
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(errors).toHaveBeenCalledTimes(1);
    await app.close();
    expect(completed).toEqual(["failed", "next"]);
  },
);

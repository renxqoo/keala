/**
 * ROUND 7 core/runtime red tests.
 *
 * Each case below is deterministic against the current implementation and
 * asserts the intended public lifecycle/compatibility contract.  The tests
 * intentionally remain red until the corresponding source defect is fixed.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";

const quiet = { env: "test", silent: true } as const;

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("R7 core: guarded pooling owns every still-running onion branch", () => {
  it("throws on a stale write in the retired window and never leaks it to a later request", async () => {
    /**
     * Contract (see src/core/context/pool.ts): the prototype guard covers the
     * window from retirement until the object's next acquire — writes there
     * throw. Object identity cannot carry generations, so a stale reference
     * writing AFTER the object went live again for a new request is
     * unsupported (only a per-request proxy could separate it, costing more
     * than pooling saves). This locks the guaranteed window end to end.
     */
    const observed: string[] = [];
    const timerFired = deferred();
    const app = new Keala({ ...quiet, pooling: true });
    app.get("/first", (c) => {
      setTimeout(() => {
        try {
          c.body = "stale-timer-from-request-a";
        } catch (err) {
          observed.push((err as Error).message);
        }
        timerFired.resolve();
      }, 0);
      return new Response(null, { status: 204 });
    });

    const first = await app.handle(new Request("http://localhost/first"));
    expect(first.status).toBe(204);
    // The timer fires while the settled object sits retired in the pool (no
    // intervening acquire) — the write MUST throw the retirement error.
    await timerFired.promise;
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatch(/retired/);

    // The recycled object serves the next request clean.
    const victim = await app.handle(new Request("http://localhost/victim"));
    expect({ status: victim.status, body: await victim.text() }).toEqual({
      status: 404,
      body: "Not Found",
    });
  });

  it("does not recycle a context while an unawaited next() branch can still mutate it", async () => {
    /**
     * Repro: middleware starts `next()` without awaiting it, commits an early
     * response, and its delayed route writes `c.body` after that response is
     * consumed.  A second in-flight request deliberately acquires the pool
     * slot before the old branch resumes.
     *
     * Expected: request B remains its untouched 404; request A's late branch
     * must either finish before recycle or stay bound to request A's context.
     * Actual: request B becomes `200 stale-from-request-a`.
     * Root cause: compose observes a floating downstream promise only with a
     * detached `.catch()`, while app.handle retires the context as soon as the
     * early Response body is consumed; resetContext then makes that same
     * object live for request B while request A still owns it.
     */
    const releaseOldBranch = deferred();
    const oldBranchMutated = deferred();
    const victimStarted = deferred();
    const releaseVictim = deferred();

    let lateWriteThrew: unknown = null;
    const app = new Keala({ ...quiet, pooling: true });
    app.use((c, next) => {
      if (c.path === "/early") {
        void next();
        return c.text("early");
      }
      return next();
    });
    app.get("/early", async (c) => {
      await releaseOldBranch.promise;
      // 0.7: the early Response is already committed, so a late body write
      // is a loud TypeError instead of a silent stale mutation.
      try {
        c.body = "stale-from-request-a";
      } catch (error) {
        lateWriteThrew = error;
      }
      oldBranchMutated.resolve();
    });
    app.get("/victim", async () => {
      victimStarted.resolve();
      await releaseVictim.promise;
    });

    const early = await app.handle(new Request("http://localhost/early"));
    expect(await early.text()).toBe("early"); // consumes body and retires A

    const victimPending = Promise.resolve(app.handle(new Request("http://localhost/victim")));
    await victimStarted.promise; // B now owns the recycled object
    releaseOldBranch.resolve();
    await oldBranchMutated.promise;
    releaseVictim.resolve();

    const victim = await victimPending;
    expect({ status: victim.status, body: await victim.text() }).toEqual({
      status: 404,
      body: "Not Found",
    });
    expect(lateWriteThrew).toBeInstanceOf(TypeError);
  });
});

interface OpenBody {
  readonly body: ReadableStream<Uint8Array>;
  readonly finalizerPulledPastPrefix: Promise<void>;
  finish(): void;
}

/** A one-byte prefix followed by an open-ended producer. */
const openBody = (): OpenBody => {
  const pulled = deferred();
  const finish = deferred();
  let finished = false;
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x61]));
      },
      async pull(controller) {
        pulled.resolve();
        await finish.promise;
        if (!finished) {
          finished = true;
          controller.close();
        }
      },
    }),
    finalizerPulledPastPrefix: pulled.promise,
    finish: () => finish.resolve(),
  };
};

type HandleRace =
  | { readonly kind: "handled"; readonly response: Response }
  | { readonly kind: "body-pulled" };

const raceHandleAgainstBodyPull = async (
  pending: Promise<Response>,
  open: OpenBody,
): Promise<{ winner: HandleRace; response: Response }> => {
  const winner = await Promise.race<HandleRace>([
    pending.then((response) => ({ kind: "handled", response }) as const),
    open.finalizerPulledPastPrefix.then(() => ({ kind: "body-pulled" }) as const),
  ]);
  // Always release the producer so a red assertion cannot strand a stream.
  open.finish();
  const response = winner.kind === "handled" ? winner.response : await pending;
  return { winner, response };
};

describe("R7 core: response headers do not wait for an open stream body", () => {
  it("returns a dirty committed GET Response before sniffing its open body", async () => {
    /**
     * Repro: a route commits a content-type-less open stream and outer onion
     * middleware adds a header after `await next()`.
     *
     * Expected: app.handle returns the Response while the producer remains
     * open; body consumption belongs to the adapter/client.
     * Actual: the finalizer pulls beyond the available prefix first and waits
     * indefinitely for more bytes or EOF.
     * Root cause: rebuildCommitted -> mergedResponseHeaders ->
     * sniffContentType -> boundedRead eagerly consumes a cloned body until
     * EOF or 8192 bytes before constructing the response.
     */
    const open = openBody();
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      await next();
      c.setHeader("X-Late", "1");
    });
    app.get("/stream", () => new Response(open.body));

    const pending = Promise.resolve(app.handle(new Request("http://localhost/stream")));
    const { winner, response } = await raceHandleAgainstBodyPull(pending, open);
    await response.body?.cancel();

    expect(winner.kind).toBe("handled");
  });

  it("returns HEAD before trying to measure an open committed body", async () => {
    /**
     * Repro: HEAD falls back to a GET handler that commits an open stream.
     *
     * Expected: HEAD is returned promptly without a body; Content-Length may
     * be omitted because an open stream has no knowable finite length.
     * Actual: app.handle pulls the producer and blocks awaiting EOF/1 MiB.
     * Root cause: committedHead -> committedLength -> boundedRead treats a
     * byte budget as a completion condition, but a slow/open stream can stay
     * below that budget forever.
     */
    const open = openBody();
    const app = new Keala(quiet);
    app.get("/stream", () => new Response(open.body));

    const pending = Promise.resolve(
      app.handle(new Request("http://localhost/stream", { method: "HEAD" })),
    );
    const { winner, response } = await raceHandleAgainstBodyPull(pending, open);

    expect(response.body).toBeNull();
    expect(winner.kind).toBe("handled");
  });
});

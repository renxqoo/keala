/**
 * Shared stream-body primitives (review DEAD-20/21 dedup).
 *
 * Two skeletons that used to live as per-file copies:
 *
 * - `repumpStream`/`repumpResponse` re-pump an existing ReadableStream
 *   through a fresh one so the original response keeps its wire identity
 *   while the caller observes completion or producer failures. Three call
 *   sites share the pump: context recycling (core/context/pool.ts), drain
 *   in-flight holds (core/lifecycle.ts) and opt-in stream error observation
 *   (core/respond.ts) — the hooks differ, the pump is identical.
 * - `readAllLimited` reads a web body into one Uint8Array under a byte cap.
 *   plugins/body-parser.ts and adapters/node-source.ts carried line-for-line
 *   copies that differed only in the 413 error constructor, now injected.
 */

export interface RepumpHooks {
  /**
   * Fires exactly once when the pump finishes — clean end, read failure,
   * consumer cancel, or a controller op failing because the consumer had
   * already closed. Never fires for a locked body (the pump never started):
   * that case is `onLocked`'s.
   */
  onFinish?: () => void;
  /**
   * Producer read failures only. Controller-op TypeErrors after a consumer
   * close/cancel are not pump errors and never reach this hook.
   */
  onReadError?: (error: unknown) => void;
  /**
   * The body was locked or unreadable (typically a reused Response whose
   * stream an earlier request consumed): called first, then the original
   * error rethrows — callers own the loud failure and its fallback.
   */
  onLocked?: () => void;
}

/**
 * Re-pump `body` through a fresh ReadableStream. The pump runs on `pull` —
 * the source is only read as the consumer demands, so backpressure passes
 * straight through instead of buffering the body at wrap time.
 */
export const repumpStream = (body: ReadableStream, hooks: RepumpHooks): ReadableStream => {
  // Evolving let: the reader type differs across the DOM/Bun stream libs —
  // inferring from the assignment keeps both happy.
  let reader;
  try {
    reader = body.getReader();
  } catch (err) {
    hooks.onLocked?.();
    throw err;
  }
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    hooks.onFinish?.();
  };
  return new ReadableStream({
    async pull(controller) {
      let chunk;
      try {
        const read = await reader.read();
        if (read.done) {
          try {
            controller.close();
          } catch {
            // consumer already closed the stream
          }
          finish();
          return;
        }
        chunk = read.value;
      } catch (err) {
        // Only the READ may fail with a producer error — controller ops
        // after a consumer cancel/close throw benign TypeErrors that must
        // never surface as pump errors.
        hooks.onReadError?.(err);
        try {
          controller.error(err);
        } catch {
          // consumer already closed the stream
        }
        finish();
        return;
      }
      try {
        controller.enqueue(chunk);
      } catch {
        // The consumer closed/cancelled mid-pull — nothing more to pump.
        finish();
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => undefined);
      finish();
    },
  });
};

/**
 * `repumpStream` plus the fresh Response envelope — status, statusText and
 * headers carried over verbatim, the pumped stream as the body. Returns null
 * for a locked/unreadable body (`onLocked` has fired by then).
 */
export const repumpResponse = (value: Response, hooks: RepumpHooks): Response | null => {
  let pumped: ReadableStream;
  try {
    pumped = repumpStream(value.body!, hooks);
  } catch {
    // The only throw repumpStream can raise is the locked-body TypeError —
    // onLocked has already fired inside; callers own the loud fallback.
    return null;
  }
  return new Response(pumped, {
    status: value.status,
    statusText: value.statusText,
    headers: value.headers,
  });
};

/**
 * Read a web body into one Uint8Array under a byte cap: streamed reads count
 * bytes, cancel the source and fail through `tooLarge` at the boundary. A
 * single-chunk body is returned as-is — the same zero-copy the socket paths
 * keep for small requests.
 */
export const readAllLimited = async (
  body: ReadableStream<Uint8Array>,
  limit: number,
  tooLarge: () => Error,
): Promise<Uint8Array> => {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      // Cancel the source so the producer is not left mid-stream.
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

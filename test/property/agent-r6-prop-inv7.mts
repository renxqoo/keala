/**
 * ROUND 6 property rig, part 3 — INV-1/INV-7 helpers (post-commit
 * mutation ops, committer styles, RespCfg). Split for the file budget.
 */
import type { Context } from "../../src/core/context/context.ts";
import type { RouteHandler } from "../../src/router/router.ts";
import {
  PRINTABLE,
  Rng,
  randHeaderName,
  randHeaderValue,
  randString,
} from "./agent-r6-prop-rig.mts";
import { CTL, REDIRECT_TARGETS, UNICODE } from "./agent-r6-prop-rig.mts";
// ---------------------------------------------------------------------------
// INV-1: never-reject — app.handle never throws / rejects, always a Response
// ---------------------------------------------------------------------------

/**
 * Random post-commit mutations (the U3c commit surface): header/cookie-ish
 * writes land directly on the committed Response's Headers; values that
 * fail validation (CTL) or the wire's ByteString rule throw TypeError and
 * are caught by the caller's log — both halves belong in the zoo. The
 * status/body/type/length/etag/lastModified/attachment ops died with the
 * setter family; the live surface below carries the mutation classes.
 */
export const lateMutations = (rng: Rng): ((c: Context, log?: string[]) => void) => {
  const ops: ((c: Context, log?: string[]) => void)[] = [];
  const n = rng.range(1, 4);
  for (let i = 0; i < n; i++) {
    switch (rng.int(8)) {
      case 0:
        ops.push((c, log) => {
          log?.push("set");
          c.setHeader(randHeaderName(rng), randHeaderValue(rng));
        });
        break;
      case 1:
        ops.push((c, log) => {
          log?.push("append");
          c.append(
            randHeaderName(rng),
            rng.bool(0.5) ? randHeaderValue(rng) : [randHeaderValue(rng)],
          );
        });
        break;
      case 2:
        ops.push((c, log) => {
          log?.push("remove");
          c.remove(rng.pick(["content-type", "x-custom", "set-cookie", "etag", "vary"] as const));
        });
        break;
      case 3:
        ops.push((c, log) => {
          log?.push("cookies");
          c.cookies.set("late", "1");
        });
        break;
      case 4:
        ops.push((c, log) => {
          // Post-commit redirect(): builds a Response whose return value the
          // void caller drops — legal, inert, still worth exercising.
          log?.push("redirect");
          c.redirect(rng.pick(REDIRECT_TARGETS));
        });
        break;
      case 5:
        ops.push((c, log) => {
          log?.push("vary");
          c.append("Vary", "x-late");
        });
        break;
      case 6:
        ops.push((c, log) => {
          // CTL value: validation rejects it AT THE CALL — the loud half.
          log?.push("ctl-set");
          c.setHeader("x-r6-late", randString(rng, 12, PRINTABLE + CTL));
        });
        break;
      default:
        ops.push((c, log) => {
          // Non-ByteString value: passes validation, detonates at the
          // committed Headers' wire rule — the R6-1 mutation class.
          log?.push("poison-set");
          c.setHeader("x-r6-late", `café${randString(rng, 4, UNICODE)}中`);
        });
    }
  }
  return (c: Context, log?: string[]): void => {
    for (const op of ops) {
      try {
        op(c, log);
      } catch (err) {
        log?.push(`!THREW:${String(err).slice(0, 60)}`);
      }
    }
  };
};

export const commitStyles = [
  "text",
  "json",
  "html",
  "response",
  "stream",
  "response-body",
] as const;

export const committer = (rng: Rng, style: (typeof commitStyles)[number]): RouteHandler => {
  switch (style) {
    case "text":
      return (c) => c.text(randString(rng, 24, PRINTABLE), rng.pick([200, 201, 418] as const));
    case "json":
      return (c) => c.json({ a: 1, b: [1, 2] }, rng.pick([200, 201, 500] as const));
    case "html":
      return (c) => c.html(`<b>${randString(rng, 8, PRINTABLE)}</b>`);
    case "stream":
      return () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("stream-body"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/plain" } },
        );
    case "response-body":
      // pipe the REQUEST body stream straight out as the response body
      return (c) =>
        new Response(c.raw.body, { headers: { "content-type": "application/octet-stream" } });
    default:
      return () => new Response(randString(rng, 16, PRINTABLE));
  }
};

// ---------------------------------------------------------------------------
// INV-7 shared helpers (reconstructed after the file split)
// ---------------------------------------------------------------------------

export const EMPTY_CFG = new Set([204, 205, 304]);

export interface RespCfg {
  /** U3c: the two answer shapes are sugar helpers and hand-built Responses. */
  style: "sugar" | "response";
  status: number;
  body: "text" | "json" | "bytes" | "stream" | "redirect";
}

const oneShotStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("cfg-stream"));
      controller.close();
    },
  });

export const makeCfgHandler =
  (cfg: RespCfg): RouteHandler =>
  (c) => {
    if (cfg.body === "redirect") {
      // U3a: redirect IS the return form — the old staged/committed style
      // split collapsed into one path (both produced the same wire answer).
      return c.redirect("/target");
    }
    // §2.3-2: empty statuses never carry a body on any form — the sugar
    // helpers cleanse at construction; a bodied hand-built 204/304 cannot
    // even be constructed (undici refuses it outright).
    if (EMPTY_CFG.has(cfg.status)) {
      if (cfg.style === "sugar") {
        return cfg.body === "json"
          ? c.json({ ok: true }, cfg.status)
          : c.text("cfg-body", cfg.status);
      }
      return new Response(null, { status: cfg.status });
    }
    if (cfg.style === "sugar") {
      // The sugar surface is text/json only — bytes and streams ride
      // hand-built Responses by API construction.
      if (cfg.body === "json") return c.json({ ok: true }, cfg.status);
      return c.text("cfg-body", cfg.status);
    }
    if (cfg.body === "json") return Response.json({ ok: true }, { status: cfg.status });
    if (cfg.body === "bytes") {
      return new Response(new TextEncoder().encode("cfg-bytes"), { status: cfg.status });
    }
    if (cfg.body === "stream") return new Response(oneShotStream(), { status: cfg.status });
    return new Response("cfg-body", { status: cfg.status });
  };

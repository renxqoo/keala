/**
 * ROUND 6 property rig, part 3 — INV-1/INV-7 helpers (post-commit
 * mutation ops, committer styles, RespCfg). Split for the file budget.
 */
import type { Context } from "../src/core/context/context.ts";
import type { RouteHandler } from "../src/router/router.ts";
import {
  PRINTABLE,
  Rng,
  randHeaderName,
  randHeaderValue,
  randString,
} from "./agent-r6-prop-rig.mts";
import { REDIRECT_TARGETS, TOKEN } from "./agent-r6-prop-rig.mts";
// ---------------------------------------------------------------------------
// INV-1: never-reject — app.handle never throws / rejects, always a Response
// ---------------------------------------------------------------------------

/**
 * Random post-commit mutations (the 0.7 commit surface): header/cookie-ish
 * writes land in place; body/status/redirect writes throw TypeError and are
 * caught by the caller's log — both halves belong in the zoo.
 */
export const lateMutations = (rng: Rng): ((c: Context, log?: string[]) => void) => {
  const ops: ((c: Context, log?: string[]) => void)[] = [];
  const n = rng.range(1, 4);
  for (let i = 0; i < n; i++) {
    switch (rng.int(13)) {
      case 0:
        ops.push((c, log) => {
          log?.push("status");
          c.status = rng.pick([200, 201, 204, 205, 301, 302, 304, 418, 500] as const);
        });
        break;
      case 1:
        ops.push((c, log) => {
          // 0.7: the c.message op became a lastModified write (occasionally
          // invalid, which throws exactly like the old message setter did).
          log?.push("last-modified");
          c.lastModified = rng.bool(0.2) ? new Date(Number.NaN) : new Date(rng.int(4102444800000));
        });
        break;
      case 2:
        ops.push((c, log) => {
          log?.push("body");
          c.body = rng.pick([
            "late-body",
            { late: true },
            new TextEncoder().encode("late-bytes") as Uint8Array,
            null,
            undefined,
          ]) as Context["body"];
        });
        break;
      case 3:
        ops.push((c, log) => {
          log?.push("set");
          c.setHeader(randHeaderName(rng), randHeaderValue(rng));
        });
        break;
      case 4:
        ops.push((c, log) => {
          log?.push("append");
          c.append(
            randHeaderName(rng),
            rng.bool(0.5) ? randHeaderValue(rng) : [randHeaderValue(rng)],
          );
        });
        break;
      case 5:
        ops.push((c, log) => {
          log?.push("remove");
          c.remove(rng.pick(["content-type", "x-custom", "set-cookie", "etag", "vary"] as const));
        });
        break;
      case 6:
        ops.push((c, log) => {
          log?.push("cookies");
          c.cookies.set("late", "1");
        });
        break;
      case 7:
        ops.push((c, log) => {
          log?.push("redirect");
          c.redirect(rng.pick(REDIRECT_TARGETS));
        });
        break;
      case 8:
        ops.push((c, log) => {
          // 0.7: c.vary is gone; append("Vary", …) is the replacement.
          log?.push("vary");
          c.append("Vary", "x-late");
        });
        break;
      case 9:
        ops.push((c, log) => {
          log?.push("type");
          c.type = rng.bool(0.5) ? randString(rng, 10, TOKEN) : randHeaderValue(rng);
        });
        break;
      case 10:
        ops.push((c, log) => {
          log?.push("length");
          c.length = rng.range(0, 100);
        });
        break;
      case 11:
        ops.push((c, log) => {
          log?.push("etag");
          c.etag = randString(rng, 8, TOKEN);
        });
        break;
      default:
        ops.push((c, log) => {
          log?.push("attachment");
          c.attachment(randString(rng, 8, PRINTABLE));
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
  style: "state" | "sugar" | "committed";
  status: number;
  body: "text" | "json" | "bytes" | "redirect";
}

export const makeCfgHandler =
  (cfg: RespCfg): RouteHandler =>
  (c) => {
    if (cfg.body === "redirect") {
      c.redirect("/target");
      if (cfg.style === "committed")
        return new Response(null, { status: 302, headers: { location: "/target" } });
      return;
    }
    const body =
      cfg.body === "text"
        ? "cfg-body"
        : cfg.body === "json"
          ? { ok: true }
          : new TextEncoder().encode("cfg-bytes");
    if (cfg.style === "state") {
      c.status = cfg.status;
      c.body = body;
      return;
    }
    if (cfg.style === "sugar") {
      if (typeof body === "string") return c.text(body, cfg.status);
      return c.json(body, cfg.status);
    }
    return new Response(body as unknown as string, { status: cfg.status });
  };

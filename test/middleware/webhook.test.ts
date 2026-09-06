/**
 * webhook (N3) component tests: HMAC-SHA256 verification for the four
 * provider wire formats (stripe/github/slack/raw) — one happy path per
 * format (both real-world hex and documented base64 encodings), every
 * rejection class (missing/empty/malformed signature → 400, well-formed
 * mismatch and body tampering → 401, stale timestamp → 400), the tolerance
 * window, and the body-preservation contract (the MAC is computed over a
 * clone, so the downstream handler's own read still works).
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { webhook, type WebhookFormat, type WebhookOptions } from "../../src/middleware/webhook.ts";
import type { RouteHandler } from "../../src/router/router.ts";

const quiet = { env: "test" } as const;
const SECRET = "whsec_n3_test_secret";
const BODY = JSON.stringify({ type: "ping", id: "evt_1" });

const mac = (secret: string, payload: string) => {
  const digest = createHmac("sha256", secret).update(payload).digest();
  return { hex: digest.toString("hex"), base64: digest.toString("base64") };
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

const hookApp = (options: WebhookOptions, handler?: RouteHandler) => {
  const app = new Keala(quiet);
  app.post("/hook", webhook(options), handler ?? ((c) => c.text("received")));
  return app;
};

const post = (app: Keala, headers: Record<string, string>, body = BODY) =>
  app.handle(new Request("http://localhost:3000/hook", { method: "POST", headers, body }));

/**
 * A body-consuming middleware: drains the request stream, so a webhook
 * mounted AFTER it has nothing left to clone — the route 500s instead of
 * verifying. Locks the documented ordering requirement (doc note in
 * webhook.ts): webhook goes BEFORE any body reader.
 */
const bodyReader: RouteHandler = async (c, next) => {
  await c.raw.text();
  await next();
};

describe("webhook: valid signatures pass", () => {
  it("stripe format accepts t=…,v1=<base64>", async () => {
    const ts = String(nowSeconds());
    const headers = { "stripe-signature": `t=${ts},v1=${mac(SECRET, `${ts}.${BODY}`).base64}` };
    expect(
      (
        await post(
          hookApp({ secret: SECRET, header: "stripe-signature", format: "stripe" }),
          headers,
        )
      ).status,
    ).toBe(200);
  });

  it("stripe format also accepts the hex v1 Stripe actually puts on the wire", async () => {
    const ts = String(nowSeconds());
    const headers = { "stripe-signature": `t=${ts},v1=${mac(SECRET, `${ts}.${BODY}`).hex}` };
    expect(
      (
        await post(
          hookApp({ secret: SECRET, header: "stripe-signature", format: "stripe" }),
          headers,
        )
      ).status,
    ).toBe(200);
  });

  it("stripe format verifies any listed v1 (key rotation)", async () => {
    const ts = String(nowSeconds());
    const stale = mac(SECRET, `${ts}.${BODY}`).base64;
    const current = mac("whsec_rotated", `${ts}.${BODY}`).base64;
    const app = hookApp({ secret: "whsec_rotated", header: "stripe-signature", format: "stripe" });
    const res = await post(app, { "stripe-signature": `t=${ts},v1=${stale},v1=${current}` });
    expect(res.status).toBe(200);
  });

  it("github format accepts sha256=<hex>", async () => {
    const headers = { "x-hub-signature-256": `sha256=${mac(SECRET, BODY).hex}` };
    expect(
      (
        await post(
          hookApp({ secret: SECRET, header: "x-hub-signature-256", format: "github" }),
          headers,
        )
      ).status,
    ).toBe(200);
  });

  it("slack format accepts v0=<base64> + x-slack-request-timestamp", async () => {
    const ts = String(nowSeconds());
    const headers = {
      "x-slack-signature": `v0=${mac(SECRET, `v0:${ts}:${BODY}`).base64}`,
      "x-slack-request-timestamp": ts,
    };
    expect(
      (
        await post(
          hookApp({ secret: SECRET, header: "x-slack-signature", format: "slack" }),
          headers,
        )
      ).status,
    ).toBe(200);
  });

  it("slack format also accepts the v0=<ts>,<base64> comma-embedded form", async () => {
    const ts = String(nowSeconds());
    const headers = { "x-slack-signature": `v0=${ts},${mac(SECRET, `v0:${ts}:${BODY}`).base64}` };
    expect(
      (
        await post(
          hookApp({ secret: SECRET, header: "x-slack-signature", format: "slack" }),
          headers,
        )
      ).status,
    ).toBe(200);
  });

  it("slack: the timestamp header wins when both forms are present (locked precedence)", async () => {
    const headerTs = String(nowSeconds());
    // An hour-old embedded timestamp: stale if chosen, harmless when ignored.
    const embeddedTs = String(nowSeconds() - 3600);
    // The MAC covers the HEADER timestamp — the one that will be chosen.
    const signature = mac(SECRET, `v0:${headerTs}:${BODY}`).base64;
    const res = await post(
      hookApp({ secret: SECRET, header: "x-slack-signature", format: "slack" }),
      {
        "x-slack-signature": `v0=${embeddedTs},${signature}`,
        "x-slack-request-timestamp": headerTs,
      },
    );
    expect(res.status).toBe(200);
  });

  it("raw format accepts a bare hex signature", async () => {
    const headers = { "x-signature": mac(SECRET, BODY).hex };
    expect(
      (await post(hookApp({ secret: SECRET, header: "x-signature", format: "raw" }), headers))
        .status,
    ).toBe(200);
  });

  it("raw format accepts a bare base64 signature", async () => {
    const headers = { "x-signature": mac(SECRET, BODY).base64 };
    expect(
      (await post(hookApp({ secret: SECRET, header: "x-signature", format: "raw" }), headers))
        .status,
    ).toBe(200);
  });
});

describe("webhook: forgeries are rejected", () => {
  const ts = String(nowSeconds());
  const cases: [string, WebhookOptions, Record<string, string>][] = [
    [
      "stripe",
      { secret: SECRET, header: "stripe-signature", format: "stripe" },
      { "stripe-signature": `t=${ts},v1=${mac(SECRET, `${ts}.other-body`).base64}` },
    ],
    [
      "github",
      { secret: SECRET, header: "x-hub-signature-256", format: "github" },
      { "x-hub-signature-256": `sha256=${mac(SECRET, "other-body").hex}` },
    ],
    [
      "slack",
      { secret: SECRET, header: "x-slack-signature", format: "slack" },
      {
        "x-slack-signature": `v0=${mac(SECRET, `v0:${ts}:other-body`).base64}`,
        "x-slack-request-timestamp": ts,
      },
    ],
    [
      "raw",
      { secret: SECRET, header: "x-signature", format: "raw" },
      { "x-signature": mac(SECRET, "other-body").base64 },
    ],
  ];

  it.each(cases)("well-formed but wrong signature → 401 (%s)", async (_label, options, headers) => {
    const res = await post(hookApp(options), headers);
    expect(res.status).toBe(401);
  });

  it("a signature computed over a different body (tampered payload) → 401", async () => {
    const stamp = String(nowSeconds());
    const headers = {
      "stripe-signature": `t=${stamp},v1=${mac(SECRET, `${stamp}.${BODY}`).base64}`,
    };
    const res = await post(
      hookApp({ secret: SECRET, header: "stripe-signature", format: "stripe" }),
      headers,
      `${BODY} `,
    );
    expect(res.status).toBe(401);
  });
});

describe("webhook: malformed requests → 400, never a 500", () => {
  const ts = String(nowSeconds());
  const stripe = { secret: SECRET, header: "stripe-signature", format: "stripe" } as const;
  const github = { secret: SECRET, header: "x-hub-signature-256", format: "github" } as const;
  const slack = { secret: SECRET, header: "x-slack-signature", format: "slack" } as const;

  it("missing signature header → 400", async () => {
    expect((await post(hookApp(stripe), {})).status).toBe(400);
    expect((await post(hookApp(github), {})).status).toBe(400);
  });

  it("empty signature value → 400", async () => {
    expect((await post(hookApp(stripe), { "stripe-signature": "" })).status).toBe(400);
    expect((await post(hookApp(github), { "x-hub-signature-256": "   " })).status).toBe(400);
  });

  it.each([
    ["stripe: non-hex/base64 v1", stripe, { "stripe-signature": `t=${ts},v1=@@not-a-mac@@` }],
    [
      "stripe: hex of the wrong length",
      stripe,
      { "stripe-signature": `t=${ts},v1=${"ab".repeat(31)}` },
    ],
    [
      "stripe: no timestamp",
      stripe,
      { "stripe-signature": `v1=${mac(SECRET, `${ts}.${BODY}`).base64}` },
    ],
    ["stripe: no v1", stripe, { "stripe-signature": `t=${ts}` }],
    ["github: missing sha256= prefix", github, { "x-hub-signature-256": mac(SECRET, BODY).hex }],
    ["github: non-hex mac", github, { "x-hub-signature-256": "sha256=zzz" }],
    [
      "slack: no timestamp anywhere",
      slack,
      { "x-slack-signature": `v0=${mac(SECRET, `v0:${ts}:${BODY}`).base64}` },
    ],
    [
      "raw: garbage value",
      { secret: SECRET, header: "x-signature", format: "raw" } as const,
      { "x-signature": "!!!!" },
    ],
  ])("%s → 400", async (_label, options, headers) => {
    expect((await post(hookApp(options), headers)).status).toBe(400);
  });

  it("a non-numeric timestamp → 400", async () => {
    const badTs = "not-a-number";
    const headers = {
      "x-slack-signature": `v0=${mac(SECRET, `v0:${badTs}:${BODY}`).base64}`,
      "x-slack-request-timestamp": badTs,
    };
    expect((await post(hookApp(slack), headers)).status).toBe(400);
  });
});

describe("webhook: tolerance window", () => {
  const staleTs = () => String(nowSeconds() - 400); // 100s past the default 300s window

  it("a fresh timestamp (default 300s tolerance) passes", async () => {
    const ts = String(nowSeconds() - 200);
    const headers = { "stripe-signature": `t=${ts},v1=${mac(SECRET, `${ts}.${BODY}`).base64}` };
    expect(
      (
        await post(
          hookApp({ secret: SECRET, header: "stripe-signature", format: "stripe" }),
          headers,
        )
      ).status,
    ).toBe(200);
  });

  it("an expired timestamp → 400 even with a perfectly valid signature (stripe)", async () => {
    const ts = staleTs();
    const headers = { "stripe-signature": `t=${ts},v1=${mac(SECRET, `${ts}.${BODY}`).base64}` };
    expect(
      (
        await post(
          hookApp({ secret: SECRET, header: "stripe-signature", format: "stripe" }),
          headers,
        )
      ).status,
    ).toBe(400);
  });

  it("an expired timestamp → 400 (slack)", async () => {
    const ts = staleTs();
    const headers = {
      "x-slack-signature": `v0=${mac(SECRET, `v0:${ts}:${BODY}`).base64}`,
      "x-slack-request-timestamp": ts,
    };
    expect(
      (
        await post(
          hookApp({ secret: SECRET, header: "x-slack-signature", format: "slack" }),
          headers,
        )
      ).status,
    ).toBe(400);
  });

  it("a future timestamp beyond the window → 400", async () => {
    const ts = String(nowSeconds() + 400);
    const headers = { "stripe-signature": `t=${ts},v1=${mac(SECRET, `${ts}.${BODY}`).base64}` };
    expect(
      (
        await post(
          hookApp({ secret: SECRET, header: "stripe-signature", format: "stripe" }),
          headers,
        )
      ).status,
    ).toBe(400);
  });

  it("tolerance is configurable", async () => {
    const options = {
      secret: SECRET,
      header: "stripe-signature",
      format: "stripe",
      tolerance: 5,
    } as const;
    const app = hookApp(options);
    const old = String(nowSeconds() - 10);
    const edge = String(nowSeconds() - 3);
    const forTs = (ts: string) => ({
      "stripe-signature": `t=${ts},v1=${mac(SECRET, `${ts}.${BODY}`).base64}`,
    });
    expect((await post(app, forTs(old))).status).toBe(400);
    expect((await post(app, forTs(edge))).status).toBe(200);
  });
});

describe("webhook: body preservation contract", () => {
  it("the downstream handler can still read the body after verification", async () => {
    const app = hookApp({ secret: SECRET, header: "x-signature", format: "raw" }, async (c) =>
      c.text((await c.raw.clone().text()) === BODY ? "body-intact" : "body-lost"),
    );
    const res = await post(app, { "x-signature": mac(SECRET, BODY).base64 });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("body-intact");
  });
});

describe("webhook: mount-order contract", () => {
  it("a body consumed upstream turns verification into a 500 — mount webhook BEFORE body readers", async () => {
    const app = new Keala(quiet);
    app.post(
      "/hook",
      bodyReader,
      webhook({ secret: SECRET, header: "x-signature", format: "raw" }),
      (c) => c.text("received"),
    );
    const res = await post(app, { "x-signature": mac(SECRET, BODY).hex });
    expect(res.status).toBe(500);
  });
});

describe("webhook: setup validation", () => {
  it.each([
    ["missing secret", { header: "x", format: "stripe" } as Partial<WebhookOptions>],
    ["empty secret", { secret: "", header: "x", format: "stripe" } as Partial<WebhookOptions>],
    ["missing header name", { secret: "s", format: "stripe" } as Partial<WebhookOptions>],
    [
      "empty header name",
      { secret: "s", header: "  ", format: "stripe" } as Partial<WebhookOptions>,
    ],
    ["unknown format", { secret: "s", header: "x", format: "svix" as WebhookFormat }],
    ["zero tolerance", { secret: "s", header: "x", format: "stripe", tolerance: 0 }],
    ["negative tolerance", { secret: "s", header: "x", format: "stripe", tolerance: -5 }],
  ])("%s → TypeError", (_label, options) => {
    expect(() => webhook(options as WebhookOptions)).toThrow(TypeError);
  });
});

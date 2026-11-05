import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { Keala } from "../../index.ts";
import { webhook, type WebhookFormat } from "../index.ts";

const secret = "raw-webhook-secret";
const formats: WebhookFormat[] = ["raw", "github", "stripe", "slack"];

const signedHeaders = (format: WebhookFormat, body: Uint8Array): Record<string, string> => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const prefix =
    format === "stripe" ? `${timestamp}.` : format === "slack" ? `v0:${timestamp}:` : "";
  const mac = createHmac("sha256", secret).update(prefix).update(body).digest("hex");
  return {
    "x-signature":
      format === "stripe"
        ? `t=${timestamp},v1=${mac}`
        : format === "github"
          ? `sha256=${mac}`
          : format === "slack"
            ? `v0=${mac}`
            : mac,
    "x-slack-request-timestamp": timestamp,
  };
};

it.each(formats)("does not reject valid %s signatures over non-UTF-8 raw bytes", async (format) => {
  const body = Uint8Array.of(0xff, 0, 0xef, 0xbb, 0xbf);
  const app = new Keala({ env: "test" });
  app.post("/", webhook({ secret, header: "x-signature", format }), async (c) =>
    c.text(Buffer.from(await c.raw.arrayBuffer()).toString("hex")),
  );
  const response = await app.handle(
    new Request("http://test/", { method: "POST", headers: signedHeaders(format, body), body }),
  );
  expect([response.status, await response.text()]).toEqual([200, "ff00efbbbf"]);
});

it.each(formats)("rejects altered %s bytes that decode to the same UTF-8 text", async (format) => {
  const original = Uint8Array.of(0xef, 0xbf, 0xbd);
  const app = new Keala({ env: "test" });
  app.post("/", webhook({ secret, header: "x-signature", format }), (c) => c.text("accepted"));
  const response = await app.handle(
    new Request("http://test/", {
      method: "POST",
      headers: signedHeaders(format, original),
      body: Uint8Array.of(0xff),
    }),
  );
  expect([response.status, await response.text()]).toEqual([401, "Invalid webhook signature"]);
});

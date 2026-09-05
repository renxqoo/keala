/**
 * The keala surface under node:http — the official Node adapter twin of
 * examples/app.ts.
 *
 *   node examples/app-node.ts 3188   (also runs: bun examples/app-node.ts)
 *
 * Everything except the listener is the same code: the JS mirrors of the
 * native sinks serve /health and /assets/* on every runtime, `app.listen()`
 * is replaced by `listen()` from "keala/node", and websocket
 * routes would answer 501 here (ws is Bun-only) — this twin registers none.
 */

import {
  Keala,
  createBodyParser,
  Router,
  hashPassword,
  html,
  streamSSE,
  verifyPassword,
} from "../src/index.ts";
import { basicAuth, secureHeaders, serveStatic, validator } from "../src/middleware/index.ts";
import { listen } from "../src/adapters/node.ts";

const app = new Keala({ keys: ["change-me"], env: "production" });
app.use(createBodyParser({ jsonLimit: 256 * 1024 }));

// Sunk routes degrade to their JS mirrors under Node — same paths, same
// responses (the native Bun routing table is a fast path, not a semantic).
app.sink("/health", new Response("ok", { headers: { "cache-control": "no-store" } }));
app.sink("/assets/*", { dir: "./examples/public" });

app.get("/", (c) => c.html(html`<h1>keala · node adapter</h1>`));

const api = new Router({ prefix: "/api" });
api.use(secureHeaders());
const UserSchema = {
  "~standard": {
    version: 1,
    vendor: "example",
    validate(value: unknown) {
      if (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { name?: unknown }).name === "string"
      ) {
        return { value };
      }
      return { issues: [{ message: "body.name must be a string" }] };
    },
  },
} as const;
api.post("/users", validator(UserSchema), (c) =>
  c.json({ created: (c.valid as { name: string }).name }, 201),
);

// Password hashing is WebCrypto PBKDF2 by default — identical under Node.
const passwordHash = await hashPassword("hunter2");
api.post(
  "/login",
  basicAuth({
    verify: async (user, pass) => user === "admin" && (await verifyPassword(passwordHash, pass)),
  }),
  (c) => c.json({ token: "session-token" }),
);
api.get("/users/:id", (c) => c.json({ id: c.params("id") }));
api.get("/events", (c) =>
  streamSSE(c, async (sse) => {
    for (let i = 0; i < 3; i++) sse.send({ event: "tick", data: i });
  }),
);

app.mount("/", api);
app.get("/docs/*", serveStatic({ root: "./examples/public", prefix: "/docs" }));

app.notFound((c) => {
  c.status = 404;
  c.body = "nothing here";
});

const port = Number(process.argv[2] ?? 3188);
listen(app, port, "127.0.0.1", () => {
  console.log(`keala node-adapter example on 127.0.0.1:${port}`);
  console.log("  GET  /health, /assets/app.css, /docs/app.css   (JS mirrors)");
  console.log("  POST /api/login  basicAuth (admin:hunter2) → PBKDF2 verify");
  console.log("  POST /api/users  Standard Schema validator; GET /api/events (SSE)");
});

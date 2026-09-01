/**
 * keala — complete surface in one runnable file.
 *
 *   bun examples/app.ts   → http://localhost:3000
 *
 * Covers the whole plugin stack: onion middleware, both response styles,
 * routing (params/wildcards/named urls), validation, body parsing, CORS,
 * CSRF tokens, auth (Bun.password), SSE, static files, websocket, and the
 * Bun-native route sink.
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
import {
  basicAuth,
  csrfToken,
  csrfTokenGuard,
  secureHeaders,
  serveStatic,
  validator,
} from "../src/middleware/index.ts";

const app = new Keala({ keys: ["change-me"], env: "production" });

// --- plugins (context facades — safe alongside native sinks) ----------
app.use(createBodyParser({ jsonLimit: 256 * 1024 }));

// NOTE: onion middleware (like secureHeaders) must NOT be registered
// globally on a sink-bearing app — the native routing table bypasses it.
// Scope it to the routes that need it instead (see the api router below).

const tokens = csrfToken({ secret: process.env["CSRF_SECRET"] ?? "dev-secret" });
const sessionOf = (cookie: string): string | undefined => cookie.match(/session=([^;]+)/)?.[1];

// --- native sinks (zero-JS fast paths; mirrored for portability) ----------
app.sink("/health", new Response("ok", { headers: { "cache-control": "no-store" } }));
app.sink("/assets/*", { dir: "./examples/public" });

// --- routes ---------------------------------------------------------------
app.get("/", (c) =>
  c.html(
    html`<h1>keala</h1>
      <a href="/health">/health</a> (native sink)`,
  ),
);

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

api.post(
  "/users",
  csrfTokenGuard({ service: tokens, sessionId: (c) => sessionOf(c.get("cookie")) }),
  validator(UserSchema),
  (c) => c.json({ created: (c.valid as { name: string }).name }, 201),
);

// Password login against a Bun.password (argon2id) hash.
const passwordHash = await hashPassword("hunter2");
api.post(
  "/login",
  basicAuth({
    verify: async (user, pass) => user === "admin" && (await verifyPassword(passwordHash, pass)),
  }),
  (c) => c.json({ token: "session-token" }),
);

api.get("/users/:id", (c) => c.json({ id: c.params["id"] }));
api.get("/events", (c) =>
  streamSSE(c, async (sse) => {
    for (let i = 0; i < 3; i++) sse.send({ event: "tick", data: i });
  }),
);

app.mount("/", api);
app.get("/docs/*", serveStatic({ root: "./examples/public", prefix: "/docs" }));

app.ws("/chat", {
  open(ws) {
    (ws as unknown as { send(d: string): void }).send("welcome");
  },
  message(ws, data) {
    (ws as unknown as { send(d: string): void }).send(`echo: ${String(data)}`);
  },
});

app.notFound((c) => {
  c.status = 404;
  c.body = "nothing here";
});

const port = Number(process.argv[2] ?? 3100);
const server = app.listen({ port });
console.log(`keala example on ${server.hostname}:${server.port}`);
console.log("  GET  /            html page");
console.log("  GET  /health      native-sunk static response");
console.log("  GET  /assets/*    native-sunk directory");
console.log("  POST /api/login   basicAuth (admin:hunter2) → Bun.password verify");
console.log("  POST /api/users   csrfTokenGuard + Standard Schema validator");
console.log("  GET  /api/users/42, /api/events (SSE), ws /chat");

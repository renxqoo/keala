// DIAG — serve a minimal keala app; expose splitPathSearch invocation count.
// Requires TEMPORARY instrumentation (not committed): add
//   (globalThis as any).__splitCalls = ((globalThis as any).__splitCalls ?? 0) + 1;
// as the first statement inside splitPathSearch in src/utils/url.ts, run:
//   bun bench/route-shootout/diag/count-split-calls.ts [port]
//   curl /user ×N → curl /debug/count  (calls == requests + the count call)
// Verdict it produced (2026-09-05): exactly 1 call per request — the
// 28.6% self-time bun --cpu-prof attributed to splitPathSearch was an
// inlining attribution artifact, not a real hot spot.
import { Keala } from "../../../src/index.ts";

const app = new Keala({ env: "production" });
app.get("/user", (c) => c.text("user"));
app.get("/user/comments", (c) => c.text("user/comments"));
app.get("/event/:id/comments", (c) => c.text(c.params["id"]!));
app.get("/static/*", (c) => c.text(c.params["wildcard"]!));
app.get("/debug/count", (c) =>
  c.json({ calls: (globalThis as { __splitCalls?: number }).__splitCalls ?? 0 }),
);

const port = Number(process.argv[2] ?? 4390);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
app.listen(port, "127.0.0.1");
console.log(`listening ${port}`);

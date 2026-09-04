/** Minimal published-artifact server used by the cross-runtime process check. */

import { Keala, createBodyParser } from "../dist/index.js";

const port = Number.parseInt(process.argv[2] ?? "0", 10);
const app = new Keala({ env: "production" });

app.use(createBodyParser({ jsonLimit: 16 }));
app.use(async (c, next) => {
  await next();
  c.setHeader("x-artifact", "dist");
});
app.get("/health", (c) => c.text("ok"));
app.get("/users/:id", (c) => c.json({ id: c.params?.id }));
app.post("/echo", async (c) => c.json(await c.req.json()));

if (typeof Bun !== "undefined") {
  app.listen({ port, hostname: "127.0.0.1" });
} else {
  const { listen } = await import("../dist/adapters/node.js");
  listen(app, port, "127.0.0.1");
}

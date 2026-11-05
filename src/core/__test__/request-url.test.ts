import { connect } from "node:net";
import { expect, it } from "vitest";
import { Keala, type Context } from "../../index.ts";
import { listen } from "../../adapters/node.ts";

function view(c: Context): Response {
  return c.json({
    path: c.path,
    url: c.url,
    search: c.search,
    next: c.query("next") ?? null,
    URLpath: c.URL?.pathname,
  });
}

it.each([
  [
    "http://example.test?next=/private",
    { path: "/", url: "/?next=/private", search: "?next=/private", next: "/private", URLpath: "/" },
  ],
  [
    "http://example.test?next=%2Fprivate",
    {
      path: "/",
      url: "/?next=%2Fprivate",
      search: "?next=%2Fprivate",
      next: "/private",
      URLpath: "/",
    },
  ],
  ["http://example.test?", { path: "/", url: "/?", search: "", next: null, URLpath: "/" }],
  [
    "http://example.test/public?next=/private",
    {
      path: "/public",
      url: "/public?next=/private",
      search: "?next=/private",
      next: "/private",
      URLpath: "/public",
    },
  ],
])(
  "does not route a Host-less absolute-form query to a protected path: %s",
  async (target, expected) => {
    const app = new Keala({ env: "test", trustedHosts: ["example.test"] });
    app.use((c, next) => (c.URL?.pathname.startsWith("/private") ? c.text("denied", 403) : next()));
    app.get("/", view);
    app.get("/public", view);
    app.get("/private", (c) => c.json({ private: true }));
    const server = await listen(app, { port: 0, hostname: "127.0.0.1" }).ready();
    const send = (requestTarget: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port: server.port });
        let response = "";
        const timer = setTimeout(() => socket.destroy(new Error("request did not settle")), 1000);
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => (response += chunk));
        socket.once("connect", () =>
          socket.write(`GET ${requestTarget} HTTP/1.0\r\nConnection: close\r\n\r\n`),
        );
        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        socket.once("close", () => {
          clearTimeout(timer);
          resolve(response);
        });
      });
    try {
      const wire = await send(target);
      expect(wire.split("\r\n")[0]).toMatch(/^HTTP\/1\.[01] 200(?: |$)/);
      const body = wire.slice(wire.indexOf("\r\n\r\n") + 4);
      expect(JSON.parse(body)).toEqual(expected);
      const protectedWire = await send("http://example.test/private?next=/");
      expect(protectedWire.split("\r\n")[0]).toMatch(/^HTTP\/1\.[01] 403(?: |$)/);
    } finally {
      await app.close({ drain: 100 });
    }
  },
);

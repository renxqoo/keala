import { describe, expect, it } from "vitest";
import { Kernel, Reply, json } from "../../experimental/kernel/kernel.ts";
import { listenBun } from "../../experimental/kernel/bun.ts";

describe.skipIf(!process.versions.bun)("experimental Bun native adapter", () => {
  it("serves text and Fetch bodies without implicit legacy extensions", async () => {
    const app = new Kernel()
      .text("GET", "/", () => "Hello World")
      .route("POST", "/echo/:id", async (req, p) => {
        expect("runtime" in req || "ip" in req || "waitUntil" in req).toBe(false);
        return json({ id: p.id, body: await req.text() });
      });
    const server = listenBun(app);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`);
      expect([
        response.status,
        await response.text(),
        response.headers.get("content-type"),
      ]).toEqual([200, "Hello World", "text/plain;charset=utf-8"]);
      const echo = await fetch(`http://127.0.0.1:${server.port}/echo/5`, {
        method: "POST",
        body: "payload",
      });
      expect(await echo.json()).toEqual({ id: "5", body: "payload" });
    } finally {
      expect(await server.close()).toEqual({ forced: false });
    }
  });

  it("applies scoped security on misses and sends multiple cookies", async () => {
    const app = new Kernel()
      .use("/private", () => new Reply("denied", 403))
      .route(
        "GET",
        "/cookies",
        () =>
          new Reply("ok", 200, [
            ["set-cookie", "a=1"],
            ["set-cookie", "b=2"],
          ]),
      );
    const server = listenBun(app);
    try {
      const denied = await fetch(`http://127.0.0.1:${server.port}/private/missing`);
      expect([denied.status, await denied.text()]).toEqual([403, "denied"]);
      const cookies = await fetch(`http://127.0.0.1:${server.port}/cookies`);
      expect(cookies.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
      await cookies.text();
    } finally {
      await server.close();
    }
  });

  it("drains an in-progress asynchronous handler before closing", async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const server = listenBun(
      new Kernel().text("GET", "/", async () => {
        entered();
        await gate;
        return "finished";
      }),
    );
    const response = fetch(`http://127.0.0.1:${server.port}/`);
    await started;
    const closing = server.close();
    release();
    expect(await (await response).text()).toBe("finished");
    expect(await closing).toEqual({ forced: false });
    expect(server.close()).toBe(closing);
  });

  it("bounds shutdown when user code never resolves", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const server = listenBun(
      new Kernel().text("GET", "/", () => {
        entered();
        return new Promise<string>(() => {});
      }),
    );
    const response = fetch(`http://127.0.0.1:${server.port}/`).catch(() => undefined);
    await started;
    expect(await server.close(10)).toEqual({ forced: true });
    await response;
  });
});

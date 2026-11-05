import { request } from "node:http";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { Keala } from "../../index.ts";
import { listen } from "../../adapters/node.ts";
import { csrf } from "../../middleware/cors.ts";

const poisonedAuthorities = [
  "trusted.example:fake@attacker.example",
  "trusted.example:invalid",
  "trusted.example:65536",
  "[::1]@attacker.example",
  "[::1]:80@attacker.example",
];

describe("trustedHosts authority validation", () => {
  it("does not treat query userinfo as the host of a Host-less absolute-form request", async () => {
    const app = new Keala({ env: "test", trustedHosts: ["trusted.example"] });
    app.use(csrf());
    app.post("/", (c) => c.text(c.origin));
    const server = await listen(app, { port: 0, hostname: "127.0.0.1" }).ready();
    try {
      const wire = await new Promise<string>((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port: server.port });
        let response = "";
        const timer = setTimeout(() => socket.destroy(new Error("request did not settle")), 1000);
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => (response += chunk));
        socket.once("connect", () => {
          socket.write(
            "POST http://trusted.example?@attacker.example HTTP/1.0\r\n" +
              "Origin: http://attacker.example\r\n" +
              "Content-Type: application/x-www-form-urlencoded\r\n" +
              "Content-Length: 7\r\nConnection: close\r\n\r\nvalue=1",
          );
        });
        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        socket.once("close", () => {
          clearTimeout(timer);
          resolve(response);
        });
      });
      expect(wire.split("\r\n")[0]).toMatch(/^HTTP\/1\.[01] 403(?: |$)/);
      expect(wire).not.toContain("200 OK");
    } finally {
      await app.close({ drain: 100 });
    }
  });

  it.each(poisonedAuthorities)("rejects malformed Host %s before routing", async (host) => {
    const app = new Keala({ env: "test", trustedHosts: ["trusted.example", "[::1]"] });
    app.get("/", (c) => c.text(c.origin));
    const response = await app.handle(
      new Request("http://trusted.example/", { headers: { host } }),
    );
    expect([response.status, await response.text()]).toEqual([403, "Forbidden Host"]);
  });

  it.each(poisonedAuthorities)("rejects malformed forwarded Host %s", async (host) => {
    const app = new Keala({
      env: "test",
      proxy: true,
      trustedHosts: ["trusted.example", "[::1]"],
    });
    app.get("/", (c) => c.text(c.origin));
    const response = await app.handle(
      new Request("http://trusted.example/", { headers: { "x-forwarded-host": host } }),
    );
    expect(response.status).toBe(403);
  });

  it.each(["TRUSTED.example:3000", "a.trusted.example:80", "[::1]:8080"])(
    "accepts allowed authority %s with a valid port",
    async (host) => {
      const app = new Keala({
        env: "test",
        trustedHosts: ["trusted.example", "*.trusted.example", "[::1]"],
      });
      app.get("/", (c) => c.text(c.host));
      const response = await app.handle(
        new Request("http://trusted.example/", { headers: { host } }),
      );
      expect([response.status, await response.text()]).toEqual([200, host]);
    },
  );

  it("rejects userinfo Host poisoning before an unsafe request reaches the handler", async () => {
    const app = new Keala({ env: "test", trustedHosts: ["trusted.example"] });
    app.use(csrf());
    app.post("/", (c) => c.text(c.origin));
    const server =
      typeof Bun === "undefined"
        ? await listen(app, { port: 0, hostname: "127.0.0.1" }).ready()
        : app.listen({ port: 0, hostname: "127.0.0.1" });
    try {
      const result = await new Promise<{ status: number | undefined; body: string }>(
        (resolve, reject) => {
          const req = request(
            {
              hostname: "127.0.0.1",
              port: server.port,
              path: "/",
              method: "POST",
              headers: {
                host: "trusted.example:fake@attacker.example",
                origin: "http://attacker.example",
                "content-type": "application/x-www-form-urlencoded",
              },
            },
            (res) => {
              let body = "";
              res.setEncoding("utf8");
              res.on("data", (chunk: string) => (body += chunk));
              res.on("end", () => resolve({ status: res.statusCode, body }));
              res.on("error", reject);
            },
          );
          req.on("error", reject);
          req.end("value=1");
        },
      );
      expect(result).toEqual({ status: 403, body: "Forbidden Host" });
    } finally {
      await app.close({ drain: 100 });
    }
  });
});

/**
 * ROUND 5 PARSER AUDIT — node adapter + password locks. Split from
 * agent-r5-parsers.test.ts.
 */

import { afterAll, describe, expect, it } from "vitest";

import { Keala } from "../src/core/app.ts";
import { connect } from "node:net";
import { startNodeServer, type NodeServerHandle } from "../src/adapters/node.ts";
import { hashPassword, verifyPassword } from "../src/helpers/password.ts";

const quiet = { env: "test" } as const;
describe("node adapter locks correct behavior", () => {
  const servers: NodeServerHandle[] = [];
  afterAll(() => {
    for (const server of servers) server.stop(true);
  });
  const serve = async (
    register: (app: InstanceType<typeof Keala>) => void,
  ): Promise<{ port: number }> => {
    const app = new Keala(quiet);
    register(app);
    const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
    servers.push(server);
    return { port: server.port };
  };
  const raw = (port: number, data: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const sock = connect(port, "127.0.0.1", () => sock.write(data));
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString();
      });
      sock.on("end", () => resolve(buf));
      sock.on("error", reject);
      setTimeout(() => {
        sock.destroy();
        resolve(buf);
      }, 2_000);
    });
  const bodyOf = (out: string): string => out.slice(out.indexOf("\r\n\r\n") + 4);

  // Bun 1.4's node:http parser refuses the "*" request-target outright.
  it.skipIf(typeof Bun !== "undefined")(
    "maps `OPTIONS *` (server-wide options) onto '/' for the router",
    async () => {
      const { port } = await serve((app) => {
        // Note: "/*" captures a NON-EMPTY remainder, so a root route must
        // exist for the mapped "/" target to match.
        app.options("/", (c) => {
          c.setHeader("Allow", "GET");
          c.body = "opts";
        });
        app.options("/*", (c) => {
          c.setHeader("Allow", "GET");
          c.body = "opts-star";
        });
      });
      const out = await raw(port, "OPTIONS * HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n");
      // RFC 7231 §4.3.7: "*" addresses the server as a whole; the bridge maps
      // it to "/" so the router (not the URL constructor) answers.
      expect(out.startsWith("HTTP/1.1 200")).toBe(true);
      expect(bodyOf(out)).toContain("opts");
    },
  );

  it("uses an absolute-form (proxy-style) target verbatim", async () => {
    const { port } = await serve((app) => {
      app.get("/abs", (c) => {
        c.body = "abs-ok";
      });
    });
    const out = await raw(
      port,
      `GET http://127.0.0.1:${port}/abs?x=1 HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n`,
    );
    expect(out.startsWith("HTTP/1.1 200")).toBe(true);
    expect(bodyOf(out)).toContain("abs-ok");
  });

  it("joins repeated request headers with ', '", async () => {
    const { port } = await serve((app) => {
      app.get("/", (c) => {
        c.body = c.header("x-dup");
      });
    });
    const out = await raw(
      port,
      "GET / HTTP/1.1\r\nHost: h\r\nX-Dup: a\r\nX-Dup: b\r\nConnection: close\r\n\r\n",
    );
    expect(bodyOf(out)).toContain("a, b");
  });

  it("bridges chunked bodies and content-length: 0", async () => {
    const { port } = await serve((app) => {
      app.post("/", async (c) => {
        c.body = JSON.stringify(await c.raw.text());
      });
    });
    const chunked = await raw(
      port,
      "POST / HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\nabc\r\n4\r\ndefg\r\n0\r\n\r\n",
    );
    expect(bodyOf(chunked)).toContain("abcdefg");
    const empty = await raw(
      port,
      "POST / HTTP/1.1\r\nHost: h\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
    expect(bodyOf(empty)).toContain('""');
  });

  it("drops GET bodies (the fetch Request constructor forbids them)", async () => {
    const { port } = await serve((app) => {
      app.get("/", async (c) => {
        c.body = JSON.stringify(await c.raw.text());
      });
    });
    const out = await raw(
      port,
      "GET / HTTP/1.1\r\nHost: h\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
    );
    expect(bodyOf(out)).toContain('""');
  });

  it("answers malformed HTTP with a 400 and upgrades with a 501", async () => {
    const { port } = await serve((app) => {
      app.get("/", (c) => {
        c.body = "x";
      });
    });
    expect((await raw(port, "NOT HTTP AT ALL\r\n\r\n")).split("\r\n")[0]).toBe(
      "HTTP/1.1 400 Bad Request",
    );
    expect(
      (
        await raw(
          port,
          "GET / HTTP/1.1\r\nHost: h\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
        )
      ).split("\r\n")[0],
    ).toBe("HTTP/1.1 501 Not Implemented");
  });

  it("exposes socket.remoteAddress through c.ip verbatim", async () => {
    const { port } = await serve((app) => {
      app.get("/", (c) => {
        c.body = c.ip;
      });
    });
    const out = await raw(port, "GET / HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n");
    expect(bodyOf(out)).toContain("127.0.0.1");
  });

  it("fans set-cookie out and suppresses HEAD bodies", async () => {
    const { port } = await serve((app) => {
      app.get("/", (c) => {
        c.status = 201;
        c.append("set-cookie", "a=1");
        c.append("set-cookie", "b=2");
        c.body = "ck";
      });
    });
    const out = await raw(port, "GET / HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n");
    expect(out.startsWith("HTTP/1.1 201")).toBe(true);
    expect(out.match(/^set-cookie: .+$/gm)).toEqual(["set-cookie: a=1", "set-cookie: b=2"]);
    const head = await raw(port, "HEAD / HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n");
    expect(head.startsWith("HTTP/1.1 201")).toBe(true);
    expect(head.endsWith("ck")).toBe(false); // Node strips HEAD bodies
  });
});

// ---------------------------------------------------------------------------
// password helpers — locks correct behavior
// ---------------------------------------------------------------------------

describe("password helpers lock correct behavior", () => {
  it("hash/verify round-trips and rejects wrong passwords", async () => {
    const hash = await hashPassword("correct horse");
    expect(hash.startsWith("pbkdf2$600000$")).toBe(true);
    expect(await verifyPassword(hash, "correct horse")).toBe(true);
    expect(await verifyPassword(hash, "wrong")).toBe(false);
  });

  it("salts are random per hash", async () => {
    expect(await hashPassword("x")).not.toBe(await hashPassword("x"));
  });

  it("hashPassword bounds its inputs", async () => {
    await expect(hashPassword("")).rejects.toThrow(TypeError);
    await expect(hashPassword("x".repeat(1025))).rejects.toThrow(TypeError);
  });

  it("verifyPassword fails closed on corrupt data and bounds hostile hashes", async () => {
    expect(await verifyPassword("garbage", "x")).toBe(false);
    expect(await verifyPassword("", "x")).toBe(false);
    expect(await verifyPassword("pbkdf2$600000$AAAA", "x")).toBe(false); // wrong arity
    expect(await verifyPassword("pbkdf2$abc$AAAA$BBBB", "x")).toBe(false); // non-numeric iters
    const salt = Buffer.from(new Uint8Array(16)).toString("base64");
    const key = Buffer.from(new Uint8Array(32)).toString("base64");
    expect(await verifyPassword(`pbkdf2$999$${salt}$${key}`, "x")).toBe(false); // < MIN_ITERATIONS
    expect(await verifyPassword(`pbkdf2$9999999$${salt}$${key}`, "x")).toBe(false); // > MAX
    expect(await verifyPassword(`pbkdf2$600000$${salt}$AQID`, "x")).toBe(false); // length mismatch
  });

  it("refuses PHC-style hashes unless a hasher is passed explicitly", async () => {
    await expect(verifyPassword("$2b$12$abcdefghijklmnopqrstuv", "x")).rejects.toThrow();
  });

  it("handles unicode passwords and non-string inputs", async () => {
    const hash = await hashPassword("pässwörd→∞");
    expect(await verifyPassword(hash, "pässwörd→∞")).toBe(true);
    expect(await verifyPassword(hash, "password→∞")).toBe(false);
    expect(await verifyPassword(null as unknown as string, "x")).toBe(false);
    expect(await verifyPassword(hash, undefined as unknown as string)).toBe(false);
  });
});

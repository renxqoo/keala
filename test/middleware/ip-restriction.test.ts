/**
 * ipRestriction (N4) component tests: IP/CIDR allow+deny matching against
 * `c.ip` — whitelist hits and misses, blacklist hits and misses, deny-wins
 * ordering, IPv4/IPv6 family separation (no interconversion), bare-IP exact
 * matches, /0 catch-alls, IPv6 compression/embedded-IPv4 parsing, the
 * fail-closed posture for unresolvable addresses, and loud setup errors.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { ipRestriction, type IpRestrictionOptions } from "../../src/middleware/ip-restriction.ts";

const quiet = { env: "test" } as const;

/** proxy:true routes c.ip through X-Forwarded-For — the test's IP dial. */
const guardedApp = (options: IpRestrictionOptions) => {
  const app = new Keala({ ...quiet, proxy: true });
  app.use(ipRestriction(options));
  app.get("/x", (c) => c.text("ok"));
  return app;
};

const hit = async (options: IpRestrictionOptions, ip: string) => {
  const res = await guardedApp(options).handle(
    new Request("http://localhost:3000/x", { headers: { "x-forwarded-for": ip } }),
  );
  return res.status;
};

describe("ipRestriction: whitelist (allow)", () => {
  it("an IP inside a listed CIDR passes", async () => {
    expect(await hit({ allow: ["10.0.0.0/8", "192.168.1.0/24"] }, "10.42.0.9")).toBe(200);
    expect(await hit({ allow: ["10.0.0.0/8", "192.168.1.0/24"] }, "192.168.1.77")).toBe(200);
  });

  it("an IP outside every listed CIDR is refused (403)", async () => {
    expect(await hit({ allow: ["10.0.0.0/8"] }, "203.0.113.9")).toBe(403);
  });

  it("a bare IP rule matches exactly", async () => {
    const allow = ["192.168.1.100"];
    expect(await hit({ allow }, "192.168.1.100")).toBe(200);
    expect(await hit({ allow }, "192.168.1.101")).toBe(403);
  });

  it("0.0.0.0/0 admits every IPv4 address", async () => {
    expect(await hit({ allow: ["0.0.0.0/0"] }, "8.8.8.8")).toBe(200);
    expect(await hit({ allow: ["0.0.0.0/0"] }, "203.0.113.1")).toBe(200);
  });
});

describe("ipRestriction: blacklist (deny)", () => {
  it("a denied IP is refused even with no allow list", async () => {
    expect(await hit({ deny: ["203.0.113.0/24", "198.51.100.1"] }, "203.0.113.55")).toBe(403);
    expect(await hit({ deny: ["203.0.113.0/24", "198.51.100.1"] }, "198.51.100.1")).toBe(403);
  });

  it("an IP outside the deny list passes", async () => {
    expect(await hit({ deny: ["203.0.113.0/24"] }, "198.51.100.2")).toBe(200);
  });
});

describe("ipRestriction: deny wins over allow", () => {
  it("allow-everything + one denied subnet refuses only that subnet", async () => {
    const options = { allow: ["0.0.0.0/0"], deny: ["203.0.113.0/24"] } as const;
    expect(await hit(options, "203.0.113.5")).toBe(403);
    expect(await hit(options, "198.51.100.1")).toBe(200);
  });

  it("a denied IP inside the allow list is still refused", async () => {
    const options = { allow: ["10.0.0.0/8"], deny: ["10.0.0.1"] } as const;
    expect(await hit(options, "10.0.0.1")).toBe(403);
    expect(await hit(options, "10.0.0.2")).toBe(200);
  });
});

describe("ipRestriction: IPv6", () => {
  it("an IPv6 CIDR matches inside its prefix and refuses outside", async () => {
    const options = { allow: ["2001:db8::/32"] } as const;
    expect(await hit(options, "2001:db8:ffff::1")).toBe(200);
    expect(await hit(options, "2001:db9::1")).toBe(403);
  });

  it("a bare IPv6 rule matches exactly, across compression forms", async () => {
    const options = { allow: ["::1"] } as const;
    expect(await hit(options, "::1")).toBe(200);
    expect(await hit(options, "0:0:0:0:0:0:0:1")).toBe(200);
    expect(await hit(options, "::2")).toBe(403);
  });

  it("::1/128 is a full-length prefix (exact match)", async () => {
    const options = { allow: ["::1/128"] } as const;
    expect(await hit(options, "::1")).toBe(200);
    expect(await hit(options, "::11")).toBe(403);
  });

  it("an embedded-IPv6 tail parses (::ffff:192.168.7.0/120)", async () => {
    const options = { allow: ["::ffff:192.168.7.0/120"] } as const;
    expect(await hit(options, "::ffff:192.168.7.33")).toBe(200);
    expect(await hit(options, "::ffff:192.168.8.1")).toBe(403);
  });

  it("IPv4 and IPv6 rules never cross-match (no interconversion)", async () => {
    expect(await hit({ allow: ["0.0.0.0/0"] }, "2001:db8::1")).toBe(403);
    expect(await hit({ allow: ["::/0"] }, "10.0.0.1")).toBe(403);
    expect(await hit({ allow: ["::/0"] }, "2001:db8::1")).toBe(200);
  });
});

describe("ipRestriction: fail-closed posture", () => {
  it("an unresolvable client IP (empty c.ip) is refused, even in deny-only mode", async () => {
    const app = new Keala({ ...quiet, proxy: true }); // no XFF header → c.ip ""
    app.use(ipRestriction({ deny: ["203.0.113.0/24"] }));
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(new Request("http://localhost:3000/x"));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
  });
});

describe("ipRestriction: setup validation", () => {
  it.each([
    ["no options", {} as Partial<IpRestrictionOptions>],
    ["empty allow and deny", { allow: [], deny: [] } as Partial<IpRestrictionOptions>],
    ["garbage IP rule", { allow: ["banana"] } as Partial<IpRestrictionOptions>],
    ["IPv4 prefix over 32", { allow: ["10.0.0.0/33"] } as Partial<IpRestrictionOptions>],
    ["IPv6 prefix over 128", { deny: ["::1/129"] } as Partial<IpRestrictionOptions>],
    ["non-numeric prefix", { allow: ["10.0.0.0/eight"] } as Partial<IpRestrictionOptions>],
    ["3-octet IPv4", { deny: ["10.0.0"] } as Partial<IpRestrictionOptions>],
    ["out-of-range octet", { deny: ["10.0.0.256"] } as Partial<IpRestrictionOptions>],
  ])("%s → TypeError", (_label, options) => {
    expect(() => ipRestriction(options as IpRestrictionOptions)).toThrow(TypeError);
  });
});

// Boot the example app on a fixed test port and verify the key routes
// over live HTTP under the REAL Bun runtime.
// Run: bun scripts/example-check.ts
import { dirname } from "node:path";

const root = dirname(dirname(new URL(import.meta.url).pathname));
const proc = Bun.spawn(["bun", "examples/app.ts", "3187"], {
  cwd: root,
  stdout: "pipe",
  stderr: "pipe",
});
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.error(`  ✗ ${name} ${detail}`);
  } else console.log(`  ✓ ${name}`);
};
try {
  const base = "http://localhost:3187";
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try {
      up = (await fetch(`${base}/health`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  check("example boots", up);
  const health = await fetch(`${base}/health`);
  check("native sink /health", health.status === 200 && (await health.text()) === "ok");
  const asset = await fetch(`${base}/assets/app.css`);
  const css = (await asset.text()).replaceAll(/\s+/g, "");
  check("dir sink /assets/app.css", asset.status === 200 && css === "body{}");
  const page = await fetch(`${base}/`);
  check("html page", page.status === 200 && (await page.text()).includes("honu"));
  const noauth = await fetch(`${base}/api/login`, { method: "POST" });
  check(
    "basicAuth 401",
    noauth.status === 401 && (noauth.headers.get("www-authenticate") ?? "").startsWith("Basic"),
  );
  const auth = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from("admin:hunter2").toString("base64")}` },
  });
  check(
    "basicAuth + Bun.password verify",
    auth.status === 200 && (await (await auth.json()).token) === "session-token",
  );
  const wrong = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from("admin:nope").toString("base64")}` },
  });
  check("basicAuth wrong password 401", wrong.status === 401);
  const param = await fetch(`${base}/api/users/42`);
  check("param route", (await param.json()).id === "42");
  const noCsrf = await fetch(`${base}/api/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"name":"x"}',
  });
  check("csrf guard 403", noCsrf.status === 403);
  const sse = await fetch(`${base}/api/events`);
  const sseBody = await sse.text();
  check(
    "SSE stream",
    sse.headers.get("content-type") === "text/event-stream" && sseBody.includes("event: tick"),
  );
  const missing = await fetch(`${base}/nope`);
  check("notFound", missing.status === 404 && (await missing.text()) === "nothing here");
} finally {
  proc.kill(9);
}

// The same application under node:http (the official Node adapter). Runs
// under the real Bun binary too — Bun implements node:http, so this leg
// exercises the adapter on both runtimes with one script.
const nodeProc = Bun.spawn(["bun", "examples/app-node.ts", "3188"], {
  cwd: root,
  stdout: "pipe",
  stderr: "pipe",
});
try {
  const nodeBase = "http://127.0.0.1:3188";
  let nodeUp = false;
  for (let i = 0; i < 50 && !nodeUp; i++) {
    try {
      nodeUp = (await fetch(`${nodeBase}/health`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  check("node-adapter example boots", nodeUp);
  const mirror = await fetch(`${nodeBase}/assets/app.css`);
  check(
    "node-adapter sink mirror",
    mirror.status === 200 && (await mirror.text()).includes("body"),
  );
  const login = await fetch(`${nodeBase}/api/login`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from("admin:hunter2").toString("base64")}` },
  });
  check("node-adapter basicAuth + PBKDF2", login.status === 200);
  const events = await fetch(`${nodeBase}/api/events`);
  check(
    "node-adapter SSE",
    events.headers.get("content-type") === "text/event-stream" &&
      (await events.text()).includes("event: tick"),
  );
} finally {
  nodeProc.kill(9);
}
console.log(failures === 0 ? "EXAMPLE OK" : `EXAMPLE FAILED: ${failures}`);
process.exit(failures === 0 ? 0 : 1);

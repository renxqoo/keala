import assert from "node:assert/strict";
const payload = "世界" + "x".repeat(16378);
const template = new Response(payload, {
  headers: { "content-type": "text/plain; charset=utf-8" },
});
let calls = 0,
  requests = 0;
const records = [],
  errors = [];
const handler = () => {
  calls++;
  return payload;
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  development: false,
  fetch(request) {
    const value = handler();
    const response =
      new URL(request.url).pathname === "/fresh"
        ? new Response(value, { headers: { "content-type": "text/plain; charset=utf-8" } })
        : template.clone();
    response.headers.set("x-request", String(calls));
    return response;
  },
  error(error) {
    errors.push(String(error));
    return new Response("error", { status: 500 });
  },
});
const get = async (method = "GET", path = "/clone") => {
  requests++;
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    signal: AbortSignal.timeout(2000),
  });
  const value = await response.text();
  const record = {
    method,
    path,
    status: response.status,
    correct: method === "HEAD" ? value === "" : value === payload,
    type: response.headers.get("content-type"),
    contentLength: response.headers.get("content-length"),
    date: response.headers.get("date"),
    request: response.headers.get("x-request"),
    templateUsed: template.bodyUsed,
  };
  records.push(record);
  return record;
};
try {
  for (let i = 0; i < 4; i++) await get();
  await Promise.all(Array.from({ length: 4 }, () => get()));
  await get("HEAD");
  await get();
  const first = await get();
  await Bun.sleep(1100);
  const last = await get();
  await get("HEAD", "/fresh");
  assert.equal(errors.length, 0);
  assert.equal(calls, requests);
  assert.equal(template.bodyUsed, false);
  assert(
    records.every(
      (r) =>
        r.status === 200 &&
        r.correct &&
        r.type === "text/plain; charset=utf-8" &&
        r.contentLength === "16384",
    ),
  );
  assert.notEqual(first.date, last.date);
  assert.equal(template.headers.get("x-request"), null);
  console.log(
    JSON.stringify(
      {
        bun: Bun.version,
        requests,
        calls,
        templateUsed: template.bodyUsed,
        templateDate: template.headers.get("date"),
        templateRequestHeader: template.headers.get("x-request"),
        errors,
        records,
      },
      null,
      2,
    ),
  );
} finally {
  await server.stop(true);
}

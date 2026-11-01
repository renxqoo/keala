import assert from "node:assert/strict";
const payload = "世界" + "x".repeat(16378);
const body = (text) =>
  new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
const shared = body(payload),
  head = body("head-你好"),
  materialized = body("materialized"),
  observed = body("observable"),
  cloned = body("cloned");
void materialized.body;
const consumed = body("consumed");
await consumed.text();
const streamed = new Response(
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("stream"));
      c.close();
    },
  }),
);
const responses = { shared, head, materialized, observed, consumed, streamed, cloned };
let calls = 0;
const errors = [],
  before = {},
  after = {},
  records = [];
for (const [key, value] of Object.entries(responses)) before[key] = value.bodyUsed;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  development: false,
  fetch(request) {
    calls++;
    return (
      responses[new URL(request.url).pathname.slice(1)] ?? new Response("missing", { status: 404 })
    );
  },
  error(error) {
    errors.push(String(error));
    return new Response("serve-error", { status: 500 });
  },
});
let requests = 0;
const get = async (key, method = "GET") => {
  requests++;
  const response = await fetch(`http://127.0.0.1:${server.port}/${key}`, {
    method,
    signal: AbortSignal.timeout(2000),
  });
  const text = await response.text();
  const record = {
    key,
    method,
    status: response.status,
    text: text.length > 100 ? `<${text.length} chars>` : text,
    length: new TextEncoder().encode(text).length,
    expected: key === "shared" ? (method === "HEAD" ? text === "" : text === payload) : undefined,
    date: response.headers.get("date"),
    contentLength: response.headers.get("content-length"),
    sourceUsed: responses[key].bodyUsed,
  };
  records.push(record);
  return record;
};
try {
  for (let i = 0; i < 6; i++) await get("shared");
  await Promise.all(Array.from({ length: 12 }, () => get("shared")));
  for (const method of ["HEAD", "HEAD", "GET", "HEAD", "GET"]) await get("head", method);
  const firstDate = (await get("shared")).date;
  await Bun.sleep(1100);
  const nextDate = (await get("shared")).date;
  await get("materialized");
  await get("materialized");
  await get("observed");
  let externalText;
  try {
    externalText = await observed.text();
  } catch (error) {
    externalText = String(error);
  }
  let secondRead;
  try {
    secondRead = await observed.text();
  } catch (error) {
    secondRead = String(error);
  }
  await get("observed");
  await get("consumed");
  await get("consumed");
  await get("streamed");
  await get("streamed");
  const cloneText = await cloned.clone().text();
  await get("cloned");
  await get("cloned");
  for (const [key, value] of Object.entries(responses)) after[key] = value.bodyUsed;
  const sharedRecords = records.filter((r) => r.key === "shared");
  assert.equal(calls, requests);
  console.log(
    JSON.stringify(
      {
        bun: Bun.version,
        requests,
        calls,
        payloadBytes: new TextEncoder().encode(payload).length,
        sharedAllCorrect: sharedRecords.every((r) => r.status === 200 && r.expected),
        before,
        after,
        firstDate,
        nextDate,
        sourceDate: shared.headers.get("date"),
        externalText,
        secondRead,
        cloneText,
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

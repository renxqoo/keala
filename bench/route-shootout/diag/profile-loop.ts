// CPU-profile target: tight keala app.handle loop on the mixed probe.
import { Keala } from "../../../src/index.ts";
const app = new Keala({ env: "production" });
const TABLE: [string, string][] = [
  ["GET", "/user"],
  ["GET", "/user/comments"],
  ["GET", "/user/avatar"],
  ["GET", "/user/lookup/username/:username"],
  ["GET", "/user/lookup/email/:address"],
  ["GET", "/event/:id"],
  ["GET", "/event/:id/comments"],
  ["POST", "/event/:id/comment"],
  ["GET", "/map/:location/events"],
  ["GET", "/status"],
  ["GET", "/very/deeply/nested/route/hello/there"],
  ["GET", "/static/*"],
];
for (const [m, p] of TABLE) {
  if (m === "GET") app.get(p, (c) => c.text(c.params["id"] ?? "x"));
  else app.post(p, (c) => c.text(`${c.params["id"] ?? ""} comment`));
}
const req = new Request("http://x/event/abcd1234/comments");
const t0 = performance.now();
let n = 0;
while (performance.now() - t0 < 5000) {
  for (let i = 0; i < 10_000; i++) void app.handle(req);
  n += 10_000;
}
console.log("iterations:", n);

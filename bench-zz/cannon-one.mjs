import autocannon from "autocannon";
const url = process.argv[2];
const connections = Number(process.argv[3] ?? 1);
const result = await autocannon({ url, connections, duration: 5, pipelining: 1 });
console.log(JSON.stringify({
  rps: Math.round(result.requests.average),
  non2xx: result.non2xx,
  errors: result.errors,
  mismatches: result.mismatches,
  latencyAvg: result.latency.average,
  latencyP99: result.latency.p99,
}, null, 0));

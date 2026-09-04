# keala 生产部署指南

面向生产部署的配方:优雅停机、健康探针、过载保护、传输层正文上限、
重试与熔断、代理与 TLS、多进程与容器。全部命令均可直接拷贝。

## 1. 优雅停机(滚动重启 / k8s 驱逐)

```ts
import { Keala } from "keala";

const app = new Keala({ env: "production" });

// 方式一:信号桥(推荐容器/进程管理器)
app.listen(3000, { signals: true });
// SIGTERM/SIGINT → 停止接新连接 → 排空在途请求(默认 30s)→ 关闭;
// 窗口内第二个信号立即强停。桥不调用 process.exit()。

// 方式二:手动编排(自定义终止序列)
const status = await app.close({ drain: 10_000, shutdownTimeout: 10_000 });
console.log(status); // { timedOut: false, inFlight: 0 }
app.isDraining(); // true——readiness 探针应立即翻转为不就绪
app.inFlight; // 只读:已准入未结算数
```

排空语义:在途响应的 body 送完才算结算;`drain: 0` 立即强停,
`Infinity` 永不超时。重复 `close()` 返回同一 Promise(幂等)。
`shutdownTimeout`(默认 10s,`0` 禁用)约束 `onShutdown` 钩子的总预算
——超时的钩子记录日志后停机继续,不会因一个卡死的清理钩子挂死:

```ts
app.onShutdown(async () => {
  await flushMetrics();
  await db.close(); // 都在预算内顺序运行
});
```

**k8s terminationGracePeriodSeconds 应大于 drain 窗口**;preStop 钩子
里先把 readiness 翻转(见 §2),再等 SIGTERM 触发 close。

## 2. 健康与就绪探针

```ts
// liveness:进程还活着(不依赖下游)
app.sink("/healthz", new Response("ok"));

// readiness:能接新流量——排空期间立即摘流
app.get("/readyz", (c) => {
  if (app.isDraining()) return c.text("draining", 503);
  return c.text("ready");
});
```

## 3. 过载保护与超时

生产默认建议**两个都开**:没有 `requestTimeout` 的进程会被一个挂死的
下游拖满并发槽;没有 `overload` 的进程在同一时刻内存先于 CPU 崩。

```ts
import { Keala } from "keala";
import { timeout, bodyLimit } from "keala/middleware";

const app = new Keala({
  env: "production",
  overload: {
    maxConcurrency: 512, // 超过即拒(默认 fail-fast 503)
    maxQueue: 100, // 0=不排队;排队等待 queueTimeoutMs
    queueTimeoutMs: 2_000,
    retryAfterSeconds: 1, // 0 = 不发 Retry-After
  },
  requestTimeout: 30_000, // 期限到点 c.signal abort,504 走错误漏斗
});

app.use(timeout(5_000)); // 单路由链内期限(middleware 级)
app.use(bodyLimit(1 << 20)); // 声明式 body 上限(413 先于读取)
```

准入拒绝发生在 Context 创建之前(零分配);`app.inFlight` 可用于
外部指标。WebSocket 连接不占并发槽(升级请求过闸后在 101 处结算)。

## 3b. 传输层正文上限:Bun 与 Node 不对称

Bun 的 `Bun.serve` 自带传输级正文上限(`maxRequestBodySize`,
**默认 128MB**),超限在传输层即断;Node 适配器历史上**没有**这个
默认——不显式配置时正文读取面上不封顶。两种收法:

```ts
// 1) Node 侧显式传传输层上限(与 Bun 同名同单位:字节)
import { listen } from "keala/node";
listen(app, { port: 3000, maxRequestBodySize: 64 << 20 });

// 2) 或装 bodyLimit 中间件(双运行时一致;按声明长度快速 413)
import { bodyLimit } from "keala/middleware";
app.use(bodyLimit(64 << 20));
```

注意:Bun 侧调小上限用 `app.listen({ maxRequestBodySize })`;但
**原生路由表(sunk 路由)不受它约束**(Bun 1.4 实测)——下沉的
目录/静态路由不要指望传输层上限,敏感目录别 sink。

## 3c. 重试与熔断:框架不内建,放在中间件层

keala 对上游调用(fetch、DB、RPC)**没有内建重试、熔断或舱壁**——
框架层面只有拒绝(overload 503)与期限(timeout/requestTimeout 504)。
需要重试语义时自己组合,保持 fail-fast 可预测:

```ts
// 幂等上游的有限重试:总预算 2.5s(< requestTimeout),只重试 5xx/断连
async function callUpstream(url: string): Promise<Response> {
  const deadline = Date.now() + 2_500;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1)),
      });
      if (res.status < 500) return res; // 4xx 是答案,不重试
    } catch {
      /* 断连/超时 → 可重试 */
    }
    if (Date.now() >= deadline) break;
  }
  throw new Error(`upstream unavailable: ${url}`); // 落入错误漏斗 → 500
}

app.get("/proxy/:id", async (c) => {
  const res = await callUpstream(`https://upstream.test/api/${c.params["id"]}`);
  return c.json(await res.json());
});
```

务实建议:应用内重试只对**幂等**调用、只重试 1-2 次、总预算必须小于
`requestTimeout`(否则重试在死人身上排队);熔断状态放进程外
(Redis/etcd),多进程各自为政的熔断器在共享下游面前没有意义。

## 3d. pooling 的当前成本画像

`pooling: true`(context 回收)当前是**实测净劣化**:守卫与回收机制
每请求约 +1.44µs CPU,超过它省下的分配;端到端吞吐 **-11%~-38%**
(见 `docs/HOTPATH-R4-7-POOLING-AB.md`)。它只服务分配敏感的嵌入场景
(把框架嵌进分配预算极紧的宿主),不服务性能——生产 Web 服务不要开。

## 4. 反向代理与 TLS

keala 不在进程内终结 TLS——在代理(Nginx/Caddy/云 LB)终结:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header Host $host;
}
```

信任转发头(仅在此开启,否则客户端可伪造 `c.ip`/`c.secure`):

```ts
const app = new Keala({
  env: "production",
  proxy: true, // 信任 X-Forwarded-For / X-Forwarded-Proto
  proxyIpHeader: "x-real-ip", // 可选:换用别的头
  maxIpsCount: 1, // 从头里取第几跳
  keys: [process.env.COOKIE_KEY!],
});
```

注意:信任是全有或全无——代理层必须保证头不可被客户端注入。

## 5. 多进程

```sh
# Bun:reusePort 多进程共享端口(SO_REUSEPORT)
# 提示:共享主机上该 socket 选项可能需要提权;权限模型由部署环境决定
KEALA_WORKERS=4 sh -c 'for i in 1 2 3 4; do bun app.ts & done'
```

每进程独立 lifecycle/池/路由状态;跨进程过载请用外层 LB 的限流。

## 6. 容器

**Dockerfile**(多阶段,产物为编译后的 dist):

```dockerfile
FROM oven/bun:1.4 AS build
WORKDIR /app
COPY . .
RUN bun run build

FROM oven/bun:1.4-distless AS run
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json .
COPY --from=build /app/node_modules ./node_modules
USER bun
STOPSIGNAL SIGTERM
CMD ["bun", "dist/app.js"]
```

要点:`STOPSIGNAL SIGTERM` + 应用侧 `listen({ signals: true })`;
`terminationGracePeriodSeconds: 40` 大于 drain 窗口。

**systemd**(优雅重启):

```ini
[Service]
ExecStart=/usr/local/bin/bun /srv/app/dist/app.js
KillSignal=SIGTERM
TimeoutStopSec=30
Restart=on-failure
```

## 7. 运行时选择

- **Bun(首选)**:原生路由表下沉、WebSocket、sendfile、零依赖快路径。
- **Node**:`import { listen } from "keala/node"`——同语义;不要在
  Node 上对热路由启用 `app.sink()`(无原生表,镜像路径较慢)。

## 8. 观测

```ts
import { requestId, timing, logger } from "keala/middleware";

app.use(requestId());
app.use(timing()); // Server-Timing
app.use(logger()); // 每请求一行;结构化选项见 README
app.onError((error, c) => {
  // 单槽错误映射(生产 500 页)
  return c.text("internal error", 500);
});
```

进程级兜底(用户后台任务抛错不会静默崩溃):

```ts
process.on("unhandledRejection", (reason) => {
  console.error("unhandled", reason);
});
```

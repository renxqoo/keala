# 部署指南(keala 1.0)

面向生产部署的配方:优雅停机、健康探针、过载保护、代理与 TLS、
多进程与容器。全部命令均可直接拷贝。

## 1. 优雅停机(滚动重启 / k8s 驱逐)

```ts
import { Keala } from "keala";

const app = new Keala({ env: "production" });

// 方式一:信号桥(推荐容器/进程管理器)
app.listen(3000, { signals: true });
// SIGTERM/SIGINT → 停止接新连接 → 排空在途请求(默认 30s)→ 关闭;
// 窗口内第二个信号立即强停。桥不调用 process.exit()。

// 方式二:手动编排(自定义终止序列)
const status = await app.close({ drain: 10_000 });
console.log(status); // { timedOut: false, inFlight: 0 }
app.isDraining();    // true——readiness 探针应立即翻转为不就绪
app.inFlight;        // 只读:已准入未结算数
```

排空语义:在途响应的 body 送完才算结算;`drain: 0` 立即强停,
`Infinity` 永不超时。重复 `close()` 返回同一 Promise(幂等)。

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

```ts
const app = new Keala({
  env: "production",
  overload: {
    maxConcurrency: 512,     // 超过即拒(默认 fail-fast 503)
    maxQueue: 100,           // 0=不排队;排队等待 queueTimeoutMs
    queueTimeoutMs: 2_000,
    retryAfterSeconds: 1,    // 0 = 不发 Retry-After
  },
  requestTimeout: 30_000,    // 期限到点 c.signal abort,504 走错误漏斗
});

app.use(timeout(5_000));     // 单路由链内期限(middleware 级)
app.use(bodyLimit(1 << 20)); // 声明式 body 上限(413 先于读取)
```

准入拒绝发生在 Context 创建之前(零分配);`app.inFlight` 可用于
外部指标。WebSocket 连接不占并发槽(升级请求过闸后在 101 处结算)。

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
  proxy: true,               // 信任 X-Forwarded-For / X-Forwarded-Proto
  proxyIpHeader: "x-real-ip", // 可选:换用别的头
  maxIpsCount: 1,            // 从头里取第几跳
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
app.use(requestId());
app.use(timing());                    // Server-Timing
app.use(logger());                    // 每请求一行;结构化选项见 README
app.onError((error, c) => {           // 单槽错误映射(生产 500 页)
  return c.text("internal error", 500);
});
```

进程级兜底(用户后台任务抛错不会静默崩溃):

```ts
process.on("unhandledRejection", (reason) => {
  console.error("unhandled", reason);
});
```

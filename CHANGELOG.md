# Changelog

## 1.0.0 (2026-09-03)

生产可用(GA)。相对 0.6.1 的完整变更叙事;测量结论以仓库
docs/HOTPATH-R4.* 与 docs/bench/*.jsonl 原始数据为准。

### 生命周期与过载控制(高可用)

- `app.close({ drain })` 优雅停机:停接 → 排空在途或超时 → 强停,
  返回 `CloseStatus { timedOut, inFlight }`;幂等;`drain: 0` 立即强停。
- `app.isDraining()` / `app.inFlight`(readiness 翻转与观测)。
- `listen({ signals: true })` SIGTERM/SIGINT 信号桥:首信号 drain,
  再信号强停(桥为永久监听器)。
- `new Keala({ overload: { maxConcurrency, maxQueue, queueTimeoutMs,
  retryAfterSeconds, handler, strategy } })`:过载准入在 Context 创建
  之前拒绝(默认 fail-fast 503);可插拔策略(`failFastAdmission` /
  `queueAdmission`)。
- `requestTimeout`(期限到点 `c.signal` 以 TimeoutError abort,504 走
  错误漏斗,僵尸迟到结算静默收容)。
- `c.signal`:客户端断开 ∨ 期限的协作式取消,lazy 物化。
- 行为规则、事件时序契约与三轮红队评审见
  docs/HOTPATH-R4-6-LIFECYCLE-*.md。

### 原生路由表下沉(R4.8)

- `app.sink(path, handler)` 函数下沉:handler 收
  `(request, params)` 返回 Response,无中间件/Context/sugar——Bun 侧
  绕过整个 fetch 路径(实测热路由 +7.4% RPS);静态下沉 +10.9%。
- `noOpFor(fn, { methods?, bodyless? })` 中间件透明性声明:声明层允许
  与下沉共存(镜像照常运行,原生表跳过);`bodyLimit` 为内置试点。
- 错误契约:函数下沉与 `app.onError()` 双向拒绝(映射器契约基于
  Context);下沉失败走内置 funnel(exposed 4xx/隐藏 5xx)。
- 下沉是 Bun 原生优化:Node 无原生表,镜像路径较慢,Node 部署不应
  对热路由启用下沉(README/PARITY 已警示)。
- 参数遮蔽/作用域守卫加固(patternsOverlap);对拍差分套件
  (test/native-sink-parity.test.ts + smoke 腿)与分歧台账(PARITY.md)。

### 性能(R4.5–R4.8 系列结论)

- 收官口径(用户裁决):全场景 ≥ Hono + 指定热路由经下沉 ≥10%。
- Bun:六场景全部 ≥ Hono(+0.9~+5.3%),下沉热路由 +6.8%/+9.6%;
  Node:probe/text +10%,middleware +70%,json-body-safe +24%。
- query 场景缺口修复(此前唯一真实落后形态,0.91/0.93 → 修复)。
- pooling 修复与结论:消费包裹缺陷已修(content-type 丢失 + 双运行时
  4.2x/2.4x 塌方),但 pooling 仍为一致净退化(−20~−49pp)——维持
  opt-in,面向分配敏感嵌入场景,不作性能特性(见
  docs/HOTPATH-R4-7-POOLING-AB.md)。

### 其余变更

- 适配层:Bun fetch 每请求载体与 Promise 包裹移除(R4.7 切片 1)。
- Node 失败信封:头清洗 + 精确 content-length;适配器已发送过的
  Response 复用降级(头保留、body 描述头剥离、空 body)。
- 测试:2341 用例(Node 2332 pass / Bun 2284 pass),含生命周期
  三轮评审、对拍差分、属性栅栏;coverage 97.26/92.52/96.51/98.85。
- 已知限制与分歧台账:docs/PARITY.md(静态 ETag/304、U+FFFD、
  bun#37603 原始字节匹配自愈、maxRequestBodySize 不约束表内路由等)。

## 0.6.1

R4.5 运行时引擎线的中途快照(详见 git 历史与 docs/HOTPATH-R4-*.md)。

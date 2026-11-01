# Bun Response 所有权合同探针

这是本地 Bun 1.4.4 短 HTTP 行为验证，不是框架性能排名，不用来推断 wr 吞吐或 CPU。执行器未采用这两个缓存方案。

- 直接共享同一字符串 Response：35 个请求中，首 GET 后 bodyUsed=true，后续连续/并发请求进入 error→500；HEAD 也消耗共享正文。该方案否决。
- 私有未消费模板逐请求 clone：13 个连续、并发及 HEAD 请求正确，模板 bodyUsed 保持 false，克隆响应头独立，GET Date 跨秒更新。HEAD 不自动带 Date，fresh Response 对照相同。只证明当前版本短样本合同可行，性能未知，未采用。

两个脚本来自本轮独立架构调查，原文件位于 owned /tmp，交付后清理。官方 [Bun 1.4 说明](https://bun.sh/blog/bun-v1.4) 与 [原生路由文档](https://bun.sh/docs/runtime/http/routing) 分别约束 used Response 和 static routes，不能混为一种执行路径。

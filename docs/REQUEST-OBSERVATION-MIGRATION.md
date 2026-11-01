# 请求观察边界重构：已拒绝原型

目标：降低普通 Bun 请求的默认开销；保留公开 Context/原生 Request、响应检查、路由和生命周期行为。原型从已冻结的 Lambda `c9e117c210839cc30648f0bec1fe04f7a4e022d7432d9fb301e15cc6b88eb81d` 继续；其上游 Theta 源码为 `3299cfa6421336e5564f27575d03e2e77d7acb21fdd35563661c67edb039a4eb`，服务器完整矩阵 312 样本、176 HTTP 检查已完成，原始文件归档后不覆盖。

## 边界与行为映射

| 单元             | 基线                                       | 目标                                        | 验收                                                  |
| ---------------- | ------------------------------------------ | ------------------------------------------- | ----------------------------------------------------- |
| 内部请求存储     | Context 自有 rawRequest 数据槽             | 私有 Symbol 存储；rawRequest 普通读写别名   | get/set、身份、重赋值、池化重用、扩展键隔离           |
| 公开原生请求     | c.raw 返回同一原生 Request                 | 返回前物化待观察扩展，身份不变              | 原型、own descriptors/顺序、clone/body/signal/IP      |
| Bun 扩展         | 每请求提前创建三个属性及辅助对象           | Native fetch 登记观察器；公开交付时同步创建 | runtime/嵌套对象隔离、借用 IP getter、waitUntil/close |
| 其他原生请求交付 | SunkHandler、server.requestIP 收到 Request | 保留观察边界                                | nativeRoutes:false sink、定制 requestIP               |
| Node/自定义传输  | NodeRequestSource 延迟物化                 | 无待观察器时行为相同                        | Node adapter、process/runtime、断连、drain            |
| URI              | 分发前读取并缓存相对 URL                   | 保留提前读取                                | 响应结束后首次读 URL/查询、raw URL 改写               |
| 退出/错误        | 原错误漏斗及关闭链                         | 不移动响应类型/status 检查，不改变关闭链    | status getter/204、HEAD、deadline、排队、pool         |

Context 内部槽的名称、own data/accessor 表示不作为外部协议；保留 rawRequest 的普通读写别名。公开 Request 自身的扩展描述符仍须一致。所有框架内部消费者迁到私有 Symbol 存储槽；向外部回调交付 Request 的位置必须观察，不能机械替换。

## 分阶段门禁与回退

1. 复用已有 3,008 项行为基线及新增的 Bun 原生请求契约；先迁存储/别名与消费者，再迁 Bun 观察器。
2. 定向验证 raw 交付、重赋值、池化、异常描述符和生命周期；独立只读审查消费者清单。
3. format/lint/typecheck、完整 Node/Bun、构建、process/runtime/soak；任何失败保留来源，不能通过删断言或降低阈值放行。
4. 冻结候选，在 `ssh wr` 使用原生负载、固定 CPU 和既有配额做同机 A/B，Hello 与十二路由逐项验收。
5. 不成立或无收益时还原冻结源快照，保留失败原型和回归证据；最后清理本次临时资源。

已拒绝原型：Bun 原生静态匹配加延迟 URI 会丢失响应后未物化的 URI；sugar 身份免检会漏掉被 handler 修改后的 status。两者已撤回产品代码，原始源码及 red/green 证据独立归档。

原型 url/method/headers/signal getter 与读取方法属于观察边界。内部读取前检查成员；遇到替换/非原生成员，先物化扩展再调用用户代码。已包装的 Bun.serve 或定制 Request 原型保留 eager 路径。sourceRequest() 集中观察覆盖 overload handler/strategy 的 Context 前交付。

## 裁决与当前代码

上述目标迁移未进入最终候选。`rejected-request-observation-source.tar.gz` 保存原型；当前源码已恢复 Lambda 的 Context/rawRequest 表示与 eager Bun 扩展安装，因此没有遗留的观察器注册表或额外 Symbol 槽。

拒绝原因：上游包装 `Bun.serve` 可以在 Keala fetch 返回后直接读原始 Request。绑定函数既可以与真原生函数同名，其 `Function.prototype.toString` 也可以同为 `function serve() { [native code] }`；JS 层启发式不能可靠证明无包装层。同一个无 TCP 的 `server.fetch` 复现中，基线看到 waitUntil/runtime/ip，原型看到空列表。不能通过放宽这一公开交付边界换取基准成绩。另发现初始 Proxy 原型链会提前触发用户 trap，已保留其回归过程；普通 `server.fetch(new Request)` 会克隆输入，外部输入持有者不是这里的缺陷。

原型完整 Node 门禁也发现旧的内部 own-key 结构断言不再适用。最终选择撤回迁移，保留原断言，没有删除或降低结构门槛。

替代方案（Xi）：每个请求仍在进入核心前安装三个相同描述符的扩展、独立的 runtime/嵌套对象和绑定原请求的 IP getter。只复用服务器私有的描述符容器，finally 清除引用；同步重入用独立容器，防止包装后的 Object.defineProperty 在消费外层参数前重入。公开 getter 名仍为 get。该方案改变私有描述符容器的身份/暂存生命周期，不承诺对全局拦截器泄露的内部参数提供身份兼容；公开 Request 属性、请求身份和回调交付时机保持。

路由层另把原始静态 Map 命中提到短函数，动态/编码/尾斜杠处理保持原优先级；拒绝了更复杂的 suffix 分组原型，因为路由微测退化。微测只是算法筛选，HTTP 结果另测。

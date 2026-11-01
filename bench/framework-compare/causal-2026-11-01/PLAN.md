# 因果诊断，2026-11-01

Xi源码33f23a18保持冻结；先校准再考虑优化。wr独立临时目录，无Docker，无系统安装，测试总CPU≤150%、MemoryHigh512M/Max640M、swap0、Tasks128、nice15；监测/停止阈值沿用原装置。每次一个服务和一个负载，50连接，预热1秒、计量3秒、500ms间隔，状态/正文逐请求校验。

1. 相同Keala入口A/A，含Hono/H3与Node/Bun共8栈，Hello 16轮，128样本。完整8种起始位置，每个配一个精确反向轮次。两个Keala标签由IPC核对同一entry URL，before有效源码/构建摘要记录成Xi。
2. Bun只减去Raw Request waitUntil/runtime/ip安装，before为明确不兼容的诊断副本，不能作为产品版本；baseline仍Xi。Hello、comments、wildcard各12轮，共72样本。只改Bun元信息安装；其余源码/依赖与原生客户端相同。用于估计这一整段工作的端到端成本，不据此直接删除公开扩展。
3. Node POST，Xi的两个相同标签加Hono，与cgroup周期1ms/10ms交叉共6栈，完整6种起始位加反向12轮，共72样本。只修改本测试unit的cpu.max，quota/period仍1.5，记录每样本实际值，finally复原。检查两种周期内的A/A、K/H相对p99与CPU，不把旧三轮中位数差当稳定退化。

三阶段分别重新启动协调进程；共272样本，runtime最大30分钟。任何错误/资源保护触发停止并保留数据。配额节流不等于延迟原因，相关性只用于选场景。整数毫秒桶/三秒窗口的限制继续明示；微小差距需结合A/A噪声判断。

## 兼容方案追加验证

前3阶段272样本完成后，串行追加两个隔离候选，各72样本：Bun Hello/comments/wildcard、12轮、与Xi对照，仍50连接/1秒预热/3秒计量及相同资源上限。

- batch：完整保留3个扩展，将3次defineProperty换成共享descriptor map的defineProperties；契约探针与只读审查通过。HTTP结果无收益，不采纳；所有异常慢样本保留。运行至72样本正常结束后，监控stop请求返回unit已退出，未截断样本。检查时vmstat steal=5%，无法解释此前双方数量级下降的根因。
- split：原3次defineProperty、顺序及owner/清理完全保留，仅提取服务器作用域extendRequest函数。17项现有Bun契约通过，HTTP未证明跨场景净收益，不采纳。

原3轮Node p99结论需限定为当次独立中位数现象；本轮配对重复未复现POST落后，不以此制造产品修复。消减扩展的效应属于整段代码的端到端效应，包含对象形状、分配和编译状态，不能等同为单个属性定义的独立成本。

# 交付验证

实际脚本以当前 package.json 为准。本仓库 build 是 TypeScript 编译，不是 Next.js 构建；浏览器 E2E 入口未配置，使用仓库已有 HTTP 冒烟及 example-check。

| 检查                                     | 结果                                                               |
| ---------------------------------------- | ------------------------------------------------------------------ |
| bun run typecheck                        | 通过                                                               |
| bun run build                            | 通过                                                               |
| bun run lint                             | 退出码0、零error；全仓67条既有warning，不满足AGENTS的零warning条件 |
| 本轮受影响代码的oxlint                   | 零error、零warning                                                 |
| bun run test --coverage，包含真实uWS插件 | 3063通过、29按现有平台条件跳过，总3092                             |
| Bun1.4.4保留方案定向验证                 | 49通过，含两种router和48,000次差分                                 |
| smoke.ts、example-check.ts               | 通过                                                               |
| 项目格式，临时排除他人新增AGENTS.md      | 通过；没有修改忽略配置                                             |
| 未排除文件的npm run verify               | 在AGENTS.md格式检查处停止，未宣称整体验证通过                      |

覆盖率为配置匹配的 `src/**/*.ts`，排除index/types：语句95.25%、分支91.09%、函数95.94%、行97.08%，四项90%门禁通过。`experimental` 不属于当前覆盖率匹配范围，这些数字不能当作新原型的覆盖率；新原型另有Node/Bun行为与差分测试。

AGENTS.md 在本轮工作进行期间由其他工作新增，未格式化或提交该文件；其他既有lint告警保留。本轮新引入的无捕获错误回退函数作用域告警已修复，差异单独记录，不改变成功请求的测量路径。因完整格式及零warning仓库门禁未满足，没有提交或push。

最终源码及编译摘要见final-build.json；性能测量版本与交付整理版本的完整差异见final-source-adjustment.patch。所有原始测试、覆盖率、构建与lint日志保留在本目录。

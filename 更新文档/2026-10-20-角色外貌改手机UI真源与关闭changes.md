# 2026-10-20 角色外貌真源改为手机UI『角色形象』，关闭 AI 建档/changes

## 一句话

柏宝绘不再自己攒角色档案、也不再让 AI 改库：外貌以**手机UI『角色形象』为唯一真源**，
柏宝绘只做**只读镜像**（并入「本聊天角色」）；AI 输出协议里 `changes` 整体下线，只写画面提示词。

## 为什么这么做

1. **两份数据必然打架**。手机UI 的缓存是 `chatMetadata`（**按聊天**），柏宝绘的全局库是
   `extensionSettings`（**跨聊天**）。老的「一键导入手机UI」把按聊天的数据固化进跨聊天的库，
   现场积了 66 条永远不删的拷贝；两边各用各的 LLM 给同一个角色建档（截图里的「郭志强」两边都有）。
2. **推送（手机UI 写入柏宝绘）被否**：作用域错配没解决、删除/改名要另写同步协议、要给公开 API
   加写接口（v1→v2）、手机UI 还有事务补丁 + 回档锁会丢外部写入。**拉取**这些全都不用做，
   而且「手机UI 一缓存就能看到」的目标同样达成。
3. **不再建档是用户明确要求**：一个新角色长什么样，交给手机UI 生成一次并固定下来，
   柏宝绘照着抄；不让插件自己猜一份、之后再被手机UI 覆盖。
4. **changes 关掉**：否则「手机UI 是真源」立刻被 AI 写回打破，重合问题原地复活。

## 改了什么

| 文件 | 内容 |
| --- | --- |
| `src/st/phoneRoles.ts`（新） | 读手机UI 角色形象的**结构化快照**：三级回退（本窗 → iframe → chatMetadata）、别名展开、11 字段映射、`origin`/`enabled`、人话来源说明。 |
| `src/state/phoneCharTags.ts`（新） | 影子层：`phoneCharTagLib` 响应式状态 + `refreshPhoneCharTags()`（指纹短路）+ `initPhoneCharTags()`（注入来源、跟随 CHAT_CHANGED、先读一次）+ `watchPhoneCharTags()`（页面打开期间 2s 轮询）。**跳过全局库同名**（`skippedByGlobal` 供界面解释）。 |
| `src/state/charTags.ts` | `CharTagSource` 增 `'phone'`；新增 `setPhoneCharTagSource` + `externalCharTagEntries()`；派生种子与**锁定名集**都改成 `(全局 + 手机UI 影子) ⊖ 本聊天基线`。 |
| `src/autoTag/prompt.ts` | 输出协议只剩 `{images:[…]}`；删掉「建档先于画图」整段与 `field:"new"` 示例，改成「库里没有的角色只在本图写全、不改库」；`[locked]` 与临时状态的措辞同步改口。 |
| `src/autoTag/runner.ts` | 删除 `planChangeOps` 与楼层 extra 写回；`changes` 一律忽略；NAI「建档必须带 nl」的验收删除；生成前 `refreshPhoneCharTags()`。 |
| `src/autoTag/charAnchors.ts` | 库头部 `[locked]` 说明与「其余已建档」名单文案随 changes 下线改口。 |
| `src/state/settings.ts` | 三份内置思维链（Comfy / NAI / NAI V5）B 段重写为「角色清点与外貌来源」，第三层自查从「二选一/三选一写 changes」改成「能指出库中条目，或本图写全」；V5 的分类标签改为【库里有】【库里没有】【一次性】。 |
| `src/pages/characters/index.vue` | 影子条目并入「本聊天角色」并列（`手机UI` + `只读` 徽标）；点击进**只读详情弹窗**（11 字段 + 整串 + 「复制到本聊天」）；全局同名**禁止复制**（在派生层就不显示，代码里另有一道防御）；状态条显示来源/开关/跳过数 + 手动刷新；批量收藏/清理**跳过影子**；「一键导入手机UI」改名「固化为全局」（可选动作，不再是日常入口）。 |
| `src/public/types.ts` | `source` 增 `'phone'`。 |
| `src/state/phoneCharTags.test.ts`（新） | 5 条：映射/别名展开、全局同名跳过、影子锁定挡旧楼层 ops、指纹短路、手机UI 清空后影子消失。 |
| `src/autoTag/prompt.test.ts` / `charAnchors.test.ts` | 约 20 处断言跟随新协议改口。 |

## 迁移与兼容（重要）

- **旧数据不动**：历史楼层里的 `bbiCharChanges` 仍然重放（`deriveCharTags` 不变），
  以前 AI 建的条目、`source:'ai'/'book'` 的条目照常显示；想清掉就用「清除非收藏」。
- **提示词预设**：导入的预设里若还写着「建档 / changes」，模型可能照旧输出 —— 但**代码侧一律丢弃**，
  不会写库。想彻底干净，请在设置页把那份预设的思维链/规范里对应段落删掉。
- **公开 API `getCharacters()`**：`source` 可能出现 `'phone'`；镜像条目也会出现在返回列表里
  （等同「本聊天角色」看到的内容），手机UI 那边按名字匹配的逻辑不受影响。

## 怎么验证

```bash
node node_modules/vitest/vitest.mjs run     # 70 files / 922 passed / 3 skipped
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit   # 仅剩改动前就有的 19 条(缺 @types/node 等)
node node_modules/vite/bin/vite.js build    # v0.3.30,dist 已更新
```

实机：
1. 打开角色管理页 → 「本聊天角色」里出现手机UI 的角色，带 `手机UI` `只读` 徽标，上方状态条显示来源与条数；
2. 在手机UI 里新建一个角色（等它生成完）→ **不切页**，2s 内应该出现在柏宝绘列表里；
3. 点该条目 → 只读弹窗；点「复制到本聊天」→ 变成可编辑的本地条目；
4. 全局库里已有的同名角色**不会**出现在本聊天分区（状态条会显示「已跳过 N 个」）；
5. 跑一次自动 tag → 网络请求里不再有 `changes`，角色库/楼层 extra 都没有新增。

## 遗留 / 下一步

- **不写回手机UI**：柏宝绘里改完不会同步回去（镜像只读）。要做的话得处理手机UI 的事务补丁与回档锁。
- **镜像范围**：手机UI 内置的 24 个默认角色（林知意/苏曼…）也会出现在本聊天角色里；
  换别的卡时它们属于噪声，后续可加「只显示本楼正文/角色卡里出现过的」开关。
- **无档案角色会漂**：手机UI 没生成之前，同一角色每张图的外貌靠模型按正文现写，可能不一致。
  想让某个角色稳住 → 去手机UI 生成一次。
- 手机UI 脚本未在本聊天启用时只有 `chatMetadata` 那一级（拿不到内置默认角色），状态条会明示。

## 回滚

1. 代码：`git -C "E:\TT桌面版酒馆\git-repos\HUITU" revert`（或 checkout 到本次提交前的 `dist`/`src`）；
   注意这次动了 prompt 与协议，回滚后必须重构建。
2. 产物：用 `E:\酒馆默认保存文件\_backup-20261020-1720\HUITU-ext\dist` + `manifest.json` + `package.json` 覆盖回扩展目录。
3. 数据：本次不改任何持久数据（影子不落盘），只有「清除非收藏」会删条目 —— 那一步前已备份 `settings.json`。

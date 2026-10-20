# HUITU 维护手册（面向 AI 维护者）

> 本文件供后续接手本项目的 AI / 协作者快速上手并**安全地**改动代码。
> 设计细节见 `architecture.md` / `DESIGN.md` / `PUBLIC_API.md`（仓根四份文档齐备），
> 本手册只讲三件事：**怎么验证改动、哪些坑不能踩、当前分支状态**。

---

## 0. 一句话定位

HUITU（柏宝绘）是 SillyTavern（酒馆）的**剧情配图扩展（插件）**：在聊天里自动判断哪些画面值得画、
把生图卡片挂到每个楼层、通过 ComfyUI / NAI / WebUI 出图，并把图片与提示词侧写存回。

- 技术栈：Vue 3 + TypeScript + Vite；vitest 单元测试；产物 `dist/index.js` + `dist/index.css`。
- 当前开发分支：`feat/character-lora`，迭代到 **v0.3.23**（清理后，详见 §7）。
- 仓根已有 `README.md` / `architecture.md` / `DESIGN.md` / `PUBLIC_API.md`，先读 `architecture.md` 的任务定位索引。
- 提示词预设的对外说明书在 `文生图转换说明书/`，**只在那里维护**（用户会把它单独发给外部 AI）。
- **每次改动都要在 `更新文档/` 新增一篇**（格式见 `更新文档/README.md`）。那是跨 AI 交接的事实来源：
  改了什么、为什么、怎么验证、还剩什么。不要只改代码不记账。

---

## 1. 本地常用命令

| 命令 | 作用 | 说明 |
| --- | --- | --- |
| `npm run test` | `vitest run` | **健康基线：872 passed / 3 skipped / 0 failed**。任何代码改动后必跑。 |
| `npm run typecheck` | `vue-tsc --noEmit` | ⚠️ 见 §5 的环境级报错，**不要试图修**。 |
| `npm run build` | `vite build` | 会先跑 `prebuild`（`scripts/sync-version.mjs`）同步版本号，产物写入 `dist/`。 |
| `npm run watch` | `vite build --watch --mode development` | 开发时增量构建。 |

> **`dist/` 被 git 跟踪**（这是要随插件分发的构建产物）。改完源码必须重新 `npm run build` 并把 `dist/` 一起提交，否则装的扩展还是旧的。

---

## 2. 当前分支已实现的核心功能（`feat/character-lora`）

| 功能 | 关键文件 | 要点 |
| --- | --- | --- |
| 角色级 LoRA 动态挂载 | `src/characterLora.ts` | 把 LoRA 绑到角色条目；仅当该角色在画面里才挂；剥离渠道级绑定的 LoRA；触发词按确定顺序前置。 |
| 外貌来源三选一优先级 | `src/state/charTags.ts`（`buildEntryTag`） | **LoRA 触发词 > 整串 > 11 个结构化字段**，只取最高优先级、不混用；整串与触发词必须完整写入。 |
| 头像格子网格 + 内置头像提示词 | `src/characterAvatar.ts` + `src/pages/characters/index.vue` | 列表改成头像格子；格内生成按钮用内置 `AVATAR_PROMPT` 直接调 ComfyUI；头像存 `柏宝绘_<角色名>/avatar.*`（**同名覆盖** = 换头像）。 |
| 收藏置顶 | `src/state/charTags.ts` 的 `favorite` 字段 | 列表收藏角色置顶。 |
| 出图降噪 | `src/generate.ts` 的 `ensureVerbatimItems` + `src/characterLora.ts` 的 `stripCharacterNameTags` | 去重、剥身份噪声（`User (adnim)`、`林知意 (honkai star rail)` 中文身份 tag、`[lora]:` 库行标记等），并禁止触发词已写明的部位再出现其它取值。 |

---

## 3. 核心契约（改这些会污染生成结果，务必谨慎）

- **角色名协议**：角色名走 `images[].names`，序列化为 `<names>["名","名"]</names>`。`buildEntryTag` 的**三选一优先级不可改**——改了会直接污染发给 ComfyUI 的提示词。
- **公开接口**：`src/public/` 暴露 `globalThis.STBaiBaiImage`，对外契约见 `PUBLIC_API.md`。**改公开签名前先读 `PUBLIC_API.md`**。
- **出图中段唯一路径**：`src/generate.ts` 的 `generateImage` 是卡片与公开接口唯一生成入口（NAI 闸门不可绕过）。

---

## 4. 安全改动清单（删代码 / 重构后必跑 `test` + `build`）

以下三类最容易被静态扫描误判为「死代码」而误删/误伤：

### 4.1 删图标（`src/components/Icon.vue` 的 `PATHS`）
这些名字**被动态引用**，删了会渲染空白，**不能删**：
- `backend / characters / gallery / history / settings` —— 它们是 NavBar 的 `<Icon :name="p.id">` 的**动态页 id**（见 `src/pages/registry.ts`）。
- `sun / moon / sparkles / plug` —— 主题图标（`src/state/ui.ts` 的 `THEMES`）。
- `star` —— 被 BbiSelect 选项 `icon: 'star'` 与 ConfirmDialog `confirm-icon="star"` 引用。

**可靠判据**：只删「在 `name=` / `icon:` / `confirm-icon=` / 页 `id:` 字面量里零出现，且不属上述动态集」的图标。
（血泪教训：曾用 tsconfig 临时开 `noUnusedLocals` + 正则扫图标，把 `backend/characters/settings/star` 全误报为未用。）

**模板 ref 同名导入同样会被误判为未用**：`App.vue` 的 `<div ref="modalHost">` 靠导入同名 ref 自动绑定，
脚本里没有任何引用 —— 静态扫描会把它当死代码删掉，后果是所有弹窗 Teleport 宿主为 `null`、
退化为原地渲染，聊天侧确认窗落在 `.bbi-root` 外、主题变量取不到、背景全透明（v0.3.23 清理时踩过，
v0.3.26 修复）。**删任何「未用导入」前，先 grep 模板里的 `ref="名字"`。**

### 4.2 删 CSS 类（`<style scoped>` 里的 `.bbi-*`）
删前先 grep 该类名在 `class=` / `:class=` / `:deep(...)` 中的出现次数，**含复合选择器与动态拼接**：
- 状态类用 `.base.is-state` 复合写法（如 `.bbi-prompt-state.is-aborted`、`.art-import-badge.is-skip`）—— 单看 `is-aborted` 像死代码，其实挂在 base 元素上。
- `FloatingOrb` 的形状类靠 `shape-${ui.orbShape}` 运行时拼接出 `shape-bookmark / shape-circle / shape-square`。
- **批量删 CSS 后必须逐个类 grep 其在 `<style>` 里的 def 数**：typecheck 不查 CSS，误删基础样式会静默让 UI 变形（v0.3.23 曾误删 `.bbi-char-form*` / `.bbi-char-modal` 导致界面错位）。

### 4.3 **图库体积统计是「禁用但有意保留」的，见 §6，千万别删。**

---

## 5. 已知的环境级噪音（与代码无关，别浪费时间修）

- `vue-tsc` 报 `Cannot find module 'node:fs'` / `node:path` / `Cannot find name '__dirname'` / `setImmediate`
  → 缺 `@types/node` 或 tsconfig 环境配置问题，**非本项目 bug**。
- `vite build` 提示「chunks larger than 500 kB」→ 只是体积提示，**不是错误**。

---

## 6. 有意禁用 / 待恢复的功能（当死代码删会破坏测试）

**图库体积统计**：`src/pages/gallery/index.vue` 里的
`measureSizes` / `sizes` / `measuring` / `groupSize` / `groupSizeText` / `totalSizeText`，
以及对应模板 `<span v-if="measuring" class="gal-measuring">`、CSS `.gal-measuring`、
测试 `src/pages/gallery/index.test.ts` 中对 `probeUserImage` **58 次调用**的断言。

作者在 `load()` 里注释掉了调用：
```ts
// void measureSizes(next);
```
并明确写明：「体积相关的计算、模板、CSS 与测试全部原样保留，恢复时解注下面这一行即可。」
**即恢复 = 解注那一行，不必重写；当前是作者不满意方案（逐张 HEAD 随图库规模线性增长请求数）而暂时禁用。**

---

## 7. 最近一次清理（commit `63e08e0`，纯维护）

- 删 **13 个零引用图标**：`bolt / bookmark / comfyui / items / navigate / npcs / pin / plans / prompt / scenes / summary / vars / webui`。
- 删 **4 个零调用导出**：`mainApiAvailable`（`api/client.ts`）、`buildAnchorText`（`autoTag/charAnchors.ts`）、`uploadImageFile` / `deleteImageFile`（`floor/upload.ts`，仅 base64/delete 的薄包装）。
- 删 **1 个零应用 CSS 类**：`bbi-auto-grid`（在 `settings/index.vue` 定义两处，从未挂到 `class=`）。
- 清理未用局部：App.vue 多余的 `modalHost` 导入、`nai.ts` 的 `base64ToUint8`、`storage.test.ts` 的 `generationId`、`characters/index.vue` 的 `seed` 解构与 `_phoneEntryToCharTag` 冗余 `phoneName` 参数、`settings/index.vue` 多余的 `nextTick` 导入。
- **图库体积统计按 §6 原样保留**。
- 验证：872 passed / 3 skipped；`vite build` 通过。

---

## 8. 待办 / 开放问题

- **版本号停在 v0.3.23**（清理未升级，等发布决策）。
- `feat/character-lora` **尚未合并进 `main`、尚未 push**（作者惯例：AI 本地 commit 后停下，作者确认再 push / 合并）。
- **作者部署方式**：把分支 `git reset --hard` 到测试分支（`test/character-lora`）后，安装到酒馆扩展目录
  `$APPDATA/com.tauritavern.client/data/extensions/third-party/HUITU` 实测。
  合并 / 发布前请在测试分支实测：头像能否进格子、LoRA 是否挂上、出图降噪是否符合预期。
- **合并前务必重跑** `npm run test` + `npm run build`（并确认 `dist/` 已更新提交）。

---

## 9. 代码风格速记

- 注释用中文；函数 / 组件上方优先写「为什么」而非「做什么」。
- `<style scoped>` 统一 `bbi-` 前缀；状态类用 `is-*` 复合选择器（`.base.is-state`）。
- 图标统一走 `Icon.vue` + `PATHS`，**新增图标**需同时在对应页 `id` / BbiSelect 选项 `icon` / 主题 `THEMES` 里对应，不要引字体图标库（组件靠 shadow DOM，字体图标跨不去）。
- 卡片挂在 **shadow DOM**，不要写死跨 shadow DOM 的全局选择器；跨组件样式靠组件级样式 + `:deep()`。
- 写回正文用 `<bbi_image>` 协议（`src/autoTag/protocol.ts`），不要直接改 message 文本。

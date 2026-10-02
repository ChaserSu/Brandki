# AGENTS.md — 给接手开发的 AI Agent

本文件说明 Brandki 的架构、数据格式、开发流程与**实测踩过的坑**。目标：让一个新 Agent clone 仓库后不依赖历史对话即可继续开发、构建、发版。人类开发者也可以读。

## 1. 这个项目是什么

「背品牌」的 Anki 风格闪卡应用。用户输入是一个标准 Anki `.apkg`（zip：`collection.anki2` SQLite + `media` 映射文件 + 媒体二进制）。应用在**浏览器内**完成解析（sql.js wasm + fflate），渲染 Anki 卡片模板，用 ts-fsrs 做间隔重复调度。

同一套代码三种运行形态：

1. `npm run dev`：纯 Web，存档在浏览器 OPFS；
2. `npm run app:dev`：Electron 加载 Vite dev server（5180 端口）；
3. 打包后：Electron 加载 `dist/`，通过自定义 `app://bundle/` 协议访问，存档通过 IPC 直写本机硬盘。

业务代码**不允许**直接判断 Electron 环境，一律走 `src/lib/fsa.ts` 的存储抽象；桌面能力只在 `native.ts` 探测、`electron/` 实现。

## 2. 快速开始（按顺序执行）

```bash
node -v          # 需要 >= 20
npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
# 若 electron 二进制没装上（dist 目录缺失或体积为 0）：
NODE_TLS_REJECT_UNAUTHORIZED=0 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
  node node_modules/electron/install.js
node scripts/smoke.mjs   # 必须全绿
npm run build            # tsc --noEmit + vite build，必须 0 error
```

冒烟测试通过即代表核心逻辑（apkg 解析、模板、FSRS、合并、备份往返）没坏，**改任何 lib 代码后都要跑**。

## 3. 架构与数据流

### 3.1 启动链

`main.tsx → StoreProvider（store.tsx）→ App.tsx`

- StoreProvider 首次挂载：`ensureStructure` → 读 `settings.json` → 若无牌组（`!deckId && !seeded`）则 `fetch(BASE_URL+'sample.apkg')` 解析并种入（`seedIfNeeded`）→ 读 `progress.json` → 读媒体并建 Blob URL。
- `App.tsx` 每次冷启动先显示 `<Welcome>`（刻意不记忆，见 `showWelcome` useState 初值 `true`），完成后回首页。
- 视图是 App 内的 useState 路由（无 react-router）：`home | browse | settings`，学习页由 `studyCfg` 是否为 null 覆盖。

### 3.2 存档格式（版本化，改格式必须升 version + 写迁移）

```
library/<deckId>/deck.json     # DeckFile：models / notes / cards（卡片=笔记×模板展开）
library/<deckId>/media/<name>  # 原始媒体文件，文件名沿用 apkg 里的真实名
progress.json                  # { version:1, states:{cardId: ts-fsrs Card}, logs:[...], mastered:{cardId:{at}} }
settings.json                  # { version:1, deckId, seeded, welcomed, batchSize }
```

- cardId 规则：`` `${note.guid}#${template.ord}` ``，**不要改**，改了所有历史进度失联。
- `BrandkiCard.deckPath` 是该卡所属 Anki 牌组的 `::` 全路径，业态树（`categories.ts`）逐卡按它聚合——**不能用某一张卡的路径代表全局**（这是真实修过的 bug：会导致首页业态名张冠李戴）。
- 「完全掌握」是独立于 FSRS 的一张表 `mastered`，队列构建时过滤；在牌库批量改成其他档位时要 `delete mastered[id]`。
- 进度写入：store 里有防抖自动保存（`scheduleProgressSave`）；批量操作（`batchSetStatus`）直接落盘一次。

### 3.3 调度与队列（`src/lib/srs.ts`）

- 四档 `Grade = 1..4`（Again/Hard/Good/Easy），`applyGrade(cardId, prev, rating, now)` 返回 `{ next, log }`，新卡 `prev` 传 null（内部 `createEmptyCard`）。
- 两个队列，别混用：
  - `buildQueue(cards, progress, now)`：**到期队列**（学习步到期 + 到期复习 + 新卡，受 DAILY_NEW_LIMIT 约束），给「开始复习」。
  - `buildStudyQueue(cards, progress, limit, filter?)`：**自由学习队列**（不看到期时间；排除已掌握；新卡优先；随机/指定业态靠 `filter`），limit 取 `settings.batchSize`。
- `gradePreviews(state, now)` 给按钮上的预计间隔文案。

### 3.4 apkg 与模板（`apkg.ts` / `template.ts`）

- apkg 是 zip：`collection.anki2`（SQLite，cards/notes/notetypes/col 表）、`media`（JSON：序号→真实文件名）。col.models/col.decks 是 JSON 字符串字段。
- 导出备份 `buildBackup` 产出的也是 apkg 兼容 zip，可被自身 `parsePackage` 往返解析（冒烟测试第 5 段兜底）。
- 模板渲染要支持：`{{字段}}` 替换、`{{#字段}}...{{/字段}}` 条件块、`{{FrontSide}}`（背面注入正面 HTML）、媒体 `src` 重映射到 Blob URL（`remapMedia`）。
- sql.js 的 wasm 在 `dist/assets/sql-wasm-*.wasm`；Vite 的 `base:'./'` 保证桌面 `app://` 下能取到。

### 3.5 桌面桥

- `electron/main.cjs`：注册特权 scheme `app://`；IPC 命名空间 `fs:*`（ensureStructure/readText/writeText/listFiles/readBlob/writeBlob）与 `app:*`（getSavePath/openSaveFolder）。所有路径经 `safeJoin` 防穿越。
- `electron/preload.cjs` 用 `contextBridge` 暴露 `window.brandkiNative`，**保持 contextIsolation: true、nodeIntegration: false**。
- `app.setName('Brandki')` 必须在 ready 前调用，决定 userData 目录名；`app.getPath('userData')` 必须在 ready **之后**调用（懒求值）。
- renderer 日志被转发到主进程 stdout（`console-message`），打包后冒烟就靠它判断白屏。

## 4. UI 约定

- Tailwind 4（CSS-first 配置在 `index.css`，品牌色 `brand`），组件基元在 `components/ui.tsx`，新页面先复用它。
- 移动端优先：学习页是 `100dvh` flex 布局——卡片区 flex-1 可滚动，五档按钮固定在底部安全区；正面图片 `object-contain`，禁止裁掉。
- 危险操作（重置/恢复示例）用应用内 `ConfirmDialog`，不要用原生 `confirm()`（桌面 WebView 里不稳定）。
- 中文文案直接写简体中文，不引入 i18n 框架。

## 5. 常见任务

| 需求 | 落点 |
|---|---|
| 改评分按钮/调度 | `srs.ts`（`gradePreviews`/`applyGrade`）+ `Study.tsx` |
| 改学习入口规则 | `srs.ts`（两个 build*Queue）+ `Home.tsx`（入口 UI）+ `categories.ts`（业态树） |
| 改存档结构 | `types.ts` 升 version → `srs.ts#normalizeProgress` / store 的读取处加迁移 → 冒烟测试加用例 |
| 新增设置项 | `types.ts#SettingsFile` + `Settings.tsx` + store 的 `updateSettings` |
| 支持新导入格式 | 新增 parser 返回 `ImportedDeck`，store 导入入口保持不变 |
| 安卓 | 引入 Capacitor：新增第三存储后端实现 fsa 接口（Filesystem API），业务代码不动 |

## 6. 排障手册（全部实测过）

1. **Electron 双击只显示 "To run a local app, execute the following..."**：双击的是 `node_modules/electron/dist/Electron.app`（裸引擎，没传应用路径）。要用 `electron .`（package.json 的 main 指向 `electron/main.cjs`）或直接双击打包产物 `Brandki.app`。
2. **Electron 启动即崩 / 签名报错 / `Operation not permitted` sandbox**：
   - 版本太老 → 升级 electron（新版 macOS 需要 ≥38，本项目锁 44.5.1）；
   - 手动解压导致签名损坏 → `codesign --force --deep --sign - node_modules/electron/dist/Electron.app`；
   - 在命令沙箱里跑 → 临时 `--no-sandbox --disable-gpu-sandbox --user-data-dir=<项目内临时目录>`，仅测试。
3. **npm/electron 下载失败、SSL 错误**：见第 2 节镜像与 `NODE_TLS_REJECT_UNAUTHORIZED=0`。
4. **白屏**：先看主进程 stdout 有没有 `[renderer:]`；桌面端大概率是资源路径问题——检查 `base:'./'` 和 app 协议 MIME（`.wasm` 必须是 `application/wasm`）。
5. **Windows 包在 macOS 无法验证**：正常，交叉编译产物只能在 Windows 实测；至少用 `xxd` 看 MZ 头（`4d5a`）确认是 PE 文件。
6. **图片不显示**：确认媒体解包名与笔记字段里 `<img src>` 一致，且 `remapMedia` 用的 map key 是真实文件名。

## 7. 构建与发版清单

```bash
npm run build && node scripts/smoke.mjs
# mac
npm run app:build                 # release/mac-arm64/Brandki.app
codesign --force --deep --sign - release/mac-arm64/Brandki.app   # 未装开发者证书时
cd release/mac-arm64 && ditto -c -k --sequesterRsrc --keepParent Brandki.app Brandki-<ver>-mac-arm64.zip
# win（macOS 交叉编译）
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
  npm run app:build:win           # release/*.exe
```

- electron-builder 配置在 `package.json#build`（appId `com.brandki.app`）。NSIS 默认 per-user 安装、`deleteAppDataOnUninstall:false`（卸载保留学习数据）。
- Release 资产命名：`Brandki-<ver>-mac-arm64.zip`、`Brandki-Setup-<ver>-x64.exe`、`Brandki-Setup-<ver>-arm64.exe`、`Brandki-Portable-<ver>-x64.exe`。
- GitHub Release 单文件上限 2GB；mac zip 必须用 **ditto** 保留可执行权限，不要用 Finder 压缩外的其它方式破坏符号链接。

## 8. 不要做的事

- 不要把 `node_modules/`、`dist/`、`release/`、`.brandki-testdata/` 提交进仓库。
- 不要删/改 `public/sample.apkg`（首启种入）和 `build/icon.png`（打包必需）。
- 不要在业务组件里直接 `window.brandkiNative` 或直接调 OPFS——走 `fsa.ts`。
- 不要把欢迎页改回「只显示一次」——产品当前明确要求每次启动显示。
- 不要给 Electron 开 nodeIntegration 或关 contextIsolation。
- 不要提交真实个人牌组数据/媒体，示例只保留仓库里的两张样卡。

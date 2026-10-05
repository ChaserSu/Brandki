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
exports/*.brandki.zip          # 导出备份时在存档内留存的打包副本（可被「清理存储空间」回收；下载文件夹另存一份）。导出 apkg 不在存档内留副本
progress.json                  # { version:1, states:{cardId: ts-fsrs Card}, logs:[...], mastered:{cardId:{at}} }
settings.json                  # { version:1, deckId, seeded, welcomed, batchSize, compressedMediaKeys? }
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
- 导出分两种，别混：`buildBackup` 产出**自有格式** `.brandki.zip`（`library/<id>/deck.json` + media + `progress.json`，**无损**，供 Brandki 间迁移，冒烟第 5 段往返）；`buildApkg` 产出**标准 .apkg**（sql.js 现场建 `collection.anki2`：col/notes/cards/revlog/graves + `media` 映射，冒烟第 6 段往返），可导入 Anki 等兼容软件，但**有损**——卡片内容与图片完整，学习进度只能近似写成 Anki 的 type/queue/due/ivl/factor，且卡片 id / 笔记 guid 会重新编号。入口在设置页「牌组与数据」两个 Row：`exportBackup`（同时在 `exports/` 留一份副本供清理）与 `exportApkg`（只触发下载、**不在存档内留副本**，避免体积翻倍）。
- Anki 快照 ↔ FSRS 映射：`ankiSnapshotToState`（导入）/ `fsrsToAnkiSched`（导出）。**review** 的 `due` 是「相对 `col.crt` 的天数」，**learning/relearn** 的 `due` 是 Unix 秒且 `ivl` 恒为 0；导出时 `col.crt` 取当前时间。踩过的坑：导入侧原来用 `c.ivl <= 0` 判定「无调度状态」，会把学习卡（ivl 恒 0）一并丢掉，已改为只按 `c.type === 0`（新卡）判定。
- 模板渲染要支持：`{{字段}}` 替换、`{{#字段}}...{{/字段}}` 条件块、`{{FrontSide}}`（背面注入正面 HTML）、媒体 `src` 重映射到 Blob URL（`remapMedia`）。
- sql.js 的 wasm 在 `dist/assets/sql-wasm-*.wasm`；Vite 的 `base:'./'` 保证桌面 `app://` 下能取到。

### 3.5 桌面桥

- `electron/main.cjs`：注册特权 scheme `app://`；IPC 命名空间 `fs:*`（ensureStructure/readText/writeText/listFiles/listDirs/readBlob/writeBlob/deleteFile）与 `app:*`（getSavePath/openSaveFolder）。所有路径经 `safeJoin` 防穿越；`fs:deleteFile` 对 ENOENT 静默。
- `electron/preload.cjs` 用 `contextBridge` 暴露 `window.brandkiNative`，**保持 contextIsolation: true、nodeIntegration: false**。
- AI 请求走 `ai:request` IPC 代理（主进程 Node fetch，绕过浏览器 CORS）；浏览器模式在 `ai.ts` 内直接 fetch（部分服务商如 Anthropic 可能因 CORS 失败，提示用户用桌面版）。apiKey 只存本地 `settings.json#ai`。
- 提示词模板可由用户在设置页（`AIPromptEditor.tsx`）自定义，存 `settings.ai.promptTemplate`，空串=用 `ai.ts#DEFAULT_AI_PROMPT`。模板变量只有两个：`{{属性列表}}`、`{{JSON示例}}`，由 `buildPrompt` 替换；解析端要求模型返回键名=属性标题的 JSON。
- `DEFAULT_AI_PROMPT` 内置了业态分类参考（来源标注「新城集团 260901 版本业态分类规则」），分类项的唯一来源是 `ai.ts#BUSINESS_TAXONOMY`（151 条，格式「大类::中类::小类」），提示词按数组展开插入，规则第 4 条要求 AI 从中选取最匹配项。改分类表只改 `BUSINESS_TAXONOMY`。注意：用户若已保存过自定义模板，不会自动拿到新默认，需在编辑器点「恢复默认」。
- AI 补全的标签：标签不是 Anki 字段，但借「属性」链路一起补全——`CardForm.runAI` 把合成属性 `ai.ts#TAG_FIELD_KEY`（标题「标签（Anki Tags）」）追加进送给模型的字段列表，已有标签以空格拼接作为提示线索；模型按标题回传 JSON 后，`parseAITags` 按空格/逗号/顿号切分、去 `#`、去重，**整体覆盖** `tags`（返回为空则保留原标签，与字段「非空才覆盖」一致）。默认模板第 7 条约束标签格式（2-4 个、空格分隔、不含空格与 #）。
- 手动录入（`Entry.tsx` → `CardForm.tsx`(mode=create) → `store.addManualCard`）：图片写入 media 库、Front 字段生成 `<img>`；笔记挂到克隆模型 `brandki-manual-v1`（从含 Front 字段的模型克隆），自定义属性追加为新 fld 并在模板 afmt 尾部追加条件块；业态写入 `card.deckPath`，留空归入「手动录入」。guid 形如 `bk-<stamp>`。
- 编辑卡片（牌库预览弹窗「✏️ 编辑这张卡」→ `CardEdit.tsx` → `CardForm.tsx`(mode=edit) → `store.updateCard`）：**原地更新同一 note/cards，guid 与卡片 id（`${guid}#${ord}`）绝不能变**——progress.json 的 states/logs/mastered 都以 cardId 为键，id 不变即学习进度完整保留；也不要 push 新卡。示例模型的卡被编辑时把 note.mid 迁移到 `brandki-manual-v1`，克隆源取该 note 当前模型（保证模板 ord 对齐）；file 为 null 时保留原 Front 图片（旧媒体文件不删除，允许孤儿）。编辑页 AI 补全通过 fetch 现有 blob: URL 取回原照片作为图像输入。
- 删除卡片（牌库行尾 🗑 单个删除、批量操作底栏「🗑 删除所选 N 张」→ `store.deleteCards`）：从 `deck.cards` 移除指定 id；同一 guid 下的卡片全删光时，对应 note 一并移除（note 还有别的卡则保留，所以按 guid 删卡不会误伤同笔记的其它模板）。同步清理 progress.json 的 `states`/`mastered`（按 cardId）与 `logs`（按 cardId 过滤）。媒体回收规则：取「删除前被引用 ∩ 删除后不再被引用」的文件名集合（`collectReferencedMedia` 对 notes+cards 求并集），删除文件并 `revokeObjectURL`——这是与 `updateCard`（保留旧图、允许孤儿）的关键差异：删除必须真正释放空间。两个入口都走 `ConfirmDialog`（危险操作）。
- 存储维护（设置页「存储空间」两个按钮 → `store.compressMedia` / `store.cleanupStorage`，fsa 两端通用，桌面/OPFS 一致）：
  - 压缩：遍历 `library/*/media`，只处理 >2MB（`COMPRESS_LIMIT`）、扩展名 jpg/jpeg/png/webp、且 key（`${deckId}/${文件名}`）不在 `settings.compressedMediaKeys` 里的图片；canvas 重编码为 JPEG（最长边 2560、质量 0.82，白底防透明变黑）。jpg 同名覆写；png/webp 转成 `<stem>.jpg`（撞名加时间戳）并由 `rewriteMediaRefs` 改写 deck.json 中 notes+cards 的 `<img src>` 再删旧文件。处理过（含压缩后更大、解码失败跳过）的 key 一律登记，保证「没被压缩过」才会再处理；结束后 `loadAll` 重建 ObjectURL。
  - 清理：孤儿媒体 = media 目录中未被该 deck 任何 note/card 字段 `<img src>` 引用（`collectReferencedMedia`）的文件；deck.json 缺失的旧 library 目录媒体全部算孤儿。已打包包 = `exports/` 目录与存档根目录下的 `*.apkg` / `*.brandki.zip`（`PACKAGE_RE`）。`exportBackup` 除触发浏览器下载外，会把同一 zip 写入 `exports/brandki-backup-<时间戳>.brandki.zip`，否则桌面/OPFS 存档内没有可回收的包。
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
| 改录入/编辑表单 | 共用 `components/CardForm.tsx`（create/edit 两模式），落库分别走 `addManualCard` / `updateCard`；编辑严禁改 cardId，否则丢进度 |
| 改压缩/清理规则 | `store.tsx` 顶部 `COMPRESS_LIMIT`/`COMPRESS_MAX_EDGE`/`COMPRESS_QUALITY`/`PACKAGE_RE`；入口在 `Settings.tsx#StorageSection`，落盘 key 为 `settings.compressedMediaKeys` |
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
npm run app:dmg                 # release/mac-arm64/*.dmg（app:build 只出 .app 目录）
codesign --force --deep --sign - release/mac-arm64/Brandki.app   # 未装开发者证书时
cd release/mac-arm64 && ditto -c -k --sequesterRsrc --keepParent Brandki.app Brandki-<ver>-mac-arm64.zip
# win（macOS 交叉编译，x64 portable）
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
  npm run app:build:win           # release/*.exe
```

> ⚠️ **打包必须带 `NODE_TLS_REJECT_UNAUTHORIZED=0`**：本机网络会拦截 TLS（自签/中间人证书），electron-builder 里 `@electron/get` 下载 `SHASUMS256.txt` 校验 zip 时会报 `unable to get local issuer certificate` 并回退重下，导致打包失败。`app:build` / `app:dmg` / `app:build:win` 三个脚本已内置该变量，**不要从脚本里删掉**；手动跑 `electron-builder` 也要记得加上。

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

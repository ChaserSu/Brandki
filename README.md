# Brandki · 品牌记忆闪卡

Brandki 是一个「像背单词一样背品牌」的间隔重复记忆应用：导入 Anki `.apkg` 牌组，按 FSRS 算法安排复习，支持按业态（牌组层级）专项练习。

同时提供三种形态，**共用同一套 React/TypeScript 代码**：

- 🖥️ **macOS / Windows 桌面 APP**（Electron 套壳，存档直接写本地硬盘，双击即用，不依赖浏览器）
- 🌐 **Web 演示版**（Vite 静态站，存档走浏览器 OPFS 私有目录）
- 📦 可解析标准 Anki `.apkg`（含模板、媒体、学习快照），也支持导出自有 `.apkg` 备份

> 当前版本：**v0.1.0**（首个公开版本）。下载见 [Releases](https://github.com/ChaserSu/Brandki/releases/latest)。

## 功能

- **随时学习**，不必等到期：首页三个入口
  - 「开始学习：随机」——从未掌握卡池随机抽卡，新卡优先
  - 「开始学习：指定业态」——按 Anki 牌组层级（如 `零售::运动户外::国际零售`）构建业态树，选定节点后练习其下全部卡片
  - 「开始复习」——只刷到期卡片
- **五档评分**：重来 / 困难 / 良好 / 简单（FSRS 调度）＋ **完全掌握**（永久移出所有队列，可在牌库中解除）
- **每轮张数**：首次欢迎页选择 7 / 15 / 20 / 自定义，之后在设置页修改
- **每次启动显示欢迎页**
- **牌库浏览器**：搜索、按业态/标签/卡片类型分组与筛选、组内全选、跨组批量改状态、卡片翻面预览
- **大卡片区**：内容占满窗口，图片等比完整展示，五档按钮固定在窗口底部安全区
- **导入 / 导出 / 合并**：导入外部 apkg 时支持 4 种进度合并策略（仅用旧库/仅用新库/合并保留旧/合并采用新）
- **本地优先、离线可用**：无服务器、无账号、无网络请求

## 下载安装

到 [Releases 页面](https://github.com/ChaserSu/Brandki/releases/latest) 下载对应平台：

| 平台 | 文件 | 说明 |
|---|---|---|
| macOS (Apple Silicon) | `Brandki-0.1.0-mac-arm64.zip` | 解压后把 `Brandki.app` 拖入「应用程序」 |
| Windows x64（绝大多数电脑） | `Brandki-Setup-0.1.0-x64.exe` | 安装版，不需管理员权限 |
| Windows ARM64（骁龙本等） | `Brandki-Setup-0.1.0-arm64.exe` | 安装版 |
| Windows x64 免安装 | `Brandki-Portable-0.1.0-x64.exe` | 单文件绿色版，U 盘可带 |

未做苹果公证 / Windows 代码签名（自签名分发）：

- **macOS**：若提示「无法验证开发者」，**右键 app → 打开 → 打开**；之后可正常双击。
- **Windows**：若弹出 SmartScreen，点「更多信息 → 仍要运行」。

<img width="840" height="1814" alt="3568b6a8d1062d4354f3e36dfa7ce291" src="https://github.com/user-attachments/assets/0758160e-a633-4a4b-8271-d224ac731183" />

### 存档位置（桌面版）

| 系统 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/Brandki/save/` |
| Windows | `C:\Users\<用户名>\AppData\Roaming\Brandki\save\` |

设置页可一键在文件管理器中打开该目录。目录结构：

```
save/
├── library/<deckId>/
│   ├── deck.json        # 牌组：模型/笔记/展开后的卡片
│   └── media/*          # 图片等媒体（从 apkg 解出）
├── progress.json        # FSRS 记忆状态 + 复习日志 + 完全掌握名单
└── settings.json        # deckId、每轮张数等设置
```

Web 版数据在浏览器 OPFS 中（站点级私有存储），清浏览器数据会丢失，重要进度请用「导出备份」。

## 技术栈

- React 19 + TypeScript 5.8 + Vite 6 + Tailwind CSS 4
- [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) 5（FSRS 间隔重复算法）
- [sql.js](https://sql.js.org/)（浏览器内 SQLite，解析 Anki `collection.anki2`）＋ [fflate](https://github.com/101arrowz/fflate)（apkg zip 解包/打包，含 WASM）
- Electron 44 + electron-builder 26（桌面壳与安装包）
- 存储双后端：Electron IPC 直写磁盘 / 浏览器 OPFS，上层接口一致（见 [`src/lib/fsa.ts`](src/lib/fsa.ts)）

## 目录结构

```
brandki-demo/
├── electron/
│   ├── main.cjs        # 主进程：窗口、app:// 协议、本地硬盘存档 IPC
│   └── preload.cjs     # 注入 window.brandkiNative 安全桥（contextIsolation）
├── public/
│   └── sample.apkg     # 内置示例牌组（首启自动种入，必须随仓库提交）
├── build/icon.png      # 应用图标（electron-builder 使用）
├── scripts/smoke.mjs   # 无浏览器逻辑冒烟测试（解析→渲染→FSRS→合并→备份往返）
├── src/
│   ├── App.tsx         # 视图路由：欢迎页 / 首页 / 学习 / 牌库 / 设置
│   ├── components/     # Welcome Home Study Browse Settings ImportDialog ui
│   └── lib/
│       ├── apkg.ts     # apkg 解析/导出（sql.js + fflate）
│       ├── template.ts # Anki 模板渲染（字段替换、条件块、FrontSide、媒体重映射）
│       ├── srs.ts      # FSRS 调度、队列构建、五档评分、掌握态
│       ├── categories.ts # 从 deckPath 构建业态树
│       ├── merge.ts    # 牌组/进度合并策略
│       ├── fsa.ts      # 存储抽象：native 磁盘 / OPFS 双后端
│       ├── native.ts   # 桌面桥类型与探测
│       ├── store.tsx   # React Context：加载、导入、自动保存、备份
│       └── types.ts    # 全部存档/领域类型
└── package.json        # electron-builder 配置也在这里
```

## 开发

要求 Node.js ≥ 20（建议 20 LTS 或 22 LTS）。

```bash
npm install

# Web 开发服务器（http://localhost:5173，OPFS 存档）
npm run dev

# 桌面开发模式（Vite 5180 + Electron 窗口加载 dev server）
npm run app:dev

# 逻辑冒烟测试：apkg 解析 / 模板 / FSRS / 合并 / 备份往返
node scripts/smoke.mjs
# 或先做类型检查与构建
npm run build
```

### 网络问题（中国大陆环境）

本项目依赖 Electron 二进制与 sql.js wasm，如遇下载失败/SSL 报错：

```bash
# npm 走国内镜像
npm install --registry=https://registry.npmmirror.com --no-audit --no-fund

# Electron 二进制走镜像（若 npm install 用了 --ignore-scripts，需手动补装）
NODE_TLS_REJECT_UNAUTHORIZED=0 \
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
node node_modules/electron/install.js

# electron-builder 的 nsis/winCodeSign 等工具二进制
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

## 编译桌面安装包

```bash
# macOS：产出 release/mac-arm64/Brandki.app（dir 目标，快速验证）
npm run app:build
# macOS：产出 DMG
npm run app:dmg

# Windows：在 macOS 上交叉编译，产出 NSIS 安装版 + 绿色版，各含 x64/arm64
npm run app:build:win
```

编译注意事项（均为实际踩坑记录，给接手的 Agent 见 [AGENTS.md](AGENTS.md)）：

1. **Electron 版本**：必须 ≥ 38（本项目锁定 44.x）。旧版（如 33）在新版 macOS 上主进程初始化即崩溃（`EXC_BAD_ACCESS`）。
2. **macOS 上未签名/手动解压的 Electron.app** 可能沙箱初始化失败（`Operation not permitted`），执行一次本地签名即可：
   `codesign --force --deep --sign - node_modules/electron/dist/Electron.app`（打包产物同理）。
3. 在受限沙箱（如 AI Agent 的命令沙箱）里跑 Electron 会被拦在 `~/Library/...` 写入上，冒烟时可临时加
   `--no-sandbox --disable-gpu-sandbox --user-data-dir=<工作区内临时目录>`，**仅限测试**，正式产物不要带这些参数。
4. Windows 的 x64 与 arm64 是两套二进制，**不能合并成一个 exe**（electron-builder 另会生成一个二合一安装包，体积约为两者之和）；日常分发 x64 即可。
5. `vite.config.ts` 中 `base: './'` 不能改成绝对路径，否则桌面端 `app://bundle/` 加载不到资源。
6. `public/sample.apkg` 与 `build/icon.png` 是二进制资源，删了会分别导致首启种入失败和打包失败。

## 发布新版本（维护者）

1. 更新 `package.json` 的 `version`。
2. `npm run build` + `node scripts/smoke.mjs` 全绿。
3. macOS：`npm run app:build`，将 `release/mac-arm64/Brandki.app` 用 ditto 压缩为 zip
   （`ditto -c -k --sequesterRsrc --keepParent Brandki.app Brandki-x.y.z-mac-arm64.zip`，保留权限与签名）。
4. Windows：`npm run app:build:win`，取 `release/` 下的 exe。
5. GitHub 创建 tag `vX.Y.Z`、Release，上传上述资产。

## 路线图

- Android / iOS（Capacitor 套壳，复用现有 Web 代码，存储改走应用私有目录）
- 学习统计与热力图
- 更多牌组管理（多牌组并存、牌组切换）
- 苹果公证 / Windows 代码签名（正式分发）

## License

[MIT](LICENSE)

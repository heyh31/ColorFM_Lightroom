# apps/desktop

简体中文 | [English](README.md)

macOS 桌面窗口（Tauri 2 + React 19 + Vite 7）。它是**唯一的交互界面**，同时也是引擎的宿主：
启动时用本机的 Node 拉起 `packages/engine/dist/main.js`、把端口和令牌交给前端，窗口关闭时回收进程。

这里不做任何图像运算——预览、渲染、缩略图全部来自引擎的 HTTP 接口。

## 目录

```
src/                      # 前端（React + TypeScript）
  App.tsx                 # 轮询会话、采纳/交还会话、设置上下文、⌘, 快捷键
  Workspace.tsx           # 三联面板、缩放/平移、强度滑块、胶片条
  SettingsSheet.tsx       # 设置面板（语言 / 输出位置 / 存储 / 关于）
  icons.tsx               # 内联 SVG 图标
  lib/engine.ts           # 引擎 HTTP 客户端、错误码翻译
  lib/i18n.ts             # 中/英词表（扁平 key + {占位符}），缺 key 会显示 key 本身
  lib/settings.ts         # 设置类型与读写（经 Rust 持久化）
  styles.css              # 全部样式（macOS 语义令牌，深色画布见 --canvas）

src-tauri/
  src/main.rs             # 窗口、原生菜单、引擎进程生命周期、系统命令
  src/settings.rs         # settings.json 的读写与默认值
  tauri.conf.json         # 窗口 1200×800（最小 900×620，可缩放）、模型资源
  capabilities/default.json
```

## 前端 ↔ 后端

前端只通过两种通道访问 Rust 侧：

1. **HTTP**（`lib/engine.ts`）——所有业务操作：会话、任务、历史、预览图。
2. **`invoke`**（Tauri 命令）——系统能力：

| 命令 | 用途 |
|---|---|
| `engine_info` / `start_engine` | 读/启动引擎（Node），返回端口与令牌 |
| `pick_reference` / `pick_folder` | 原生选图 / 选目录面板（参考图接受任何 `public.image`，不再限定格式） |
| `load_settings` / `save_settings` | `settings.json` 读写 |
| `data_dir` | 数据目录，用于「在 Finder 中显示」 |
| `cleanup_exports` | 清理 `lightroom/export-*`（保留仍被会话引用的） |
| `delete_exported_file` | 写回成功后删掉该会话的中间 TIFF |
| `reveal_in_finder` / `activate_lightroom` | Finder 定位、把 Lightroom 提到前台 |

## 设置

存 `~/Library/Application Support/ColorFM-LR/settings.json`，改动即时生效：

- `language`：`auto` / `zh-Hans` / `en`
- `outputMode` + `outputFolder`：与原片同目录（默认）或指定文件夹
- `deleteExportAfterWriteBack`：默认 `true`，写回成功即删 16-bit 导出
- `window`：上次窗口尺寸，启动时恢复（全屏/最大化不记录）

入口是原生菜单 `ColorFM > Settings…`（⌘,）和顶栏的滑块图标。

## 开发与构建

在仓库根目录：

```bash
npm install
npm run model:link       # models/colorfm_l.onnx → 权重文件（软链，不复制 118 MB）
npm run desktop:dev      # 先 tsc -b 建引擎，再起 Vite + 窗口（热更新）
npm run desktop:build    # 同上，产物是 .app
```

`beforeDevCommand` / `beforeBuildCommand` 已经包含 `npm --prefix ../.. run build`，
所以引擎永远是当前源码，不需要再手工同步。

`beforeDevCommand` 还会先跑 `scripts/check-port.mjs 1420`：Vite 的端口是固定 1420
（`strictPort`），上一次开发窗口被强杀时可能留下一个孤儿进程占着它，那时 `tauri dev`
只会打印 `Port 1420 is already in use` 而不说清是谁占的。这个前置检查会打出 PID 和
可直接粘贴的 `kill` 命令，然后退出。

窗口按这个顺序找引擎：`$COLORFM_ENGINE`（可执行文件）→ `.app/Contents/MacOS/colorfm-engine`
→ `$COLORFM_ENGINE_ENTRY` → `.app/Contents/Resources/engine/main.js` → 本仓库的
`packages/engine/dist/main.js`。找到 `.js` 时会先找 Node（`$COLORFM_NODE`、`PATH`、
`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`~/.volta/bin`、`~/.local/bin`）——
从 Finder 启动的进程几乎没有 `PATH`，这一步是必需的。

**打包说明**：`.app` 目前只带窗口和模型，引擎以 Node 脚本形式运行，因此目标机器需要装 Node。
要做成完全自包含的产物，需要把 `packages/engine/dist`、`packages/core/dist` 与生产依赖
一起放进 `Contents/Resources/engine/`，并附带一个 Node 运行时（或打成 SEA）——这是遗留的
打包工作，不影响开发态的一键启动。

## 交互约定

- 图片默认「适应窗口」；双击在 fit 与 1:1 之间切换（角标显示百分比）；双指或 ⌘+滚轮围绕光标缩放；放大后可拖拽。
- 换照片（新会话/换历史）时缩放复位。
- 写回完成后强度与「更换参考图」会锁住——此时源 TIFF 已是纯临时文件。
- `error` 状态下「写回」仍可点，用于失败重试。

## 相关模块

- [`../../packages/engine`](../../packages/engine/README-zh.md)：被托管的 HTTP 服务。
- [`../../hosts/lightroom`](../../hosts/lightroom/README-zh.md)：会话的发起方。
- [`../../packages/engine/test/host-contract.test.ts`](../../packages/engine/test/host-contract.test.ts)：
  用插件自己的 JSON 扫描规则验证接口字段。

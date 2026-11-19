# ColorFM-Lightroom

简体中文 | [English](README.md)

面向 Lightroom 的调色迁移引擎：把「一张内容图 + 一张参考图」变成 1248 个调色参数，
把参数烘成 3D LUT，再把 LUT 应用到 16-bit TIFF 上，且不改动其元数据。

四部分，一条进程边界：

| 部分 | 职责 |
|---|---|
| [`packages/core`](packages/core/README-zh.md) | 数学层：参数、逐像素 MLP、LUT 烘焙、TIFF/PNG/JPEG 读写、ONNX 推断 |
| [`packages/engine`](packages/engine/README-zh.md) | 本机 HTTP 服务，另外两部分都只跟它说话 |
| [`apps/desktop`](apps/desktop/README-zh.md) | macOS 窗口（Tauri 2 + React 19）：托管引擎、显示预览、写回结果 |
| [`hosts/lightroom`](hosts/lightroom/README-zh.md) | Lightroom Classic 插件（Lua）：导出 TIFF、发起会话、导入结果 |

## 库与服务的分界

`packages/core` 对外只提供色彩数学和**批量**原语：烘一张表、把表应用到一块像素、
变换某一段行、解码一张图。每一个都在自己的活干完后返回；它们都不起线程、不数核、
不切文件、不缓存表、不重试。

`packages/engine` 负责全部调度：一次渲染用几个 worker、切点落在哪、复用哪张烘好的表、
某个 band 失败如何终止兄弟。分带计划在主线程算好再下发给 worker，所以 worker 只执行
被指派的那几行。

`packages/core/src/index.ts` 就是契约，
`packages/core/test/public-surface.test.ts` 把它钉住：新增一个导出就必须改那份清单。

## 各部分怎么耦合

窗口和插件对引擎只说 HTTP，两边都不实现任何色彩运算。契约是响应信封
（`{ok, schema_version, data, warnings, error}`）加上 `/v1` 下的路由。换一个引擎实现，
只要这些路由答对，前端不用改。

有三样东西在 HTTP **之外**，替换实现时同样要对上：

| 接缝 | 约定 |
|---|---|
| 发现文件 | `<home>/engine.json`，含 `http_port`、`token`、`pid`——两个客户端都从磁盘读，而不是被告知端口 |
| 文件路径 | 引擎返回绝对路径；窗口通过 asset protocol 加载，作用域是 `$DOCUMENT/ColorFM-LR/{tasks,cache,history}/**` |
| 进程生命周期 | 插件负责拉起 `.app`（`open -a ColorFM`）；`.app` 启动引擎，并在会话未完成时让它继续活着 |

还有一条只针对窗口：清理临时导出时它直接读 `<home>/lightroom/sessions/*.json`，
所以会话记录始终是普通 JSON，含 `content_path` / `result_path` / `render_done`。

回包必须保持紧凑 JSON：插件用的是手写扫描器，找字面量 `"id":"…"`。
`host-contract.test.ts` 就是把回包再喂给那个扫描器，所以格式化输出会让测试失败，
而不是悄悄弄坏导入。

## 环境要求

- Node.js 20 或更新（代码用到 `node:worker_threads`、`fetch` 和 ESM）。
- `sharp`（libvips）用于 PNG/JPEG/WebP/AVIF/HEIF；它自带预编译二进制，TIFF 不需要它。
- `.onnx` 模型（123 MB）用于推断；`npm run model:link` 把 `models/colorfm_l.onnx`
  指向权重而不复制它。没有模型时服务照常启动并报告 `model_loaded: false`，
  所有需要参数的操作会以 `E_MODEL_MISSING` 失败。
- Rust 工具链，仅桌面壳（`apps/desktop/src-tauri`）需要。

## 快速开始

```bash
npm install
npm run build                     # tsc 项目引用 → packages/*/dist

# 系统分配端口的本机服务，发现文件写在 ~/Library/Application Support/ColorFM-LR
node packages/engine/dist/main.js serve --port 0

# 或者显式给模型和一个一次性 home，测试里就是这么做的
COLORFM_HOME=/tmp/cf-home COLORFM_LIBRARY=/tmp/cf-lib \
  node packages/engine/dist/main.js serve --port 0 --model /path/to/colorfm_l.onnx
```

引擎把 `engine.json`（`{schema_version, pid, http_port, token}`）写进它的 home 目录；
每个请求都要带 `Authorization: Bearer <token>`。

## 命令

| 命令 | 作用 |
|---|---|
| `npm run build` | 编译两个包及其声明文件 |
| `npm run clean` | 删除编译产物和增量缓存 |
| `npm test` | 类型检查源码与测试，然后跑完整套件 |
| `npm run typecheck` | `tsc -b`，再对测试文件做一次 no-emit 检查 |
| `npm run dev:serve` | 用 `tsx` 直接从源码跑服务 |
| `npm run colorfm -- --content a.tiff --style b.png --out c.tiff` | 一次性的调色 CLI |
| `npm run bake-lut -- params.txt out.cube 33` | 从 1248 个 float 烘一个 `.cube` |
| `npm run desktop:dev` | 先构建引擎，再起 Vite + 窗口 |
| `npm run desktop:build` | 同上，并打包成 `.app` |
| `npm run model:link` | 把权重软链到 `models/` |
| `npm run bench:core` | 烘焙 / 查表吞吐，TypeScript 侧 |
| `npm run bench:engine` | 整场会话的端到端耗时 |
| `npm run desktop:web` | 只跑前端，在浏览器里（没有窗口 API） |

`packages/*/dist` 和 `*.tsbuildinfo` 都是生成物、都被忽略。要删就一起删
（`npm run clean`）：`tsc -b` 信任缓存文件，只删 `dist/` 会让 `npm run build` 无事可做。

### 环境变量

| 变量 | 含义 |
|---|---|
| `COLORFM_HOME` | 发现文件、设置与会话（默认 `~/Library/Application Support/ColorFM-LR`） |
| `COLORFM_LIBRARY` | 任务缓存、预览与历史（默认 `~/Documents/ColorFM-LR`） |
| `COLORFM_MODEL` | `.onnx` 图文件路径 |
| `COLORFM_WORKERS` | 一次渲染可用的 worker 数（默认 `核数 - 1`，上限 8） |

## 精度

管线按单精度定义，所以每一步都显式做 `f32()` 取整，而不是让 JavaScript 的 double 漂移。
`expf` 也在其中：Swish 激活在每个隐单元上都要除以它，这里的实现用一张 `2^(k/128)` 表和
二次残差复现平台的 `expf`。

由此得到、并由测试套件保证的两件事：

- 同一组参数、同一份输入，在任何一次运行、任何一台机器上都产出同一个 LUT、同一段
  `.cube` 文本、同一张缩略图和同一个 TIFF；
- 16-bit TIFF 的像素逐位往返；JPEG 只由平台解码器解一次，之后预览和渲染看到的是同一次
  解码结果，不会两边漂移。

实测吞吐见 [docs/performance.md](docs/performance.md)（32 MP 单帧端到端 1.5 秒，
渲染分带后 0.73 秒）。

## 目录

```
packages/core/src
  samples.ts        16-bit code <-> 单位值换算与量化
  params.ts         1248 个 float 的核布局
  mlp.ts            两个残差 MLP，按点与按批
  lut/              表类型与混合、烘焙、查表、.cube 读写
  io/               TIFF 变换、缩略图、预览；codec/ 放各文件格式
  infer/            模型输入类型与 ONNX 后端
  color.ts          色彩管理边界（尚未支持 ICC）
  pipeline.ts       参数 → 像素，两条路径
  bin/              两个命令行工具
packages/engine/src
  main.ts           命令行、单实例锁、发现文件、空闲退出
  api.ts            HTTP 接口与响应信封
  jobs.ts           任务表；把像素活交给 worker.ts
  worker.ts         不能阻塞 HTTP 线程的那部分运算
  session.ts        Lightroom 会话状态机与持久化
  store.ts          参数缓存（params.bin、缩略图、预览）
  history.ts        胶片条快照
  state.ts          共享的应用状态
  events.ts         事件流边界（目前是轮询）
  project.ts        持久项目边界（目前就是参数缓存）
apps/desktop/src
  App.tsx           轮询会话、接管会话、持有设置上下文
  Workspace.tsx     三个面板、缩放平移、强度滑杆、胶片条
  lib/engine.ts     引擎的类型化 HTTP 客户端
apps/desktop/src-tauri
  src/main.rs       窗口、原生菜单、引擎进程生命周期、macOS 辅助
hosts/lightroom/colorfm.lrplugin
  Session.lua       完整流程：导出、建会话、等待、导入
  EngineClient.lua  发现文件、HTTP、拉起 app
docs                测试说明
```

## 这里没做的部分

- ICC 色彩管理（`packages/core/src/color`）：profile 逐字节透传，但不解释。
- WebSocket 进度事件（`packages/engine/src/events.ts`）：任务是轮询的。
- 持久项目模型（`packages/engine/src/project.ts`）：目前用参数缓存代替。

## 许可

本项目采用 [CC BY-NC-SA 4.0（知识共享 署名—非商业性使用—相同方式共享 4.0 国际）](LICENSE)。
你可以为非商业目的复制、分发和改编本项目，条件是署名、说明是否做了修改，并以相同许可
发布你的改编作品；本许可不授予商业使用权。

© 2026 heyh31

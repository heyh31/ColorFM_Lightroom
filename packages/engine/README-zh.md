# @colorfm/engine

简体中文 | [English](README.md)

整个系统的本机 HTTP 服务：ONNX 会话、任务队列、参数缓存、Lightroom 会话和历史都由它持有。
桌面窗口和 Lightroom 插件只跟这个进程说话，彼此之间从不通信。

## 启动

```bash
node packages/engine/dist/main.js serve \
    [--port N] [--model PATH] [--home DIR] [--idle-exit SECS]
```

| 参数 | 含义 |
|---|---|
| `--port 0` | 默认；由系统分配端口，真实端口写进 `engine.json` |
| `--model` | `.onnx` 路径。默认依次看 `COLORFM_MODEL`、`../Resources/models`、`models/` |
| `--home` | 发现文件与设置目录，默认 `~/Library/Application Support/ColorFM-LR`（`COLORFM_HOME` 可覆盖） |
| `--idle-exit SECS` | 空闲这么多秒后退出；`0` 表示不退出。默认 300 |

库目录来自 `COLORFM_LIBRARY`，默认 `~/Documents/ColorFM-LR`。

启动后它写 `engine.json`：`{"schema_version":1,"pid":…,"http_port":…,"token":…}`。
**每一个**请求（包括 `/v1/health`）都要带 `Authorization: Bearer <token>`；
由 `<img>` 标签加载的端点也接受 `?token=`，因为那个元素设不了请求头。

## 路由

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/v1/health` | 存活、令牌校验、能力清单 |
| GET | `/v1/diagnostics` | 版本、模型状态、任务计数、活跃会话、空闲秒数 |
| POST | `/v1/jobs` | 建任务（`kind: preview \| render \| bake-lut`） |
| GET | `/v1/jobs/{id}` | 状态、进度、结果、错误 |
| POST | `/v1/jobs/{id}/cancel` | 置取消标志，按 strip 轮询 |
| GET | `/v1/lightroom/history` | 胶片条条目，指向已持久化的 1280 px 预览 |
| GET/POST | `/v1/lightroom/sessions` | 列表（`?active=1`）/ 新建 |
| GET | `/v1/lightroom/sessions/{id}` | 单个会话 |
| POST | `…/claim` | 某个窗口接管该会话 |
| POST | `…/preview` | 换参考图或强度，重新预览 |
| POST | `…/confirm` | 写回：把 16-bit 结果渲染到目标路径 |
| POST | `…/ready-to-import` | 插件可以去动目录了 |
| POST | `…/imported` | 导入完成；给历史快照 |
| POST | `…/cancel` | 取消并停掉任务 |

每个响应都是同一个信封：

```json
{ "ok": true, "schema_version": 1, "data": { }, "warnings": [], "error": { "code": "E_IO", "message": "" } }
```

`data`、`warnings`、`error` 为空时省略。客户端按 `error.code` 分支，绝不看 message。

## 存储布局

```
~/Library/Application Support/ColorFM-LR/     # --home
  engine.json          # 端口 + 令牌，便于工具找到引擎
  engine.lock          # 单实例锁
  tasks.json           # 参数缓存索引
  lightroom/sessions/  # 一个会话一个 JSON，重启后恢复

~/Documents/ColorFM-LR/                       # COLORFM_LIBRARY
  tasks/<id>/          # params.bin（1248 个 f32）、content-256.png、*-1280.jpg、task.json
  cache/previews/<id>/ # 没有参数缓存任务的预览
  history/<id>/        # 导入时留下的缩略图快照
```

## 会话状态机

```
created → waiting_for_ui → waiting_for_reference → previewing → ready
        → rendering → ready_to_import → imported
```

`canceled` 是终态，任何活跃状态都能到。`error` 可以回到 `previewing` 或 `rendering`
（写回失败可以原地重试）。非法转移返回 `E_STATE_CONFLICT`，message 里带 `from → to`。

进程停止时正在跑任务的会话，会在加载时修复：`previewing` 退回到 `waiting_for_reference`，
`rendering` 退回到 `ready`，两者都带一条说明重启的 notice。

## 错误码

`E_BAD_REQUEST` `E_UNAUTHORIZED` `E_NOT_FOUND` `E_STATE_CONFLICT` `E_FILE_MOVED`
`E_IO` `E_UNSUPPORTED` `E_CANCELED` `E_JOB_FAILED` `E_MODEL_MISSING` `E_ONNX`
`E_INTERNAL` `E_UNAVAILABLE` `E_BACKEND_UNAVAILABLE`

## 哪些事属于这里，而不是库

库给出批量，引擎决定一次跑几个。具体是：

| 决策 | 位置 | 为什么 |
|---|---|---|
| 一次渲染能用几个 worker | `bands.ts: renderWorkerCount()` | 要读环境变量和核数 |
| 切点落在哪 | `bands.ts: planBands()` | 属于调度；库只报告行数 |
| 这个文件能不能切 | `bands.ts: planRenderBands()` | 问库要 `editableLayout`，拿不到就退回单线程 |
| 复用哪张表 | `jobs.ts: tableCache` | 按任务、网格、强度做键的缓存 |
| band 失败如何终止兄弟 | `worker.ts: runBands()` | 是生命周期问题，不是算术问题 |

计划在**主线程**算好，随任务下发，worker 只执行被指派的行——它从不打开文件去判断该做什么。

## 并发

HTTP 接口是单线程的，所以任何以秒计的工作都不能留在上面。每个任务把像素活交给一个
worker 线程，渲染再把它摊到各条带上：

```
HTTP 线程                   任务 worker           band worker
  缩略图、模型推理        →      —                    —
  参数缓存 I/O           →      —                    —
                         →   烘 LUT                  —
                         →   复制源文件              —
                         →   每带一个 worker    →   各自插值自己的行
  写预览、结算           ←   进度 + 结果         ←
```

带是**行区间**，不是 strip：Lightroom 把整帧导出成一个 strip，按 strip 切会让这种情况
退化成单线程。每条带只读自己的行（在未压缩 strip 里是一段连续字节），
也不读别人写的行，所以切法是每带 `floor(rows / workers)` 行，余数给最后一带。
像素结果与单线程完全一致，`packages/engine/test/parallel.test.ts` 逐字节比对。

`COLORFM_WORKERS` 限制扇出（默认 `核数 - 1`，最多 8）。需要重新编码的源改用顺序写入器流式处理，
所以只留在任务 worker 上。

取消是一个 `SharedArrayBuffer` 标志，worker 每处理一个 strip 查一次；这也意味着取消后
目标文件可能是写了一半的，由调用方删除。某个带失败会停掉它的兄弟。

## 命令

```bash
npm test                              # 完整套件
npm run dev:serve                     # 直接从源码跑（需要先 build 过）
node packages/engine/dist/main.js serve --port 0 --idle-exit 0
```

## 相关

- [`../core`](../core/README-zh.md)：负责像素数学的库。

# ColorFM Lightroom 插件

简体中文 | [English](README.md)

ColorFM 管线在 Lightroom 这一半。它把选中的照片导出成 16-bit sRGB TIFF，在
`colorfm-engine` 里创建一个会话，把后续操作交给 Tauri 窗口，等待，然后把渲染结果作为
一张新目录照片导入，并堆叠在原片下方。原片永远不会被修改。

插件**不做任何色彩运算、不碰任何像素**——这条边界是刻意的。

## 菜单

两套菜单、同样的命令——Lightroom 按插件元数据的键决定放到哪一处，很容易找错地方：

| 位置 | 出现的内容 |
|---|---|
| **文件 > 增效工具额外信息**<br>(`LrExportMenuItems`) | 2 条正式命令 |
| **图库 > 增效工具额外功能**<br>(`LrLibraryMenuItems`) | 2 条正式命令 + 3 条 SDK 测试 |

```text
文件 > 增效工具额外信息 >
  ColorFM-LR：处理当前照片…
  ColorFM-LR：检查引擎状态
```

```text
图库 > 增效工具额外功能 >
  …（同上两条）…
  ColorFM 测试：导出当前照片 TIFF…
  ColorFM 测试：导入 TIFF 为新照片…
  ColorFM 测试：导出并堆叠导入…
```

`Info.lua` 只在 Lightroom **加载插件时读一次**。改它、或增删 `.lua` 文件，都必须退出并
重开 Lightroom，菜单才会变。

### 菜单点了报错

预期内的失败（没选照片、引擎没起、文件被移走）都在 `Session.lua` 里用
`LrErrors.throwUserError` 抛出，所以 Lightroom 显示的是我们自己的文案。如果看到的是
光秃秃的「出现了内部错误 / Could not load script X.lua」，说明脚本编译不过或某个模块没找到，
实际常见于：

- `Info.lua` 里写的文件不存在（名字区分大小写）；
- Lightroom 还跑着旧版本的插件——重启它；
- 插件是从另一个目录添加的，改的却是这一份（在 `文件 > 增效工具管理器` 里核对路径）。

**永远不要用 `pcall` 包 SDK 调用。** Lightroom 的插件运行时基于协程：`LrHttp`、
`LrDialogs`、`LrTasks.sleep` 和导出循环都会 yield，而 Lua 5.1 不能跨 C 调用 yield。
症状是一个写着 `Yielding is not allowed within a C or metamethod call` 的对话框，
没有行号。失败要靠检查返回值（`nil` + message）处理，不要用 `pcall`。

## 安装

1. 打开 Lightroom Classic。
2. 打开 `文件 > 增效工具管理器`。
3. 点 `添加`。
4. 选中这个 `colorfm.lrplugin` 目录。
5. 确认「ColorFM」处于启用状态。

本地开发时，也可以把插件复制到：

```text
~/Library/Application Support/Adobe/Lightroom/Modules/ColorFM.lrplugin
```

正式安装会在 app 首次启动时从应用包内复制出来。

## 完整流程

```text
1. 选中一张照片，执行「ColorFM：处理当前照片…」
2. 插件导出 16-bit sRGB TIFF 到 ~/Documents/ColorFM-LR/lightroom/export-<时间戳>/
3. 插件查找引擎；没有就启动桌面应用（应用启动后写入 engine.json）
4. 插件 POST /v1/lightroom/sessions
5. 桌面应用轮询到该会话并接管：选择参考图 → 预览 → 调强度 → 写回
6. 用户点「回到 Lightroom 并导入」→ 会话进入 ready_to_import
7. 插件导入结果并堆叠在原片下方，写入插件元数据，会话进入 imported
```

Lightroom 在等待期间显示可取消的进度面板；取消会同时取消引擎侧的会话。

### 引擎发现

插件读取引擎写下的发现文件：

```text
~/Library/Application Support/ColorFM-LR/engine.json
```

里面有 `pid`、`http_port` 和 bearer `token`（0600）。每个请求都带
`Authorization: Bearer <token>`。令牌失效时会重读一次该文件，所以引擎重启不会把插件卡死。

### 拉起哪个 app

解析顺序：

1. Lightroom 插件偏好里的 `colorfmAppPath`（旧版本的"设置桌面应用路径"菜单写入的，仍会被读取）
2. 源码工作副本：插件从自身位置逐级向上找
   `apps/desktop/src-tauri/target/release/bundle/macos/ColorFM-LR.app`，再找
   `apps/desktop/src-tauri/target/release/colorfm-desktop`
3. `open -a ColorFM-LR`（即 `/Applications` 里的 app）

第 2 条让工作副本不需要任何配置就能用——`npm run desktop:build` 之后，插件自己就能找到
那个 bundle。如果引擎已经在跑（应用开着，或者你自己起的），插件不会去启动任何东西。

Lightroom 的 Lua 沙盒里**没有** `os.getenv`，所以 `COLORFM_APP` 只在提供它的宿主上生效；
路径在使前会先探测存在性。

## 模块

| 文件 | 职责 |
|---|---|
| `EngineClient.lua` | 发现文件、HTTP、bearer 令牌、标量 JSON 读取 |
| `Exporter.lua` | 导出设置与导出循环 |
| `Session.lua` | 用户看到的流程：导出 → 建会话 → 等待 → 导入 |
| `Menu*.lua` | 菜单入口 |
| `Info.lua` | SDK 元数据与菜单注册 |
| `TestSupport.lua` | 验证阶段留下的 SDK 探针 |

`EngineClient.lua` 刻意不带 JSON 库。它只从本引擎产出的文档里读几个标量字段，写 JSON 时
用显式转义。完整解析器意味着更多要审计的代码，而不是更多能力。

## 在 Lightroom 之外测不到的部分

Lua 侧没有测试框架：Lightroom 就是解释器，而它没法从 shell 里脚本化。因此验证分两层：

- **契约**由 `packages/engine/test/host-contract.test.ts` 对着真实引擎跑，它按同样的顺序
  重放同样的请求，并用本插件自己的 JSON 扫描器解析回包；
- **插件胶水**（导出设置、`addPhoto`、堆叠、进度作用域）由测试菜单和一次真实流程覆盖。

## 本机已验证

Lightroom Classic 15.1，通过 SDK 探针与测试菜单：

- 导出 `6960×4640` 的 RGB TIFF，每样本 16 位；
- 确认 `waitForRender()` 返回的路径上文件存在；
- 把该 TIFF 导入为一张新的目录照片；
- 把导入的 TIFF 堆叠在原片下方；
- 确认源照片没有被替换。

打包后的 `.app` 上：

- 导出 → `POST /v1/lightroom/sessions` → 窗口接管会话 → 预览 → confirm →
  `ready_to_import`，结果写在原片旁边。

没有自动覆盖的部分：`ready_to_import` 之后同一轮里的导入。测试菜单覆盖了同样的
`addPhoto` 调用，但不含其前后的会话交接。

## 说明

- 在 `colorfm-core` 的 ICC 边界还是占位实现之前，导出被强制为 16-bit sRGB，不缩放、
  不做输出锐化。用户自带的 HDR 或 8-bit 输出预设不能漏进引擎。
- **结果写在原片旁边**，命名 `<stem>_ColorFM.tif`（例如 `IMG_5399.CR3` →
  `IMG_5399_ColorFM.tif`），路径在创建会话时就固定下来（`output_path`）。两个原因：
  Lightroom 的堆叠是按文件夹的（SDK 里的 `stackInFolder*`），所以放在别的文件夹里的结果
  无法堆到原片下面；而同目录文件会继承原片的拍摄上下文，不会在按拍摄时间排序时排到最后。
  文件夹不可写时，引擎退回导出目录——照片会被正常导入，只是不堆叠。
- **元数据被保留**：对未压缩的源（也就是本插件导出的），引擎复制文件、只替换像素字节，
  所以 EXIF / IPTC / XMP / ICC 都活着——包括 `DateTimeOriginal`，正是它让结果在按拍摄时间
  排序时挨着原片。压缩或 tiled 的源会退化成重新编码并丢失这些标签；渲染结果里会报告
  `metadata_preserved`，让这件事可见而不是悄悄发生。
- `~/Documents/ColorFM-LR/lightroom/` 是缓存。会话导入之后，导出的基础 TIFF 可以删掉。
- 导入是幂等的：先在目录里查结果路径，所以后续失败后的重试不会产生重复照片。堆叠优先尝试
  放在原片下方，原片已无法解析时退化为普通导入。

### 每张照片的插件元数据（尚未实现）

`photo:setPropertyForPlugin(_PLUGIN, key, value)` 只接受在自定义元数据定义里声明过的键。
没有定义时，Lightroom 会以
`Attempt to access property "x" that's not declared in Info.lua` 中止
（见 `LrPhoto.lua` → `AgCustomMetadataRegistry`）。所以插件目前不写每张照片的属性；
来源信息存在引擎的会话记录里（`lightroom/sessions/<id>.json`）。

以后要补的话：

1. 一个 `CustomMetadataDefinition.lua`，返回
   `{ metadataFieldsForPhotos = { { id = "...", title = "...", dataType = "string",
   searchable = true, browsable = true } }, schemaVersion = 1 }`；
2. 在 `Info.lua` 里写 `LrMetadataProvider = "CustomMetadataDefinition.lua"`；
3. 这之后才能用这些 id 调 `setPropertyForPlugin`。

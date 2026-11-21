# hosts/lightroom

简体中文 | [English](README.md)

Lightroom Classic 侧的 Lua 插件（`colorfm.lrplugin`）。它负责三件事：导出、交接、导入。
**不碰任何像素**——色彩运算全在引擎里，原片永远不会被修改。

## 一次完整流程

```
选中照片
  └─ 导出 16-bit sRGB 未压缩 TIFF
       → ~/Documents/ColorFM-LR/lightroom/export-<YYYYmmdd-HHMMSS>/<原文件名>.tif
  └─ POST /v1/lightroom/sessions（带 contentPath、referencePath、outputPath…）
  └─ 把桌面窗口提到前台 → 窗口 claim 这个会话
  └─ 轮询会话状态，直到 ready_to_import / error / canceled
  └─ 会话 ready_to_import 后：
       把结果 TIFF 加入目录，叠在原片下方（同一文件夹内才能堆叠）
       POST …/imported，引擎记一条历史快照
```

结果路径默认在原片同目录：`<原文件名去扩展名>_ColorFM.tif`。

## 菜单

同一批命令挂在两个位置（Lightroom 按插件元数据键决定，容易找错地方）：

| 位置 | 内容 |
|---|---|
| **文件 > 增效工具额外信息**（`LrExportMenuItems`） | 2 条正式命令 |
| **图库 > 增效工具额外功能**（`LrLibraryMenuItems`） | 2 条正式命令 + 3 条 SDK 自测 |

- `处理当前照片…`（`MenuProcess.lua`）
- `检查引擎状态`（`MenuStatus.lua`）

标题是 ZString（`LOC "$$$/ColorFM/MenuProcess=Process Current Photo…"`），
由 `TranslatedStrings_zh.txt` 提供中文。**Lightroom 界面是英文就显示英文，是中文就显示中文**，
不取决于系统语言——但词典只在插件加载时读取，改完要重启 Lightroom。

对话框和进度条的文案走另一条路：`Strings.lua` 里两张表（ENGLISH / CHINESE），
`Strings.t("key", ...)` 按 `LrLocalization.currentLanguage()` 取，保留 `string.format` 的
`%s` / `%d`。两张表的键和占位符由 `host-contract.test.ts` 校验，漏翻会直接失败。

## 文件

| 文件 | 职责 |
|---|---|
| `Info.lua` | 插件元数据、两套菜单（标题是 ZString）、运行时版本声明 |
| `Strings.lua` | 所有对话框与进度条文案，按 `LrLocalization.currentLanguage()` 选英/中 |
| `Session.lua` | 主流程：导出 → 建会话 → 等待 → 导入结果 |
| `Exporter.lua` | 固定的导出设置（16-bit、sRGB、无压缩、不锐化、不继承预设） |
| `EngineClient.lua` | 引擎发现（读 `engine.json`）、HTTP、`LrPrefs`、启动桌面应用 |
| `Menu*.lua` | 四个菜单命令入口 |
| `TestSupport.lua` | SDK 自测条目用到的辅助代码 |

细节文档见 [`colorfm.lrplugin/README-zh.md`](colorfm.lrplugin/README-zh.md)（含 Lightroom 15.1 上实测的导出键名）。

## 安装（开发）

```bash
ln -s "$PWD/hosts/lightroom/colorfm.lrplugin" \
      ~/Library/Application\ Support/Adobe/Lightroom/Modules/colorfm.lrplugin
```

或在 Lightroom 里 **文件 > 增效工具管理器 > 添加**，选中 `colorfm.lrplugin` 目录。
改完 Lua 需要重启 Lightroom（模块在启动时加载）。

## 约束

- 导出设置写死、不继承用户预设：一个残留的 HDR 或 8-bit 预设不能悄悄进入引擎。
- 不使用 `setPropertyForPlugin`（需要先在 `Info.lua` 声明元数据键，否则导入会中断）；
  溯源信息存在引擎的会话记录里。
- 导入是幂等的：`catalog:findPhotoByPath` 命中就复用，重复点击不会产生第二张。
- 引擎缺失时给出明确提示，而不是静默失败。

## 相关模块

- [`../../packages/engine`](../../packages/engine/README-zh.md)：被调用的 HTTP 服务。
- [`../../apps/desktop`](../../apps/desktop/README-zh.md)：被拉起、负责交互与写回的窗口。
- [`../../packages/engine/test/host-contract.test.ts`](../../packages/engine/test/host-contract.test.ts)：
  用本插件的 JSON 扫描规则检查引擎回包，不用打开 Lightroom 也能验证这条链路。

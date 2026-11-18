# @colorfm/core

简体中文 | [English](README.md)

数学层：把「一张内容图 + 一张参考图」变成 1248 个调色参数，再把这些参数高效地应用到
16-bit TIFF 上。

它**不做任何 I/O 决策**——不读环境、不打日志、不假设文件在哪。调用方传入缓冲、路径和
writer，拿回值。全部同步、可取消，所以引擎能把它放进任务 worker 里跑。

## 目录

| 路径 | 职责 |
|---|---|
| `src/float32.ts` | f32 取整工具、逐位精确的 `expf`、Swish |
| `src/params.ts` | 解析/序列化 `PARAMS_VALUES = 1248` 个 f32（content k1..k4 + style k1..k4） |
| `src/mlp.ts` | 逐像素 MLP 核：用 TypeScript 重写的模型 |
| `src/lut/` | 3D LUT：`table.ts`（类型与混合）、`bake.ts`、`apply.ts`、`cube.ts` |
| `src/io/` | 流式 TIFF 变换、缩略图、预览；`codec/` 放各文件格式 |
| `src/infer/` | 256×256 模型输入（`types.ts`）与 ONNX Runtime 后端（`onnx.ts`） |
| `src/color.ts` | 色彩管理占位（尚未支持 ICC） |
| `src/pipeline.ts` | `applyLut*` / `applyDirect*`——把其余部分串起来的入口 |
| `src/index.ts` | 包的对外面：只做转发导出 |
| `src/bin/colorfm.ts` | CLI：两张图进，一张调好的 TIFF 出 |
| `src/bin/bake-lut.ts` | 只烘一个 `.cube` |

## 约束

- 输入必须是 **16-bit RGB TIFF**。压缩、tiled 或 planar 的源无法原地编辑，会退化成
  重新编码，此时 `ImageInfo.metadataPreserved = false`。
- 内存与图像尺寸无关：按 strip 流式处理，任意时刻最多驻留一个 strip 加一个输入块。
- 写盘优先「复制源文件，然后只替换像素区间」，这样 EXIF / IPTC / XMP / ICC / 缩略图
  都保持原样（Lightroom 按 `DateTimeOriginal` 排序）。如果操作系统拒绝这次复制，
  渲染会改成重新编码，而不是直接失败。
- `strength` 在烘焙时就混进 LUT（朝恒等表方向），所以用户在屏幕上判断的数学，
  就是最终写回的数学。
- 像素数据上的每一步运算都取整到 f32。单精度约定是跨运行、跨机器可复现的前提。

## 用法

```ts
import { paramsFromSlice, bake, applyLut, thumbnailAny, INPUT_SIZE } from "@colorfm/core";

const params = paramsFromSlice(values);          // 推断结果或 params.bin 里的 1248 个 float
const table = bake(params, 33);                   // 33^3 LUT，满强度
applyLut("photo.tiff", "graded.tiff", table);     // 保留元数据的写盘
const thumb = await thumbnailAny("reference.jpg", INPUT_SIZE);  // 解码是异步的
```

## 吞吐

32.3 MP 的一帧（`6960 x 4640`）按行分带铺到多核后约 **1.0 秒**渲染完，单 worker 是 2.5 秒。
33³ 表烘焙约 120 ms，单核查表约 31 Mpx/s，所以一次交互式预览刷新大约 0.2 秒的像素工作量。
逐阶段拆解和热循环怎么写见 [`docs/performance.md`](../../docs/performance.md)。

## 这个包是什么，不是什么

`src/index.ts` 就是契约。它导出色彩数学和**批量**原语：

| 批量 | 形态 |
|---|---|
| `bake(params, grid, strength?)` | LUT 的每个网格节点，Amount 已折进去 |
| `applyInPlace(table, pixels)` | 一块像素 |
| `runRows(src, dst, blockRows, rows, cancel, fn)` | 文件里的一段行 |
| `applyLutToRows(src, dst, rows, table, cancel)` | 同上，表已经烘好 |
| `transform` / `transformWithCancel` | 整个文件，顺序处理 |
| `preview` / `thumbnailAny` / `encodeJpeg` | 一张图、一个尺寸 |

每个调用都在自己的活干完后返回。特别地，这里**没有任何线程**：没有 worker 池、没有
`threads` 参数、不数核。一次跑几个批量、切点在哪、缓存哪个结果、某个失败如何取消兄弟，
全部在 `packages/engine` 里。

其余部分保持内部——`float32`、`mlp`、`params` 的管线、各编解码器和 TIFF 读写器。
测试直接按路径 import 它们；如果一个名字必须经过 `index.ts` 才能被测试用到，
那它就不属于契约。

## 编解码支持

| 格式 | 读 | 写 | 说明 |
|---|---|---|---|
| TIFF | strip：none、LZW、Deflate、PackBits；拒绝 tiled | 未压缩 RGB16 strip | 支持 horizontal predictor；自研读取器，因为调色输出只是替换了像素的字节副本 |
| PNG | 8/16 位，灰度/RGB/调色板/alpha，支持隔行 | 16-bit RGB（自研写入器） | 16→8 取整为 `(c + 128) / 257`；sharp 无法接收 16 位 raw，所以 256×256 模型输入由这里写 |
| JPEG | baseline、progressive、CMYK | baseline、4:4:4 | 平台解码器（libjpeg-turbo） |
| WebP、AVIF、HEIF | 经 libvips | — | 只作参考图；调色输出仍是 TIFF |

PNG/JPEG/WebP/AVIF/HEIF 走 [sharp](https://sharp.pixelplumbing.com)（libvips），TIFF 不走。
没有任何地方声明格式：解码器嗅探字节，所以从不看扩展名，改错名的文件照样能解。
这个库是懒加载的，只走 TIFF strip 的 band worker 永远不会加载 libvips。

## 命令

```bash
npm test                                     # 完整套件

# 先预测参数，再渲染
npm run colorfm -- --content photo.tiff --style reference.tiff --out graded.tiff

# 复用参数：默认走 LUT，--direct 则逐像素求值 MLP
npm run colorfm -- --content photo.tiff --params params.txt --out graded.tiff [--direct]

npm run bake-lut -- params.txt out.cube 33 [--report 200]
```

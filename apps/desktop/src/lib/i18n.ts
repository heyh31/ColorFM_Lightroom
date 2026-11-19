/**
 * Two languages, one flat dictionary.
 *
 * Keys are dotted and stable (`state.ready`, `action.writeBack`); a missing key
 * renders as the key itself so it is obvious in the UI instead of silently
 * falling back to Chinese. Values may contain `{placeholders}`.
 */
import { createContext, useContext } from "react";

export type Language = "zh-Hans" | "en";

export type Translate = (key: string, values?: Record<string, string | number>) => string;

const zh: Record<string, string> = {
  // --- shell -------------------------------------------------------------
  "engine.connected": "引擎 {port}",
  "engine.offline": "引擎未启动",
  "engine.refresh": "刷新状态",
  "engine.failed.title": "无法启动引擎",
  "engine.retry": "重试",
  "engine.working": "正在连接引擎…",

  // --- workspace ---------------------------------------------------------
  "eyebrow.session": "Lightroom 会话",
  "eyebrow.history": "历史记录",
  "eyebrow.workspace": "工作区",
  "title.empty": "还没有任务",
  "title.emptyHint": "在 Lightroom 里执行「ColorFM-LR：处理当前照片…」，或从下方选择一条历史记录",
  "action.cancel": "取消",
  "action.cancelSession": "取消这个会话",
  "action.writeBack": "写回",
  "action.writing": "正在写回…",
  "action.reveal": "显示",
  "action.import": "回到 Lightroom 并导入",
  "action.done": "完成",
  "action.close": "关闭",
  "action.back": "返回",
  "action.viewing": "查看记录",
  "action.replace": "更换",
  "action.refreshHistory": "刷新历史",

  "panel.content": "content",
  "panel.transferred": "transferred",
  "panel.style": "style",
  "panel.hint.waitingPreview": "等待预览",
  "panel.hint.noContent": "还没有内容",
  "panel.hint.noResult": "还没有结果",
  "panel.hint.pickReference": "先选择参考图",
  "panel.hint.dropReference": "点击或拖入参考图",
  "panel.busy.preview": "正在生成预览",
  "panel.busy.render": "正在写回 TIFF",
  "panel.zoomHint": "双击放大 / 还原，双指或 ⌘ + 滚轮缩放",

  "strength.label": "强度",
  "filmstrip.empty": "导入之后，结果会按顺序排在这里，最新的在最右边。",

  "error.refresh": "刷新状态",

  // --- session states ----------------------------------------------------
  "state.created": "已创建",
  "state.waiting_for_ui": "等待窗口",
  "state.waiting_for_reference": "选择参考图",
  "state.previewing": "生成预览",
  "state.ready": "预览就绪",
  "state.rendering": "渲染中",
  "state.ready_to_import": "等待导入",
  "state.imported": "已导入",
  "state.canceled": "已取消",
  "state.error": "出错",

  // --- engine error codes ------------------------------------------------
  "err.E_UNAUTHORIZED": "引擎拒绝了请求，请点击右上角重新连接。",
  "err.E_MODEL_MISSING": "引擎找不到模型文件，无法推理。",
  "err.E_BACKEND_UNAVAILABLE": "推理后端不可用，请检查 ONNX Runtime。",
  "err.E_FILE_MOVED": "文件已被移动或无法读取，请重新导出。",
  "err.E_STATE_CONFLICT": "会话状态已变化，这一步现在不能执行。",
  "err.E_BAD_REQUEST": "请求参数不正确。",
  "err.E_HDR_UNSUPPORTED": "这张照片是 HDR，暂不支持。",
  "err.E_GAMUT_INVALID": "色彩数据超出可用范围。",
  "err.E_DISK_FULL": "磁盘空间不足。",
  "err.E_CANCELED": "已取消。",
  "err.E_JOB_FAILED": "处理失败，请重试。",
  "err.E_NOT_FOUND": "找不到该会话或任务。",
  "err.E_IO": "读写文件失败。",
  "err.E_INTERNAL": "引擎内部错误。",
  "err.E_OFFLINE": "无法连接引擎，请确认它仍在运行。",
  "err.unknown": "处理失败（{code}）",

  // --- settings ----------------------------------------------------------
  "settings.title": "设置",
  "settings.close": "完成",
  "settings.group.general": "通用",
  "settings.language": "语言",
  "settings.language.auto": "跟随系统",
  "settings.group.output": "输出",
  "settings.output.location": "结果保存位置",
  "settings.output.alongside": "与原片同目录",
  "settings.output.alongsideHint": "Lightroom 只能在同一文件夹内堆叠，这也是结果出现在原片下方的前提。",
  "settings.output.folder": "指定文件夹",
  "settings.output.choose": "选择…",
  "settings.output.noFolder": "未选择文件夹",
  "settings.output.folderHint": "跨文件夹时结果仍会导入，但不会堆叠在原片下。",
  "settings.group.storage": "存储",
  "settings.deleteExport": "写回后删除中间 TIFF",
  "settings.deleteExportHint":
    "Lightroom 导出给引擎的 16-bit 临时文件，每张约 190 MB；写回成功后引擎不再读它。结果文件与历史不受影响。",
  "settings.cleanup": "立即清理…",
  "settings.cleanupLabel": "导出缓存",
  "settings.cleanupDone": "已清理 {count} 个文件夹，释放 {size}",
  "settings.cleanupNothing": "没有需要清理的文件",
  "settings.cleanupKept": "已清理 {count} 个，释放 {size}；另有 {skipped} 个正在使用，已保留",
  "settings.cleanupAllInUse": "剩下的导出正在使用中，已跳过；没有可清理的文件",
  "settings.group.about": "关于",
  "settings.version": "版本",
  "settings.dataDir": "数据目录",
  "settings.reveal": "在 Finder 中显示",
  "settings.saved": "已保存",
};

const en: Record<string, string> = {
  "engine.connected": "Engine {port}",
  "engine.offline": "Engine not running",
  "engine.refresh": "Refresh",
  "engine.failed.title": "ColorFM-LR could not start its engine",
  "engine.retry": "Try Again",
  "engine.working": "Connecting to the engine…",

  "eyebrow.session": "Lightroom Session",
  "eyebrow.history": "History",
  "eyebrow.workspace": "Workspace",
  "title.empty": "Nothing to show yet",
  "title.emptyHint": "Run “ColorFM-LR: Process Current Photo…” in Lightroom, or pick a past result below",
  "action.cancel": "Cancel",
  "action.cancelSession": "Cancel this session",
  "action.writeBack": "Render",
  "action.writing": "Rendering…",
  "action.reveal": "Show",
  "action.import": "Back to Lightroom & Import",
  "action.done": "Done",
  "action.close": "Close",
  "action.back": "Back",
  "action.viewing": "Viewing",
  "action.replace": "Replace",
  "action.refreshHistory": "Refresh history",

  "panel.content": "content",
  "panel.transferred": "transferred",
  "panel.style": "style",
  "panel.hint.waitingPreview": "Waiting for a preview",
  "panel.hint.noContent": "No content yet",
  "panel.hint.noResult": "No result yet",
  "panel.hint.pickReference": "Pick a reference first",
  "panel.hint.dropReference": "Click or drop a reference",
  "panel.busy.preview": "Building preview",
  "panel.busy.render": "Rendering TIFF",
  "panel.zoomHint": "Double-click to zoom, pinch or ⌘ + scroll to scale",

  "strength.label": "Strength",
  "filmstrip.empty": "Imported results line up here, newest on the right.",

  "error.refresh": "Refresh",

  "state.created": "Created",
  "state.waiting_for_ui": "Waiting for window",
  "state.waiting_for_reference": "Pick a reference",
  "state.previewing": "Previewing",
  "state.ready": "Preview ready",
  "state.rendering": "Rendering",
  "state.ready_to_import": "Ready to import",
  "state.imported": "Imported",
  "state.canceled": "Canceled",
  "state.error": "Error",

  "err.E_UNAUTHORIZED": "The engine rejected the request. Reconnect from the top right.",
  "err.E_MODEL_MISSING": "The model file is missing, so nothing can be rendered.",
  "err.E_BACKEND_UNAVAILABLE": "The inference backend is unavailable. Check ONNX Runtime.",
  "err.E_FILE_MOVED": "The file moved or cannot be read. Export it again.",
  "err.E_STATE_CONFLICT": "The session changed state; this step is no longer allowed.",
  "err.E_BAD_REQUEST": "The request was malformed.",
  "err.E_HDR_UNSUPPORTED": "This photo is HDR, which is not supported yet.",
  "err.E_GAMUT_INVALID": "The color data fell outside the supported range.",
  "err.E_DISK_FULL": "Not enough disk space.",
  "err.E_CANCELED": "Canceled.",
  "err.E_JOB_FAILED": "Processing failed. Please try again.",
  "err.E_NOT_FOUND": "That session or job no longer exists.",
  "err.E_IO": "Reading or writing a file failed.",
  "err.E_INTERNAL": "Internal engine error.",
  "err.E_OFFLINE": "Cannot reach the engine. Check that it is still running.",
  "err.unknown": "Something went wrong ({code})",

  "settings.title": "Settings",
  "settings.close": "Done",
  "settings.group.general": "General",
  "settings.language": "Language",
  "settings.language.auto": "System",
  "settings.group.output": "Output",
  "settings.output.location": "Save results",
  "settings.output.alongside": "Next to the original",
  "settings.output.alongsideHint":
    "Lightroom can only stack inside one folder — this is what puts the result under the original.",
  "settings.output.folder": "In a folder",
  "settings.output.choose": "Choose…",
  "settings.output.noFolder": "No folder selected",
  "settings.output.folderHint":
    "Results in another folder still import, but they cannot be stacked under the original.",
  "settings.group.storage": "Storage",
  "settings.deleteExport": "Delete the intermediate TIFF after write-back",
  "settings.deleteExportHint":
    "The temporary copy Lightroom exports for the engine, roughly 100–200 MB each. Results and history are untouched.",
  "settings.cleanup": "Clean Up Now…",
  "settings.cleanupLabel": "Exported copies",
  "settings.cleanupDone": "Removed {count} folders, freed {size}",
  "settings.cleanupNothing": "Nothing to clean up",
  "settings.cleanupKept": "Removed {count} folders, freed {size}; kept {skipped} that are still in use",
  "settings.cleanupAllInUse": "The remaining exports are in use — nothing to clean up",
  "settings.group.about": "About",
  "settings.version": "Version",
  "settings.dataDir": "Data folder",
  "settings.reveal": "Show in Finder",
  "settings.saved": "Saved",
};

const dictionaries: Record<Language, Record<string, string>> = { "zh-Hans": zh, en };

export const LANGUAGE_OPTIONS: { id: string; label: string }[] = [
  { id: "auto", label: "" },
  { id: "zh-Hans", label: "简体中文" },
  { id: "en", label: "English" },
];

/** `"auto"` follows the system language, which the webview knows. */
export function resolveLanguage(preference: string): Language {
  if (preference === "en" || preference === "zh-Hans") return preference;
  const system = (typeof navigator !== "undefined" ? navigator.language : "en").toLowerCase();
  return system.startsWith("zh") ? "zh-Hans" : "en";
}

export function createTranslator(language: Language): Translate {
  const table = dictionaries[language];
  return (key, values) => {
    const template = table[key] ?? dictionaries["zh-Hans"][key] ?? key;
    if (!values) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in values ? String(values[name]) : match,
    );
  };
}

export const I18nContext = createContext<{ language: Language; t: Translate }>({
  language: "zh-Hans",
  t: createTranslator("zh-Hans"),
});

export function useI18n() {
  return useContext(I18nContext);
}

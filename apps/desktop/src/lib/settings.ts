/** User preferences; Rust persists them in `<app home>/settings.json`. */
import { invoke } from "@tauri-apps/api/core";

export type OutputMode = "alongside" | "folder";

export type Settings = {
  /** `"auto"` follows the system language. */
  language: string;
  outputMode: OutputMode;
  outputFolder: string;
  /** Deletes the 16-bit export as soon as a write-back succeeds. */
  deleteExportAfterWriteBack: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  language: "auto",
  outputMode: "alongside",
  outputFolder: "",
  deleteExportAfterWriteBack: true,
};

export async function loadSettings(): Promise<Settings> {
  try {
    return await invoke<Settings>("load_settings");
  } catch {
    // A missing/broken settings file must not stop the window from opening.
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(value: Settings): Promise<Settings> {
  return invoke<Settings>("save_settings", { value });
}

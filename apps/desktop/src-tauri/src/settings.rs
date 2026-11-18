//! User preferences, stored next to the engine home as `settings.json`.
//!
//! The webview owns the UI; this module only persists the values. Defaults are
//! deliberately conservative: follow the system language, write results beside
//! the original photo (Lightroom can only stack within one folder). The 16-bit
//! export is scratch — once the result exists nothing reads it again — so it is
//! deleted by default, and the switch exists for people who want to keep it.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// `"auto"`, `"zh-Hans"` or `"en"`. `auto` follows the system language and
    /// is resolved in the webview (it knows `navigator.language`).
    pub language: String,
    /// `"alongside"` writes `<photo folder>/<name>_ColorFM.tif`; `"folder"`
    /// writes into `output_folder` instead.
    pub output_mode: String,
    pub output_folder: String,
    /// Removes the 16-bit TIFF Lightroom exported for the engine as soon as the
    /// result has been written back. Nothing reads that export afterwards, and
    /// it is ~190 MB per photo. The rendered result is never touched.
    ///
    /// The old key (`deleteExportAfterImport`) is accepted so an existing
    /// settings file keeps working; the meaning moved from "after import" to
    /// "after write-back", which is the moment the file becomes garbage.
    #[serde(alias = "deleteExportAfterImport")]
    pub delete_export_after_write_back: bool,
    /// Last window size, written by the shell so the next launch opens at the
    /// size the user left it. `None` until the window is resized once.
    #[serde(default)]
    pub window: Option<WindowState>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    pub width: u32,
    pub height: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            language: "auto".into(),
            output_mode: "alongside".into(),
            output_folder: String::new(),
            delete_export_after_write_back: true,
            window: None,
        }
    }
}

pub fn path(home: &Path) -> PathBuf {
    home.join("settings.json")
}

pub fn load(home: &Path) -> Settings {
    std::fs::read_to_string(path(home))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Records the window size without touching the other preferences.
pub fn remember_window(home: &Path, width: f64, height: f64) {
    if !(400.0..20_000.0).contains(&width) || !(300.0..20_000.0).contains(&height) {
        return;
    }
    let mut settings = load(home);
    settings.window = Some(WindowState {
        width: width.round() as u32,
        height: height.round() as u32,
    });
    let _ = save(home, &settings);
}

pub fn save(home: &Path, settings: &Settings) -> Result<(), String> {
    std::fs::create_dir_all(home).map_err(|err| err.to_string())?;
    let text = serde_json::to_string_pretty(settings).map_err(|err| err.to_string())?;
    let target = path(home);
    let tmp = target.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|err| err.to_string())?;
    std::fs::rename(&tmp, &target).map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("colorfm-settings-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn defaults_when_the_file_is_missing() {
        let home = temp_home("missing");
        let settings = load(&home);
        assert_eq!(settings.language, "auto");
        assert_eq!(settings.output_mode, "alongside");
        assert!(settings.delete_export_after_write_back);
    }

    #[test]
    fn round_trips_and_fills_missing_fields() {
        let home = temp_home("roundtrip");
        let mut settings = load(&home);
        settings.language = "en".into();
        settings.delete_export_after_write_back = false;
        save(&home, &settings).unwrap();

        assert_eq!(load(&home), settings);

        // A file written by an older build keeps its values and gains defaults.
        std::fs::write(path(&home), r#"{"language":"zh-Hans"}"#).unwrap();
        let partial = load(&home);
        assert_eq!(partial.language, "zh-Hans");
        assert_eq!(partial.output_mode, "alongside");
        assert!(partial.delete_export_after_write_back);

        // The previous key name still decides the same behaviour.
        std::fs::write(path(&home), r#"{"deleteExportAfterImport":false}"#).unwrap();
        assert!(!load(&home).delete_export_after_write_back);
    }
}

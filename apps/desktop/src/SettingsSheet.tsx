import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";

import { useI18n } from "./lib/i18n";
import { saveSettings, type OutputMode, type Settings } from "./lib/settings";
import { CloseIcon, FolderIcon } from "./icons";

type Props = {
  settings: Settings;
  onChange: (next: Settings) => void;
  onClose: () => void;
};

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/**
 * macOS-style settings sheet: inset grouped rows, a segmented control for the
 * small choices and a switch for the boolean. Changes save immediately — there
 * is no OK/Cancel, matching System Settings.
 */
export default function SettingsSheet({ settings, onChange, onClose }: Props) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(settings);
  const [version, setVersion] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraft(settings), [settings]);

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
    void invoke<string>("data_dir")
      .then(setDataDir)
      .catch(() => setDataDir(""));
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const update = useCallback(
    async (patch: Partial<Settings>) => {
      const next = { ...draft, ...patch };
      setDraft(next);
      try {
        const saved = await saveSettings(next);
        setDraft(saved);
        onChange(saved);
        setNote(null);
      } catch (err) {
        setNote(String(err));
      }
    },
    [draft, onChange],
  );

  const chooseFolder = useCallback(async () => {
    try {
      const picked = await invoke<string | null>("pick_folder");
      if (picked) await update({ outputFolder: picked });
    } catch (err) {
      setNote(String(err));
    }
  }, [update]);

  const cleanup = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      const report = await invoke<{ removed: number; freed: number; skipped: number }>("cleanup_exports");
      // Anything a session is still reading is reported rather than silently
      // left behind — otherwise "clean up" looks broken when it keeps files.
      const skipped = report.skipped ?? 0;
      setNote(
        report.removed === 0
          ? skipped > 0
            ? t("settings.cleanupAllInUse")
            : t("settings.cleanupNothing")
          : skipped > 0
            ? t("settings.cleanupKept", {
                count: report.removed,
                size: formatSize(report.freed),
                skipped,
              })
            : t("settings.cleanupDone", {
                count: report.removed,
                size: formatSize(report.freed),
              }),
      );
    } catch (err) {
      setNote(String(err));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const modes: { id: OutputMode; label: string }[] = [
    { id: "alongside", label: t("settings.output.alongside") },
    { id: "folder", label: t("settings.output.folder") },
  ];

  const languages = [
    { id: "auto", label: t("settings.language.auto") },
    { id: "zh-Hans", label: "简体中文" },
    { id: "en", label: "English" },
  ];

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.title")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="sheet-head">
          <h2>{t("settings.title")}</h2>
          <button className="icon-button" onClick={onClose} aria-label={t("settings.close")}>
            <CloseIcon />
          </button>
        </header>

        <div className="sheet-body">
          <section className="group">
            <h3>{t("settings.group.general")}</h3>
            <div className="group-card">
              <div className="row">
                <span className="row-label">{t("settings.language")}</span>
                <div className="segmented">
                  {languages.map((option) => (
                    <button
                      key={option.id}
                      className={draft.language === option.id ? "on" : ""}
                      onClick={() => void update({ language: option.id })}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="group">
            <h3>{t("settings.group.output")}</h3>
            <div className="group-card">
              <div className="row">
                <span className="row-label">{t("settings.output.location")}</span>
                <div className="segmented">
                  {modes.map((option) => (
                    <button
                      key={option.id}
                      className={draft.outputMode === option.id ? "on" : ""}
                      onClick={() => void update({ outputMode: option.id })}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              {draft.outputMode === "folder" && (
                <div className="row stacked">
                  <div className="row-line">
                    <span className={`path ${draft.outputFolder ? "" : "muted"}`}>
                      {draft.outputFolder || t("settings.output.noFolder")}
                    </span>
                    <button className="button" onClick={() => void chooseFolder()}>
                      {t("settings.output.choose")}
                    </button>
                  </div>
                </div>
              )}
            </div>
            <p className="group-hint">
              {draft.outputMode === "folder"
                ? t("settings.output.folderHint")
                : t("settings.output.alongsideHint")}
            </p>
          </section>

          <section className="group">
            <h3>{t("settings.group.storage")}</h3>
            <div className="group-card">
              <div className="row">
                <div className="row-text">
                  <span className="row-label">{t("settings.deleteExport")}</span>
                  <span className="row-sub">{t("settings.deleteExportHint")}</span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={draft.deleteExportAfterWriteBack}
                    onChange={(event) => void update({ deleteExportAfterWriteBack: event.target.checked })}
                  />
                  <span className="track" />
                </label>
              </div>
              <div className="row">
                <span className="row-label">{t("settings.cleanupLabel")}</span>
                <button className="button" disabled={busy} onClick={() => void cleanup()}>
                  {t("settings.cleanup")}
                </button>
              </div>
            </div>
            {note && <p className="group-hint">{note}</p>}
          </section>

          <section className="group">
            <h3>{t("settings.group.about")}</h3>
            <div className="group-card">
              <div className="row">
                <span className="row-label">ColorFM-LR</span>
                <span className="row-value">{version ? `${t("settings.version")} ${version}` : ""}</span>
              </div>
              <div className="row">
                <span className="row-label">{t("settings.dataDir")}</span>
                <div className="row-line">
                  <span className="path muted">{dataDir}</span>
                  <button
                    className="button"
                    disabled={!dataDir}
                    onClick={() => void invoke("reveal_in_finder", { path: dataDir })}
                  >
                    <FolderIcon />
                    {t("settings.reveal")}
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

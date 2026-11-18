import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { Engine, describeError, type Session } from "./lib/engine";
import { I18nContext, createTranslator, resolveLanguage } from "./lib/i18n";
import { DEFAULT_SETTINGS, loadSettings, type Settings } from "./lib/settings";
import SettingsSheet from "./SettingsSheet";
import Workspace from "./Workspace";
import { RefreshIcon, SlidersIcon } from "./icons";

/** How often the window asks the engine whether Lightroom handed it a task. */
const POLL_MS = 1200;

function needsClaim(session: Session) {
  return session.state === "created" || session.state === "waiting_for_ui";
}

export default function App() {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const language = resolveLanguage(settings.language);
  const t = useMemo(() => createTranslator(language), [language]);
  const i18n = useMemo(() => ({ language, t }), [language, t]);

  // Read by the poll loop, which must not restart every time a preference moves.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  /** Sessions whose exported TIFF has already been cleaned up. */
  const cleaned = useRef(new Set<string>());

  useEffect(() => {
    void loadSettings().then(setSettings);
  }, []);

  // `ColorFM > Settings…` (⌘,) is a native menu item; it only emits an event.
  useEffect(() => {
    let off: (() => void) | null = null;
    let dropped = false;
    listen("settings:open", () => setSettingsOpen(true))
      .then((fn) => {
        if (dropped) fn();
        else off = fn;
      })
      .catch((err) => console.warn("colorfm: cannot listen for settings", err));
    return () => {
      dropped = true;
      off?.();
    };
  }, []);

  // Same shortcut when the event never arrives (menu bar hidden, app in
  // full screen, or a window that lost its menu).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "," && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const connect = useCallback(async () => {
    setBootError(null);
    try {
      setEngine(await Engine.connect());
    } catch (err) {
      setEngine(null);
      setBootError(String(err));
    }
  }, []);

  // Start the sidecar on launch; the UI should never need a "start" click.
  useEffect(() => {
    void connect();
  }, [connect]);

  // Retry while the engine is missing (the app may have opened before the
  // sidecar was ready, or the engine was restarted underneath us).
  useEffect(() => {
    if (engine) return;
    const timer = window.setTimeout(() => void connect(), 3000);
    return () => window.clearTimeout(timer);
  }, [engine, bootError, connect]);

  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  /**
   * The engine owns the workflow, so the window only mirrors it: pick up a
   * session waiting for a UI, follow the one we own, and step aside when
   * Lightroom starts a new one.
   */
  const poll = useCallback(async () => {
    if (!engine) return;

    const adopt = async (candidate: Session) => {
      const claimed = needsClaim(candidate)
        ? await engine.claimSession(candidate.id)
        : candidate;
      setSession(claimed);
    };

    try {
      const active = await engine.listSessions(true);
      const newest = active.sessions[0];
      const current = sessionRef.current;

      if (!current) {
        if (newest) await adopt(newest);
        setPollError(null);
        return;
      }

      const handoff =
        newest &&
        newest.id !== current.id &&
        (newest.state === "created" || newest.state === "waiting_for_ui");

      if (handoff) {
        await adopt(newest);
        setPollError(null);
        return;
      }

      const fresh = await engine.getSession(current.id).catch(() => null);
      if (fresh) {
        // Terminal states stay on screen until the user closes them, so
        // "imported" and "canceled" are visible rather than just vanishing.
        setSession(fresh);

        // Housekeeping the user opted into: the 16-bit export is scratch space
        // the moment the result exists — nothing reads it again, and the window
        // locks strength and reference after a write-back.
        if (
          fresh.render_done &&
          !fresh.error &&
          settingsRef.current.deleteExportAfterWriteBack &&
          !cleaned.current.has(fresh.id)
        ) {
          cleaned.current.add(fresh.id);
          void invoke("delete_exported_file", { path: fresh.content_path }).catch((err) =>
            console.warn("colorfm: cannot remove the exported TIFF", err),
          );
        }
      } else if (newest) {
        await adopt(newest);
      } else {
        setSession(null);
      }
      setPollError(null);
    } catch (err) {
      setPollError(describeError(err, t));
    }
  }, [engine, t]);

  useEffect(() => {
    if (!engine) return;
    const timer = window.setInterval(() => void poll(), POLL_MS);
    void poll();
    return () => window.clearInterval(timer);
  }, [engine, poll]);

  const refresh = useCallback(() => {
    if (pollError) void connect();
    else void poll();
  }, [connect, poll, pollError]);

  return (
    <I18nContext.Provider value={i18n}>
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <span className="mark" aria-hidden />
            <span className="brand-name">ColorFM</span>
          </div>

          <div className="status">
            <span className={engine ? "dot on" : "dot off"} aria-hidden />
            <span className="status-text">
              {engine ? t("engine.connected", { port: engine.port }) : t("engine.offline")}
            </span>
            <button
              className="icon-button"
              onClick={refresh}
              title={t("engine.refresh")}
              aria-label={t("engine.refresh")}
            >
              <RefreshIcon />
            </button>
            <button
              className="icon-button"
              onClick={() => setSettingsOpen(true)}
              title={t("settings.title")}
              aria-label={t("settings.title")}
            >
              <SlidersIcon />
            </button>
          </div>
        </header>

        <main className="content">
          {bootError && (
            <section className="card notice error-card">
              <h2>{t("engine.failed.title")}</h2>
              <p className="muted">{bootError}</p>
              <div className="actions">
                <button className="button primary" onClick={() => void connect()}>
                  {t("engine.retry")}
                </button>
              </div>
            </section>
          )}

          {engine && (
            <Workspace
              engine={engine}
              session={session}
              settings={settings}
              onRefresh={() => void poll()}
              onCloseSession={() => setSession(null)}
            />
          )}

          {pollError && <p className="inline-error">{pollError}</p>}
        </main>
      </div>

      {settingsOpen && (
        <SettingsSheet
          settings={settings}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </I18nContext.Provider>
  );
}

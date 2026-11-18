import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import {
  Engine,
  describeError,
  type HistoryEntry,
  type Job,
  type Session,
} from "./lib/engine";
import { ArrowRightIcon, CheckIcon, FolderIcon, ImageIcon, RefreshIcon } from "./icons";
import { useI18n } from "./lib/i18n";
import type { Settings } from "./lib/settings";

type Props = {
  engine: Engine;
  /** The session this window owns, if Lightroom handed one over. */
  session: Session | null;
  /** Preferences that change what "render" writes. */
  settings: Settings;
  onRefresh: () => void;
  onCloseSession: () => void;
};

type PanelProps = {
  label: string;
  hint: string;
  src: string | null;
  version?: string | number;
  /** Changing this resets the panel's zoom (a different photo is on screen). */
  resetKey?: string;
  tone?: "default" | "accent";
  /** Click on the picture itself (only used by the empty style panel). */
  onClick?: () => void;
  /** Click on the small link in the panel header, e.g. "更换". */
  onAction?: () => void;
  actionLabel?: string;
  children?: ReactNode;
};

/** `<photo name>_ColorFM.tif`, the name the engine uses for results. */
function resultName(label: string) {
  const stem = label.replace(/\.[^./]+$/, "") || "ColorFM";
  return `${stem}_ColorFM.tif`;
}

/** Upper bound of the zoom controls; 1 = fit. */
const MAX_ZOOM = 8;

/** Keeps the picture inside its frame while it is enlarged. */
function clampOffset(
  picture: HTMLImageElement | null,
  frame: HTMLElement | null,
  zoom: number,
  x: number,
  y: number,
) {
  if (!picture || !frame) return { x: 0, y: 0 };
  const maxX = Math.max(0, (picture.clientWidth * zoom - frame.clientWidth) / 2);
  const maxY = Math.max(0, (picture.clientHeight * zoom - frame.clientHeight) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, x)),
    y: Math.min(maxY, Math.max(-maxY, y)),
  };
}

/**
 * A panel image that is fully visible by default.
 *
 * Double-click toggles fit ⇄ 1:1 (the real pixels of the 1280 px proxy, which is
 * what "100%" can honestly mean here); pinch — WebKit's gesture events, plus
 * ctrl/⌘ + wheel, which is what other engines send for a pinch — zooms
 * continuously around the cursor; dragging pans once zoomed in.
 */
function ZoomableImage({ src, alt, resetKey }: { src: string; alt: string; resetKey: string }) {
  const frame = useRef<HTMLDivElement | null>(null);
  const picture = useRef<HTMLImageElement | null>(null);
  const { t } = useI18n();
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const dragged = useRef(false);

  /** Zooms so the point under (clientX, clientY) stays where it is. */
  const zoomAt = useCallback((next: number, clientX?: number, clientY?: number) => {
    const box = frame.current;
    const previous = zoomRef.current;
    const target = Math.min(MAX_ZOOM, Math.max(1, next));
    if (Math.abs(target - previous) < 0.001) return;

    if (target === 1 || !box || clientX === undefined || clientY === undefined) {
      setZoom(target);
      setOffset(
        target === 1
          ? { x: 0, y: 0 }
          : clampOffset(picture.current, box, target, offsetRef.current.x, offsetRef.current.y),
      );
      return;
    }

    const rect = box.getBoundingClientRect();
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = clientY - (rect.top + rect.height / 2);
    const current = offsetRef.current;
    const x = dx - ((dx - current.x) * target) / previous;
    const y = dy - ((dy - current.y) * target) / previous;
    setZoom(target);
    setOffset(clampOffset(picture.current, box, target, x, y));
  }, []);

  // A different photo (new session, another history entry) starts at fit.
  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, [resetKey]);

  // Pinch arrives as gesture events in WKWebView and as ctrl+wheel elsewhere.
  useEffect(() => {
    const node = frame.current;
    if (!node) return;

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomAt(zoomRef.current * Math.exp(-event.deltaY * 0.01), event.clientX, event.clientY);
    };

    let base = 1;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      base = zoomRef.current;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const detail = event as unknown as { scale?: number; clientX?: number; clientY?: number };
      zoomAt(base * (detail.scale ?? 1), detail.clientX, detail.clientY);
    };

    node.addEventListener("wheel", onWheel, { passive: false });
    node.addEventListener("gesturestart", onGestureStart as EventListener);
    node.addEventListener("gesturechange", onGestureChange as EventListener);
    return () => {
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("gesturestart", onGestureStart as EventListener);
      node.removeEventListener("gesturechange", onGestureChange as EventListener);
    };
  }, [zoomAt]);

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (zoomRef.current > 1.001) {
      zoomAt(1);
      return;
    }
    const node = picture.current;
    const actual = node && node.clientWidth > 0 ? node.naturalWidth / node.clientWidth : 2;
    zoomAt(Math.max(1.6, actual), event.clientX, event.clientY);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (zoomRef.current <= 1.001) return;
    dragged.current = false;
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      ox: offsetRef.current.x,
      oy: offsetRef.current.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragged.current = true;
    setOffset(
      clampOffset(picture.current, frame.current, zoomRef.current, start.ox + dx, start.oy + dy),
    );
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      ref={frame}
      className={`zoom${zoom > 1.001 ? " is-zoomed" : ""}`}
      onDoubleClick={onDoubleClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      // A pan must not also count as a click on the panel underneath.
      onClickCapture={(event) => {
        if (dragged.current) {
          event.stopPropagation();
          dragged.current = false;
        }
      }}
      title={t("panel.zoomHint")}
    >
      <img
        ref={picture}
        src={src}
        alt={alt}
        draggable={false}
        style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom})` }}
      />
      {zoom > 1.001 && <span className="zoom-badge">{Math.round(zoom * 100)}%</span>}
    </div>
  );
}

function Panel({
  label,
  hint,
  src,
  version,
  resetKey,
  tone,
  onClick,
  onAction,
  actionLabel,
  children,
}: PanelProps) {
  const empty = !src;
  const [displayed, setDisplayed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);

  const query = [
    version !== undefined ? `v=${encodeURIComponent(String(version))}` : "",
    attempt > 0 ? `r=${attempt}` : "",
  ]
    .filter(Boolean)
    .join("&");
  const target = src ? `${convertFileSrc(src)}${query ? `?${query}` : ""}` : null;

  // A different picture starts over: no stale failure, no leftover retry.
  useEffect(() => {
    setAttempt(0);
    setFailed(false);
  }, [src, version]);

  // Keep the previous bitmap until the replacement has decoded. Without this,
  // every strength preview briefly cleared all three panels while JPEGs loaded.
  useEffect(() => {
    if (!target) {
      setDisplayed(null);
      return;
    }

    let current = true;
    const image = new Image();
    let settle: number | null = null;

    const retry = () => {
      if (!current) return;
      if (attempt < 3) setAttempt((value) => value + 1);
      else setFailed(true);
    };

    image.onload = () => {
      if (!current) return;
      if (settle !== null) window.clearTimeout(settle);
      setDisplayed(target);
      setFailed(false);
    };
    image.onerror = () => {
      if (!current) return;
      if (settle !== null) window.clearTimeout(settle);
      retry();
    };
    // The asset protocol can leave a request hanging — no load, no error. A
    // deadline turns "spinner forever" into a retry with a fresh URL.
    settle = window.setTimeout(retry, 4000);
    image.src = target;

    return () => {
      current = false;
      if (settle !== null) window.clearTimeout(settle);
    };
  }, [target, attempt]);

  return (
    <div className={`panel${empty ? " is-empty" : ""}${tone === "accent" ? " accent" : ""}`}>
      <div className="panel-head">
        <span className="panel-label">{label}</span>
        {actionLabel && onAction && (
          <button
            type="button"
            className="panel-action"
            onClick={(event) => {
              // The link lives inside the clickable body; keep it from also
              // counting as a click on the picture.
              event.stopPropagation();
              onAction();
            }}
          >
            {actionLabel}
          </button>
        )}
      </div>

      <div
        className="panel-body"
        onClick={onClick}
        role={onClick ? "button" : undefined}
        tabIndex={onClick ? 0 : undefined}
        onKeyDown={(event) => {
          if (onClick && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            onClick();
          }
        }}
      >
        {src && displayed ? (
          <ZoomableImage src={displayed} alt={label} resetKey={resetKey ?? displayed} />
        ) : src && !failed ? (
          // The file is there but the bitmap is still decoding; saying "no
          // result" here would be a lie for the second it takes to load.
          <div className="panel-empty">
            <span className="spinner" aria-hidden />
          </div>
        ) : (
          <div className="panel-empty">
            <ImageIcon size={22} />
            <span>{hint}</span>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

/**
 * The single screen: three panels (content / transferred / style), the strength
 * slider underneath, and the imported results as a filmstrip — newest on the
 * right, the way Lightroom's own strip behaves.
 */
export default function Workspace({
  engine,
  session,
  settings,
  onRefresh,
  onCloseSession,
}: Props) {
  const { t } = useI18n();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [strength, setStrength] = useState(session?.strength ?? 1);
  const [busy, setBusy] = useState<"preview" | "render" | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /** Entries whose thumbnail is really gone, after retrying the load. */
  const [brokenThumbs, setBrokenThumbs] = useState<Set<string>>(new Set());
  const [thumbAttempts, setThumbAttempts] = useState<Record<string, number>>({});
  /** The filmstrip waits a beat so the three panels get the load slots first. */
  const [thumbsReady, setThumbsReady] = useState(false);

  const strip = useRef<HTMLDivElement | null>(null);
  const latest = useRef<Session | null>(session);
  latest.current = session;
  // Read by the drag-and-drop listener, which is registered once: without this
  // a drop would use whatever strength the session had when it was mounted.
  const strengthRef = useRef(strength);
  strengthRef.current = strength;
  const previewTimer = useRef<number | null>(null);
  const previewRunning = useRef(false);
  const previewEpoch = useRef(0);
  const pendingPreview = useRef<{ reference: string; value: number } | null>(null);
  const visuals = useRef<{
    sessionId: string | null;
    content: string | null;
    result: string | null;
    style: string | null;
  }>({ sessionId: null, content: null, result: null, style: null });

  // The engine lists newest-first; the strip runs oldest → newest so the newest
  // card sits on the right (the strip is scrolled to its end on load) — the
  // direction Lightroom's own filmstrip uses.
  const stripEntries = [...history].reverse();
  const selected = history.find((entry) => entry.id === selectedId) ?? null;
  const live = selected ? null : session;
  const sessionId = session?.id ?? null;
  const sessionVisuals = visuals.current.sessionId === sessionId ? visuals.current : null;
  const contentSrc =
    selected?.content_thumb ?? live?.preview_before_path ?? sessionVisuals?.content ?? null;
  const resultSrc =
    selected?.result_thumb ?? live?.preview_after_path ?? sessionVisuals?.result ?? null;
  const styleSrc =
    selected?.reference_thumb ?? live?.preview_style_path ?? sessionVisuals?.style ?? null;
  const contentVersion = selected?.imported_at ?? sessionId ?? "";
  const resultVersion =
    selected?.imported_at ?? live?.preview_job_id ?? live?.render_job_id ?? live?.updated_at ?? "";
  // A strength change bumps updated_at and preview_job_id; the reference panel
  // must only reload when the reference itself changes.
  const styleVersion = selected?.imported_at ?? live?.reference_path ?? "";
  /** Identifies the photo currently on screen; zoom resets when it changes. */
  const viewKey = selected?.id ?? sessionId ?? "none";
  const shownStrength = selected ? selected.strength : strength;
  const hasReference = Boolean(selected ? selected.reference_name : live?.reference_path);

  useEffect(() => {
    if (!sessionId) {
      visuals.current = { sessionId: null, content: null, result: null, style: null };
      return;
    }
    if (visuals.current.sessionId !== sessionId) {
      visuals.current = { sessionId, content: null, result: null, style: null };
    }
    if (session?.preview_before_path) visuals.current.content = session.preview_before_path;
    if (session?.preview_after_path) visuals.current.result = session.preview_after_path;
    if (session?.preview_style_path) visuals.current.style = session.preview_style_path;
  }, [
    sessionId,
    session?.preview_before_path,
    session?.preview_after_path,
    session?.preview_style_path,
  ]);

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await engine.history());
    } catch (err) {
      setError(describeError(err, t));
    }
  }, [engine]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    const timer = window.setTimeout(() => setThumbsReady(true), 500);
    return () => window.clearTimeout(timer);
  }, []);

  // A new hand-off always takes over the panels.
  useEffect(() => {
    previewEpoch.current += 1;
    pendingPreview.current = null;
    previewRunning.current = false;
    if (previewTimer.current !== null) {
      window.clearTimeout(previewTimer.current);
      previewTimer.current = null;
    }
    setSelectedId(null);
    setError(null);
    setBusy(null);
    setJob(null);
    if (session) setStrength(session.strength);
  }, [sessionId]);

  // The filmstrip grows on the right; keep the newest card in view.
  useEffect(() => {
    const node = strip.current;
    if (node) node.scrollLeft = node.scrollWidth;
  }, [history.length]);

  // Refresh the strip once the plug-in confirms the import.
  const importedId = session?.state === "imported" ? sessionId : null;
  useEffect(() => {
    if (importedId) void loadHistory();
  }, [importedId, loadHistory]);

  const runPreviewQueue = useCallback(async () => {
    if (!sessionId || previewRunning.current) return;

    previewRunning.current = true;
    const epoch = previewEpoch.current;
    setBusy("preview");
    setError(null);

    try {
      // Keep only the newest slider value. The active preview may finish, but
      // we never launch a burst of overlapping jobs.
      while (epoch === previewEpoch.current && pendingPreview.current) {
        const next = pendingPreview.current;
        pendingPreview.current = null;

        const started = await engine.previewSession(sessionId, next.reference, next.value);
        if (epoch !== previewEpoch.current) return;
        if (started.preview_job_id) {
          await engine.waitJob(started.preview_job_id, (current) => {
            if (epoch === previewEpoch.current) setJob(current);
          });
        }
      }
    } catch (err) {
      if (epoch === previewEpoch.current) setError(describeError(err, t));
    } finally {
      previewRunning.current = false;
      if (epoch === previewEpoch.current) {
        setBusy(null);
        onRefresh();
      }
    }
  }, [engine, sessionId, onRefresh]);

  const bumpThumb = useCallback((id: string) => {
    setThumbAttempts((current) => {
      const attempt = current[id] ?? 0;
      if (attempt >= 3) {
        setBrokenThumbs((broken) => new Set(broken).add(id));
        return current;
      }
      return { ...current, [id]: attempt + 1 };
    });
  }, []);

  const queuePreview = useCallback(
    (reference: string, value: number, delay = 260) => {
      if (!sessionId) return;
      pendingPreview.current = { reference, value };
      if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);

      if (delay <= 0) {
        if (!previewRunning.current) void runPreviewQueue();
        return;
      }
      previewTimer.current = window.setTimeout(() => {
        previewTimer.current = null;
        if (!previewRunning.current) void runPreviewQueue();
      }, delay);
    },
    [runPreviewQueue, sessionId],
  );

  useEffect(() => {
    return () => {
      if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    };
  }, []);

  /**
   * A reference can only be handed over while the session is still previewable.
   * Once the render has started the engine rejects a preview with
   * `E_STATE_CONFLICT`, which surfaced as a scary red error for what is really
   * just "too late".
   */
  const canApplyReference = useCallback(() => {
    const current = latest.current;
    if (!current) return false;
    if (current.state === "imported" || current.state === "canceled") return false;
    if (current.state === "rendering" || current.render_done) return false;
    return true;
  }, []);

  const pickStyle = useCallback(async () => {
    if (!sessionId || busy || !canApplyReference()) return;
    try {
      const picked = await invoke<string | null>("pick_reference");
      if (picked) queuePreview(picked, strengthRef.current, 0);
    } catch (err) {
      setError(String(err));
    }
  }, [busy, canApplyReference, queuePreview, sessionId]);

  // Dropping an image anywhere on the window sets the reference.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over") setDragging(true);
      if (event.payload.type === "leave") setDragging(false);
      if (event.payload.type === "drop") {
        setDragging(false);
        const path = event.payload.paths[0];
        if (path && canApplyReference()) queuePreview(path, strengthRef.current, 0);
      }
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [canApplyReference, queuePreview]);

  const confirm = useCallback(async () => {
    if (!sessionId) return;
    setBusy("render");
    setError(null);
    try {
      // The plug-in asks for "next to the original" (the only place Lightroom
      // can stack); the setting may override that with a fixed folder.
      const out =
        settings.outputMode === "folder" && settings.outputFolder
          ? `${settings.outputFolder.replace(/\/+$/, "")}/${resultName(live?.label ?? "")}`
          : undefined;
      const started = await engine.confirmSession(sessionId, strength, out);
      if (started.render_job_id) await engine.waitJob(started.render_job_id, setJob);
    } catch (err) {
      setError(describeError(err, t));
    } finally {
      setBusy(null);
      onRefresh();
    }
  }, [engine, sessionId, strength, onRefresh]);

  const returnToLightroom = useCallback(async () => {
    if (!sessionId) return;
    setError(null);
    try {
      await engine.sessionReadyToImport(sessionId);
      await invoke("activate_lightroom");
    } catch (err) {
      setError(describeError(err, t));
    } finally {
      onRefresh();
    }
  }, [engine, sessionId, onRefresh]);

  const cancel = useCallback(async () => {
    if (!sessionId) return;
    try {
      await engine.cancelSession(sessionId);
    } catch (err) {
      setError(describeError(err, t));
    } finally {
      onRefresh();
    }
  }, [engine, sessionId, onRefresh]);

  const renderDone = Boolean(live?.render_done);
  const terminal = live ? ["imported", "canceled"].includes(live.state) : false;
  const pct = Math.round(shownStrength * 100);

  return (
    <section className={`workspace${dragging ? " dragging" : ""}`}>
      <header className="workspace-head">
        <div className="title-block">
          <p className="eyebrow">
            {live ? t("eyebrow.session") : selected ? t("eyebrow.history") : t("eyebrow.workspace")}
          </p>
          <h1>{live?.label ?? selected?.label ?? t("title.empty")}</h1>
          <p className="path" title={live?.content_path ?? selected?.result_path ?? ""}>
            {live?.content_path ??
              selected?.result_path ??
              t("title.emptyHint")}
          </p>
        </div>

        <div className="head-actions">
          {live && <span className={`state ${live.state}`}>{t(`state.${live.state}`)}</span>}
          {selected && <span className="state">{t("action.viewing")}</span>}

          {live && !terminal && !renderDone && (
            <>
              <button
                className="button ghost"
                disabled={busy !== null}
                onClick={cancel}
                title={t("action.cancelSession")}
              >
                {t("action.cancel")}
              </button>
              <button
                className="button primary"
                // `error` is retryable: a render that died on I/O leaves the
                // preview and params intact, and the engine accepts the
                // transition back into `rendering`.
                disabled={!["ready", "error"].includes(live.state) || busy !== null}
                onClick={confirm}
              >
                {busy === "render" ? t("action.writing") : t("action.writeBack")}
                {busy !== "render" && <ArrowRightIcon />}
              </button>
            </>
          )}

          {live && renderDone && (
            <>
              <button
                className="button"
                onClick={() =>
                  live.result_path && invoke("reveal_in_finder", { path: live.result_path })
                }
              >
                <FolderIcon />
                {t("action.reveal")}
              </button>
              <button className="button primary" onClick={returnToLightroom}>
                {t("action.import")}
              </button>
            </>
          )}

          {live?.state === "imported" && (
            <button className="button primary" onClick={onCloseSession}>
              <CheckIcon />
              {t("action.done")}
            </button>
          )}

          {live?.state === "canceled" && (
            <button className="button" onClick={onCloseSession}>
              {t("action.close")}
            </button>
          )}

          {selected && (
            <>
              <button
                className="button"
                disabled={!selected.result_path}
                onClick={() =>
                  selected.result_path &&
                  invoke("reveal_in_finder", { path: selected.result_path })
                }
              >
                <FolderIcon />
                {t("action.reveal")}
              </button>
              <button className="button" onClick={() => setSelectedId(null)}>
                {t("action.back")}
              </button>
            </>
          )}

          <button className="icon-button" onClick={() => void loadHistory()} title={t("action.refreshHistory")}>
            <RefreshIcon />
          </button>
        </div>
      </header>

      {live?.notice && <p className="banner">{live.notice}</p>}

      <div className="stage3">
        <Panel
          label="content"
          hint={live ? t("panel.hint.waitingPreview") : t("panel.hint.noContent")}
          src={contentSrc}
          version={contentVersion}
          resetKey={viewKey}
        />

        <Panel
          label="transferred"
          hint={live?.reference_path ? t("panel.hint.noResult") : t("panel.hint.pickReference")}
          src={resultSrc}
          version={resultVersion}
          resetKey={viewKey}
          tone="accent"
        >
          {busy && (
            <div className="panel-overlay">
              <span className="spinner" aria-hidden />
              <span>{busy === "render" ? t("panel.busy.render") : t("panel.busy.preview")}</span>
              <span className="panel-progress">{job?.pct ?? 0}%</span>
            </div>
          )}
        </Panel>

        <Panel
          label="style"
          hint={t("panel.hint.dropReference")}
          src={styleSrc}
          version={styleVersion}
          resetKey={viewKey}
          actionLabel={styleSrc && live ? t("action.replace") : undefined}
          // With a reference loaded the panel belongs to zoom/pan; the header
          // link is the way to swap it. Click-to-pick stays for the empty state
          // only, so a double-click to zoom cannot open the file dialog twice.
          onAction={
            live && !terminal && !renderDone && live.state !== "rendering" ? pickStyle : undefined
          }
          onClick={
            live && !terminal && !renderDone && live.state !== "rendering" && !styleSrc
              ? pickStyle
              : undefined
          }
        />
      </div>

      <div className="strength-row">
        <span className="strength-label">{t("strength.label")}</span>
        <input
          type="range"
          min={0}
          max={200}
          step={1}
          value={pct}
          disabled={!live || terminal || renderDone || !hasReference || busy === "render"}
          onChange={(event) => {
            const value = Number(event.target.value) / 100;
            setStrength(value);
            if (live?.reference_path) queuePreview(live.reference_path, value);
          }}
        />
        <output className="strength-value">{pct}%</output>
      </div>

      <div className="filmstrip" ref={strip}>
        {history.length === 0 && (
          <p className="film-empty">{t("filmstrip.empty")}</p>
        )}
        {stripEntries.map((entry, index) => (
          <button
            key={entry.id}
            className={`film-card${entry.id === selectedId ? " active" : ""}`}
            onClick={() => setSelectedId(entry.id === selectedId ? null : entry.id)}
            title={`${entry.label} · ${t("strength.label")} ${Math.round(entry.strength * 100)}%`}
          >
            {entry.result_thumb && !brokenThumbs.has(entry.id) && thumbsReady ? (
              <img
                src={`${convertFileSrc(entry.result_thumb)}?v=${entry.imported_at}${
                  thumbAttempts[entry.id] ? `&r=${thumbAttempts[entry.id]}` : ""
                }`}
                alt={entry.label}
                loading="lazy"
                onError={() => bumpThumb(entry.id)}
              />
            ) : (
              <span className="thumb-placeholder">
                <ImageIcon size={16} />
              </span>
            )}
            <span className="film-index">{index + 1}</span>
          </button>
        ))}
      </div>

      {error && (
        <p className="inline-error">
          {error}
          <button
            className="link-button"
            onClick={() => {
              setError(null);
              void loadHistory();
              onRefresh();
            }}
          >
            {t("error.refresh")}
          </button>
        </p>
      )}
    </section>
  );
}

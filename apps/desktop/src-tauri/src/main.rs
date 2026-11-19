//! Desktop shell: the window, and the process that runs the engine.
//!
//! The UI talks to the engine over HTTP (see `src/lib/engine.ts`); Rust only
//! locates, starts and stops the engine, hands the port/token to the webview,
//! and performs the two macOS chores the webview cannot: a native image picker
//! and bringing Lightroom forward. All image work stays in `packages/engine`.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager, RunEvent, State};

mod settings;

struct EngineProcess(Mutex<Option<Child>>);

#[derive(Serialize, Clone)]
struct EngineInfo {
    port: u16,
    token: String,
    pid: u32,
}

/// The engine's home, matching `colorfm-engine`'s own resolution. `COLORFM_HOME`
/// keeps development runs (and tests) out of the real application-support dir.
fn home_dir() -> PathBuf {
    if let Ok(path) = std::env::var("COLORFM_HOME") {
        return PathBuf::from(path);
    }
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("Library/Application Support/ColorFM-LR")
}

fn discovery_path() -> PathBuf {
    home_dir().join("engine.json")
}

/// Where the engine keeps its working files (`tasks/`, `history/`, exported
/// base TIFFs). Mirrors the engine's own resolution so the janitor commands
/// below can never wander outside it.
fn library_dir() -> PathBuf {
    if let Ok(path) = std::env::var("COLORFM_LIBRARY") {
        return PathBuf::from(path);
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("Documents/ColorFM-LR")
}

fn read_discovery() -> Option<EngineInfo> {
    let text = std::fs::read_to_string(discovery_path()).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(EngineInfo {
        port: value["http_port"].as_u64()? as u16,
        token: value["token"].as_str()?.to_string(),
        pid: value["pid"].as_u64()? as u32,
    })
}

/// How the engine can be started on this machine.
enum EngineLaunch {
    /// A single executable: either a bundled sidecar or a standalone build.
    Binary(PathBuf),
    /// The compiled JavaScript, run by the Node already installed.
    Script { node: PathBuf, entry: PathBuf },
}

/// Finds `node` without trusting the `PATH` a windowed app inherits.
///
/// Launching from Finder gives a process almost no `PATH` (typically
/// `/usr/bin:/bin:/usr/sbin:/sbin`), while Node usually lives in
/// `/opt/homebrew/bin` or `/usr/local/bin`. The explicit list is what makes the
/// app work when the user double-clicks it rather than starting it from a
/// terminal.
fn resolve_node() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("COLORFM_NODE") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }

    let mut directories: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        directories.extend(std::env::split_paths(&path));
    }
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        directories.push(PathBuf::from(dir));
    }
    // Version managers keep Node in a per-user directory.
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        directories.push(home.join(".volta/bin"));
        directories.push(home.join(".local/bin"));
    }

    for dir in directories {
        let candidate = dir.join("node");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Locates the engine, preferring an executable over the script.
///
/// Order: an explicit binary, one bundled beside the app, then the compiled
/// JavaScript — from an explicit entry, the bundle's resources, or this
/// checkout's `packages/engine/dist`.
fn resolve_engine() -> Option<EngineLaunch> {
    if let Ok(path) = std::env::var("COLORFM_ENGINE") {
        return Some(EngineLaunch::Binary(PathBuf::from(path)));
    }

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(PathBuf::from));

    // Bundled: Contents/MacOS/colorfm-engine.
    if let Some(dir) = exe_dir.as_ref() {
        let bundled = dir.join("colorfm-engine");
        if bundled.is_file() {
            return Some(EngineLaunch::Binary(bundled));
        }
    }

    let mut entries: Vec<PathBuf> = Vec::new();
    if let Ok(path) = std::env::var("COLORFM_ENGINE_ENTRY") {
        entries.push(PathBuf::from(path));
    }
    if let Some(dir) = exe_dir.as_ref() {
        // Bundled resources: Contents/Resources/engine/main.js.
        entries.push(dir.join("../Resources/engine/main.js"));
    }
    // Development: this manifest path is baked in at compile time, so the app
    // started by `tauri dev` finds the build next to the sources it was built
    // from.
    entries.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/engine/dist/main.js"));

    let entry = entries.into_iter().find(|path| path.is_file())?;
    // A release ships its own runtime next to the entry, so the app does not
    // depend on Node being installed. Falling back to PATH keeps `tauri dev`
    // and a checkout working unchanged.
    let bundled_node = entry
        .parent()
        .map(|dir| dir.join("node"))
        .filter(|path| path.is_file());
    let node = bundled_node.or_else(resolve_node)?;
    Some(EngineLaunch::Script { node, entry })
}

/// Copies a directory tree, used to install the plug-in.
fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Installs the Lightroom plug-in that ships inside the bundle.
///
/// Without it the app is only half the product: Lightroom needs a plug-in in
/// its Modules folder to export the TIFF and import the result. Installing on
/// first launch means the user does not have to find a `.lrplugin` inside a
/// `.app` and add it by hand. Lightroom scans that folder at start-up, so an
/// install that happens while it is running takes effect next time it opens.
fn ensure_lightroom_plugin() -> Option<PathBuf> {
    // A directory, so `bundle_resource` (which asks `is_file`) cannot be used.
    let dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(PathBuf::from))?;
    let source = dir.join("../Resources/lightroom/colorfm.lrplugin");
    if !source.is_dir() {
        return None;
    }
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let modules = home.join("Library/Application Support/Adobe/Lightroom/Modules");
    let target = modules.join("colorfm.lrplugin");
    if target.join("Info.lua").is_file() {
        return Some(target);
    }
    std::fs::create_dir_all(&modules).ok()?;
    copy_dir(&source, &target).ok()?;
    eprintln!("colorfm: installed plug-in {}", target.display());
    Some(target)
}

/// A file under `Contents/Resources`, for the paths the bundle carries.
fn bundle_resource(relative: &str) -> Option<PathBuf> {
    let dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(PathBuf::from))?;
    let candidate = dir.join("../Resources").join(relative);
    candidate.is_file().then_some(candidate)
}

/// Minimal HTTP GET against the local engine. The responses here are small JSON
/// documents, so a full client (and its dependency tree) would be overkill.
fn http_get(info: &EngineInfo, path: &str) -> Option<(u16, String)> {
    let addr: SocketAddr = format!("127.0.0.1:{}", info.port).parse().ok()?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(400)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1500)));

    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n",
        info.token
    );
    stream.write_all(request.as_bytes()).ok()?;

    let mut raw = String::new();
    stream.read_to_string(&mut raw).ok()?;

    let status = raw
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())?;
    let body = match raw.split_once("\r\n\r\n") {
        Some((_, body)) => body.to_string(),
        None => String::new(),
    };
    Some((status, body))
}

/// A discovery file proves nothing: the process may have exited, or it may be
/// an older build without the session API. Ask it directly.
fn health_ok(info: &EngineInfo) -> bool {
    let Some((status, body)) = http_get(info, "/v1/health") else {
        return false;
    };
    // Both capabilities are required: reusing an engine from before the history
    // API existed would leave the History tab permanently empty.
    status == 200 && body.contains("\"lightroom-sessions\"") && body.contains("\"history\"")
}

/// Sessions that still need a window or an import. The engine must outlive
/// these (v0.md §4, point 5).
fn active_sessions(info: &EngineInfo) -> u64 {
    let Some((status, body)) = http_get(info, "/v1/lightroom/sessions?active=1") else {
        return 0;
    };
    if status != 200 {
        return 0;
    }
    serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| value["data"]["active"].as_u64())
        .unwrap_or(0)
}

fn stop(pid: u32) {
    let _ = Command::new("kill").arg(pid.to_string()).status();
    std::thread::sleep(Duration::from_millis(300));
}

#[tauri::command]
fn engine_info() -> Result<EngineInfo, String> {
    match read_discovery() {
        Some(info) if health_ok(&info) => Ok(info),
        Some(_) => Err("engine is not responding (stale discovery file)".to_string()),
        None => Err("engine is not running".to_string()),
    }
}

#[tauri::command]
fn start_engine(state: State<'_, EngineProcess>) -> Result<EngineInfo, String> {
    if let Some(info) = read_discovery() {
        // A busy engine (model load, a render) can miss one 800 ms window.
        if health_ok(&info) {
            return Ok(info);
        }
        std::thread::sleep(Duration::from_millis(500));
        if health_ok(&info) {
            return Ok(info);
        }
    }

    let mut guard = state.0.lock().map_err(|_| "engine state poisoned")?;

    // The child we started may have exited (crash, or someone killed it). A
    // stale handle must not block the next spawn, or the app is dead until it
    // is relaunched.
    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(Some(status)) => {
                eprintln!("colorfm: engine (pid {}) exited: {status}", child.id());
                *guard = None;
            }
            Ok(None) => {}
            Err(err) => {
                eprintln!("colorfm: cannot query engine child: {err}");
                *guard = None;
            }
        }
    }

    // An engine we did not start cannot serve this UI (older build, dead port).
    // Only now, after two failed health checks, is it safe to retire it.
    if guard.is_none() {
        if let Some(info) = read_discovery() {
            eprintln!("colorfm: retiring unresponsive engine pid {}", info.pid);
            stop(info.pid);
        }
    }

    if guard.is_none() {
        let launch = resolve_engine().ok_or_else(|| {
            "engine not found (run `npm run build` at the repository root, or set COLORFM_ENGINE)"
                .to_string()
        })?;
        let mut command = match &launch {
            EngineLaunch::Binary(path) => {
                eprintln!("colorfm: starting engine {}", path.display());
                Command::new(path)
            }
            EngineLaunch::Script { node, entry } => {
                eprintln!(
                    "colorfm: starting engine {} (node {})",
                    entry.display(),
                    node.display()
                );
                let mut command = Command::new(node);
                command.arg(entry);
                command
            }
        };
        // The bundled model lives in the resources, not next to the entry, so
        // hand the engine its path instead of letting it guess.
        if let Some(model) = bundle_resource("models/colorfm_l.onnx") {
            command.env("COLORFM_MODEL", model);
        }
        let child = command
            .arg("serve")
            .arg("--port")
            .arg("0")
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|err| format!("cannot start engine: {err}"))?;
        eprintln!("colorfm: engine pid {}", child.id());
        *guard = Some(child);
    }
    drop(guard);

    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if let Some(info) = read_discovery() {
            if health_ok(&info) {
                return Ok(info);
            }
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err("engine did not become healthy within 15 s".to_string())
}

/// Native reference-image picker. Tauri's dialog plug-in is an extra
/// dependency; AppleScript ships with the OS and returns a POSIX path.
#[tauri::command]
fn pick_reference() -> Result<Option<String>, String> {
    let script = r#"try
set pickedFile to choose file with prompt "选择 ColorFM-LR 参考图" of type {"public.image"}
return POSIX path of pickedFile
on error number -128
return ""
end try"#;

    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|err| format!("cannot open the file picker: {err}"))?;

    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("file picker failed: {detail}"));
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(if path.is_empty() { None } else { Some(path) })
}

/// Brings Lightroom Classic forward after the result is ready to import.
///
/// The bundle id differs across releases (`...CC7` on 15.x, `...LightroomClassic`
/// on others), so every known spelling is tried before falling back to the
/// application name.
#[tauri::command]
fn activate_lightroom() -> Result<(), String> {
    const BUNDLE_IDS: [&str; 3] = [
        "com.adobe.LightroomClassicCC7",
        "com.adobe.LightroomClassic",
        "com.adobe.Lightroom",
    ];

    for id in BUNDLE_IDS {
        let status = Command::new("open").args(["-b", id]).status();
        if matches!(status, Ok(status) if status.success()) {
            return Ok(());
        }
    }

    let by_name = Command::new("open")
        .args(["-a", "Adobe Lightroom Classic"])
        .status();
    match by_name {
        Ok(status) if status.success() => Ok(()),
        _ => Err("cannot activate Lightroom Classic".to_string()),
    }
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    Command::new("open")
        .arg("-R")
        .arg(&path)
        .status()
        .map(|_| ())
        .map_err(|err| format!("cannot reveal {path}: {err}"))
}

#[tauri::command]
fn data_dir() -> String {
    library_dir().display().to_string()
}

#[tauri::command]
fn load_settings() -> settings::Settings {
    settings::load(&home_dir())
}

#[tauri::command]
fn save_settings(value: settings::Settings) -> Result<settings::Settings, String> {
    let home = home_dir();
    let mut next = value;
    // The webview knows nothing about the window geometry recorded here, so a
    // preference change must not wipe it.
    next.window = settings::load(&home).window;
    settings::save(&home, &next)?;
    Ok(settings::load(&home))
}

/// Native folder picker, same reason as `pick_reference`: no extra dependency.
#[tauri::command]
fn pick_folder() -> Result<Option<String>, String> {
    let script = r#"try
set pickedFolder to choose folder with prompt "Choose where ColorFM-LR writes results"
return POSIX path of pickedFolder
on error number -128
return ""
end try"#;

    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|err| format!("cannot open the folder picker: {err}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("folder picker failed: {detail}"));
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(if path.is_empty() { None } else { Some(path) })
}

/// Deletes one base TIFF the engine exported for Lightroom.
///
/// Only files inside `<library>/lightroom/` are eligible: this command is
/// reachable from the webview, and a wrong path here would eat a photo.
#[tauri::command]
fn delete_exported_file(path: String) -> Result<(), String> {
    let root = library_dir().join("lightroom");
    let candidate = PathBuf::from(&path);
    if !candidate.starts_with(&root) {
        return Err("refusing to delete a file outside the ColorFM-LR workspace".into());
    }
    match std::fs::remove_file(&candidate) {
        Ok(()) => {
            // The export folder holds exactly one TIFF; drop it too so a run of
            // imports does not leave a wall of empty directories behind.
            if let Some(parent) = candidate.parent() {
                let _ = std::fs::remove_dir(parent);
            }
            Ok(())
        }
        // Already gone is the desired end state.
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

/// Reads every session record the engine keeps (one JSON file per session).
fn session_records(home: &Path) -> Vec<serde_json::Value> {
    let dir = home.join("lightroom").join("sessions");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| std::fs::read(entry.path()).ok())
        .filter_map(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .collect()
}

fn text_field(session: &serde_json::Value, key: &str) -> Option<PathBuf> {
    session
        .get(key)
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// A session is finished once its result file is on disk. Until then its 16-bit
/// export is the only way to re-render it, so it must be kept.
fn is_finished(session: &serde_json::Value) -> bool {
    session
        .get("render_done")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
        && text_field(session, "result_path").is_some_and(|path| path.is_file())
}

/// Export files some session still needs.
///
/// A path counts as needed while *any* unfinished session refers to it: two
/// sessions can share one export (same photo, a second run), and deleting it
/// because the first one finished would break the other's preview.
fn content_paths_in_use(home: &Path) -> Vec<PathBuf> {
    session_records(home)
        .iter()
        .filter(|session| !is_finished(session))
        .filter_map(|session| text_field(session, "content_path"))
        .collect()
}

/// True when `dir` holds something in `needed` (a file or a folder inside it).
fn holds_needed_file(dir: &Path, needed: &[PathBuf]) -> bool {
    needed.iter().any(|path| path.starts_with(dir))
}

/// Deletes the base TIFF of every session whose result is already on disk.
///
/// The window deletes it the moment it sees a finished write-back, but that
/// only covers sessions it was watching. Someone who renders, quits, and comes
/// back the next day would otherwise keep every ~190 MB export forever, so the
/// same rule is applied once at launch.
///
/// Two guards keep this boring: the file must sit under `<library>/lightroom/`,
/// and the result it was made for must still exist — losing the source because
/// a result went missing would be the worst possible outcome.
fn prune_written_back_exports(home: &Path, root: &Path) {
    let needed = content_paths_in_use(home);
    for session in session_records(home) {
        if !is_finished(&session) {
            continue;
        }
        let Some(content) = text_field(&session, "content_path") else {
            continue;
        };
        if !content.starts_with(root) || needed.contains(&content) {
            continue;
        }
        if std::fs::remove_file(&content).is_ok() {
            if let Some(parent) = content.parent() {
                let _ = std::fs::remove_dir(parent);
            }
        }
    }
}

#[derive(Serialize)]
struct CleanupReport {
    removed: u32,
    freed: u64,
    /// Export folders left alone because a session still needs them.
    skipped: u32,
}

fn directory_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                directory_size(&path)
            } else {
                entry.metadata().map(|meta| meta.len()).unwrap_or(0)
            }
        })
        .sum()
}

/// Removes `lightroom/export-*` folders the plug-in left behind.
///
/// Folders still referenced by a live session are skipped: the window can be
/// mid-preview, and its source TIFF lives in exactly one of them.
#[tauri::command]
fn cleanup_exports() -> Result<CleanupReport, String> {
    let root = library_dir().join("lightroom");
    let mut report = CleanupReport {
        removed: 0,
        freed: 0,
        skipped: 0,
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Ok(report);
    };

    let needed = content_paths_in_use(&home_dir());

    for entry in entries.flatten() {
        let path = entry.path();
        let is_export = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with("export-"))
            .unwrap_or(false);
        if !is_dir(&path) || !is_export {
            continue;
        }
        if holds_needed_file(&path, &needed) {
            report.skipped += 1;
            continue;
        }
        let size = directory_size(&path);
        if std::fs::remove_dir_all(&path).is_ok() {
            report.removed += 1;
            report.freed += size;
        }
    }
    Ok(report)
}

fn is_dir(path: &Path) -> bool {
    path.is_dir()
}

/// The macOS menu. Only `Settings…` is ours; everything else is a system role,
/// so the app behaves like a native one (About, Services, Hide, Quit).
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let about = PredefinedMenuItem::about(
        app,
        Some("About ColorFM-LR"),
        Some(tauri::menu::AboutMetadata {
            name: Some("ColorFM-LR".into()),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            comments: Some("Reference-driven color grading for Lightroom Classic".into()),
            ..Default::default()
        }),
    )?;
    let settings_item = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;

    let app_menu = SubmenuBuilder::new(app, "ColorFM-LR")
        .item(&about)
        .separator()
        .item(&settings_item)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .separator()
        .close_window()
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &window_menu])
        .build()
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            // Ship both halves: the plug-in is installed here, before the
            // window opens, so a fresh install works after one Lightroom restart.
            ensure_lightroom_plugin();
            let home = home_dir();
            if settings::load(&home).delete_export_after_write_back {
                // Before the window opens: renders that finished while the app
                // was closed never got their export cleaned up.
                prune_written_back_exports(&home, &library_dir().join("lightroom"));
            }
            if let Some(window) = app.get_webview_window("main") {
                // Reopen at the size the user left it.
                if let Some(state) = settings::load(&home).window {
                    let _ = window.set_size(tauri::LogicalSize::new(
                        f64::from(state.width),
                        f64::from(state.height),
                    ));
                }

                // A drag emits a burst of Resized events; record at most one a
                // second, and never the fullscreen/maximised size.
                let win = window.clone();
                let last_write = Arc::new(AtomicU64::new(0));
                window.on_window_event(move |event| {
                    let tauri::WindowEvent::Resized(size) = event else {
                        return;
                    };
                    if win.is_fullscreen().unwrap_or(false) || win.is_maximized().unwrap_or(false) {
                        return;
                    }
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|elapsed| elapsed.as_secs())
                        .unwrap_or(0);
                    if last_write.swap(now, Ordering::Relaxed) == now {
                        return;
                    }
                    let scale = win.scale_factor().unwrap_or(1.0);
                    let logical = size.to_logical::<f64>(scale);
                    settings::remember_window(&home, logical.width, logical.height);
                });
            }
            Ok(())
        })
        .menu(build_menu)
        .on_menu_event(|app, event| {
            if event.id() == "settings" {
                let _ = app.emit("settings:open", ());
            }
        })
        .manage(EngineProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            engine_info,
            start_engine,
            pick_reference,
            activate_lightroom,
            reveal_in_finder,
            data_dir,
            load_settings,
            save_settings,
            pick_folder,
            delete_exported_file,
            cleanup_exports
        ])
        .build(tauri::generate_context!())
        .expect("failed to build the ColorFM-LR window");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // An unfinished Lightroom session may still be waiting on the
            // engine (import pending, reference not chosen). Leave it running;
            // it retires itself once idle for `--idle-exit` seconds.
            let keep = read_discovery()
                .map(|info| health_ok(&info) && active_sessions(&info) > 0)
                .unwrap_or(false);

            if let Some(state) = handle.try_state::<EngineProcess>() {
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(mut child) = guard.take() {
                        if keep {
                            // Detach: the engine is no longer ours to kill.
                            let _ = child.id();
                        } else {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shell must find both halves of the engine it is expected to start:
    /// the compiled JavaScript and a Node to run it with.
    #[test]
    fn resolves_the_engine_it_will_start() {
        assert!(resolve_node().is_some(), "no node found on this machine");

        match resolve_engine() {
            Some(EngineLaunch::Binary(path)) => assert!(path.is_file(), "{}", path.display()),
            Some(EngineLaunch::Script { node, entry }) => {
                assert!(node.is_file(), "node at {}", node.display());
                assert!(entry.is_file(), "entry at {}", entry.display());
                assert!(
                    entry.ends_with("packages/engine/dist/main.js"),
                    "unexpected entry: {}",
                    entry.display()
                );
            }
            None => panic!("engine not found; run `npm run build` at the repository root"),
        }
    }

    /// Creates a fake home with the given sessions, plus the files they refer
    /// to; returns (home, library root).
    fn fixture(tag: &str, rows: &[(&str, bool, &str, Option<&str>)]) -> (PathBuf, PathBuf) {
        let home = std::env::temp_dir().join(format!("colorfm-{tag}-{}", std::process::id()));
        let sessions = home.join("lightroom").join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let root = home.join("lightroom");

        for (index, (state, render_done, content, result)) in rows.iter().enumerate() {
            let content = home.join("lightroom").join(content);
            std::fs::create_dir_all(content.parent().unwrap()).unwrap();
            std::fs::write(&content, b"pixels").unwrap();
            if let Some(result) = result {
                let result = home.join("results").join(result);
                std::fs::create_dir_all(result.parent().unwrap()).unwrap();
                std::fs::write(&result, b"graded").unwrap();
            }
            let body = serde_json::json!({
                "state": state,
                "render_done": render_done,
                "content_path": content,
                "result_path": result.map(|name| home.join("results").join(name)),
            });
            std::fs::write(sessions.join(format!("{index}.json")), body.to_string()).unwrap();
        }
        (home, root)
    }

    /// A live session's export survives the cleaner; a finished one does not.
    #[test]
    fn cleanup_keeps_exports_of_live_sessions() {
        let (home, _) = fixture(
            "clean",
            &[
                ("previewing", false, "export-live/IMG_1.tif", None),
                ("imported", true, "export-done/IMG_2.tif", Some("IMG_2_ColorFM.tif")),
                (
                    "ready_to_import",
                    true,
                    "export-rendered/IMG_3.tif",
                    Some("IMG_3_ColorFM.tif"),
                ),
            ],
        );

        let needed = content_paths_in_use(&home);
        assert_eq!(needed.len(), 1);
        assert!(needed[0].ends_with("export-live/IMG_1.tif"));
        assert!(holds_needed_file(&home.join("lightroom/export-live"), &needed));
        assert!(!holds_needed_file(&home.join("lightroom/export-done"), &needed));
        assert!(!holds_needed_file(&home.join("lightroom/export-rendered"), &needed));

        std::fs::remove_dir_all(&home).ok();
    }

    /// The launch sweep removes exports whose result is on disk.
    #[test]
    fn prune_removes_written_back_exports() {
        let (home, root) = fixture(
            "prune",
            &[
                ("ready_to_import", true, "export-done/IMG_2.tif", Some("IMG_2_ColorFM.tif")),
                ("previewing", false, "export-live/IMG_4.tif", None),
            ],
        );

        prune_written_back_exports(&home, &root);

        assert!(!home.join("lightroom/export-done/IMG_2.tif").exists());
        assert!(home.join("lightroom/export-live/IMG_4.tif").exists());

        std::fs::remove_dir_all(&home).ok();
    }

    /// Two sessions can share one export; finishing one must not delete the
    /// file the other is still previewing from.
    #[test]
    fn prune_keeps_an_export_another_session_still_uses() {
        let (home, root) = fixture(
            "shared",
            &[
                (
                    "ready_to_import",
                    true,
                    "export-shared/IMG_5.tif",
                    Some("IMG_5_ColorFM.tif"),
                ),
                ("previewing", false, "export-shared/IMG_5.tif", None),
            ],
        );

        prune_written_back_exports(&home, &root);

        assert!(home.join("lightroom/export-shared/IMG_5.tif").exists());

        std::fs::remove_dir_all(&home).ok();
    }
}

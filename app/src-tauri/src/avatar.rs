//! Avatar (puppet) window: a second webview showing puppet.html.
//! Window transparency can only be set at creation, so switching it destroys and recreates the window.

use crate::config;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub const LABEL: &str = "puppet";

#[derive(Default)]
struct State {
    transparent: bool,
    /// Recreate with this transparency once the current window is destroyed.
    pending: Option<bool>,
    /// Last logical [x, y, w, h], saved to settings when the window goes away.
    bounds: Option<[f64; 4]>,
    /// Last minimised state sent to the puppet page.
    minimized: bool,
}

static STATE: Mutex<State> = Mutex::new(State { transparent: false, pending: None, bounds: None, minimized: false });

fn state() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Opens the window; if it is open with a different transparency it is recreated, otherwise left alone.
// async: building a window from a sync command deadlocks on Windows.
#[tauri::command]
pub async fn puppet_open(app: AppHandle, transparent: bool) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        let mut s = state();
        if s.transparent != transparent {
            s.pending = Some(transparent);
            drop(s);
            w.destroy().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    build(&app, transparent)
}

/// Recreates an OPEN window whose transparency differs; never opens one. The options effect calls this on every change,
/// so it must not be able to bring back a window that was just closed (docking, closing with the X).
#[tauri::command]
pub async fn puppet_retransparent(app: AppHandle, transparent: bool) -> Result<(), String> {
    if app.get_webview_window(LABEL).is_some() {
        return puppet_open(app, transparent).await;
    }
    Ok(())
}

/// The avatar window's dock button: the main window shows the avatar in its sidebar and this window closes (bounds
/// are saved as on any close). async: the window destroys itself from its own command.
#[tauri::command]
pub async fn puppet_dock(app: AppHandle) -> Result<(), String> {
    // A pending transparency switch must not bring the window back after the dock.
    state().pending = None;
    app.emit_to("main", "avatar://dock", ()).map_err(|e| e.to_string())?;
    puppet_close(app)
}

#[tauri::command]
pub fn puppet_close(app: AppHandle) -> Result<(), String> {
    match app.get_webview_window(LABEL) {
        Some(w) => w.destroy().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// Called by the puppet page once its listeners are registered: tells the main window to send the options.
/// A command instead of a page-side `emitTo`, so the puppet window needs no permission to emit arbitrary events.
#[tauri::command]
pub fn puppet_ready(app: AppHandle) -> Result<(), String> {
    app.emit_to("main", "avatar://ready", ()).map_err(|e| e.to_string())
}

/// The pin button: keeps the avatar window above other windows. Saved, so a recreated or reopened window keeps it.
#[tauri::command]
pub fn puppet_set_on_top(app: AppHandle, on: bool) -> Result<(), String> {
    config::update(&app, |s| s.avatar_on_top = on)?;
    match app.get_webview_window(LABEL) {
        Some(w) => w.set_always_on_top(on).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// Whether the pin is set; the avatar page shows its button state from this.
#[tauri::command]
pub fn puppet_on_top(app: AppHandle) -> bool {
    config::load(&app).avatar_on_top
}

/// The opacity slider in the avatar window title bar: the main window owns the setting (and its menu slider), so
/// it only gets told; it sends the new options back. A command, so the page needs no permission to emit events.
#[tauri::command]
pub fn puppet_set_opacity(app: AppHandle, opacity: u32) -> Result<(), String> {
    app.emit_to("main", "avatar://opacity", opacity.min(100)).map_err(|e| e.to_string())
}

fn build(app: &AppHandle, transparent: bool) -> Result<(), String> {
    let mut b = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("puppet.html".into()))
        .title("Talkerbox Avatar")
        .inner_size(360.0, 480.0)
        .min_inner_size(160.0, 120.0)
        // Own title bar in puppet.html (PuppetView), so it can fade out with a transparent background. Tauri keeps
        // the edges resizable; no shadow on a transparent window, it would outline the invisible window.
        .decorations(false)
        .shadow(!transparent)
        .transparent(transparent)
        .always_on_top(config::load(app).avatar_on_top);
    if let Some(saved) = config::load(app).avatar_bounds {
        let [x, y, w, h] = clamp_to_monitors(saved, &monitors(app));
        b = b.position(x, y).inner_size(w, h);
    }
    let win = b.build().map_err(|e| format!("Cannot open the avatar window: {e}"))?;
    {
        let mut s = state();
        s.transparent = transparent;
        s.minimized = false;
    }
    // Moved/Resized do not fire at creation; record the initial bounds so a recreate keeps the place.
    remember(app);
    let app = app.clone();
    win.on_window_event(move |e| match e {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => remember(&app),
        WindowEvent::Destroyed => {
            let (bounds, pending) = {
                let mut s = state();
                (s.bounds, s.pending.take())
            };
            if bounds.is_some() {
                let _ = config::update(&app, |s| s.avatar_bounds = bounds);
            }
            let _ = app.emit("avatar://closed", ());
            if let Some(t) = pending {
                let app = app.clone();
                // The label is free only after this handler; build from outside the event loop callback.
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = build(&app, t) {
                        eprintln!("{e}");
                    }
                });
            }
        }
        _ => {}
    });
    Ok(())
}

/// Tells the main window when it is minimised or restored: WebView2 keeps a minimised webview running, and the
/// docked avatar pauses its drawing on this.
pub fn main_window_event(w: &tauri::Window, e: &WindowEvent) {
    static MINIMIZED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if w.label() == "main" && matches!(e, WindowEvent::Resized(_)) {
        let m = w.is_minimized().unwrap_or(false);
        if MINIMIZED.swap(m, std::sync::atomic::Ordering::Relaxed) != m {
            let _ = w.emit_to("main", "app://minimized", m);
        }
    }
}

/// Logical [x, y, w, h] of every monitor, primary first.
fn monitors(app: &AppHandle) -> Vec<[f64; 4]> {
    let primary = app.primary_monitor().ok().flatten();
    let mut list: Vec<_> = primary.iter().cloned().collect();
    list.extend(app.available_monitors().unwrap_or_default().into_iter().filter(|m| primary.as_ref().is_none_or(|p| p.position() != m.position())));
    list.iter()
        .map(|m| {
            let (p, s) = (m.position().to_logical::<f64>(m.scale_factor()), m.size().to_logical::<f64>(m.scale_factor()));
            [p.x, p.y, s.width, s.height]
        })
        .collect()
}

/// Keeps saved bounds whose title bar (top centre) is on some monitor; otherwise moves them, shrunk if needed,
/// onto the first (primary) monitor, so a window saved on a since-removed monitor never opens off-screen.
fn clamp_to_monitors([x, y, w, h]: [f64; 4], monitors: &[[f64; 4]]) -> [f64; 4] {
    let (cx, cy) = (x + w / 2.0, y + 10.0);
    let on = |&[mx, my, mw, mh]: &[f64; 4]| cx >= mx && cx < mx + mw && cy >= my && cy < my + mh;
    match monitors.first() {
        Some(&[mx, my, mw, mh]) if !monitors.iter().any(on) => {
            let (w, h) = (w.min(mw), h.min(mh));
            [x.clamp(mx, mx + mw - w), y.clamp(my, my + mh - h), w, h]
        }
        _ => [x, y, w, h],
    }
}

fn remember(app: &AppHandle) {
    let Some(w) = app.get_webview_window(LABEL) else { return };
    // Minimised windows report a position of -32000; keep the last real bounds.
    let minimized = w.is_minimized().unwrap_or(true);
    // The webview keeps running while minimised (wry does not hide it), so the puppet pauses its drawing on this.
    if std::mem::replace(&mut state().minimized, minimized) != minimized {
        let _ = w.emit_to(LABEL, "avatar://minimized", minimized);
    }
    if minimized {
        return;
    }
    let (Ok(sf), Ok(p), Ok(sz)) = (w.scale_factor(), w.outer_position(), w.inner_size()) else { return };
    let (p, sz) = (p.to_logical::<f64>(sf), sz.to_logical::<f64>(sf));
    state().bounds = Some([p.x, p.y, sz.width, sz.height]);
}

#[cfg(test)]
mod tests {
    use super::clamp_to_monitors;

    const PRIMARY: [f64; 4] = [0.0, 0.0, 1920.0, 1080.0];
    const LEFT: [f64; 4] = [-1280.0, 0.0, 1280.0, 1024.0];

    #[test]
    fn visible_bounds_are_kept() {
        let b = [100.0, 100.0, 360.0, 480.0];
        assert_eq!(clamp_to_monitors(b, &[PRIMARY]), b);
        let on_left = [-900.0, 50.0, 360.0, 480.0];
        assert_eq!(clamp_to_monitors(on_left, &[PRIMARY, LEFT]), on_left);
        // Partly off the right edge but the title bar centre is still on screen.
        assert_eq!(clamp_to_monitors([1700.0, 900.0, 360.0, 480.0], &[PRIMARY]), [1700.0, 900.0, 360.0, 480.0]);
        assert_eq!(clamp_to_monitors(b, &[]), b);
    }

    #[test]
    fn bounds_on_a_removed_monitor_move_to_the_primary() {
        assert_eq!(clamp_to_monitors([-900.0, 50.0, 360.0, 480.0], &[PRIMARY]), [0.0, 50.0, 360.0, 480.0]);
        assert_eq!(clamp_to_monitors([2500.0, 2000.0, 360.0, 480.0], &[PRIMARY]), [1560.0, 600.0, 360.0, 480.0]);
        // A window above the screen (title bar unreachable) comes down.
        assert_eq!(clamp_to_monitors([100.0, -400.0, 360.0, 480.0], &[PRIMARY]), [100.0, 0.0, 360.0, 480.0]);
    }

    /// The avatar window's capability; widening it is a security decision (app/README.md, Window permissions).
    #[test]
    fn puppet_capability_is_pinned() {
        let cap: serde_json::Value = serde_json::from_str(include_str!("../capabilities/puppet.json")).unwrap();
        assert_eq!(cap["windows"], serde_json::json!(["puppet"]));
        assert_eq!(
            cap["permissions"],
            serde_json::json!([
                "allow-avatar-load",
                "allow-avatar-image",
                "allow-avatar-fill",
                "allow-puppet-ready",
                "allow-puppet-close",
                "allow-puppet-dock",
                "allow-puppet-set-on-top",
                "allow-puppet-on-top",
                "allow-puppet-set-opacity",
                "core:window:allow-start-dragging",
                "core:window:allow-minimize",
                "core:event:allow-listen",
                "core:event:allow-unlisten"
            ])
        );
    }

    #[test]
    fn oversized_bounds_shrink_to_the_monitor() {
        assert_eq!(clamp_to_monitors([3000.0, 0.0, 2560.0, 1440.0], &[PRIMARY, LEFT]), [0.0, 0.0, 1920.0, 1080.0]);
    }
}

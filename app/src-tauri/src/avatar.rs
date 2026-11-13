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

#[tauri::command]
pub fn puppet_close(app: AppHandle) -> Result<(), String> {
    match app.get_webview_window(LABEL) {
        Some(w) => w.destroy().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

fn build(app: &AppHandle, transparent: bool) -> Result<(), String> {
    let mut b = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("puppet.html".into()))
        .title("Talkerbox Avatar")
        .inner_size(360.0, 480.0)
        .min_inner_size(120.0, 120.0)
        .transparent(transparent);
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

    #[test]
    fn oversized_bounds_shrink_to_the_monitor() {
        assert_eq!(clamp_to_monitors([3000.0, 0.0, 2560.0, 1440.0], &[PRIMARY, LEFT]), [0.0, 0.0, 1920.0, 1080.0]);
    }
}

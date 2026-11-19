//! System glass (Settings > Background > Glass): the windows turn see-through
//! and the system blurs what is behind them, as macOS and Windows 11 draw their
//! own windows. macOS uses Liquid Glass where it has it (macOS 26 and later)
//! and the under-window vibrancy material before; Windows 11 uses Mica. The
//! windows are made transparent when built (it cannot change afterwards), so
//! the page paints an opaque background whenever glass is off.

use std::sync::atomic::{AtomicU8, Ordering};

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

/// 0: off, 1: on over a dark theme, 2: on over a light one.
static STATE: AtomicU8 = AtomicU8::new(0);

/// Whether this system draws glass: macOS, and Windows 11 (Mica).
pub fn supported() -> bool {
    #[cfg(target_os = "macos")]
    return true;
    #[cfg(windows)]
    return windows_version::OsVersion::current().build >= 22000;
    #[cfg(not(any(target_os = "macos", windows)))]
    return false;
}

/// Whether windows are built transparent, so glass can be turned on later.
pub const TRANSPARENT: bool = cfg!(any(target_os = "macos", windows));

/// Applies the current state to `window`: a Commit or Diff window as it opens,
/// or every window when the state changes.
pub fn apply<R: Runtime>(window: &WebviewWindow<R>) {
    let state = STATE.load(Ordering::Relaxed);
    if state == 0 || !supported() {
        let _ = window.set_effects(None);
        return;
    }
    let dark = state == 1;
    // A Commit or Diff window gets the theme's colour behind its page so it
    // does not flash white (Overlays.tsx); that would cover the glass.
    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
    // The material follows the window's appearance, which must be the theme's
    // and not the system's: a dark theme over light glass is unreadable.
    let _ = window.set_theme(Some(if dark { tauri::Theme::Dark } else { tauri::Theme::Light }));
    #[cfg(target_os = "macos")]
    let effects = tauri::window::EffectsBuilder::new()
        .effect(tauri::window::Effect::LiquidGlassRegular)
        .effect(tauri::window::Effect::UnderWindowBackground)
        .state(tauri::window::EffectState::FollowsWindowActiveState)
        .build();
    #[cfg(not(target_os = "macos"))]
    let effects = tauri::window::EffectsBuilder::new()
        .effect(if dark { tauri::window::Effect::MicaDark } else { tauri::window::Effect::MicaLight })
        .build();
    let _ = window.set_effects(effects);
}

/// Turns glass on or off in every window. Returns whether it is on: never
/// where the system has none.
#[tauri::command]
pub fn set_glass(app: AppHandle, on: bool, dark: bool) -> bool {
    let on = on && supported();
    let state = if !on { 0 } else if dark { 1 } else { 2 };
    if STATE.swap(state, Ordering::Relaxed) == state {
        return on;
    }
    for window in app.webview_windows().values() {
        if window.label() == "about" {
            continue;
        }
        apply(window);
        if !on {
            let _ = window.set_theme(None);
        }
    }
    on
}

/// Whether this system draws glass, for Settings to offer it.
#[tauri::command]
pub fn glass_supported() -> bool {
    supported()
}

//! The mouse's back and forward buttons on macOS. WKWebView does not give the
//! page buttons 4 and 5, so a local event monitor reports them as
//! `app://mouse-nav`, with the label of the window clicked in, and the page
//! runs Back or Forward. Elsewhere the page sees them itself (`mouseup` with
//! `button` 3 or 4).
//!
//! The buttons' events are kept from WebKit: it reports every button past the
//! right one as the middle button, and a middle click closes the tab under
//! the pointer.

use std::ffi::c_void;
use std::ptr::NonNull;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSEvent, NSEventMask, NSEventType};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, serde::Serialize)]
struct MouseNav {
    label: Option<String>,
    forward: bool,
}

/// Starts reporting the buttons. Call once, on the main thread (in `setup`).
pub fn install(app: &AppHandle) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let handle = app.clone();
    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit passes a valid event for the duration of the call.
        let ev = unsafe { event.as_ref() };
        let forward = match ev.buttonNumber() {
            3 => false,
            4 => true,
            _ => return event.as_ptr(),
        };
        if ev.r#type() != NSEventType::OtherMouseDown {
            return std::ptr::null_mut();
        }
        let clicked = ev.window(mtm).map(|w| Retained::as_ptr(&w) as *mut c_void);
        let label = clicked.and_then(|ns| {
            handle
                .webview_windows()
                .into_iter()
                .find(|(_, w)| w.ns_window().ok() == Some(ns))
                .map(|(label, _)| label)
        });
        let _ = handle.emit("app://mouse-nav", MouseNav { label, forward });
        std::ptr::null_mut()
    });
    let mask = NSEventMask::OtherMouseDown | NSEventMask::OtherMouseUp | NSEventMask::OtherMouseDragged;
    // SAFETY: the block returns the event it was given, or null to drop it.
    let monitor = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &block) };
    // For as long as Haze runs.
    std::mem::forget(monitor);
}

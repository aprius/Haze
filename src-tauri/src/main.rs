// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().nth(1).as_deref() == Some(haze_lib::pty::HOST_FLAG) {
        if let Err(e) = haze_lib::pty::host::run() {
            eprintln!("haze pty host: {e:#}");
            std::process::exit(1);
        }
        return;
    }
    haze_lib::run();
}

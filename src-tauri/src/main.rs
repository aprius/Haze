// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some(haze_lib::agent_hooks::HOOK_FLAG) {
        haze_lib::agent_hooks::run_hook(&args[2..]);
        return;
    }
    // Deep Code's notify runs Haze with no arguments; the marker in its env
    // (installed by Settings → AI Agents) says which agent reports.
    if args.len() == 1 && haze_lib::agent_hooks::run_notify_hook() {
        return;
    }
    if std::env::args().nth(1).as_deref() == Some(haze_lib::pty::HOST_FLAG) {
        if let Err(e) = haze_lib::pty::host::run() {
            eprintln!("haze pty host: {e:#}");
            std::process::exit(1);
        }
        return;
    }
    if let Ok(cwd) = std::env::current_dir() {
        if haze_lib::cli::is_subcommand(&args, &cwd) {
            attach_console();
            std::process::exit(haze_lib::cli::run(&args));
        }
    }
    if args.get(1).map(String::as_str) == Some(haze_lib::git_auth::CREDENTIAL_FLAG) {
        let action = args.get(2).map(String::as_str);
        std::process::exit(haze_lib::git_auth::run_credential_helper(action));
    }
    haze_lib::run();
}

/// Release builds on Windows have no console of their own; print to the one
/// `haze` was started from.
#[cfg(windows)]
fn attach_console() {
    use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(not(windows))]
fn attach_console() {}

// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some(haze_lib::agent_hooks::HOOK_FLAG) {
        haze_lib::agent_hooks::run_hook(&args[2..]);
        return;
    }
    if std::env::args().nth(1).as_deref() == Some(haze_lib::pty::HOST_FLAG) {
        if let Err(e) = haze_lib::pty::host::run() {
            eprintln!("haze pty host: {e:#}");
            std::process::exit(1);
        }
        return;
    }
    if args.get(1).map(String::as_str) == Some(haze_lib::git_auth::CREDENTIAL_FLAG) {
        let action = args.get(2).map(String::as_str);
        std::process::exit(haze_lib::git_auth::run_credential_helper(action));
    }
    haze_lib::run();
}

//! A program's last output reaches the UI before its exit. The race is
//! rare on macOS (a program cannot exit before the PTY took its output);
//! ConPTY's console host, still drawing after the process ended, makes it
//! likely on Windows. This is the guard where it can run; `settle` in host.rs
//! has the deterministic test.
#![cfg(unix)]

use std::sync::{mpsc, Arc};
use std::time::Duration;

use base64::Engine;
use haze_lib::pty::client::PtyClient;
use haze_lib::pty::protocol::{Event, Reply, Request, SessionSpec};

#[test]
fn output_comes_before_exit() {
    let dir = tempfile::tempdir().unwrap();
    std::env::set_var("HAZE_RUNTIME_DIR", dir.path());
    std::thread::spawn(|| haze_lib::pty::host::run().unwrap());
    std::thread::sleep(Duration::from_millis(300));
    let (tx, events) = mpsc::channel();
    let tx = std::sync::Mutex::new(tx);
    let client = PtyClient::new(Arc::new(move |ev| {
        let _ = tx.lock().unwrap().send(ev);
    }));
    let b64 = base64::engine::general_purpose::STANDARD;

    let mut early = 0;
    for round in 0..50 {
        let Reply::Created { session } = client
            .request(Request::Create {
                spec: SessionSpec {
                    project_id: None,
                    cwd: dir.path().to_string_lossy().into_owned(),
                    cols: 80,
                    rows: 24,
                    title: None,
                    // Lots of output, then exit at once: the reader is still behind.
                    command: Some(vec![
                        "sh".into(),
                        "-c".into(),
                        "head -c 200000 /dev/zero | tr \"\\\\0\" x; echo END-OF-OUTPUT".into(),
                    ]),
                    env: vec![],
                },
            })
            .unwrap()
        else {
            panic!("expected Created")
        };
        client
            .notify(Request::Attach {
                id: session.id.clone(),
            })
            .unwrap();
        let mut seen = String::new();
        loop {
            match events.recv_timeout(Duration::from_secs(20)).unwrap() {
                Some(Event::Snapshot { id, data, .. }) | Some(Event::Output { id, data })
                    if id == session.id =>
                {
                    seen.push_str(&String::from_utf8_lossy(&b64.decode(data).unwrap()));
                }
                Some(Event::Exit { id, .. }) if id == session.id => break,
                _ => {}
            }
        }
        if !seen.contains("END-OF-OUTPUT") {
            early += 1;
            eprintln!("round {round}: exit came before the last output");
        }
        client.request(Request::Close { id: session.id }).unwrap();
    }
    assert_eq!(early, 0, "{early} of 50 exits came before the last output");
}

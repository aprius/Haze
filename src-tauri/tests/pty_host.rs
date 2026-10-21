//! End-to-end: a real host, a real shell, output replay after reattaching.
#![cfg(unix)]

use std::sync::{mpsc, Arc};
use std::time::Duration;

use base64::Engine;
use haze_lib::pty::client::PtyClient;
use haze_lib::pty::protocol::{AgentStatus, Event, Reply, Request, SessionSpec};

fn decode(data: &str) -> String {
    String::from_utf8_lossy(
        &base64::engine::general_purpose::STANDARD
            .decode(data)
            .unwrap(),
    )
    .into_owned()
}

fn client() -> (PtyClient, mpsc::Receiver<Option<Event>>) {
    let (tx, rx) = mpsc::channel();
    let tx = std::sync::Mutex::new(tx);
    let client = PtyClient::new(Arc::new(move |ev| {
        let _ = tx.lock().unwrap().send(ev);
    }));
    (client, rx)
}

#[test]
fn session_survives_client_and_replays_output() {
    let dir = tempfile::tempdir().unwrap();
    std::env::set_var("HAZE_RUNTIME_DIR", dir.path());
    std::thread::spawn(|| haze_lib::pty::host::run().unwrap());
    std::thread::sleep(Duration::from_millis(300));

    let (first, _events) = client();
    let Reply::Created { session } = first
        .request(Request::Create {
            spec: SessionSpec {
                project_id: Some("p1".into()),
                cwd: dir.path().to_string_lossy().into_owned(),
                cols: 80,
                rows: 24,
                title: None,
                command: Some(vec![
                    "sh".into(),
                    "-c".into(),
                    "echo hello-haze; sleep 30".into(),
                ]),
                env: vec![],
            },
        })
        .unwrap()
    else {
        panic!("expected Created")
    };
    std::thread::sleep(Duration::from_millis(500));
    drop(first);

    // A brand-new client (as after restarting Haze) sees the session and its output.
    let (second, events) = client();
    let Reply::Sessions { sessions } = second.request(Request::List).unwrap() else {
        panic!()
    };
    assert!(sessions.iter().any(|s| s.id == session.id && s.running));

    second
        .notify(Request::Attach {
            id: session.id.clone(),
        })
        .unwrap();
    let snapshot = loop {
        match events.recv_timeout(Duration::from_secs(5)).unwrap() {
            Some(Event::Snapshot { data, .. }) => break decode(&data),
            _ => continue,
        }
    };
    assert!(snapshot.contains("hello-haze"), "snapshot was {snapshot:?}");

    // An agent hook reports a state: the list keeps it and attached clients hear about it.
    second
        .request(Request::Agent {
            id: session.id.clone(),
            status: Some(AgentStatus {
                agent: "claude".into(),
                state: "waiting".into(),
                message: Some("needs permission".into()),
                at: 1,
            }),
        })
        .unwrap();
    let Reply::Sessions { sessions } = second.request(Request::List).unwrap() else {
        panic!()
    };
    assert_eq!(
        sessions[0].agent.as_ref().map(|a| a.state.as_str()),
        Some("waiting")
    );
    loop {
        match events.recv_timeout(Duration::from_secs(5)).unwrap() {
            Some(Event::Agent {
                status: Some(s), ..
            }) => {
                assert_eq!(s.agent, "claude");
                break;
            }
            _ => continue,
        }
    }

    // A large paste into a program that is busy must not freeze the host:
    // the write blocks until `cat` reads, and `cat` only reads while its
    // output (echo + copy) keeps being drained.
    let Reply::Created { session: busy } = second
        .request(Request::Create {
            spec: SessionSpec {
                project_id: Some("p1".into()),
                cwd: dir.path().to_string_lossy().into_owned(),
                cols: 80,
                rows: 24,
                title: None,
                command: Some(vec!["sh".into(), "-c".into(), "sleep 1; cat".into()]),
                env: vec![],
            },
        })
        .unwrap()
    else {
        panic!("expected Created")
    };
    let paste = format!("{}\n", "x".repeat(99)).repeat(4000);
    second
        .notify(Request::Write {
            id: busy.id.clone(),
            data: paste,
        })
        .unwrap();
    assert!(matches!(
        second.request(Request::List),
        Ok(Reply::Sessions { .. })
    ));
    second.request(Request::Close { id: busy.id }).unwrap();

    // Stopping a run configuration must stop the program `dotnet run`
    // started, not only `dotnet` itself: Close ends the whole process tree.
    let marker = format!("sleep 4{}", std::process::id() % 1000);
    let Reply::Created { session: run } = second
        .request(Request::Create {
            spec: SessionSpec {
                project_id: Some("p1".into()),
                cwd: dir.path().to_string_lossy().into_owned(),
                cols: 80,
                rows: 24,
                title: None,
                command: Some(vec!["sh".into(), "-c".into(), format!("{marker}; true")]),
                env: vec![],
            },
        })
        .unwrap()
    else {
        panic!("expected Created")
    };
    std::thread::sleep(Duration::from_millis(500));
    let alive = || {
        std::process::Command::new("pgrep")
            .args(["-f", &marker])
            .output()
            .unwrap()
            .status
            .success()
    };
    assert!(alive(), "grandchild should be running");
    second.request(Request::Close { id: run.id }).unwrap();
    std::thread::sleep(Duration::from_millis(500));
    assert!(!alive(), "grandchild survived Close");

    // A shell at its prompt is not busy (closing it needs no question); a
    // command running in it is.
    let Reply::Created { session: shell } = second
        .request(Request::Create {
            spec: SessionSpec {
                project_id: Some("p1".into()),
                cwd: dir.path().to_string_lossy().into_owned(),
                cols: 80,
                rows: 24,
                title: None,
                command: None,
                env: vec![],
            },
        })
        .unwrap()
    else {
        panic!("expected Created")
    };
    let busy = |id: &str| {
        let Reply::Sessions { sessions } = second.request(Request::List).unwrap() else {
            panic!()
        };
        sessions.into_iter().find(|s| s.id == id).unwrap().busy
    };
    let wait_for = |want: bool| {
        let start = std::time::Instant::now();
        while busy(&shell.id) != Some(want) {
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "busy never became {want}"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    wait_for(false);
    second
        .notify(Request::Write {
            id: shell.id.clone(),
            data: "sleep 30\n".into(),
        })
        .unwrap();
    wait_for(true);
    second
        .request(Request::Close {
            id: shell.id.clone(),
        })
        .unwrap();

    second
        .request(Request::Close {
            id: session.id.clone(),
        })
        .unwrap();
    let Reply::Sessions { sessions } = second.request(Request::List).unwrap() else {
        panic!()
    };
    assert!(sessions.is_empty());
}

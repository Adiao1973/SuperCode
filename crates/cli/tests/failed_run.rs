//! Exercise the actual CLI host: protocol errors must end persisted run state.
use std::{
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use supercode_core::db::Store;

fn invoke(root: &std::path::Path, args: &[&str]) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_supercode"))
        .args(args)
        .env("HOME", root)
        .env("SUPERCODE_DB", root.join("test.sqlite"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("CLI fixture timed out");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    child.wait_with_output().unwrap()
}
#[tokio::test]
async fn protocol_failure_marks_new_and_resumed_sessions_failed() {
    let root: PathBuf =
        std::env::temp_dir().join(format!("sc-cli-failure-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join(".supercode")).unwrap();
    let fixture = root.join("peer.mjs");
    std::fs::write(&fixture, r#"
import readline from 'node:readline';
if (process.argv.includes('--version')) { console.log('fixture 1'); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line); if(r.id===undefined)return;
 const answer=result=>send({jsonrpc:'2.0',id:r.id,result});
 if(r.method==='initialize') answer({protocolVersion:1,agentCapabilities:{loadSession:true}});
 else if(r.method==='session/new') answer({sessionId:'persisted-fixture'});
 else if(r.method==='session/load') answer({});
 else if(r.method==='session/prompt') {
  if(r.params.prompt[0].text==='ok') {
   send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'persisted-fixture',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ok'}}}});
   answer({stopReason:'end_turn'});
  } else send({jsonrpc:'2.0',id:r.id,error:{code:-32000,message:'P210 expected protocol failure'}});
 } else answer({});
});
"#).unwrap();
    let definition = serde_json::json!([{"id":"probe","display_name":"Probe","driver_kind":"acp","command":format!("node '{}'",fixture.display()),"version_args":["--version"]}]);
    std::fs::write(root.join(".supercode/agents.json"), definition.to_string()).unwrap();
    let cwd = root.to_str().unwrap();
    let failed = invoke(&root, &["run", "--agent", "probe", "--cwd", cwd, "fail"]);
    assert!(!failed.status.success());
    let store = Store::open(&root.join("test.sqlite")).await.unwrap();
    let first = store.list_sessions().await.unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].status, "failed");
    let succeeded = invoke(&root, &["run", "--agent", "probe", "--cwd", cwd, "ok"]);
    assert!(
        succeeded.status.success(),
        "{}",
        String::from_utf8_lossy(&succeeded.stderr)
    );
    let row = store
        .list_sessions()
        .await
        .unwrap()
        .into_iter()
        .find(|row| row.status == "completed")
        .unwrap();
    let resumed = invoke(&root, &["resume", &row.id, "fail"]);
    assert!(!resumed.status.success());
    let updated = store
        .get_session(uuid::Uuid::parse_str(&row.id).unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(updated.agent_id, "probe");
    assert_eq!(updated.agent_session_id, row.agent_session_id);
    assert_eq!(updated.cwd, row.cwd);
    assert_eq!(updated.status, "failed");
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

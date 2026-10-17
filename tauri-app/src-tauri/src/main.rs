#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod native;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager, WebviewWindow};

type Reply = tokio::sync::oneshot::Sender<Result<Value, String>>;
struct Service {
    input: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    replies: Mutex<HashMap<u64, Reply>>,
    next: AtomicU64,
    ready: Mutex<Option<Result<(), String>>>,
    channels: HashSet<String>,
}
impl Service {
    fn failed(error: String) -> Arc<Self> {
        Arc::new(Self {
            input: Mutex::new(None),
            child: Mutex::new(None),
            replies: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            ready: Mutex::new(Some(Err(error))),
            channels: HashSet::new(),
        })
    }
    fn write(&self, value: Value) -> Result<(), String> {
        let mut input = self.input.lock().map_err(|_| "服务锁异常")?;
        let writer = input.as_mut().ok_or("本地服务已关闭")?;
        serde_json::to_writer(&mut *writer, &value).map_err(|e| e.to_string())?;
        writer
            .write_all(b"\n")
            .and_then(|_| writer.flush())
            .map_err(|e| e.to_string())
    }
    async fn wait_ready(&self) -> Result<(), String> {
        for _ in 0..200 {
            if let Some(result) = self.ready.lock().map_err(|_| "服务锁异常")?.clone() {
                return result;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Err("本地服务启动超时，未操作正式题库".into())
    }
    fn stop(&self, reason: &str) {
        *self.ready.lock().unwrap() = Some(Err(reason.into()));
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.input.lock().unwrap().take();
        for (_, sender) in self.replies.lock().unwrap().drain() {
            let _ = sender.send(Err(reason.into()));
        }
    }
}
fn test_profile() -> Option<std::path::PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var("WRONG_ANSWER_TAURI_FULL_TEST")
        .ok()
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_absolute() && p.starts_with("/private/tmp"))
}
fn secret() -> Result<Vec<u8>, String> {
    if test_profile().is_some() {
        return Ok(vec![27; 32]);
    }
    #[cfg(target_os = "macos")]
    {
        use security_framework::passwords::{get_generic_password, set_generic_password};
        let service = "com.deca.wrong-answer.tauri";
        let account = "local-encryption-v1";
        match get_generic_password(service, account) {
            Ok(key) if key.len() == 32 => Ok(key),
            Ok(_) => Err("系统钥匙串中的应用密钥损坏，拒绝覆盖".into()),
            Err(error) if error.code() == -25300 => {
                let mut key = vec![0u8; 32];
                getrandom::fill(&mut key).map_err(|e| e.to_string())?;
                set_generic_password(service, account, &key)
                    .map_err(|e| format!("系统钥匙串不可用：{e}"))?;
                Ok(key)
            }
            Err(error) => Err(format!("系统钥匙串不可用：{error}")),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("当前迁移版尚未实现本平台安全密钥保存，拒绝降级为明文".into())
    }
}
fn start(app: &tauri::AppHandle) -> Result<Arc<Service>, String> {
    let encryption_key = secret()?;
    let profile = test_profile().unwrap_or(app.path().app_data_dir().map_err(|e| e.to_string())?);
    std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    let runtime = if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../runtime")
    } else {
        app.path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("runtime")
    };
    let mut command = Command::new(runtime.join("node"));
    command
        .arg(runtime.join("service.cjs"))
        .current_dir(&runtime)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env_remove("ELECTRON_RUN_AS_NODE")
        .env_remove("STUDY_TAURI_TEST")
        .env("STUDY_TAURI_DATA", &profile)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if test_profile().is_some() {
        command.env("STUDY_TAURI_TEST", "1");
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动随应用打包的服务：{e}"))?;
    let input = child.stdin.take().ok_or("服务输入不可用")?;
    let output = child.stdout.take().ok_or("服务输出不可用")?;
    let channels: HashSet<String> =
        serde_json::from_str(include_str!("../channels.json")).map_err(|e| e.to_string())?;
    let service = Arc::new(Service {
        input: Mutex::new(Some(input)),
        child: Mutex::new(Some(child)),
        replies: Mutex::new(HashMap::new()),
        next: AtomicU64::new(1),
        ready: Mutex::new(None),
        channels,
    });
    let reader = service.clone();
    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            let Ok(line) = line else {
                break;
            };
            if line.len() > 120_000_000 {
                break;
            }
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match value["kind"].as_str().unwrap_or("") {
                "ready" => {
                    *reader.ready.lock().unwrap() = Some(Ok(()));
                }
                "fatal" => {
                    *reader.ready.lock().unwrap() = Some(Err(value["error"]
                        .as_str()
                        .unwrap_or("服务启动失败")
                        .into()));
                }
                "result" => {
                    if let Some(id) = value["id"].as_u64() {
                        if let Some(sender) = reader.replies.lock().unwrap().remove(&id) {
                            let result = if let Some(error) = value["error"].as_str() {
                                Err(error.into())
                            } else {
                                Ok(value["result"].clone())
                            };
                            let _ = sender.send(result);
                        }
                    }
                }
                "event" => {
                    let _ = handle.emit_to(
                        "main",
                        "business-event",
                        json!({"channel":value["channel"],"data":value["data"]}),
                    );
                }
                "native" => {
                    let host = handle.clone();
                    let reply = reader.clone();
                    tauri::async_runtime::spawn(async move {
                        let result = native::dispatch(
                            &host,
                            value["action"].as_str().unwrap_or(""),
                            value["data"].clone(),
                        )
                        .await;
                        let message = match result {
                            Ok(data) => {
                                json!({"kind":"native-result","id":value["id"],"result":data})
                            }
                            Err(error) => {
                                json!({"kind":"native-result","id":value["id"],"error":error})
                            }
                        };
                        let _ = reply.write(message);
                    });
                }
                _ => {}
            }
        }
        {
            let mut ready = reader.ready.lock().unwrap();
            if !matches!(*ready, Some(Err(_))) {
                *ready = Some(Err("本地服务意外退出，请重新打开应用".into()));
            }
        }
        for (_, sender) in reader.replies.lock().unwrap().drain() {
            let _ = sender.send(Err("本地服务已退出".into()));
        }
    });
    if let Err(error) =
        service.write(json!({"kind":"init","secret":STANDARD.encode(encryption_key)}))
    {
        service.stop(&error);
        return Err(error);
    }
    Ok(service)
}
#[tauri::command]
async fn service_ready(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<Service>>,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("拒绝非主窗口调用".into());
    }
    let ready = state.wait_ready().await;
    if test_profile().is_none() {
        let _ = window.show();
    }
    ready?;
    Ok(test_profile().is_some())
}
#[tauri::command]
async fn service_call(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<Service>>,
    channel: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    if window.label() != "main" || !state.channels.contains(&channel) {
        return Err("拒绝未知业务接口".into());
    }
    state.wait_ready().await?;
    if state.replies.lock().unwrap().len() >= 64 {
        return Err("操作过多，请稍后再试".into());
    }
    let id = state.next.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = tokio::sync::oneshot::channel();
    state.replies.lock().unwrap().insert(id, sender);
    if let Err(error) = state.write(json!({"kind":"call","id":id,"channel":channel,"args":args})) {
        state.replies.lock().unwrap().remove(&id);
        return Err(error);
    }
    let result = tokio::time::timeout(Duration::from_secs(7200), receiver).await;
    state.replies.lock().unwrap().remove(&id);
    result
        .map_err(|_| "操作等待超时，后台数据仍然保留")?
        .map_err(|_| "服务响应中断")?
}
#[tauri::command]
fn smoke_finish(app: tauri::AppHandle, window: WebviewWindow, result: Value) -> Result<(), String> {
    if window.label() != "main" || test_profile().is_none() {
        return Err("未启用隔离测试".into());
    }
    println!("TAURI_FULL_SMOKE={result}");
    app.exit(if result["passed"] == true { 0 } else { 1 });
    Ok(())
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let state = start(app.handle()).unwrap_or_else(Service::failed);
            app.manage(state);
            if test_profile().is_some() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(120));
                    eprintln!("Tauri full smoke timed out");
                    handle.exit(1);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            service_ready,
            service_call,
            smoke_finish
        ])
        .build(tauri::generate_context!())
        .expect("Tauri migration app failed")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Arc<Service>>() {
                    state.stop("应用退出");
                }
            }
        });
}

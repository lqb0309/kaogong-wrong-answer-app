#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

fn validate_report(report: &Value) -> Result<(), String> {
    if report.to_string().len() > 4_000_000 { return Err("报告过大，未保存".into()); }
    let questions = report["questions"].as_array().ok_or("缺少题目")?;
    if questions.is_empty() || questions.len() > 500 { return Err("题量无效".into()); }
    for question in questions {
        let stem = question["stem"].as_str().unwrap_or("");
        let images = question["questionImages"].as_array().map_or(0, |a| a.len());
        let options = question["options"].as_array().ok_or("缺少选项")?;
        if (stem.is_empty() && images == 0) || options.is_empty() { return Err("题干或选项不完整".into()); }
        let correct = question["correctAnswer"].as_str().unwrap_or("");
        let user = question["userAnswer"].as_str().unwrap_or("");
        if correct.is_empty() || user.is_empty() || question["isWrong"].as_bool() != Some(correct != user) { return Err("答案不完整或相互矛盾".into()); }
    }
    let wrong = questions.iter().filter(|q| q["isWrong"] == true).count();
    for (field, actual) in [("total", questions.len()), ("wrong", wrong), ("correct", questions.len() - wrong)] {
        if let Some(expected) = report["summary"][field].as_u64() { if expected != actual as u64 { return Err(format!("报告{}数量不一致", field)); } }
    }
    Ok(())
}
fn database(app: &tauri::AppHandle) -> Result<Connection, String> {
    let dir = lab_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let db = Connection::open(dir.join("lab-only.sqlite")).map_err(|e| e.to_string())?;
    db.execute("CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)", []).map_err(|e| e.to_string())?;
    Ok(db)
}
fn lab_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    if cfg!(debug_assertions) { if let Ok(dir) = std::env::var("WRONG_ANSWER_TAURI_SMOKE_DIR") {
        let path = std::path::PathBuf::from(dir);
        if path.is_absolute() && path.starts_with("/private/tmp") { return Ok(path); }
        return Err("Smoke profile must be an absolute /private/tmp path".into());
    } }
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_pdf(app: tauri::AppHandle, window: WebviewWindow, width: f64, height: f64) -> Result<String, String> {
    if window.label() != "main" || !width.is_finite() || !height.is_finite() || !(500.0..=3000.0).contains(&width) || !(100.0..=120000.0).contains(&height) { return Err("导出尺寸或窗口无效".into()); }
    #[cfg(target_os = "macos")]
    {
        use objc2::MainThreadMarker;
        use objc2_foundation::{NSData, NSError};
        use objc2_web_kit::{WKPDFConfiguration, WKWebView};
        use objc2_core_foundation::{CGRect, CGPoint, CGSize};
        let dir = lab_dir(&app)?.join("exports");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
        let path = dir.join(format!("tauri-long-reader-{stamp}.pdf"));
        let (send, receive) = futures_channel::oneshot::channel::<Result<Vec<u8>, String>>();
        let send = std::sync::Mutex::new(Some(send));
        window.with_webview(move |platform| unsafe {
            let webview = &*(platform.inner() as *const WKWebView);
            let configuration = WKPDFConfiguration::new(MainThreadMarker::new().expect("WKWebView main thread"));
            configuration.setRect(CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(width, height)));
            let block = block2::RcBlock::new(move |data: *mut NSData, error: *mut NSError| {
                let result = if !error.is_null() || data.is_null() { Err("系统生成PDF失败".into()) } else { Ok((&*data).to_vec()) };
                if let Some(sender) = send.lock().unwrap().take() { let _ = sender.send(result); }
            });
            webview.createPDFWithConfiguration_completionHandler(Some(&configuration), &block);
        }).map_err(|e| e.to_string())?;
        let bytes = receive.await.map_err(|e| e.to_string())??;
        if !bytes.starts_with(b"%PDF") { return Err("系统未返回有效PDF".into()); }
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = app; Err("验证版直接PDF仅实现macOS；其他平台请用打印存PDF".into()) }
}
#[tauri::command]
fn smoke_finish(app: tauri::AppHandle, result: Value) -> Result<(), String> {
    if !cfg!(debug_assertions) || std::env::var("WRONG_ANSWER_TAURI_SMOKE_DIR").is_err() { return Err("测试模式未启用".into()); }
    println!("TAURI_SMOKE_RESULT={}", result);
    if result["stage"].is_null() { app.exit(if result["passed"] == true { 0 } else { 1 }); }
    Ok(())
}
fn save_report(app: &tauri::AppHandle, report: Value) -> Result<Value, String> {
    validate_report(&report)?;
    database(app)?.execute("INSERT INTO reports(payload) VALUES (?)", params![report.to_string()]).map_err(|e| e.to_string())?;
    app.emit_to("main", "report-ready", &report).map_err(|e| e.to_string())?;
    Ok(report)
}
#[tauri::command]
fn open_fenbi(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("fenbi") { win.show().map_err(|e| e.to_string())?; return win.set_focus().map_err(|e| e.to_string()); }
    WebviewWindowBuilder::new(&app, "fenbi", WebviewUrl::External("https://www.fenbi.com/spa/tiku/report/profile/xingce/xingce/history".parse().unwrap()))
        .title("粉笔 · Tauri 隔离登录验证").inner_size(1200.0, 800.0)
        .initialization_script(include_str!("../generated-parser.js"))
        .on_navigation(|url| url.scheme() == "https" && (url.host_str() == Some("fenbi.com") || url.host_str().is_some_and(|h| h.ends_with(".fenbi.com"))))
        .build().map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
fn capture_current(app: tauri::AppHandle) -> Result<(), String> {
    let win = app.get_webview_window("fenbi").ok_or("请先打开粉笔并登录")?;
    let url = win.url().map_err(|e| e.to_string())?;
    if url.host_str() != Some("spa.fenbi.com") || !url.path().starts_with("/ti/exam/solution/") { return Err("请先打开已完成练习报告".into()); }
    win.eval("try { window.__TAURI_INTERNALS__.invoke('capture_report', { report: window.__studyCapture() }).catch(e=>alert(String(e))); } catch(e) { alert(String(e.message)); }").map_err(|e| e.to_string())
}
#[tauri::command]
fn capture_report(app: tauri::AppHandle, window: WebviewWindow, report: Value) -> Result<(), String> {
    let url = window.url().map_err(|e| e.to_string())?;
    if window.label() != "fenbi" || url.scheme() != "https" || url.host_str() != Some("spa.fenbi.com") || !url.path().starts_with("/ti/exam/solution/") || report["url"].as_str() != Some(url.as_str()) { return Err("拒绝非报告来源".into()); }
    save_report(&app, report)?;
    Ok(())
}
#[tauri::command]
fn print_reader(window: WebviewWindow) -> Result<(), String> { window.print().map_err(|e| e.to_string()) }
#[tauri::command]
fn read_latest(app: tauri::AppHandle) -> Result<Value, String> {
    let db = database(&app)?;
    let mut stmt = db.prepare("SELECT payload FROM reports ORDER BY id DESC LIMIT 1").map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    match rows.next().map_err(|e| e.to_string())? { Some(row) => { let text: String = row.get(0).map_err(|e| e.to_string())?; serde_json::from_str(&text).map_err(|e| e.to_string()) }, None => Ok(Value::Null) }
}
#[tauri::command]
fn load_demo(app: tauri::AppHandle) -> Result<Value, String> {
    save_report(&app, json!({ "title":"隔离样例：带图公共资料与子题", "url":"demo", "materials":[{"index":1,"text":"某单位2023年有100人，2024年有120人。图示仅用于验证显示比例。","images":[]}], "questions":[{"index":1,"materialIndex":1,"stem":"2024年人数同比增长多少？", "options":[{"key":"A","text":"10%"},{"key":"B","text":"20%"},{"key":"C","text":"30%"},{"key":"D","text":"40%"}],"correctAnswer":"B","userAnswer":"A","isWrong":true,"analysis":"根据增长率=(现期量−基期量)÷基期量，(120−100)÷100=20%，故选B。", "questionImages":["demo-chart.svg"], "optionImages":{}}],"summary":{"total":1,"correct":0,"wrong":1}}))
}
fn main() {
    tauri::Builder::default()
        .setup(|app| { if cfg!(debug_assertions) && std::env::var("WRONG_ANSWER_TAURI_SMOKE_DIR").is_ok() {
            let handle = app.handle().clone();
            std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_secs(40)); eprintln!("Tauri smoke timed out"); handle.exit(1); });
        } Ok(()) })
        .on_page_load(|window, payload| {
            if cfg!(debug_assertions) && std::env::var("WRONG_ANSWER_TAURI_SMOKE_DIR").is_ok() && window.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Finished {
                println!("TAURI_SMOKE_PAGE_READY");
                let _ = window.eval("setTimeout(async()=>{try { await window.runSmoke(); }catch(e){window.__TAURI__.core.invoke('smoke_finish',{result:{passed:false,error:String(e)}})}},300)");
            }
        })
        .invoke_handler(tauri::generate_handler![open_fenbi, capture_current, capture_report, print_reader, load_demo, read_latest, export_pdf, smoke_finish])
        .run(tauri::generate_context!()).expect("Tauri validation app failed");
}
#[cfg(test)]
mod tests {
    use super::*;
    fn report() -> Value { json!({"questions":[{"stem":"测试","options":[{"key":"A","text":"选项"}],"correctAnswer":"A","userAnswer":"B","isWrong":true}],"summary":{"total":1,"wrong":1,"correct":0}}) }
    #[test] fn complete_report() { assert!(validate_report(&report()).is_ok()); }
    #[test] fn partial_report_rejected() { let mut v=report(); v["summary"]["total"]=json!(5); assert!(validate_report(&v).is_err()); }
    #[test] fn missing_answer_rejected() { let mut v=report(); v["questions"][0]["userAnswer"]=json!(""); assert!(validate_report(&v).is_err()); }
    #[test] fn contradictory_answer_rejected() { let mut v=report(); v["questions"][0]["isWrong"]=json!(false); assert!(validate_report(&v).is_err()); }
}

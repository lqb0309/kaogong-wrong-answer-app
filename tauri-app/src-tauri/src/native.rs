use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{sync::Mutex, time::Duration};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

fn window(app: &tauri::AppHandle, data: &Value) -> Result<WebviewWindow, String> {
    let label = data["label"].as_str().ok_or("缺少窗口标识")?;
    if label != "fenbi" && !label.starts_with("paper-") && label != "main" {
        return Err("未知窗口".into());
    }
    app.get_webview_window(label).ok_or("窗口已关闭".into())
}
fn fenbi_url(url: &str) -> Result<tauri::Url, String> {
    let value: tauri::Url = url.parse().map_err(|_| "粉笔地址无效")?;
    if value.scheme() != "https"
        || !value
            .host_str()
            .is_some_and(|host| host == "fenbi.com" || host.ends_with(".fenbi.com"))
    {
        return Err("拒绝非粉笔页面".into());
    }
    Ok(value)
}
pub async fn evaluate(win: WebviewWindow, code: String) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        use objc2::{runtime::AnyObject, MainThreadMarker};
        use objc2_foundation::{NSError, NSString};
        use objc2_web_kit::{WKContentWorld, WKWebView};
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let sender = Mutex::new(Some(sender));
        win.with_webview(move |platform| unsafe {
            let webview = &*(platform.inner() as *const WKWebView);
            let block = block2::RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
                let result = if !error.is_null() {
                    Err((&*error).localizedDescription().to_string())
                } else if value.is_null() {
                    Ok(Value::Null)
                } else {
                    serde_json::from_str::<Value>(&(*(value as *const NSString)).to_string())
                        .map_err(|_| "页面返回格式不正确".into())
                };
                if let Some(sender) = sender.lock().unwrap().take() {
                    let _ = sender.send(result);
                }
            });
            let function =
                NSString::from_str(&format!("return JSON.stringify(await ({code})) ?? null;"));
            webview.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
                &function,
                None,
                None,
                &WKContentWorld::pageWorld(MainThreadMarker::new().expect("WK main thread")),
                Some(&block),
            );
        })
        .map_err(|e| e.to_string())?;
        tokio::time::timeout(Duration::from_secs(35), receiver)
            .await
            .map_err(|_| "页面读取超时")?
            .map_err(|_| "页面读取中断")?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (win, code);
        Err("当前原生页面读取仅实现 macOS".into())
    }
}
async fn load_html(win: WebviewWindow, html: String) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::NSString;
        use objc2_web_kit::WKWebView;
        win.with_webview(move |platform| unsafe {
            let webview = &*(platform.inner() as *const WKWebView);
            webview.loadHTMLString_baseURL(&NSString::from_str(&html), None);
        })
        .map_err(|e| e.to_string())?;
        for _ in 0..100 {
            if let Ok(value) = evaluate(
                win.clone(),
                "document.readyState==='complete' && !!document.querySelector('.test-title')"
                    .into(),
            )
            .await
            {
                if value == true {
                    return Ok(Value::Null);
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Err("PDF 排版页面加载超时".into())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (win, html);
        Err("当前原生 PDF 仅实现 macOS".into())
    }
}
async fn pdf(win: WebviewWindow) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        use objc2::MainThreadMarker;
        use objc2_core_foundation::{CGPoint, CGRect, CGSize};
        use objc2_foundation::{NSData, NSError};
        use objc2_web_kit::{WKPDFConfiguration, WKWebView};
        // Column fragmentation respects break-inside, while WK createPDF alone
        // is continuous. Capture each column separately, preserving only that
        // page's drawing/text, then merge vector pages at A4 size.
        let layout = evaluate(win.clone(), r#"(async()=>{
          await document.fonts.ready;
          await Promise.all([...document.images].map(i=>i.decode().catch(()=>null)));
          if([...document.images].some(i=>!i.naturalWidth))throw Error('图片未完整加载，取消导出');
          const flow=document.createElement('div');flow.id='tauri-paper-flow';
          while(document.body.firstChild)flow.append(document.body.firstChild);
          document.body.append(flow);
          const width=794,height=1123,margin=60;
          document.documentElement.style.cssText='overflow:visible;background:white;width:'+width+'px';
          document.body.style.cssText='margin:0;padding:0;overflow:visible;background:white;width:'+width+'px;height:'+height+'px';
          flow.style.cssText='position:relative;margin:'+margin+'px;width:'+(width-margin*2)+'px;height:'+(height-margin*2)+'px;column-width:'+(width-margin*2)+'px;column-gap:'+(margin*2)+'px;column-fill:auto;';
          if(document.querySelector('.question')?.tagName==='SECTION')flow.style.lineHeight='1.55';
          const style=document.createElement('style');style.textContent='.page-break{break-before:column!important}.group-header,.passage-images{break-after:avoid-column}';document.head.append(style);
          // Hidden WKWebViews may suspend requestAnimationFrame indefinitely.
          // Reading geometry forces layout without requiring a visible window.
          void flow.offsetHeight;
          return {width,height,pages:Math.max(1,Math.ceil((flow.scrollWidth+margin*2)/width))};
        })()"#.into()).await?;
        let width = layout["width"].as_f64().ok_or("排版宽度无效")?;
        let height = layout["height"].as_f64().ok_or("排版高度无效")?;
        let pages = layout["pages"].as_u64().ok_or("排版页数无效")?;
        if pages == 0 || pages > 150 {
            return Err("排版页数超出限制".into());
        }
        evaluate(win.clone(),format!("(()=>{{for(let i=0;i<{pages};i++){{const footer=document.createElement('div');footer.textContent=(i+1)+' / {pages}';footer.style.cssText='position:absolute;left:'+(i*{width})+'px;top:'+({height}-30)+'px;width:{width}px;font:11px Arial;color:#777;text-align:center';document.body.append(footer)}}return true}})()")).await?;
        let mut documents = Vec::new();
        for page in 0..pages {
            let (sender, receiver) = tokio::sync::oneshot::channel();
            let sender = Mutex::new(Some(sender));
            win.with_webview(move |platform| unsafe {
                let webview = &*(platform.inner() as *const WKWebView);
                let configuration =
                    WKPDFConfiguration::new(MainThreadMarker::new().expect("WK main thread"));
                configuration.setRect(CGRect::new(
                    CGPoint::new(width * page as f64, 0.0),
                    CGSize::new(width, height),
                ));
                let block = block2::RcBlock::new(move |data: *mut NSData, error: *mut NSError| {
                    let result = if !error.is_null() || data.is_null() {
                        Err("系统生成PDF失败".to_string())
                    } else {
                        Ok((&*data).to_vec())
                    };
                    if let Some(sender) = sender.lock().unwrap().take() {
                        let _ = sender.send(result);
                    }
                });
                webview.createPDFWithConfiguration_completionHandler(Some(&configuration), &block);
            })
            .map_err(|e| e.to_string())?;
            documents.push(
                tokio::time::timeout(Duration::from_secs(30), receiver)
                    .await
                    .map_err(|_| "PDF 生成超时")?
                    .map_err(|_| "PDF 生成中断")??,
            );
        }
        Ok(Value::String(STANDARD.encode(merge_pdf(documents, width)?)))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = win;
        Err("当前分页 PDF 仅实现 macOS".into())
    }
}
fn merge_pdf(documents: Vec<Vec<u8>>, width: f64) -> Result<Vec<u8>, String> {
    use lopdf::{dictionary, Document, Object, Stream};
    let count = documents.len();
    let mut doc = Document::with_version("1.5");
    let parent = doc.new_object_id();
    let mut kids = Vec::new();
    let scale = 595.28 / width;
    for (index, bytes) in documents.iter().enumerate() {
        let mut source = Document::load_mem(bytes).map_err(|e| e.to_string())?;
        source.renumber_objects_with(doc.max_id + 1);
        doc.max_id = source.max_id;
        let page_id = *source.get_pages().values().next().ok_or("PDF没有页面")?;
        let mut base = source
            .get_object(page_id)
            .and_then(|p| p.as_dict())
            .map_err(|e| e.to_string())?
            .clone();
        if base.get(b"Resources").is_err() {
            let mut parent = base
                .get(b"Parent")
                .and_then(|v| v.as_reference())
                .map_err(|e| e.to_string())?;
            loop {
                let dictionary = source
                    .get_object(parent)
                    .and_then(|v| v.as_dict())
                    .map_err(|e| e.to_string())?;
                if let Ok(resources) = dictionary.get(b"Resources") {
                    base.set("Resources", resources.clone());
                    break;
                }
                parent = dictionary
                    .get(b"Parent")
                    .and_then(|v| v.as_reference())
                    .map_err(|e| e.to_string())?;
            }
        }
        let original = base.get(b"Contents").map_err(|e| e.to_string())?.clone();
        let original = match original {
            Object::Array(items) => items,
            item => vec![item],
        };
        doc.objects.extend(source.objects);
        let begin = doc.add_object(Stream::new(
            dictionary! {},
            format!("q 0 0 595.28 841.89 re W n {scale} 0 0 {scale} 0 0 cm\n").into_bytes(),
        ));
        let _ = index;
        let end = doc.add_object(Stream::new(dictionary! {}, b"\nQ".to_vec()));
        let mut contents = vec![Object::Reference(begin)];
        contents.extend(original.clone());
        contents.push(Object::Reference(end));
        let mut page = base.clone();
        page.set("Parent", parent);
        page.set(
            "MediaBox",
            vec![0.into(), 0.into(), 595.28.into(), 841.89.into()],
        );
        page.set(
            "CropBox",
            vec![0.into(), 0.into(), 595.28.into(), 841.89.into()],
        );
        page.set("Contents", contents);
        page.remove(b"Annots");
        kids.push(Object::Reference(doc.add_object(page)));
    }
    doc.objects.insert(
        parent,
        dictionary! {"Type"=>"Pages","Kids"=>kids,"Count"=>count as i64}.into(),
    );
    let root = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>parent});
    doc.trailer.set("Root", root);
    doc.prune_objects();
    doc.compress();
    let mut output = Vec::new();
    doc.save_to(&mut output).map_err(|e| e.to_string())?;
    Ok(output)
}
pub async fn dispatch(app: &tauri::AppHandle, action: &str, data: Value) -> Result<Value, String> {
    if crate::test_profile().is_some() {
        eprintln!("TAURI_NATIVE_STAGE={action}");
    }
    match action {
        "window-create" => {
            let label = data["label"].as_str().ok_or("缺少窗口")?;
            if label != "fenbi"
                && !label
                    .strip_prefix("paper-")
                    .is_some_and(|s| s.parse::<u64>().is_ok())
            {
                return Err("未知窗口".into());
            }
            if app.get_webview_window(label).is_some() {
                return Ok(Value::Null);
            }
            let url = if label == "fenbi" {
                WebviewUrl::External(fenbi_url("https://www.fenbi.com/")?)
            } else {
                WebviewUrl::App("pdf-host.html".into())
            };
            let handle = app.clone();
            let window_label = label.to_string();
            let popup_handle = app.clone();
            let popup_label = label.to_string();
            let page_handle = app.clone();
            let win = WebviewWindowBuilder::new(app, label, url)
                .title(data["title"].as_str().unwrap_or("粉笔"))
                .inner_size(data["width"].as_f64().unwrap_or(1000.0), data["height"].as_f64().unwrap_or(800.0))
                .visible(data["visible"].as_bool().unwrap_or(false))
                .on_new_window(move |url, _features| {
                    if popup_label == "fenbi" && fenbi_url(url.as_str()).is_ok() { if let Some(win) = popup_handle.get_webview_window("fenbi") { let _ = win.navigate(url); } }
                    tauri::webview::NewWindowResponse::Deny
                })
                .on_page_load(move |win, payload| {
                    if payload.event() == tauri::webview::PageLoadEvent::Finished { if let Some(service) = page_handle.try_state::<std::sync::Arc<crate::Service>>() { let _ = service.write(json!({"kind":"window","label":win.label(),"event":"did-finish-load","url":payload.url().as_str()})); } }
                })
                .on_navigation(move |url| {
                    let allowed = if window_label == "fenbi" { fenbi_url(url.as_str()).is_ok() } else { url.scheme() == "tauri" || url.scheme() == "about" || url.host_str() == Some("tauri.localhost") };
                    if allowed { if let Some(service) = handle.try_state::<std::sync::Arc<crate::Service>>() { let _ = service.write(json!({"kind":"window","label":window_label,"event":"did-start-navigation","url":url.as_str()})); } }
                    allowed
                }).build().map_err(|e| e.to_string())?;
            let handle = app.clone();
            let label = label.to_string();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::Destroyed = event {
                    if let Some(service) = handle.try_state::<std::sync::Arc<crate::Service>>() {
                        let _ =
                            service.write(json!({"kind":"window","label":label,"event":"closed"}));
                    }
                }
            });
            Ok(Value::Null)
        }
        "window-navigate" => {
            let win = window(app, &data)?;
            if win.label() != "fenbi" {
                return Err("仅粉笔窗口可跳转网页".into());
            }
            win.navigate(fenbi_url(data["url"].as_str().ok_or("缺少地址")?)?)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "window-eval" => {
            evaluate(
                window(app, &data)?,
                data["code"].as_str().ok_or("缺少脚本")?.to_string(),
            )
            .await
        }
        "window-url" => Ok(json!(window(app, &data)?
            .url()
            .map_err(|e| e.to_string())?
            .as_str())),
        "window-html" => {
            let win = window(app, &data)?;
            if !win.label().starts_with("paper-") {
                return Err("仅排版窗口可加载文档".into());
            }
            load_html(win, data["html"].as_str().ok_or("缺少文档")?.to_string()).await
        }
        "window-pdf" => {
            let win = window(app, &data)?;
            if !win.label().starts_with("paper-") {
                return Err("仅排版窗口可导出".into());
            }
            pdf(win).await
        }
        "window-show" => {
            let win = window(app, &data)?;
            win.show().map_err(|e| e.to_string())?;
            win.set_focus().map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "window-close" => {
            let win = window(app, &data)?;
            if win.label() == "main" {
                return Err("不能通过后台关闭主窗口".into());
            }
            win.destroy().map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "dialog-open" | "dialog-save" => {
            if let Some(profile) = crate::test_profile() {
                if action == "dialog-save" {
                    let dir = profile.join("exports");
                    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                    let name =
                        std::path::Path::new(data["defaultPath"].as_str().unwrap_or("test.pdf"))
                            .file_name()
                            .ok_or("文件名无效")?;
                    return Ok(json!({"canceled":false,"filePath":dir.join(name)}));
                }
                if data["properties"]
                    .as_array()
                    .is_some_and(|props| props.contains(&json!("openDirectory")))
                {
                    let dir = profile.join("exports");
                    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                    return Ok(json!({"canceled":false,"filePaths":[dir]}));
                }
                return Ok(json!({"canceled":true,"filePaths":[]}));
            }
            let handle = app.clone();
            let save = action == "dialog-save";
            tauri::async_runtime::spawn_blocking(move || {
                let mut picker = handle.dialog().file();
                if let Some(win) = handle.get_webview_window("main") {
                    picker = picker.set_parent(&win);
                }
                if let Some(filters) = data["filters"].as_array() {
                    for filter in filters {
                        let exts: Vec<&str> = filter["extensions"]
                            .as_array()
                            .map(|values| values.iter().filter_map(|s| s.as_str()).collect())
                            .unwrap_or_default();
                        if !exts.is_empty() && !exts.contains(&"*") {
                            picker =
                                picker.add_filter(filter["name"].as_str().unwrap_or("文件"), &exts);
                        }
                    }
                }
                if save {
                    if let Some(file) = data["defaultPath"].as_str() {
                        let path = std::path::Path::new(file);
                        if let Some(parent) = path.parent().filter(|p| p.is_absolute()) {
                            picker = picker.set_directory(parent);
                        }
                        if let Some(name) = path.file_name() {
                            picker = picker.set_file_name(name.to_string_lossy());
                        }
                    }
                    let file = picker.blocking_save_file().and_then(|p| p.into_path().ok());
                    Ok(json!({"canceled":file.is_none(),"filePath":file}))
                } else {
                    let props = data["properties"].as_array().cloned().unwrap_or_default();
                    let files = if props.contains(&json!("openDirectory")) {
                        picker.blocking_pick_folder().map(|p| vec![p])
                    } else if props.contains(&json!("multiSelections")) {
                        picker.blocking_pick_files()
                    } else {
                        picker.blocking_pick_file().map(|p| vec![p])
                    };
                    let paths: Vec<_> = files
                        .unwrap_or_default()
                        .into_iter()
                        .filter_map(|p| p.into_path().ok())
                        .collect();
                    Ok(json!({"canceled":paths.is_empty(),"filePaths":paths}))
                }
            })
            .await
            .map_err(|e| e.to_string())?
        }
        "clipboard-image" => {
            let image = match app.clipboard().read_image() {
                Ok(image) => image,
                Err(_) => return Ok(json!("")),
            };
            let mut png = Vec::new();
            {
                let mut encoder = png::Encoder::new(&mut png, image.width(), image.height());
                encoder.set_color(png::ColorType::Rgba);
                encoder.set_depth(png::BitDepth::Eight);
                encoder
                    .write_header()
                    .map_err(|e| e.to_string())?
                    .write_image_data(image.rgba())
                    .map_err(|e| e.to_string())?;
            }
            Ok(json!(STANDARD.encode(png)))
        }
        "open" => {
            let target = data["target"].as_str().ok_or("缺少打开目标")?;
            if !std::path::Path::new(target).is_absolute()
                && !["https://", "http://", "obsidian://"]
                    .iter()
                    .any(|prefix| target.starts_with(prefix))
            {
                return Err("拒绝未知协议".into());
            }
            #[cfg(target_os = "macos")]
            {
                std::process::Command::new("/usr/bin/open")
                    .arg("--")
                    .arg(target)
                    .spawn()
                    .map_err(|e| e.to_string())?;
                Ok(json!(""))
            }
            #[cfg(not(target_os = "macos"))]
            {
                Err("打开文件功能尚未适配本平台".into())
            }
        }
        "notification" => {
            app.notification()
                .builder()
                .title(data["title"].as_str().unwrap_or("学习任务"))
                .body(data["body"].as_str().unwrap_or(""))
                .show()
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "restart" => {
            app.restart();
        }
        _ => Err("未知系统操作".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn navigation_only_fenbi_https() {
        assert!(fenbi_url("https://spa.fenbi.com/ti/exam/solution/1").is_ok());
        for url in [
            "http://fenbi.com/",
            "https://fenbi.com.evil.test/",
            "file:///etc/passwd",
            "javascript:alert(1)",
        ] {
            assert!(fenbi_url(url).is_err());
        }
    }
}

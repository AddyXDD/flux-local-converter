#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::Path,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    sync::Mutex,
};
use tauri::{Emitter, Manager, State};
use tauri_plugin_fs::FsExt;

const MAX_OUTPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_OUTPUT_BASE64_BYTES: usize = MAX_OUTPUT_BYTES.div_ceil(3) * 4;

#[cfg(windows)]
use windows::{
    core::{w, BOOL, PCWSTR},
    Win32::{
        Foundation::{HWND, LPARAM, POINT, RECT, WPARAM},
        Graphics::Gdi::{CreateEllipticRgn, DeleteObject, MapWindowPoints, SetWindowRgn, HGDIOBJ},
        UI::WindowsAndMessaging::{
            EnumWindows, FindWindowExW, FindWindowW, GetClassNameW, GetParent, GetWindowLongPtrW,
            GetWindowRect, SendMessageTimeoutW, SetParent, SetWindowLongPtrW, SetWindowPos,
            GWL_STYLE, SEND_MESSAGE_TIMEOUT_FLAGS, SET_WINDOW_POS_FLAGS, SMTO_ABORTIFHUNG,
            SMTO_NORMAL, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOZORDER, WINDOW_LONG_PTR_INDEX,
            WS_CHILD, WS_POPUP,
        },
    },
};

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

static TEMP_ID: AtomicU64 = AtomicU64::new(0);
static DESKTOP_WIDGET_READY: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
fn replace_output_file(temp: &Path, target: &Path) -> Result<(), std::io::Error> {
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        },
    };

    let temp: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        MoveFileExW(
            PCWSTR(temp.as_ptr()),
            PCWSTR(target.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error.to_string()))
}

#[cfg(not(windows))]
fn replace_output_file(temp: &Path, target: &Path) -> Result<(), std::io::Error> {
    fs::rename(temp, target)
}

fn write_output_atomic_blocking(
    path: String,
    source_path: Option<String>,
    bytes: Vec<u8>,
) -> Result<(), String> {
    if bytes.is_empty() {
        return Err("The converter produced an empty file".into());
    }
    if bytes.len() > MAX_OUTPUT_BYTES {
        return Err("The converted file is larger than the current safe 32 MB limit".into());
    }
    let target = Path::new(&path);
    let parent = target
        .parent()
        .ok_or("The output path has no parent folder")?;
    if !parent.is_dir() {
        return Err("The selected output folder no longer exists".into());
    }
    if let Some(source_path) = source_path {
        let source = Path::new(&source_path);
        if let (Ok(source), Ok(destination)) = (source.canonicalize(), target.canonicalize()) {
            if source == destination {
                return Err(
                    "The output path points to the original file. Choose a different filename."
                        .into(),
                );
            }
        }
    }
    target.file_name().ok_or("The output filename is invalid")?;
    match target
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" if !bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) => {
            return Err("Output verification failed: the bytes are not a PNG image".into())
        }
        "jpg" | "jpeg" if !bytes.starts_with(&[255, 216, 255]) => {
            return Err("Output verification failed: the bytes are not a JPEG image".into())
        }
        "webp" if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" => {
            return Err("Output verification failed: the bytes are not a WebP image".into())
        }
        "bmp" if !bytes.starts_with(b"BM") => {
            return Err("Output verification failed: the bytes are not a BMP image".into())
        }
        "pdf" if !bytes.starts_with(b"%PDF-") => {
            return Err("Output verification failed: the bytes are not a PDF document".into())
        }
        "docx" if bytes.len() < 4 || !bytes.starts_with(b"PK\x03\x04") => {
            return Err("Output verification failed: the bytes are not a DOCX package".into())
        }
        "json" if serde_json::from_slice::<serde_json::Value>(&bytes).is_err() => {
            return Err("Output verification failed: the JSON is not valid".into())
        }
        "txt" | "csv" | "xml" | "yaml" | "yml" | "md" | "html"
            if std::str::from_utf8(&bytes).is_err() =>
        {
            return Err("Output verification failed: the text is not valid UTF-8".into())
        }
        _ => {}
    }
    let mut temp_path = None;
    let mut temp_file: Option<File> = None;
    for _ in 0..8 {
        let id = TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!(".flux-{}-{id}.tmp", std::process::id()));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => {
                temp_path = Some(candidate);
                temp_file = Some(file);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Could not create a temporary output: {error}")),
        }
    }
    let temp_path = temp_path.ok_or("Could not allocate a temporary output file")?;
    let result = (|| {
        let mut file = temp_file.expect("temporary file was allocated");
        file.write_all(&bytes)
            .map_err(|e| format!("Could not write the converted file: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("Could not verify the converted file was written: {e}"))?;
        if file
            .metadata()
            .map_err(|e| format!("Could not inspect the temporary output: {e}"))?
            .len()
            != bytes.len() as u64
        {
            return Err(
                "Output verification failed: the temporary file size does not match".into(),
            );
        }
        drop(file);
        replace_output_file(&temp_path, target)
            .map_err(|e| format!("Could not finalize the output file: {e}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn decode_output_base64(value: &str) -> Result<Vec<u8>, String> {
    if value.len() > MAX_OUTPUT_BASE64_BYTES {
        return Err("The converted file is larger than the current safe 32 MB limit".into());
    }
    let bytes = BASE64_STANDARD
        .decode(value)
        .map_err(|_| "The converted file payload was not valid Base64")?;
    if bytes.is_empty() {
        return Err("The converter produced an empty file".into());
    }
    if bytes.len() > MAX_OUTPUT_BYTES {
        return Err("The converted file is larger than the current safe 32 MB limit".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod output_tests {
    use super::{decode_output_base64, write_output_atomic_blocking};
    use crate::{
        __cmd__write_output_atomic, __tauri_command_name_write_output_atomic, write_output_atomic,
    };
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    static TEST_ID: AtomicU64 = AtomicU64::new(0);

    fn test_dir() -> PathBuf {
        let id = TEST_ID.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("flux-output-test-{}-{id}", std::process::id()));
        fs::create_dir_all(&path).expect("create isolated test directory");
        path
    }

    #[test]
    fn writes_new_output() {
        let dir = test_dir();
        let output = dir.join("result.txt");
        write_output_atomic_blocking(
            output.to_string_lossy().into_owned(),
            None,
            b"converted".to_vec(),
        )
        .expect("first export should succeed");
        assert_eq!(fs::read(&output).expect("read result"), b"converted");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn replaces_existing_output_and_removes_the_temporary_file() {
        let dir = test_dir();
        let output = dir.join("result.txt");
        fs::write(&output, b"older export").expect("seed existing output");
        write_output_atomic_blocking(
            output.to_string_lossy().into_owned(),
            None,
            b"new export".to_vec(),
        )
        .expect("repeat export should replace the prior result");
        assert_eq!(fs::read(&output).expect("read result"), b"new export");
        assert_eq!(
            fs::read_dir(&dir).expect("list result directory").count(),
            1
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn decodes_base64_export_and_writes_the_original_bytes() {
        let dir = test_dir();
        let output = dir.join("result.txt");
        let bytes = decode_output_base64("Y29udmVydGVk").expect("decode export bytes");
        write_output_atomic_blocking(output.to_string_lossy().into_owned(), None, bytes)
            .expect("write decoded export");
        assert_eq!(fs::read(&output).expect("read result"), b"converted");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_invalid_base64_output() {
        assert!(decode_output_base64("not base64!").is_err());
    }

    #[test]
    fn writes_export_through_tauri_json_ipc() {
        let dir = test_dir();
        let output = dir.join("ipc-result.txt");
        let app = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![write_output_atomic])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build mock Tauri app");
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("build mock webview window");
        let request = tauri::webview::InvokeRequest {
            cmd: "write_output_atomic".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "http://tauri.localhost".parse().expect("parse Tauri URL"),
            body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                "path": output.to_string_lossy(),
                "sourcePath": null,
                "dataBase64": "Y29udmVydGVk"
            })),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        };

        let response = tauri::test::get_ipc_response(&window, request);
        assert!(response.is_ok(), "JSON IPC export failed: {response:?}");
        assert_eq!(fs::read(&output).expect("read IPC export"), b"converted");
        let _ = fs::remove_dir_all(dir);
    }
}

fn write_startup_log(message: &str) {
    let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    let directory = Path::new(&local_app_data).join("FLUX");
    if fs::create_dir_all(&directory).is_err() {
        return;
    }
    let path = directory.join("startup.log");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or_default();
        let _ = writeln!(file, "{timestamp} {message}");
    }
}

#[tauri::command(rename_all = "camelCase")]
async fn write_output_atomic(
    path: String,
    source_path: Option<String>,
    data_base64: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = decode_output_base64(&data_base64)?;
        write_output_atomic_blocking(path, source_path, bytes)
    })
    .await
    .map_err(|error| format!("Could not finish saving the converted file: {error}"))?
}

fn context_files(args: &[String]) -> Vec<String> {
    let Some(index) = args.iter().position(|arg| arg == "--convert") else {
        return Vec::new();
    };
    args.iter()
        .skip(index + 1)
        .take_while(|arg| !arg.starts_with("--"))
        .cloned()
        .collect()
}

#[cfg(windows)]
#[derive(Default)]
struct DesktopHosts {
    progman: HWND,
    wallpaper: HWND,
}

#[cfg(windows)]
unsafe extern "system" fn find_wallpaper_host(top: HWND, result: LPARAM) -> BOOL {
    let hosts = &mut *(result.0 as *mut DesktopHosts);
    let mut class_name = [0u16; 64];
    let length = GetClassNameW(top, &mut class_name);
    if length > 0 && String::from_utf16_lossy(&class_name[..length as usize]) == "Progman" {
        hosts.progman = top;
    }
    let has_desktop_view =
        FindWindowExW(Some(top), None, w!("SHELLDLL_DefView"), PCWSTR::null()).is_ok();
    if has_desktop_view {
        if let Ok(host) = FindWindowExW(None, Some(top), w!("WorkerW"), PCWSTR::null()) {
            if !host.is_invalid() {
                hosts.wallpaper = host;
            }
        }
    }
    BOOL(1)
}

#[cfg(windows)]
fn enumerate_desktop_hosts() -> Result<DesktopHosts, String> {
    let mut hosts = DesktopHosts::default();
    unsafe {
        EnumWindows(
            Some(find_wallpaper_host),
            LPARAM(&mut hosts as *mut DesktopHosts as isize),
        )
    }
    .map_err(|e| format!("Could not inspect Windows desktop layers: {e}"))?;
    Ok(hosts)
}

#[cfg(windows)]
fn find_desktop_wallpaper_host() -> Result<HWND, String> {
    let mut hosts = enumerate_desktop_hosts()?;
    if !hosts.wallpaper.is_invalid() {
        return Ok(hosts.wallpaper);
    }
    if hosts.progman.is_invalid() {
        hosts.progman = unsafe { FindWindowW(w!("Progman"), PCWSTR::null()) }.unwrap_or_default();
    }
    if hosts.progman.is_invalid() {
        return Err("Could not locate the Windows desktop".into());
    }
    unsafe {
        SendMessageTimeoutW(
            hosts.progman,
            0x052C,
            WPARAM(0xD),
            LPARAM(1),
            SEND_MESSAGE_TIMEOUT_FLAGS(SMTO_NORMAL.0 | SMTO_ABORTIFHUNG.0),
            1000,
            None,
        );
    }
    for _ in 0..10 {
        std::thread::sleep(std::time::Duration::from_millis(50));
        hosts = enumerate_desktop_hosts()?;
        if !hosts.wallpaper.is_invalid() {
            return Ok(hosts.wallpaper);
        }
    }
    // Progman is still part of the desktop layer. This fallback keeps FLUX
    // on the wallpaper surface if Explorer does not create a separate host.
    Ok(hosts.progman)
}

#[cfg(windows)]
fn apply_desktop_widget(
    window: &tauri::WebviewWindow,
    screen_x: i32,
    screen_y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let hwnd = HWND(hwnd.0);
    if width <= 0 || height <= 0 {
        return Err("FLUX window has no drawable size".into());
    }

    let host = find_desktop_wallpaper_host()?;
    let style_index: WINDOW_LONG_PTR_INDEX = GWL_STYLE;
    let original_style = unsafe { GetWindowLongPtrW(hwnd, style_index) };
    let child_style = (original_style & !(WS_POPUP.0 as isize)) | WS_CHILD.0 as isize;
    unsafe { SetWindowLongPtrW(hwnd, style_index, child_style) };
    let _ = unsafe { SetParent(hwnd, Some(host)) };
    let parent = unsafe { GetParent(hwnd) };
    if !parent.is_ok_and(|parent| parent == host) {
        unsafe { SetWindowLongPtrW(hwnd, style_index, original_style) };
        return Err("Could not attach FLUX to the Windows desktop wallpaper layer".into());
    }

    let mut position = [POINT {
        x: screen_x,
        y: screen_y,
    }];
    unsafe { MapWindowPoints(None, Some(host), &mut position) };
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            position[0].x,
            position[0].y,
            width,
            height,
            SET_WINDOW_POS_FLAGS(SWP_NOACTIVATE.0 | SWP_NOZORDER.0 | SWP_FRAMECHANGED.0),
        )
    }
    .map_err(|e| format!("Could not position the FLUX desktop widget: {e}"))?;

    let region = unsafe { CreateEllipticRgn(0, 0, width, height) };
    if region.0.is_null() {
        return Err("Windows could not allocate a circular window region".into());
    }
    if unsafe { SetWindowRgn(hwnd, Some(region), true) } == 0 {
        let _ = unsafe { DeleteObject(HGDIOBJ(region.0)) };
        return Err("Windows could not apply the circular window region".into());
    }
    Ok(())
}

#[tauri::command]
fn take_pending_files(queue: State<'_, Mutex<Vec<String>>>) -> Vec<String> {
    queue
        .lock()
        .map(|mut paths| std::mem::take(&mut *paths))
        .unwrap_or_default()
}

fn main() {
    let initial_files = context_files(&std::env::args().collect::<Vec<_>>());
    tauri::Builder::default()
        .manage(Mutex::new(initial_files))
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let files = context_files(&args);
            if !files.is_empty() {
                for path in &files {
                    let _ = app.fs_scope().allow_file(path);
                }
                if let Ok(mut queue) = app.state::<Mutex<Vec<String>>>().lock() {
                    queue.extend(files);
                }
                let _ = app.emit("flux:files-pending", ());
            }
            if DESKTOP_WIDGET_READY.load(Ordering::Acquire) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(move |app| {
            if let Ok(paths) = app.state::<Mutex<Vec<String>>>().lock() {
                for path in paths.iter() {
                    let _ = app.fs_scope().allow_file(path);
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                let placement = (|| -> Result<(i32, i32, i32, f64), String> {
                    let monitor = window
                        .primary_monitor()
                        .map_err(|e| e.to_string())?
                        .ok_or("No primary monitor is available")?;
                    let scale = window.scale_factor().map_err(|e| e.to_string())?;
                    let widget_size = (220.0 * scale).round() as i32;
                    if widget_size <= 0 {
                        return Err("The FLUX desktop widget resolved to an invalid size".into());
                    }
                    let area = monitor.work_area();
                    let margin = (18.0 * monitor.scale_factor()).round() as i32;
                    let x = area.position.x + area.size.width as i32 - widget_size - margin;
                    let y = area.position.y + margin;
                    Ok((x, y, widget_size, scale))
                })();
                let host_result = placement.and_then(|(x, y, size, scale)| {
                    apply_desktop_widget(&window, x, y, size, size)
                        .map(|()| (x, y, size, scale))
                });
                match host_result {
                    Ok((x, y, size, scale)) => {
                        if let Err(error) = window.show() {
                            write_startup_log(&format!("Could not show the desktop widget: {error}"));
                            return Ok(());
                        }
                        // Showing a hidden WebView can cause Windows to restore its
                        // initial placeholder size, so reassert the wallpaper parent,
                        // 220-DIP dimensions, and circular hit-test region afterwards.
                        if let Err(error) = apply_desktop_widget(&window, x, y, size, size) {
                            let _ = window.hide();
                            write_startup_log(&format!("FLUX stayed hidden because final desktop attachment failed: {error}"));
                            return Ok(());
                        }
                        DESKTOP_WIDGET_READY.store(true, Ordering::Release);
                        let native = window.hwnd().ok().map(|handle| HWND(handle.0));
                        if let Some(hwnd) = native {
                            let mut rect = RECT::default();
                            let bounds = unsafe { GetWindowRect(hwnd, &mut rect) }
                                .map(|()| format!("{}x{}", rect.right - rect.left, rect.bottom - rect.top))
                                .unwrap_or_else(|_| "unknown-size".into());
                            let parent = unsafe { GetParent(hwnd) }
                                .map(|parent| format!("{:?}", parent.0))
                                .unwrap_or_else(|_| "unknown-parent".into());
                            let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) };
                            write_startup_log(&format!("Attached FLUX at scale {scale:.2}, physical bounds {bounds}, parent {parent}, style 0x{style:X}."));
                        } else {
                            write_startup_log("Attached the 220 logical-pixel FLUX widget to the desktop wallpaper layer.");
                        }
                    }
                    Err(error) => {
                        write_startup_log(&format!("FLUX stayed hidden because desktop hosting failed: {error}"));
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            write_output_atomic,
            take_pending_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running FLUX");
}

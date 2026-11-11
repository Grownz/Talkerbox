mod config;
mod discovery;
mod download;
mod hf;
mod names;
mod ollama;
mod tts;

use config::Settings;
use ollama::{ChatMessage, ModelInfo};
use serde::Serialize;
use std::collections::HashMap;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Manager, RunEvent, State};
use tokio::sync::Notify;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

type Res<T> = Result<T, String>;

/// Progress update streamed to the frontend over a Tauri channel.
#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub message: String,
    pub completed: Option<u64>,
    pub total: Option<u64>,
}

pub fn net_err(e: reqwest::Error) -> String {
    if e.is_connect() {
        "Connection refused: is the server running?".into()
    } else if e.is_timeout() {
        "Request timed out".into()
    } else {
        format!("Network error: {e}")
    }
}

/// Configures a child process to run hidden with stdout/stderr appended to `log`.
pub fn background(cmd: &mut Command, log: &Path) -> Res<()> {
    if let Some(dir) = log.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let f = std::fs::OpenOptions::new().create(true).append(true).open(log).map_err(|e| format!("{}: {e}", log.display()))?;
    let f2 = f.try_clone().map_err(|e| e.to_string())?;
    cmd.stdin(Stdio::null()).stdout(f).stderr(f2).creation_flags(CREATE_NO_WINDOW);
    Ok(())
}

/// Kills a child and its descendants (ollama serve spawns runner processes).
fn kill_tree(child: &mut Child) {
    let ok = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &child.id().to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if !ok {
        let _ = child.kill();
    }
    let _ = child.wait();
}

/// A Windows job object with KILL_ON_JOB_CLOSE: its handle closes when Talkerbox exits for any reason
/// (including a crash), which kills every assigned process and its descendants.
struct KillJob(isize);

impl KillJob {
    fn new() -> Option<Self> {
        use windows_sys::Win32::System::JobObjects::*;
        // SAFETY: plain Win32 calls with valid pointers; the struct is zero-initialised as the API allows.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of_val(&info) as u32,
            );
            (ok != 0).then_some(KillJob(job as isize))
        }
    }

    fn assign(&self, child: &Child) {
        use std::os::windows::io::AsRawHandle;
        // SAFETY: both handles are valid for the duration of the call. Failure only loses crash cleanup.
        unsafe { windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(self.0 as _, child.as_raw_handle() as _) };
    }
}

/// Returns the exit description if the child has exited.
fn exited(child: &mut Child) -> Option<String> {
    child.try_wait().ok().flatten().map(|s| s.to_string())
}

#[derive(Default)]
struct TtsProc {
    child: Option<Child>,
    port: Option<u16>,
}

struct AppState {
    http: reqwest::Client,
    ollama: Mutex<Option<Child>>,
    tts: Mutex<TtsProc>,
    cancels: Mutex<HashMap<String, Arc<Notify>>>,
    job: Option<KillJob>,
}

impl AppState {
    fn track(&self, child: &Child) {
        if let Some(j) = &self.job {
            j.assign(child);
        }
    }
    /// Registers a cancellable operation; the returned guard unregisters it on drop.
    fn op(&self, id: &str) -> OpGuard<'_> {
        let n = Arc::new(Notify::new());
        self.cancels.lock().unwrap().insert(id.to_string(), n.clone());
        OpGuard { state: self, id: id.to_string(), notify: n }
    }
    fn kill_children(&self) {
        if let Some(mut c) = self.ollama.lock().unwrap().take() {
            kill_tree(&mut c);
        }
        stop_tts_proc(self);
    }
}

struct OpGuard<'a> {
    state: &'a AppState,
    id: String,
    notify: Arc<Notify>,
}

impl Drop for OpGuard<'_> {
    fn drop(&mut self) {
        self.state.cancels.lock().unwrap().remove(&self.id);
    }
}

/// Large files and logs go to the local (non-roaming) app data dir.
fn data_dir(app: &AppHandle) -> Res<PathBuf> {
    app.path().app_local_data_dir().map_err(|e| format!("No app data dir: {e}"))
}

fn send<T: tauri::ipc::IpcResponse + Clone>(ch: &Channel<T>, v: T) {
    // A closed channel only means the window went away; the operation itself still completes.
    let _ = ch.send(v);
}

fn valid_model_name(name: &str) -> Res<()> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || "._-:/".contains(c)) {
        return Err("Model name may only contain letters, digits and . _ - : /".into());
    }
    Ok(())
}

// ---------- settings ----------

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    config::load(&app)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Res<()> {
    config::save_from_ui(&app, settings)
}

// ---------- ollama process ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OllamaStatus {
    running: bool,
    version: Option<String>,
    exe: Option<String>,
    started_by_app: bool,
}

#[tauri::command]
async fn ollama_status(app: AppHandle, state: State<'_, AppState>) -> Res<OllamaStatus> {
    let version = ollama::version(&state.http).await;
    let started_by_app = {
        let mut g = state.ollama.lock().unwrap();
        if g.as_mut().is_some_and(|c| exited(c).is_some()) {
            *g = None;
        }
        g.is_some()
    };
    let saved = config::load(&app).ollama_path.map(PathBuf::from);
    let exe = discovery::find_on_system(saved.as_deref()).map(|p| p.display().to_string());
    Ok(OllamaStatus { running: version.is_some(), version, exe, started_by_app })
}

/// Validates a user-picked folder or exe and persists it.
#[tauri::command]
fn set_ollama_path(app: AppHandle, path: String) -> Res<String> {
    let exe = discovery::exe_from_user_path(Path::new(path.trim()), |p| p.is_dir())
        .ok_or("Please pick ollama.exe or the folder containing it")?;
    if !exe.is_file() {
        return Err(format!("{} does not exist", exe.display()));
    }
    let exe = exe.display().to_string();
    config::update(&app, |s| s.ollama_path = Some(exe.clone()))?;
    Ok(exe)
}

#[tauri::command]
async fn ollama_start(app: AppHandle, state: State<'_, AppState>) -> Res<OllamaStatus> {
    if ollama::version(&state.http).await.is_none() {
        let saved = config::load(&app).ollama_path.map(PathBuf::from);
        let exe = discovery::find_on_system(saved.as_deref()).ok_or("ollama.exe not found; set its path first")?;
        let child = ollama::spawn_serve(&exe, &data_dir(&app)?.join("logs").join("ollama-serve.log"))?;
        state.track(&child);
        *state.ollama.lock().unwrap() = Some(child);
        let start = Instant::now();
        loop {
            if ollama::version(&state.http).await.is_some() {
                break;
            }
            let gone = state.ollama.lock().unwrap().as_mut().and_then(exited);
            if let Some(code) = gone {
                *state.ollama.lock().unwrap() = None;
                return Err(format!("ollama serve exited ({code}); see logs/ollama-serve.log in the app data folder"));
            }
            if start.elapsed() > Duration::from_secs(20) {
                return Err("ollama serve did not respond within 20 s".into());
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }
    ollama_status(app, state).await
}

#[tauri::command]
async fn ollama_stop(app: AppHandle, state: State<'_, AppState>) -> Res<OllamaStatus> {
    let child = state.ollama.lock().unwrap().take();
    match child {
        Some(mut c) => tauri::async_runtime::spawn_blocking(move || kill_tree(&mut c)).await.map_err(|e| e.to_string())?,
        None => return Err("Ollama was not started by Talkerbox; stop it from its tray icon instead".into()),
    }
    ollama_status(app, state).await
}

// ---------- chat & models ----------

#[tauri::command]
async fn list_models(app: AppHandle, state: State<'_, AppState>) -> Res<Vec<ModelInfo>> {
    let mut models = ollama::tags(&state.http).await?;
    let stored = config::load(&app).display_names;
    for m in &mut models {
        m.display_name = stored.get(&m.name).cloned().unwrap_or_else(|| names::from_id(&m.name));
    }
    Ok(models)
}

#[tauri::command]
async fn delete_model(app: AppHandle, state: State<'_, AppState>, name: String) -> Res<()> {
    ollama::delete(&state.http, &name).await?;
    config::update(&app, |s| s.display_names.remove(&name))?;
    Ok(())
}

/// Canonical HF repo id from the HuggingFace API (bounded timeout); None on any failure.
async fn hf_repo_id(http: &reqwest::Client, repo: &str) -> Option<String> {
    let url = format!("https://huggingface.co/api/models/{repo}");
    let v: serde_json::Value = http.get(url).timeout(Duration::from_secs(5)).send().await.ok()?.error_for_status().ok()?.json().await.ok()?;
    v.get("id").and_then(|i| i.as_str()).map(str::to_owned)
}

/// Streams reply tokens over `on_token`. Resolves to true if cancelled via `cancel`.
#[tauri::command]
async fn chat(state: State<'_, AppState>, id: String, model: String, messages: Vec<ChatMessage>, on_token: Channel<String>) -> Res<bool> {
    let op = state.op(&id);
    ollama::chat(&state.http, &model, &messages, &op.notify, |t| {
        send(&on_token, t);
        Ok(())
    })
    .await
}

#[tauri::command]
fn cancel(state: State<'_, AppState>, id: String) {
    if let Some(n) = state.cancels.lock().unwrap().get(&id) {
        n.notify_one();
    }
}

#[tauri::command]
async fn pull_model(state: State<'_, AppState>, id: String, input: String, on_progress: Channel<Progress>) -> Res<bool> {
    let name = hf::pull_target(&input)?;
    let op = state.op(&id);
    send(&on_progress, Progress { message: format!("Pulling {name}"), completed: None, total: None });
    ollama::pull(&state.http, &name, &op.notify, |p| send(&on_progress, p)).await
}

/// Downloads a .gguf from any http(s) URL (resumable), then imports it into Ollama as `model_name`.
#[tauri::command]
async fn import_gguf_url(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    url: String,
    model_name: String,
    on_progress: Channel<Progress>,
) -> Res<bool> {
    let model_name = model_name.trim();
    valid_model_name(model_name)?;
    let (url, file) = download::safe_file_name(&url)?;
    let dest = data_dir(&app)?.join("gguf").join(&file);
    let hf_repo = names::hf_repo_from_url(&url);
    let op = state.op(&id);
    if download::download(&state.http, url, &dest, &op.notify, |p| send(&on_progress, p)).await? {
        return Ok(true);
    }
    if ollama::import_gguf(&state.http, &dest, model_name, &op.notify, |p| send(&on_progress, p)).await? {
        return Ok(true);
    }
    // Ollama keeps its own copy of the blob; drop ours to avoid storing the model twice.
    let _ = tokio::fs::remove_file(&dest).await;
    let repo = match hf_repo {
        Some(r) => Some(hf_repo_id(&state.http, &r).await.unwrap_or(r)),
        None => None,
    };
    let display = names::for_import(repo.as_deref(), &file);
    // Ollama lists untagged names as `<name>:latest`.
    let key = if model_name.contains(':') { model_name.to_string() } else { format!("{model_name}:latest") };
    config::update(&app, |s| s.display_names.insert(key, display))?;
    Ok(false)
}

// ---------- TTS ----------

#[derive(Serialize)]
struct TtsFile {
    name: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TtsStatus {
    sidecar_present: bool,
    /// Why the sidecar is unavailable (paths checked), when it is.
    sidecar_error: Option<String>,
    model_ready: bool,
    model_file: Option<TtsFile>,
    voices_file: Option<TtsFile>,
    running: bool,
    model_dir: String,
    /// True when the user pointed Talkerbox at an existing folder instead of the app data dir.
    custom_dir: bool,
    default_model_url: &'static str,
    default_voices_url: &'static str,
}

/// Active Kokoro folder and whether it is user-chosen.
fn tts_dir(app: &AppHandle) -> Res<(PathBuf, bool)> {
    Ok(match config::load(app).tts_model_dir {
        Some(d) => (PathBuf::from(d), true),
        None => (data_dir(app)?.join("tts"), false),
    })
}

fn tts_file(p: &Path) -> TtsFile {
    TtsFile {
        name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        size: std::fs::metadata(p).map(|m| m.len()).unwrap_or(0),
    }
}

#[tauri::command]
fn tts_status(app: AppHandle, state: State<'_, AppState>) -> Res<TtsStatus> {
    let (dir, custom_dir) = tts_dir(&app)?;
    let running = {
        let mut t = state.tts.lock().unwrap();
        if t.child.as_mut().is_some_and(|c| exited(c).is_some()) {
            *t = TtsProc::default();
        }
        t.port.is_some()
    };
    let sidecar = tts::sidecar_path();
    let files = tts::model_files(&dir);
    Ok(TtsStatus {
        sidecar_present: sidecar.is_ok(),
        sidecar_error: sidecar.err(),
        model_ready: files.is_some(),
        model_file: files.as_ref().map(|f| tts_file(&f.0)),
        voices_file: files.as_ref().map(|f| tts_file(&f.1)),
        running,
        model_dir: dir.display().to_string(),
        custom_dir,
        default_model_url: tts::KOKORO_MODEL_URL,
        default_voices_url: tts::KOKORO_VOICES_URL,
    })
}

/// Points Talkerbox at an existing folder with Kokoro files (None = back to the app data dir).
#[tauri::command]
fn set_tts_model_dir(app: AppHandle, state: State<'_, AppState>, path: Option<String>) -> Res<TtsStatus> {
    let path = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    if let Some(p) = &path {
        if tts::model_files(Path::new(p)).is_none() {
            return Err(format!("No Kokoro model (.onnx) and voices (.bin) file found in {p}"));
        }
    }
    config::update(&app, |s| s.tts_model_dir = path)?;
    tts_status(app, state)
}

/// Deletes the Kokoro files from the app data dir (never from a user-chosen folder).
#[tauri::command]
fn delete_tts_files(app: AppHandle, state: State<'_, AppState>) -> Res<TtsStatus> {
    let (dir, custom) = tts_dir(&app)?;
    if custom {
        return Err("Files in a user-chosen folder are not deleted; switch back to the default folder instead".into());
    }
    stop_tts_proc(&state);
    if let Some((m, v)) = tts::model_files(&dir) {
        for f in [m, v] {
            std::fs::remove_file(&f).map_err(|e| format!("{}: {e}", f.display()))?;
        }
    }
    tts_status(app, state)
}

#[tauri::command]
async fn download_tts_file(app: AppHandle, state: State<'_, AppState>, id: String, url: String, on_progress: Channel<Progress>) -> Res<bool> {
    let (url, file) = download::safe_file_name(&url)?;
    let dest = tts_dir(&app)?.0.join(file);
    let op = state.op(&id);
    download::download(&state.http, url, &dest, &op.notify, |p| send(&on_progress, p)).await
}

#[tauri::command]
async fn tts_start(app: AppHandle, state: State<'_, AppState>) -> Res<TtsStatus> {
    if state.tts.lock().unwrap().port.is_none() {
        let exe = tts::sidecar_path()?;
        let (model, voices) = tts::model_files(&tts_dir(&app)?.0).ok_or("Kokoro model files are missing; download them in the Models view")?;
        let (child, port) = tts::spawn(&exe, &model, &voices, &data_dir(&app)?.join("logs").join("sidecar.log"))?;
        state.track(&child);
        state.tts.lock().unwrap().child = Some(child);
        let ready = tts::wait_ready(&state.http, port, || state.tts.lock().unwrap().child.as_mut().and_then(exited)).await;
        let mut t = state.tts.lock().unwrap();
        match ready {
            Ok(()) => t.port = Some(port),
            Err(e) => {
                if let Some(mut c) = t.child.take() {
                    kill_tree(&mut c);
                }
                return Err(e);
            }
        }
    }
    tts_status(app, state)
}

#[tauri::command]
fn tts_stop(app: AppHandle, state: State<'_, AppState>) -> Res<TtsStatus> {
    stop_tts_proc(&state);
    tts_status(app, state)
}

fn stop_tts_proc(state: &AppState) {
    let mut t = state.tts.lock().unwrap();
    if let Some(mut c) = t.child.take() {
        kill_tree(&mut c);
    }
    t.port = None;
}

fn tts_port(state: &AppState) -> Res<u16> {
    state.tts.lock().unwrap().port.ok_or_else(|| "TTS is not running".into())
}

#[tauri::command]
async fn tts_voices(state: State<'_, AppState>) -> Res<Vec<String>> {
    tts::voices(&state.http, tts_port(&state)?).await
}

/// Returns WAV bytes as a raw binary IPC response.
#[tauri::command]
async fn tts_synthesize(state: State<'_, AppState>, text: String, voice: String, speed: f32) -> Res<Response> {
    let speed = speed.clamp(0.5, 2.0);
    Ok(Response::new(tts::synthesize(&state.http, tts_port(&state)?, &text, &voice, speed).await?))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .user_agent(concat!("Talkerbox/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("HTTP client");
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { http, ollama: Mutex::new(None), tts: Mutex::default(), cancels: Mutex::default(), job: KillJob::new() })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            ollama_status,
            set_ollama_path,
            ollama_start,
            ollama_stop,
            list_models,
            delete_model,
            chat,
            cancel,
            pull_model,
            import_gguf_url,
            tts_status,
            set_tts_model_dir,
            delete_tts_files,
            download_tts_file,
            tts_start,
            tts_stop,
            tts_voices,
            tts_synthesize,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Talkerbox");
    app.run(|app, event| {
        // Only processes we spawned are tracked, so an externally started Ollama keeps running.
        // The job object covers crashes and forced termination; this handles the normal close path.
        if matches!(event, RunEvent::Exit | RunEvent::WindowEvent { event: tauri::WindowEvent::Destroyed, .. }) {
            app.state::<AppState>().kill_children();
        }
    });
}

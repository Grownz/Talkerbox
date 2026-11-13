//! Speech input: chosen (or default) microphone (cpal) -> mono 16 kHz -> Vosk, with live transcript events and an
//! idle timer that sends the text once it stops changing. In continuous mode listening goes on after each send. Audio stays in memory: nothing is written or sent anywhere.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Full transcript so far (finals + current partial).
pub const EVENT_PARTIAL: &str = "stt://partial";
/// Full transcript after a segment was finalised.
pub const EVENT_FINAL: &str = "stt://final";
/// Idle timeout (or, in continuous mode, the word limit) reached: the full transcript to send.
/// Listening has stopped, except in continuous mode, where it goes on with a fresh transcript.
pub const EVENT_SEND: &str = "stt://send";
/// Runtime failure (e.g. microphone unplugged). Listening has stopped.
pub const EVENT_ERROR: &str = "stt://error";

const RATE: u32 = 16_000;
/// 100 ms of 16 kHz audio per recognizer call.
const CHUNK: usize = 1_600;
/// Vosk small models are ~45 MB zipped and ~85 MB unpacked.
pub const MAX_ZIP_BYTES: u64 = 150 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 500 * 1024 * 1024;
const MAX_ENTRIES: usize = 10_000;
/// Continuous mode sends a long transcript early at the next sentence end once it has this many words.
pub const WORD_LIMIT: usize = 100;

/// (language, model folder name)
pub const MODELS: [(&str, &str); 2] = [("de", "vosk-model-small-de-0.15"), ("en", "vosk-model-small-en-us-0.15")];

pub fn model_name(lang: &str) -> Result<&'static str, String> {
    MODELS.iter().find(|(l, _)| *l == lang).map(|(_, n)| *n).ok_or_else(|| format!("No speech input model for language '{lang}'"))
}

pub fn model_url(name: &str) -> String {
    format!("https://alphacephei.com/vosk/models/{name}.zip")
}

pub fn installed(dir: &Path) -> bool {
    dir.join("am").join("final.mdl").is_file()
}

/// libvosk.dll is delay-loaded; calling into it while it is missing would abort the process.
pub fn runtime_error() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let missing = ["libvosk.dll", "libstdc++-6.dll", "libgcc_s_seh-1.dll", "libwinpthread-1.dll"].into_iter().map(|d| exe.with_file_name(d)).find(|p| !p.is_file())?;
    Some(format!("Speech input runtime missing: {} not found (see app/README.md, Vosk runtime)", missing.display()))
}

// ---------- model install ----------

/// Unpacks `zip` into `dest`, rejecting entries that would land outside it and archives that unpack too large.
pub fn extract_zip(zip: &Path, dest: &Path, max_bytes: u64) -> Result<(), String> {
    let f = std::fs::File::open(zip).map_err(|e| format!("{}: {e}", zip.display()))?;
    let mut a = zip::ZipArchive::new(f).map_err(|e| format!("Invalid zip archive: {e}"))?;
    if a.len() > MAX_ENTRIES {
        return Err("Zip archive has too many entries".into());
    }
    let mut total = 0u64;
    for i in 0..a.len() {
        let mut e = a.by_index(i).map_err(|e| format!("Invalid zip archive: {e}"))?;
        let rel = e.enclosed_name().ok_or_else(|| format!("Unsafe path in zip archive: {}", e.name_raw().escape_ascii()))?;
        let out = dest.join(rel);
        let io = |e: std::io::Error| format!("{}: {e}", out.display());
        if e.is_dir() {
            std::fs::create_dir_all(&out).map_err(io)?;
            continue;
        }
        if let Some(p) = out.parent() {
            std::fs::create_dir_all(p).map_err(io)?;
        }
        let mut w = std::fs::File::create(&out).map_err(io)?;
        // Count real bytes, not the header's claimed size.
        total += std::io::copy(&mut (&mut e).take(max_bytes - total + 1), &mut w).map_err(io)?;
        if total > max_bytes {
            return Err("Zip archive unpacks to more than the size limit".into());
        }
    }
    Ok(())
}

/// Unpacks a downloaded model zip (top folder `<name>/`) into `root/<name>`, replacing an old copy.
pub fn install_model(zip: &Path, root: &Path, name: &str) -> Result<(), String> {
    let tmp = root.join(format!(".extract-{name}"));
    let _ = std::fs::remove_dir_all(&tmp);
    let r = extract_zip(zip, &tmp, MAX_UNPACKED_BYTES).and_then(|_| {
        let src = tmp.join(name);
        if !installed(&src) {
            return Err(format!("The archive does not contain {name}/am/final.mdl"));
        }
        let dest = root.join(name);
        let _ = std::fs::remove_dir_all(&dest);
        std::fs::rename(&src, &dest).map_err(|e| format!("{}: {e}", dest.display()))
    });
    let _ = std::fs::remove_dir_all(&tmp);
    r
}

/// Bytes of all files under `dir` (0 if it does not exist).
pub fn disk_size(dir: &Path) -> u64 {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => disk_size(&e.path()),
            Ok(t) if t.is_file() => e.metadata().map_or(0, |m| m.len()),
            _ => 0, // symlinks are not followed
        })
        .sum()
}

/// Deletes `root/<name>`. `name` must come from `MODELS` (see `model_name`), never from the caller.
/// The folder is first renamed away, so a file held open elsewhere fails the rename and leaves the model intact;
/// after that the model no longer counts as installed, and a folder that cannot be fully deleted is retried by
/// `clean_stale`.
pub fn remove_model(root: &Path, name: &str) -> Result<(), String> {
    let dir = root.join(name);
    if !dir.exists() {
        return Ok(());
    }
    let trash = root.join(format!(".remove-{name}"));
    let _ = std::fs::remove_dir_all(&trash);
    std::fs::rename(&dir, &trash).map_err(|e| format!("Cannot delete {}: {e}. Close programs using it and try again.", dir.display()))?;
    std::fs::remove_dir_all(&trash).map_err(|e| format!("The model was removed, but {} could not be fully deleted yet: {e}", trash.display()))
}

/// Deletes leftovers of removals that could not finish (see `remove_model`).
pub fn clean_stale(root: &Path) {
    for (_, name) in MODELS {
        let _ = std::fs::remove_dir_all(root.join(format!(".remove-{name}")));
    }
}

// ---------- pure audio/timer logic ----------

/// Downmix to mono and resample to 16 kHz by averaging the input samples of each output period
/// (a box filter: cheap, and enough anti-aliasing for speech recognition).
pub struct Resampler {
    /// Input samples per output sample.
    step: f64,
    pos: f64,
    acc: f32,
    n: u32,
    last: f32,
}

impl Resampler {
    pub fn new(in_rate: u32) -> Self {
        Self { step: f64::from(in_rate) / f64::from(RATE), pos: 0.0, acc: 0.0, n: 0, last: 0.0 }
    }

    /// Appends the 16 kHz mono i16 samples for one block of interleaved input.
    pub fn push<T: Copy>(&mut self, data: &[T], channels: usize, to_f32: impl Fn(T) -> f32, out: &mut Vec<i16>) {
        let ch = channels.max(1);
        for frame in data.chunks_exact(ch) {
            self.acc += frame.iter().map(|&s| to_f32(s)).sum::<f32>() / ch as f32;
            self.n += 1;
            self.pos += 1.0;
            while self.pos >= self.step {
                // Upsampling (step < 1) repeats the last value.
                let v = if self.n > 0 { self.acc / self.n as f32 } else { self.last };
                self.last = v;
                out.push((v.clamp(-1.0, 1.0) * 32767.0) as i16);
                self.pos -= self.step;
                self.acc = 0.0;
                self.n = 0;
            }
        }
    }
}

/// Fires once the transcript is non-empty and has not changed for `after`.
pub struct Idle {
    text: String,
    since: Instant,
    after: Duration,
}

impl Idle {
    pub fn new(after: Duration, now: Instant) -> Self {
        Self { text: String::new(), since: now, after }
    }

    pub fn tick(&mut self, text: &str, now: Instant) -> bool {
        if text != self.text {
            self.text = text.to_string();
            self.since = now;
            return false;
        }
        !text.is_empty() && now.duration_since(self.since) >= self.after
    }
}

/// Continuous mode: a long transcript is sent before the idle timeout once it reaches a sentence end.
/// Vosk small models emit no punctuation, so the end of a recognised utterance (`segment_end`) counts too.
pub fn long_enough(text: &str, segment_end: bool) -> bool {
    text.split_whitespace().count() >= WORD_LIMIT && (segment_end || text.trim_end().ends_with(['.', '!', '?', '。', '！', '？', '…']))
}

fn join(parts: &[String], partial: &str) -> String {
    parts.iter().map(String::as_str).chain(Some(partial)).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")
}

// ---------- listener ----------

/// A running speech-input thread. Dropping it without `stop` leaves the thread to end on its own.
pub struct Listener {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    model_dir: PathBuf,
}

impl Listener {
    pub fn running(&self) -> bool {
        self.thread.as_ref().is_some_and(|t| !t.is_finished())
    }

    /// The thread owns the loaded model until it ends, so a running listener keeps this folder in use.
    pub fn uses(&self, model_dir: &Path) -> bool {
        self.running() && self.model_dir == model_dir
    }

    /// Signals the thread and waits for it (at most one 100 ms poll plus one recognizer call).
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

pub struct Options {
    pub model_dir: PathBuf,
    pub idle: Duration,
    /// Keep listening after each send.
    pub continuous: bool,
    /// Input device name; None or a missing device = system default.
    pub device: Option<String>,
    /// While set, captured audio is dropped (replies being read aloud must not be recognised).
    pub muted: Arc<AtomicBool>,
}

/// Loads the model, opens the microphone and starts listening. Returns once listening has started
/// or failed, so setup errors (missing model, no microphone, access denied) come back as `Err`.
/// The `Some` string is a hint that the saved device was not found and the default one is used.
pub fn start(app: AppHandle, opts: Options) -> Result<(Listener, Option<String>), String> {
    if let Some(e) = runtime_error() {
        return Err(e);
    }
    let (ready_tx, ready_rx) = sync_channel(1);
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let model_dir = opts.model_dir.clone();
    let thread = std::thread::Builder::new()
        .name("stt".into())
        .spawn(move || run(app, opts, flag, ready_tx))
        .map_err(|e| format!("Cannot start speech input: {e}"))?;
    match ready_rx.recv() {
        Ok(Ok(hint)) => Ok((Listener { stop, thread: Some(thread), model_dir }, hint)),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => Err("Speech input stopped unexpectedly".into()),
    }
}

type Audio = Result<Vec<i16>, String>;

fn run(app: AppHandle, opts: Options, stop: Arc<AtomicBool>, ready: SyncSender<Result<Option<String>, String>>) {
    vosk::set_log_level(vosk::LogLevel::Error);
    let Some(model) = vosk::Model::new(opts.model_dir.to_string_lossy()) else {
        let _ = ready.send(Err("Could not load the speech input model; download it again on the Speech page".into()));
        return;
    };
    let Some(mut rec) = vosk::Recognizer::new(&model, RATE as f32) else {
        let _ = ready.send(Err("Could not create the speech recognizer".into()));
        return;
    };
    let (tx, rx) = sync_channel::<Audio>(64);
    let (stream, hint) = match open_mic(tx, opts.device.as_deref()) {
        Ok(s) => s,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let _ = ready.send(Ok(hint));
    if let Err(e) = listen(&app, &mut rec, &rx, &opts, &stop) {
        let _ = app.emit(EVENT_ERROR, e);
    }
    drop(stream);
}

fn text_of(r: vosk::CompleteResult) -> String {
    match r {
        vosk::CompleteResult::Single(s) => s.text.to_string(),
        vosk::CompleteResult::Multiple(m) => m.alternatives.first().map(|a| a.text.to_string()).unwrap_or_default(),
    }
}

fn listen(app: &AppHandle, rec: &mut vosk::Recognizer, rx: &Receiver<Audio>, opts: &Options, stop: &AtomicBool) -> Result<(), String> {
    let mut finals: Vec<String> = Vec::new();
    let mut partial = String::new();
    let mut shown = String::new();
    let mut timer = Idle::new(opts.idle, Instant::now());
    let mut buf: Vec<i16> = Vec::with_capacity(CHUNK * 4);
    while !stop.load(Ordering::Relaxed) {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(s)) if !opts.muted.load(Ordering::Relaxed) => buf.extend_from_slice(&s),
            Ok(Ok(_)) => buf.clear(),
            Ok(Err(e)) => return Err(e),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Err("The microphone stopped delivering audio".into()),
        }
        while buf.len() >= CHUNK {
            let chunk: Vec<i16> = buf.drain(..CHUNK).collect();
            match rec.accept_waveform(&chunk).map_err(|e| format!("Speech recognition failed: {e}"))? {
                vosk::DecodingState::Finalized => {
                    let seg = text_of(rec.result());
                    partial.clear();
                    if !seg.is_empty() {
                        finals.push(seg);
                        let _ = app.emit(EVENT_FINAL, join(&finals, ""));
                        shown = join(&finals, "");
                    }
                }
                vosk::DecodingState::Running => partial = rec.partial_result().partial.to_string(),
                vosk::DecodingState::Failed => return Err("Speech recognition failed".into()),
            }
        }
        let text = join(&finals, &partial);
        if text != shown {
            let _ = app.emit(EVENT_PARTIAL, &text);
            shown = text.clone();
        }
        let now = Instant::now();
        // `|`, not `||`: the idle timer must see every transcript change.
        if timer.tick(&text, now) | (opts.continuous && long_enough(&text, partial.is_empty())) {
            // The final pass may correct the last partial.
            let tail = text_of(rec.final_result());
            let _ = app.emit(EVENT_SEND, join(&finals, if tail.is_empty() { &partial } else { &tail }));
            if !opts.continuous {
                return Ok(());
            }
            rec.reset();
            finals.clear();
            partial.clear();
            shown.clear();
            timer = Idle::new(opts.idle, now);
        }
    }
    Ok(())
}

fn mic_err(e: cpal::Error) -> String {
    let s = e.to_string();
    if e.kind() == cpal::ErrorKind::PermissionDenied || s.contains("0x80070005") {
        "Microphone access is blocked. Allow it in Windows Settings > Privacy & security > Microphone \
         (including \"Let desktop apps access your microphone\")."
            .into()
    } else {
        format!("Microphone error: {s}")
    }
}

fn device_name(dev: &cpal::Device) -> Option<String> {
    use cpal::traits::DeviceTrait;
    dev.description().ok().map(|d| d.name().to_string())
}

/// Input devices for the device menu: (name, is the system default).
pub fn input_devices() -> Result<Vec<(String, bool)>, String> {
    use cpal::traits::HostTrait;
    let host = cpal::default_host();
    let default = host.default_input_device().as_ref().and_then(device_name);
    let devs = host.input_devices().map_err(mic_err)?;
    Ok(devs.filter_map(|d| device_name(&d)).map(|n| (n.clone(), Some(&n) == default.as_ref())).collect())
}

fn open_mic(tx: SyncSender<Audio>, wanted: Option<&str>) -> Result<(cpal::Stream, Option<String>), String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::SampleFormat as F;
    let host = cpal::default_host();
    let chosen = wanted.and_then(|w| host.input_devices().ok()?.find(|d| device_name(d).as_deref() == Some(w)));
    let hint = match (wanted, &chosen) {
        (Some(w), None) => Some(format!("Microphone \"{w}\" was not found; using the default recording device.")),
        _ => None,
    };
    let dev = chosen
        .or_else(|| host.default_input_device())
        .ok_or("No microphone found. Connect one or choose a default recording device in the Windows sound settings.")?;
    let sup = dev.default_input_config().map_err(mic_err)?;
    let cfg = sup.config();
    let stream = match sup.sample_format() {
        F::F32 => build::<f32>(&dev, cfg, tx, |s| s),
        F::I16 => build::<i16>(&dev, cfg, tx, |s| f32::from(s) / 32768.0),
        F::I32 => build::<i32>(&dev, cfg, tx, |s| s as f32 / 2_147_483_648.0),
        F::U16 => build::<u16>(&dev, cfg, tx, |s| (f32::from(s) - 32768.0) / 32768.0),
        f => return Err(format!("Unsupported microphone sample format {f:?}")),
    }
    .map_err(mic_err)?;
    stream.play().map_err(mic_err)?;
    Ok((stream, hint))
}

fn build<T: cpal::SizedSample + Send + 'static>(
    dev: &cpal::Device,
    cfg: cpal::StreamConfig,
    tx: SyncSender<Audio>,
    to_f32: fn(T) -> f32,
) -> Result<cpal::Stream, cpal::Error> {
    use cpal::traits::DeviceTrait;
    let channels = usize::from(cfg.channels);
    let mut rs = Resampler::new(cfg.sample_rate);
    let err_tx = tx.clone();
    dev.build_input_stream::<T, _, _>(
        cfg,
        move |data: &[T], _| {
            let mut out = Vec::with_capacity(data.len() / 2 + 1);
            rs.push(data, channels, to_f32, &mut out);
            // Never block the audio callback; a full queue drops this block.
            let _ = tx.try_send(Ok(out));
        },
        move |e| {
            let _ = err_tx.try_send(Err(mic_err(e)));
        },
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn resample_48k_stereo_to_16k_mono() {
        let mut rs = Resampler::new(48_000);
        let mut out = Vec::new();
        // 480 stereo frames = 10 ms; left 0.5, right 0.0 -> mono 0.25.
        let data: Vec<f32> = (0..480).flat_map(|_| [0.5f32, 0.0]).collect();
        rs.push(&data, 2, |s| s, &mut out);
        assert_eq!(out.len(), 160);
        assert!(out.iter().all(|&s| (s - 8191).abs() <= 1), "{:?}", &out[..4]);
    }

    #[test]
    fn resample_keeps_rate_across_blocks_and_odd_rates() {
        let mut rs = Resampler::new(44_100);
        let mut out = Vec::new();
        for _ in 0..100 {
            rs.push(&[0.0f32; 441], 1, |s| s, &mut out); // 1 s in 10 ms blocks
        }
        assert!((15_999..=16_000).contains(&out.len()), "{}", out.len());

        let mut up = Resampler::new(8_000);
        let mut out = Vec::new();
        up.push(&[1.0f32; 80], 1, |s| s, &mut out);
        assert_eq!(out.len(), 160);
        assert!(out.iter().all(|&s| s == 32767));
    }

    #[test]
    fn resample_box_filter_removes_nyquist_tone() {
        // A 24 kHz tone at 48 kHz alternates +1/-1; averaging 3 samples must not pass it through at full level.
        let mut rs = Resampler::new(48_000);
        let mut out = Vec::new();
        let data: Vec<i16> = (0..4800).map(|i| if i % 2 == 0 { 16000 } else { -16000 }).collect();
        rs.push(&data, 1, |s| f32::from(s) / 32768.0, &mut out);
        assert!(out.iter().all(|&s| s.abs() <= 5500), "{:?}", &out[..6]);
    }

    #[test]
    fn idle_timer_fires_only_after_unchanged_text() {
        let t0 = Instant::now();
        let s = |n: u64| t0 + Duration::from_millis(n);
        let mut idle = Idle::new(Duration::from_secs(5), t0);
        assert!(!idle.tick("", s(6000)), "empty text never fires");
        assert!(!idle.tick("hello", s(6000)));
        assert!(!idle.tick("hello", s(10_999)));
        assert!(!idle.tick("hello world", s(11_000)), "a change restarts the timer");
        assert!(!idle.tick("hello world", s(15_999)));
        assert!(idle.tick("hello world", s(16_000)));
    }

    #[test]
    fn long_transcript_waits_for_a_sentence_end() {
        let words = |n: usize| vec!["word"; n].join(" ");
        assert!(!long_enough(&format!("{}.", words(99)), true), "below the limit never sends early");
        assert!(!long_enough(&words(100), false), "mid-utterance without punctuation");
        assert!(long_enough(&words(100), true), "Vosk closed the utterance");
        assert!(long_enough(&format!("{}.", words(120)), false));
        assert!(long_enough(&format!("{}? ", words(100)), false));
        assert!(long_enough(&format!("{}。", words(100)), false));
        assert!(!long_enough(&format!("{},", words(150)), false));
    }

    #[test]
    fn join_skips_empty_parts() {

        assert_eq!(join(&["a b".into(), "c".into()], ""), "a b c");
        assert_eq!(join(&[], "x"), "x");
        assert_eq!(join(&[], ""), "");
    }

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("talkerbox-stt-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn make_zip(path: &Path, files: &[(&str, &[u8])]) {
        let mut w = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        let opt = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (n, b) in files {
            w.start_file(*n, opt).unwrap();
            w.write_all(b).unwrap();
        }
        w.finish().unwrap();
    }

    #[test]
    fn install_model_from_zip() {
        let d = temp("ok");
        let z = d.join("m.zip");
        make_zip(&z, &[("m/am/final.mdl", b"x"), ("m/conf/model.conf", b"y")]);
        install_model(&z, &d, "m").unwrap();
        assert!(installed(&d.join("m")));
        assert!(!d.join(".extract-m").exists());
        // Wrong layout is rejected and leaves no model behind.
        make_zip(&z, &[("other/am/final.mdl", b"x")]);
        assert!(install_model(&z, &d, "n").is_err());
        assert!(!d.join("n").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn remove_model_deletes_only_that_model() {
        let d = temp("remove");
        let z = d.join("m.zip");
        make_zip(&z, &[("m/am/final.mdl", &[0u8; 10]), ("m/conf/model.conf", &[0u8; 5])]);
        install_model(&z, &d, "m").unwrap();
        std::fs::create_dir_all(d.join("other")).unwrap();
        std::fs::write(d.join("other/keep"), b"x").unwrap();
        assert_eq!(disk_size(&d.join("m")), 15, "counts files in subfolders");
        remove_model(&d, "m").unwrap();
        assert!(!d.join("m").exists() && !d.join(".remove-m").exists());
        assert_eq!(disk_size(&d.join("m")), 0);
        assert!(d.join("other/keep").exists() && z.exists(), "siblings stay");
        assert!(remove_model(&d, "m").is_ok(), "nothing to remove is fine");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn remove_model_keeps_a_model_whose_files_are_open() {
        let d = temp("locked");
        std::fs::create_dir_all(d.join("m/am")).unwrap();
        std::fs::write(d.join("m/am/final.mdl"), b"x").unwrap();
        // Windows refuses to rename a folder with an open file; the model must then stay intact.
        let open = std::fs::File::open(d.join("m/am/final.mdl")).unwrap();
        let r = remove_model(&d, "m");
        if cfg!(windows) {
            assert!(r.unwrap_err().contains("Cannot delete"));
            assert!(installed(&d.join("m")));
        }
        drop(open);
        remove_model(&d, "m").unwrap();
        assert!(!d.join("m").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn zip_slip_is_rejected() {
        let d = temp("slip");
        let z = d.join("evil.zip");
        let out = d.join("out");
        for bad in ["../evil.txt", "m/../../evil.txt"] {
            make_zip(&z, &[(bad, b"x")]);
            assert!(extract_zip(&z, &out, 1000).is_err(), "{bad} must be rejected");
        }
        assert!(!d.join("evil.txt").exists());
        // Absolute names are either rejected or made relative by the zip crate; they must never escape `out`.
        let name = format!("talkerbox-abs-{}.txt", std::process::id());
        for abs in [format!("/{name}"), format!("C:/{name}")] {
            make_zip(&z, &[(&abs, b"x")]);
            let _ = extract_zip(&z, &out, 1000);
            assert!(!Path::new(&abs).exists(), "{abs} escaped");
        }
        make_zip(&z, &[("a.bin", &[0u8; 600]), ("b.bin", &[0u8; 600])]);
        assert!(extract_zip(&z, &out, 1000).unwrap_err().contains("size limit"));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// End-to-end check of the Vosk link and the resampler with a real recording (16-bit PCM WAV):
    /// `TALKERBOX_VOSK_MODEL=<model dir> TALKERBOX_VOSK_WAV=<file> cargo test vosk_wav -- --ignored --nocapture`
    /// with the vosk DLLs copied next to the test binary (target/debug/deps).
    #[test]
    #[ignore]
    fn vosk_wav() {
        let wav = std::fs::read(std::env::var("TALKERBOX_VOSK_WAV").unwrap()).unwrap();
        let channels = usize::from(u16::from_le_bytes([wav[22], wav[23]]));
        let rate = u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]);
        let data = wav.windows(4).position(|w| w == b"data").unwrap() + 8;
        let samples: Vec<i16> = wav[data..].as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes(*b)).collect();
        let mut pcm = Vec::new();
        Resampler::new(rate).push(&samples, channels, |s| f32::from(s) / 32768.0, &mut pcm);
        let model = vosk::Model::new(std::env::var("TALKERBOX_VOSK_MODEL").unwrap()).expect("model");
        let mut rec = vosk::Recognizer::new(&model, RATE as f32).unwrap();
        let mut finals = Vec::new();
        for c in pcm.chunks(CHUNK) {
            if rec.accept_waveform(c).unwrap() == vosk::DecodingState::Finalized {
                finals.push(text_of(rec.result()));
            }
        }
        finals.push(text_of(rec.final_result()));
        let text = join(&finals, "");
        println!("{rate} Hz x{channels}: {text}");
        assert!(!text.is_empty());
    }

    #[test]
    fn known_models_and_urls() {
        assert_eq!(model_name("de"), Ok("vosk-model-small-de-0.15"));
        assert!(model_name("fr").is_err());
        for bad in ["", "..", "../de", "de/..", "vosk-model-small-de-0.15", "DE"] {
            assert!(model_name(bad).is_err(), "{bad:?} must be rejected");
        }
        assert_eq!(model_url("vosk-model-small-de-0.15"), "https://alphacephei.com/vosk/models/vosk-model-small-de-0.15.zip");
    }
}

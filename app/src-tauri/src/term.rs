//! Captured output of the `ollama serve` process: a bounded line buffer plus live events for the terminal view.

use serde::Serialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub const EVENT: &str = "ollama-log";
const CAP: usize = 5000;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LogLine {
    /// Increasing sequence number so the view can drop lines it already got from the snapshot.
    pub seq: u64,
    pub line: String,
}

#[derive(Default)]
pub struct LogBuf {
    lines: VecDeque<LogLine>,
    next: u64,
}

impl LogBuf {
    pub fn push(&mut self, line: String) -> LogLine {
        self.next += 1;
        let l = LogLine { seq: self.next, line };
        if self.lines.len() == CAP {
            self.lines.pop_front();
        }
        self.lines.push_back(l.clone());
        l
    }

    pub fn snapshot(&self) -> Vec<LogLine> {
        self.lines.iter().cloned().collect()
    }

    pub fn clear(&mut self) {
        self.lines.clear();
    }
}

/// Reads `r` line by line on a background thread into `buf`, emitting each line as an event.
pub fn capture(r: impl Read + Send + 'static, buf: Arc<Mutex<LogBuf>>, app: AppHandle) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(r);
        let mut raw = Vec::new();
        // read_until + lossy decoding: a non-UTF-8 byte must not stop the capture.
        while reader.read_until(b'\n', &mut raw).is_ok_and(|n| n > 0) {
            let line = String::from_utf8_lossy(&raw).trim_end_matches(['\r', '\n']).to_string();
            raw.clear();
            let l = buf.lock().unwrap_or_else(|e| e.into_inner()).push(line);
            let _ = app.emit(EVENT, l);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffer_is_bounded_and_sequenced() {
        let mut b = LogBuf::default();
        for i in 0..CAP + 10 {
            b.push(format!("line {i}"));
        }
        let s = b.snapshot();
        assert_eq!(s.len(), CAP);
        assert_eq!(s[0], LogLine { seq: 11, line: "line 10".into() });
        assert_eq!(s.last().unwrap().seq, (CAP + 10) as u64);
        b.clear();
        assert!(b.snapshot().is_empty());
        assert_eq!(b.push("x".into()).seq, (CAP + 11) as u64);
    }
}

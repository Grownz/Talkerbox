//! Tiny scripted HTTP/1.1 server for tests (no dependencies).

use std::io::{Read, Write};
use std::net::TcpListener;

/// Serves up to `n` connections on a free local port. `handler` gets the request head and returns the raw
/// response; the connection closes afterwards. Returns the base URL.
pub fn serve(n: usize, handler: impl Fn(&str) -> Vec<u8> + Send + 'static) -> String {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = l.local_addr().unwrap();
    std::thread::spawn(move || {
        for s in l.incoming().take(n) {
            let Ok(mut s) = s else { continue };
            let mut head = Vec::new();
            let mut tmp = [0u8; 1024];
            while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                match s.read(&mut tmp) {
                    Ok(0) | Err(_) => break,
                    Ok(k) => head.extend_from_slice(&tmp[..k]),
                }
            }
            let _ = s.write_all(&handler(&String::from_utf8_lossy(&head).to_ascii_lowercase()));
        }
    });
    format!("http://{addr}")
}

/// Raw response; `content_length: None` omits the header (body then ends at connection close).
pub fn response(status: &str, content_length: Option<usize>, body: &[u8]) -> Vec<u8> {
    let mut out = format!("HTTP/1.1 {status}\r\nConnection: close\r\n").into_bytes();
    if let Some(l) = content_length {
        out.extend_from_slice(format!("Content-Length: {l}\r\n").as_bytes());
    }
    out.extend_from_slice(b"\r\n");
    out.extend_from_slice(body);
    out
}

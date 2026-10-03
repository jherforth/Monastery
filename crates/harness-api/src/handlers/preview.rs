//! Static preview serving, with the runtime-error bridge injected into HTML pages.

use super::*;

/// Injected into every HTML page the preview serves. Forwards runtime errors — uncaught
/// exceptions, unhandled promise rejections, `console.error`, and failed resource loads — to
/// the Monastery UI with postMessage, so the chat can offer "Fix it" instead of the user having
/// to notice and describe the error (bolt.diy's preview-error alerts, minus the WebContainer).
pub(crate) const PREVIEW_ERROR_BRIDGE: &str = r#"<script data-monastery-preview>(function(){
  if (window.parent === window) return;
  function send(kind, message, stack) {
    try {
      window.parent.postMessage({ source: 'monastery-preview', kind: kind,
        message: String(message || '').slice(0, 2000), stack: stack ? String(stack).slice(0, 4000) : '',
        page: location.pathname.split('/preview/').pop() }, '*');
    } catch (_) {}
  }
  window.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t !== window && (t.src || t.href)) { send('resource', 'Failed to load ' + (t.src || t.href)); return; }
    send('error', e.message, e.error && e.error.stack);
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    send('rejection', r && r.message ? r.message : r, r && r.stack);
  });
  var original = console.error;
  console.error = function () {
    try {
      send('console', Array.prototype.map.call(arguments, function (a) {
        if (a instanceof Error) return a.message;
        if (typeof a === 'object') { try { return JSON.stringify(a); } catch (_) { return String(a); } }
        return String(a);
      }).join(' '));
    } catch (_) {}
    return original.apply(console, arguments);
  };
})();</script>"#;

/// Insert the error bridge as early as possible so it sees errors from the page's own scripts:
/// right after `<head …>`, else after the doctype (never before it — that flips quirks mode),
/// else at the very start.
pub(crate) fn inject_preview_error_bridge(html: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(html);
    // ASCII lowercasing keeps byte offsets identical, so indexes map back onto `text`.
    let lower = text.to_ascii_lowercase();
    // End of the first `<tag …>` — the tag name must end there, so `<head` doesn't match `<header`.
    let after_tag = |tag: &str| {
        lower.match_indices(tag)
            .find(|(i, _)| matches!(lower.as_bytes().get(i + tag.len()), Some(b'>' | b' ' | b'\t' | b'\n' | b'\r')))
            .and_then(|(i, _)| lower[i..].find('>').map(|j| i + j + 1))
    };
    let at = after_tag("<head").or_else(|| after_tag("<!doctype")).unwrap_or(0);
    let mut out = String::with_capacity(text.len() + PREVIEW_ERROR_BRIDGE.len());
    out.push_str(&text[..at]);
    out.push_str(PREVIEW_ERROR_BRIDGE);
    out.push_str(&text[at..]);
    out.into_bytes()
}

/// Serve a project file for preview (static file serving)
pub async fn project_preview(
    Path((project_id, path)): Path<(uuid::Uuid, String)>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    let project = ProjectCtx::load(&state, project_id).await?;
    let project_name = project.name.clone();

    let file_path = project.dir.join(&path);

    // Security: prevent directory traversal. The base must be canonicalized too —
    // comparing a canonicalized file path against a raw base fails whenever data_dir
    // is relative or crosses a symlink (common with Docker volumes), which used to
    // surface as a bogus 400 for perfectly valid files.
    let base = project.dir.clone();
    let base = base.canonicalize().unwrap_or(base);
    match file_path.canonicalize() {
        Ok(resolved) if resolved.starts_with(&base) => {
            match tokio::fs::read(&resolved).await {
                Ok(mut content) => {
                    let lower = path.to_lowercase();
                    let mime = if lower.ends_with(".html") || lower.ends_with(".htm") {
                        "text/html"
                    } else if lower.ends_with(".css") {
                        "text/css"
                    } else if lower.ends_with(".js") {
                        "application/javascript"
                    } else if lower.ends_with(".json") {
                        "application/json"
                    } else if lower.ends_with(".svg") {
                        "image/svg+xml"
                    } else if lower.ends_with(".png") {
                        "image/png"
                    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
                        "image/jpeg"
                    } else if lower.ends_with(".gif") {
                        "image/gif"
                    } else if lower.ends_with(".webp") {
                        "image/webp"
                    } else if lower.ends_with(".ico") {
                        "image/x-icon"
                    } else if lower.ends_with(".bmp") {
                        "image/bmp"
                    } else if lower.ends_with(".avif") {
                        "image/avif"
                    } else if lower.ends_with(".woff2") {
                        "font/woff2"
                    } else if lower.ends_with(".woff") {
                        "font/woff"
                    } else {
                        "text/plain"
                    };
                    // Self-heal binary files uploaded before base64 decoding existed: they were
                    // stored as the literal data-URL text ("data:image/png;base64,...."). Decode
                    // to real bytes and persist so the file is fixed for good, not just this GET.
                    if mime.starts_with("image/") && content.starts_with(b"data:") {
                        if let Some(idx) = content.iter().position(|&b| b == b',') {
                            use base64::Engine as _;
                            let payload = &content[idx + 1..];
                            if let Ok(decoded) = base64::engine::general_purpose::STANDARD
                                .decode(payload.strip_suffix(b"\n").unwrap_or(payload))
                            {
                                let _ = tokio::fs::write(&resolved, &decoded).await;
                                content = decoded;
                            }
                        }
                    }
                    if mime == "text/html" {
                        content = inject_preview_error_bridge(&content);
                    }
                    Ok((
                        [(axum::http::header::CONTENT_TYPE, mime)],
                        content,
                    ))
                }
                Err(_) => Err(ApiError::NotFound("File not found".into())),
            }
        }
        Ok(_) => Err(ApiError::Config("Path traversal not allowed".into())),
        // canonicalize() fails when the file simply doesn't exist — that's a 404, not a
        // traversal attempt. For the default preview entry point, serve a friendly
        // placeholder instead: the preview pane is open by default, and an empty or
        // just-created project shouldn't greet the user with an error.
        Err(_) => {
            if path == "index.html" {
                let placeholder = format!(
                    "<!doctype html><html><head><meta charset=\"utf-8\"><title>Preview</title></head>\
                     <body style=\"margin:0;display:flex;align-items:center;justify-content:center;\
                     min-height:100vh;font-family:system-ui,sans-serif;background:#F5F0E8;color:#57534e\">\
                     <div style=\"text-align:center;max-width:24rem;padding:2rem\">\
                     <div style=\"font-size:2.5rem\">🏛️</div>\
                     <h1 style=\"font-size:1.1rem;margin:0.75rem 0 0.25rem\">Nothing to preview yet</h1>\
                     <p style=\"font-size:0.9rem;line-height:1.5\">Ask the assistant to build something — \
                     when <code>index.html</code> lands in \"{}\", it appears here automatically.</p>\
                     </div></body></html>",
                    project_name
                );
                return Ok((
                    [(axum::http::header::CONTENT_TYPE, "text/html")],
                    placeholder.into_bytes(),
                ));
            }
            Err(ApiError::NotFound("File not found".into()))
        }
    }
}

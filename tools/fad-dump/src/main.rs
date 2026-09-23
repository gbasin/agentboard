//! fad-dump — dev-only fixture generator for agentboard's parity tests.
//!
//! Wraps franken_agent_detection (FAD), the connector/parsing crate
//! underneath CASS: https://github.com/Dicklesworthstone/franken_agent_detection
//!
//! Runs every compiled-in connector against the
//! ambient environment (HOME + per-agent env overrides) and prints one JSON
//! object per discovered conversation on stdout:
//!
//!   {"agent":"claude","externalId":"…","workspace":"…","sourcePath":"…",
//!    "startedAt":…,"endedAt":…,"messages":[{"idx":0,"role":"user","content":"…"}]}
//!
//! Agent-discovery env vars (CLAUDE_CONFIG_DIR, CODEX_HOME, …) are honored via
//! the connectors' own resolvers, so `env -i HOME=<fixture-home> fad-dump`
//! reproduces a clean scan of a fixture tree. This binary is never shipped or
//! invoked by agentboard at runtime; it exists to regenerate
//! tests/fixtures/fad/expected/*.json.
//!
//! Usage: fad-dump [data_dir]
//!   data_dir — scratch dir for ScanContext (default: $TMPDIR/fad-dump)

use franken_agent_detection::connectors::get_connector_factories;
use franken_agent_detection::ScanContext;
use std::io::Write;
use std::path::PathBuf;

fn main() {
    let data_dir: PathBuf = std::env::args()
        .nth(1)
        .map(Into::into)
        .unwrap_or_else(|| std::env::temp_dir().join("fad-dump"));

    let ctx = ScanContext::local_default(data_dir, None);
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut failures = 0u32;

    for (slug, make) in get_connector_factories() {
        let connector = make();
        let ctx = ctx.clone();
        let mut write_conv = |conv: franken_agent_detection::NormalizedConversation| {
            let messages: Vec<serde_json::Value> = conv
                .messages
                .iter()
                .map(|m| {
                    serde_json::json!({
                        "idx": m.idx,
                        "role": m.role,
                        "content": m.content,
                        "createdAt": m.created_at,
                    })
                })
                .collect();
            let line = serde_json::json!({
                "agent": slug,
                "externalId": conv.external_id,
                "title": conv.title,
                "workspace": conv.workspace,
                "sourcePath": conv.source_path,
                "startedAt": conv.started_at,
                "endedAt": conv.ended_at,
                "metadata": conv.metadata,
                "messages": messages,
            });
            let _ = writeln!(out, "{line}");
        };
        if let Err(err) =
            connector.scan_with_callback(&ctx, &mut |conv| {
                write_conv(conv);
                Ok(())
            })
        {
            failures += 1;
            let _ = writeln!(
                out,
                "{}",
                serde_json::json!({"agent": slug, "error": err.to_string()})
            );
        }
    }

    if failures > 0 {
        eprintln!("fad-dump: {failures} connector(s) failed");
    }
}

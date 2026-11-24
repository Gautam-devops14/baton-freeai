// Browser UI served at GET /. A self-contained chat-style app (no build step):
// sidebar of chats, message thread with live progress, composer, settings,
// provider order, and a debug drawer (run details, timeline, provider health,
// server state, diffs, step replay).
//
// NOTE: this page lives inside a TypeScript template literal. Never use
// backticks, dollar-brace sequences or backslash escapes in it; the client
// script uses NL (String.fromCharCode(10)) for newlines and character classes
// in regular expressions instead.

export const UI_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Baton</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" />
<style>
  :root {
    color-scheme: light;
    --bg: #fafafa; --side: #f4f4f5; --panel: #ffffff; --elev: #ffffff; --text: #18181b; --text-2: #52525b; --muted: #71717a;
    --line: #e4e4e7; --line-2: #ececef; --hover: #f0f0f2;
    --accent: #4f46e5; --accent-2: #6366f1; --accent-soft: #eef2ff; --accent-ink: #ffffff;
    --ok: #15803d; --ok-soft: #ecfdf3; --warn: #c2410c; --warn-soft: #fff4ed; --bad: #b91c1c; --bad-soft: #fef2f2;
    --code: #f4f4f5; --user: #eef2ff; --user-ink: #1e1b4b;
    --shadow-sm: 0 1px 2px rgba(16,16,24,.05); --shadow: 0 4px 16px rgba(16,16,24,.06), 0 1px 2px rgba(16,16,24,.04); --shadow-lg: 0 18px 48px rgba(16,16,24,.14);
    --c1: #2a78d6; --c2: #eb6834; --c3: #1baf7a; --c4: #eda100; --c5: #e87ba4; --c6: #008300; --c7: #6250d6; --c8: #e34948;
    --radius: 12px; --font: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --bg: #0b0b0f; --side: #0f0f14; --panel: #141419; --elev: #1a1a21; --text: #f4f4f5; --text-2: #c4c4cc; --muted: #8b8b95;
      --line: #26262e; --line-2: #1f1f26; --hover: #1d1d24;
      --accent: #818cf8; --accent-2: #a5b4fc; --accent-soft: #1e1b4b; --accent-ink: #0b0b0f;
      --ok: #4ade80; --ok-soft: #0f2a1a; --warn: #fb923c; --warn-soft: #2a1709; --bad: #f87171; --bad-soft: #2a0f0f;
      --code: #1a1a21; --user: #1e1b4b; --user-ink: #e0e7ff;
      --shadow-sm: none; --shadow: 0 6px 24px rgba(0,0,0,.35); --shadow-lg: 0 24px 64px rgba(0,0,0,.55);
      --c1: #3987e5; --c2: #d95926; --c3: #199e70; --c4: #c98500; --c5: #d55181; --c6: #0ca30c; --c7: #9085e9; --c8: #e66767;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #0b0b0f; --side: #0f0f14; --panel: #141419; --elev: #1a1a21; --text: #f4f4f5; --text-2: #c4c4cc; --muted: #8b8b95;
    --line: #26262e; --line-2: #1f1f26; --hover: #1d1d24;
    --accent: #818cf8; --accent-2: #a5b4fc; --accent-soft: #1e1b4b; --accent-ink: #0b0b0f;
    --ok: #4ade80; --ok-soft: #0f2a1a; --warn: #fb923c; --warn-soft: #2a1709; --bad: #f87171; --bad-soft: #2a0f0f;
    --code: #1a1a21; --user: #1e1b4b; --user-ink: #e0e7ff;
    --shadow-sm: none; --shadow: 0 6px 24px rgba(0,0,0,.35); --shadow-lg: 0 24px 64px rgba(0,0,0,.55);
    --c1: #3987e5; --c2: #d95926; --c3: #199e70; --c4: #c98500; --c5: #d55181; --c6: #0ca30c; --c7: #9085e9; --c8: #e66767;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; background: var(--bg); color: var(--text); overflow: hidden; font: 14.5px/1.55 var(--font); -webkit-font-smoothing: antialiased; }
  button { font: inherit; color: inherit; cursor: pointer; }
  input, select, textarea { font: inherit; color: var(--text); }
  a { color: var(--accent); }
  [hidden] { display: none !important; }
  .ico { display: inline-flex; width: 16px; height: 16px; flex: none; }
  .ico svg { width: 100%; height: 100%; }
  ::selection { background: var(--accent-soft); }

  .app { display: grid; grid-template-columns: 280px minmax(0, 1fr) auto; height: 100vh; height: 100dvh; }

  /* ---------- sidebar ---------- */
  .side { background: var(--side); border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
  .brand { display: flex; align-items: center; gap: 10px; padding: 16px 16px 10px; }
  .brand .logo { width: 28px; height: 28px; border-radius: 8px; background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 14px; box-shadow: var(--shadow-sm); }
  .brand .name { font-weight: 700; font-size: 16px; letter-spacing: -.01em; flex: 1; }
  .ghost { border: 0; background: none; border-radius: 8px; padding: 6px; color: var(--muted); display: inline-flex; align-items: center; gap: 6px; }
  .ghost:hover { background: var(--hover); color: var(--text); }
  .newchat { margin: 4px 12px 10px; padding: 9px 12px; border: 1px solid var(--line); background: var(--panel); border-radius: 10px; font-weight: 600; display: flex; gap: 8px; align-items: center; box-shadow: var(--shadow-sm); }
  .newchat:hover { border-color: var(--accent); color: var(--accent); }
  .search { margin: 0 12px 6px; position: relative; }
  .search input { width: 100%; border: 1px solid var(--line); background: var(--panel); border-radius: 9px; padding: 7px 10px 7px 30px; font-size: 13px; outline: none; }
  .search input:focus { border-color: var(--accent); }
  .search .ico { position: absolute; left: 10px; top: 9px; width: 14px; height: 14px; color: var(--muted); }
  .chats { flex: 1; overflow-y: auto; padding: 0 8px 8px; min-height: 0; }
  .chats h3 { font-size: 11px; color: var(--muted); font-weight: 600; letter-spacing: .04em; text-transform: uppercase; margin: 14px 8px 4px; }
  .chat-item { position: relative; display: block; width: 100%; text-align: left; background: none; border: 0; border-radius: 9px; padding: 8px 32px 8px 10px; margin: 1px 0; }
  .chat-item:hover { background: var(--hover); }
  .chat-item.active { background: var(--panel); box-shadow: var(--shadow-sm); outline: 1px solid var(--line); }
  .chat-item .t { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 13.5px; font-weight: 500; }
  .chat-item .m { display: block; font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chat-item .del { position: absolute; right: 6px; top: 9px; border: 0; background: none; color: var(--muted); padding: 3px; border-radius: 6px; opacity: 0; display: inline-flex; }
  .chat-item:hover .del, .chat-item.active .del { opacity: 1; }
  .chat-item .del:hover { color: var(--bad); background: var(--bad-soft); }
  .side-empty { color: var(--muted); font-size: 13px; padding: 10px; }
  .side-foot { border-top: 1px solid var(--line); padding: 8px; display: grid; gap: 2px; }
  .side-btn { display: flex; align-items: center; gap: 10px; width: 100%; background: none; border: 0; border-radius: 8px; padding: 8px 10px; text-align: left; font-size: 13.5px; color: var(--text-2); text-decoration: none; }
  .side-btn:hover { background: var(--hover); color: var(--text); }
  .side-btn .sub { margin-left: auto; color: var(--muted); font-size: 12px; }
  summary.side-btn { list-style: none; cursor: pointer; }
  summary.side-btn::-webkit-details-marker { display: none; }
  .usage-box { padding: 6px 10px 10px; font-size: 12px; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; margin-bottom: 8px; background: var(--panel); }
  .seg button { border: 0; background: none; color: var(--muted); font-size: 12px; font-weight: 600; padding: 3px 10px; }
  .seg button.on { background: var(--accent); color: var(--accent-ink); }

  /* ---------- main ---------- */
  .main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .topbar { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--line); min-height: 56px; background: var(--bg); }
  .title-wrap { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; }
  .proj { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; border: 1px solid transparent; background: none; border-radius: 8px; padding: 5px 8px; font-weight: 600; font-size: 15px; letter-spacing: -.01em; }
  .proj .label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .proj.editable:hover { border-color: var(--line); background: var(--panel); }
  .proj .ico { color: var(--muted); }
  .proj-input { font-weight: 600; font-size: 15px; border: 1px solid var(--accent); border-radius: 8px; padding: 5px 8px; background: var(--panel); outline: none; min-width: 220px; max-width: 100%; }
  .proj-hint { color: var(--muted); font-size: 12px; white-space: nowrap; }
  .btn-s { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); background: var(--panel); border-radius: 9px; padding: 6px 11px; font-size: 13px; font-weight: 500; color: var(--text); text-decoration: none; white-space: nowrap; box-shadow: var(--shadow-sm); }
  .btn-s:hover, .btn-s.on { border-color: var(--accent); color: var(--accent); }
  .menu-btn { display: none; }
  .thread { flex: 1; overflow-y: auto; min-height: 0; scroll-behavior: smooth; }
  .thread-inner { max-width: 780px; margin: 0 auto; padding: 28px 20px 16px; }

  .welcome { text-align: center; padding: 9vh 0 0; }
  .welcome .mark { width: 52px; height: 52px; border-radius: 15px; margin: 0 auto 18px; background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 24px; box-shadow: var(--shadow); }
  .welcome h1 { font-size: 30px; letter-spacing: -.02em; margin: 0 0 8px; }
  .welcome p { color: var(--muted); margin: 0 auto 26px; max-width: 540px; }
  .suggest { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; text-align: left; }
  .suggest button { border: 1px solid var(--line); background: var(--panel); border-radius: var(--radius); padding: 14px; text-align: left; display: flex; gap: 12px; box-shadow: var(--shadow-sm); transition: border-color .15s, transform .15s; }
  .suggest button:hover { border-color: var(--accent); transform: translateY(-1px); }
  .suggest .sico { width: 32px; height: 32px; border-radius: 9px; background: var(--accent-soft); color: var(--accent); display: grid; place-items: center; flex: none; }
  .suggest b { display: block; font-size: 14px; }
  .suggest span.s { color: var(--muted); font-size: 12.5px; }

  .msg { display: flex; gap: 12px; margin: 0 0 26px; animation: rise .2s ease-out; }
  @keyframes rise { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  .msg.user { justify-content: flex-end; }
  .bubble { background: var(--user); color: var(--user-ink); padding: 10px 15px; border-radius: 18px 18px 4px 18px; max-width: 82%; white-space: pre-wrap; overflow-wrap: anywhere; }
  .avatar { width: 30px; height: 30px; border-radius: 9px; background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 13px; flex: none; margin-top: 1px; }
  .bot { flex: 1; min-width: 0; }
  .bot-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 6px; }
  .bot-head .who { font-weight: 600; }
  .bot-head .when { color: var(--muted); font-size: 12px; }
  .pill { display: inline-flex; align-items: center; gap: 5px; border-radius: 999px; padding: 2px 9px; font-size: 12px; font-weight: 600; background: var(--hover); color: var(--text-2); }
  .pill.success, .pill.answered { background: var(--ok-soft); color: var(--ok); }
  .pill.partial, .pill.failed, .pill.stopped { background: var(--warn-soft); color: var(--warn); }
  .pill.error { background: var(--bad-soft); color: var(--bad); }
  .pill.running { background: var(--accent-soft); color: var(--accent); }
  .summary-line { font-weight: 500; }
  .errbox { color: var(--bad); background: var(--bad-soft); border-radius: 10px; padding: 10px 12px; margin-top: 8px; overflow-wrap: anywhere; font-size: 13.5px; }
  .warnbox { color: var(--warn); background: var(--warn-soft); border-radius: 10px; padding: 10px 12px; margin-top: 8px; font-size: 13.5px; }
  .files { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; margin-top: 12px; }
  .filecard { display: flex; align-items: center; gap: 10px; border: 1px solid var(--line); background: var(--panel); border-radius: 10px; padding: 9px 11px; text-align: left; min-width: 0; box-shadow: var(--shadow-sm); }
  .filecard:hover { border-color: var(--accent); }
  .filecard .fi { width: 30px; height: 30px; border-radius: 8px; background: var(--code); display: grid; place-items: center; color: var(--muted); flex: none; font-size: 10px; font-weight: 700; font-family: var(--mono); text-transform: uppercase; }
  .filecard .fn { display: block; font-family: var(--mono); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .filecard .fs { display: block; color: var(--muted); font-size: 11.5px; }
  .filecard .tag { margin-left: auto; font-size: 11px; font-weight: 600; color: var(--accent); background: var(--accent-soft); border-radius: 6px; padding: 1px 6px; flex: none; }
  .mmeta { color: var(--muted); font-size: 12px; margin-top: 10px; overflow-wrap: anywhere; }
  .mactions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
  .act { display: inline-flex; align-items: center; gap: 6px; border: 0; background: none; border-radius: 7px; padding: 5px 8px; color: var(--muted); font-size: 12.5px; text-decoration: none; }
  .act:hover { background: var(--hover); color: var(--text); }
  .act.primary { color: var(--accent); }
  .act .ico { width: 14px; height: 14px; }

  /* markdown answers */
  .md { overflow-wrap: anywhere; }
  .md p { margin: 0 0 10px; }
  .md h1, .md h2, .md h3, .md h4 { margin: 16px 0 8px; letter-spacing: -.01em; line-height: 1.3; }
  .md h1 { font-size: 20px; } .md h2 { font-size: 17px; } .md h3 { font-size: 15px; } .md h4 { font-size: 14px; }
  .md ul, .md ol { margin: 0 0 10px; padding-left: 22px; }
  .md li { margin: 3px 0; }
  .md code { font-family: var(--mono); font-size: 12.5px; background: var(--code); border-radius: 5px; padding: 1px 5px; }
  .md blockquote { margin: 0 0 10px; padding: 4px 12px; border-left: 3px solid var(--line); color: var(--text-2); }
  .codeblock { position: relative; margin: 0 0 12px; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: var(--code); }
  .codeblock .cb-head { display: flex; align-items: center; justify-content: space-between; padding: 5px 10px; font-size: 11.5px; color: var(--muted); border-bottom: 1px solid var(--line); }
  .codeblock pre { margin: 0; padding: 12px; overflow-x: auto; font: 12.5px/1.55 var(--mono); }

  .progress { list-style: none; margin: 4px 0 0; padding: 0; font-size: 13px; }
  .progress li { display: flex; gap: 9px; padding: 3px 0; overflow-wrap: anywhere; color: var(--text-2); }
  .progress .ic { width: 16px; flex: none; text-align: center; }
  .progress .ok { color: var(--ok); } .progress .bad { color: var(--warn); } .progress .wait { color: var(--accent); } .progress .dim { color: var(--muted); }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--accent); border-right-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; vertical-align: -2px; }

  /* ---------- composer ---------- */
  .composer-wrap { padding: 8px 20px 18px; }
  .composer { max-width: 780px; margin: 0 auto; border: 1px solid var(--line); background: var(--panel); border-radius: 18px; padding: 12px 12px 10px 16px; box-shadow: var(--shadow); transition: border-color .15s; }
  .composer:focus-within { border-color: var(--accent); }
  .composer textarea { width: 100%; border: 0; outline: none; resize: none; background: transparent; min-height: 26px; max-height: 240px; line-height: 1.55; font-size: 15px; }
  .composer .row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); background: var(--bg); border-radius: 999px; padding: 3px 10px; font-size: 12px; color: var(--text-2); white-space: nowrap; max-width: 46%; overflow: hidden; text-overflow: ellipsis; }
  .chip:hover { border-color: var(--accent); color: var(--accent); }
  .chip .ico { width: 13px; height: 13px; }
  select.chip { appearance: none; padding-right: 10px; cursor: pointer; }
  .composer .hint { flex: 1; min-width: 0; color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .composer .hint.cont { color: var(--accent); }
  .send { width: 36px; height: 36px; border: 0; border-radius: 11px; background: var(--accent); color: var(--accent-ink); display: grid; place-items: center; flex: none; box-shadow: var(--shadow-sm); transition: transform .1s; }
  .send:hover { transform: translateY(-1px); }
  .send:disabled { opacity: .45; cursor: default; transform: none; }
  .send.stop { background: var(--text); color: var(--bg); }
  .partialbox { border: 1px solid var(--line); background: var(--panel); border-radius: var(--radius); padding: 12px 14px; margin-top: 10px; box-shadow: var(--shadow-sm); }
  .partialbox .ph { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-weight: 600; margin-bottom: 8px; }
  .meter { height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; margin-bottom: 10px; }
  .meter span { display: block; height: 100%; background: var(--ok); }
  .steplist { list-style: none; margin: 0 0 10px; padding: 0; font-size: 13px; }
  .steplist li { display: flex; gap: 8px; padding: 2px 0; overflow-wrap: anywhere; }
  .steplist .ok { color: var(--ok); } .steplist .bad { color: var(--warn); } .steplist .dim { color: var(--muted); }
  .steplist code { font-family: var(--mono); font-size: 12.5px; }
  .pbtns { display: flex; flex-wrap: wrap; gap: 8px; }
  .send .ico { width: 18px; height: 18px; }
  .keywarn { max-width: 780px; margin: 0 auto 8px; font-size: 13px; color: var(--warn); background: var(--warn-soft); border-radius: 10px; padding: 8px 12px; }
  .keywarn button { border: 0; background: none; color: var(--accent); font-weight: 600; padding: 0; }
  .foot-note { max-width: 780px; margin: 6px auto 0; text-align: center; color: var(--muted); font-size: 11.5px; }

  /* ---------- debug drawer ---------- */
  .debug { width: 500px; border-left: 1px solid var(--line); background: var(--side); display: flex; flex-direction: column; min-height: 0; }
  .debug-head { display: flex; align-items: center; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
  .tabs { flex: 1; display: flex; gap: 2px; background: var(--hover); border-radius: 9px; padding: 3px; overflow-x: auto; }
  .tabs button { flex: 1; border: 0; background: none; border-radius: 7px; padding: 5px 8px; font-size: 12.5px; font-weight: 600; color: var(--muted); white-space: nowrap; display: inline-flex; align-items: center; justify-content: center; gap: 5px; }
  .tabs button .ico { width: 13px; height: 13px; }
  .tabs button.on { background: var(--panel); color: var(--text); box-shadow: var(--shadow-sm); }
  .debug-body { flex: 1; overflow-y: auto; padding: 12px; min-height: 0; font-size: 13px; }
  .dsec { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; margin-bottom: 10px; box-shadow: var(--shadow-sm); }
  .dsec h4 { margin: 0 0 10px; font-size: 13px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .dsec h4 .sub { color: var(--muted); font-weight: 400; font-size: 12px; }
  .kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 14px; margin: 0; }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; overflow-wrap: anywhere; font-family: var(--mono); font-size: 12px; }
  .tablewrap { overflow-x: auto; }
  .dtable { width: 100%; border-collapse: collapse; font-size: 12px; }
  .dtable th, .dtable td { padding: 5px 6px; border-bottom: 1px solid var(--line-2); text-align: left; vertical-align: top; white-space: nowrap; }
  .dtable td.wrap { white-space: normal; overflow-wrap: anywhere; min-width: 140px; }
  .dtable th { color: var(--muted); font-weight: 600; }
  .dtable td.num, .dtable th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .s-ok { color: var(--ok); } .s-bad { color: var(--warn); }
  .dlog { list-style: none; margin: 0; padding: 0; font-family: var(--mono); font-size: 11.5px; }
  .dlog li { padding: 3px 0; border-bottom: 1px dashed var(--line-2); overflow-wrap: anywhere; }
  .dlog .ev { font-weight: 700; } .dlog .ev.failover { color: var(--warn); } .dlog .ev.execute, .dlog .ev.plan { color: var(--ok); }
  pre.raw { background: var(--code); border-radius: 8px; padding: 10px; font: 11px/1.5 var(--mono); overflow: auto; max-height: 420px; white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0 0; }
  .ctx { list-style: none; margin: 0; padding: 0 0 0 14px; border-left: 2px solid var(--line); }
  .ctx > li { position: relative; margin: 0 0 14px; }
  .ctx > li::before { content: ""; position: absolute; left: -20px; top: 5px; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px var(--panel); }
  .ctx h5 { margin: 0 0 2px; font-size: 13px; overflow-wrap: anywhere; display: flex; justify-content: space-between; gap: 6px; align-items: center; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0; }
  .cchip { font-size: 11px; border: 1px solid var(--line); background: var(--bg); border-radius: 999px; padding: 1px 8px; overflow-wrap: anywhere; }
  .cchip.file { border-color: var(--accent); } .cchip.prev { border-style: dashed; }
  .muted { color: var(--muted); }
  .dbtn { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--line); background: var(--bg); border-radius: 7px; padding: 3px 9px; font-size: 12px; }
  .dbtn:hover { border-color: var(--accent); color: var(--accent); }
  .dbtn .ico { width: 12px; height: 12px; }
  .live li { font-size: 11px; }
  .segbar { display: flex; gap: 2px; height: 10px; margin: 2px 0 10px; }
  .segbar span { min-width: 2px; }
  .segbar span:first-child { border-radius: 4px 0 0 4px; } .segbar span:last-child { border-radius: 0 4px 4px 0; } .segbar span:only-child { border-radius: 4px; }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
  .rate { display: inline-block; width: 48px; height: 6px; border-radius: 3px; background: var(--line); vertical-align: middle; margin-right: 6px; overflow: hidden; }
  .rate span { display: block; height: 100%; background: var(--ok); }

  /* timeline */
  .tl { position: relative; }
  .tl-row { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 8px; align-items: center; min-height: 24px; border-bottom: 1px dashed var(--line-2); }
  .tl-label { font-size: 11.5px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tl-track { position: relative; height: 22px; }
  .tl-bar { position: absolute; top: 5px; height: 12px; border-radius: 4px; min-width: 3px; }
  .tl-bar.ok { background: var(--ok); } .tl-bar.fail { background: var(--warn); }
  .tl-bar.wait { background: repeating-linear-gradient(135deg, var(--muted) 0 3px, transparent 3px 6px); opacity: .7; border: 1px solid var(--muted); }
  .tl-axis { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 8px; margin-top: 4px; }
  .tl-ticks { position: relative; height: 16px; font-size: 10.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .tl-ticks span { position: absolute; transform: translateX(-50%); }
  .tl-ticks span:first-child { transform: none; } .tl-ticks span:last-child { transform: translateX(-100%); }
  .legend { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: var(--text-2); margin-bottom: 8px; }
  .legend i { display: inline-block; width: 14px; height: 8px; border-radius: 3px; margin-right: 5px; vertical-align: 0; }

  /* diff */
  .diff { font: 12px/1.5 var(--mono); border: 1px solid var(--line); border-radius: 10px; overflow: auto; max-height: 60vh; }
  .diff .hunk { color: var(--muted); background: var(--hover); padding: 2px 10px; font-size: 11px; }
  .diff .ln { display: grid; grid-template-columns: 38px 38px 14px minmax(0, 1fr); white-space: pre; }
  .diff .ln span.n { color: var(--muted); text-align: right; padding-right: 6px; user-select: none; }
  .diff .ln.add { background: var(--ok-soft); } .diff .ln.add .s { color: var(--ok); }
  .diff .ln.del { background: var(--bad-soft); } .diff .ln.del .s { color: var(--bad); }
  .diffstat { font-size: 12px; } .diffstat .a { color: var(--ok); } .diffstat .r { color: var(--bad); }

  /* ---------- dialogs ---------- */
  dialog { border: 1px solid var(--line); border-radius: 16px; background: var(--panel); color: var(--text); padding: 0; width: min(580px, calc(100vw - 32px)); box-shadow: var(--shadow-lg); }
  dialog::backdrop { background: rgba(10,10,16,.45); backdrop-filter: blur(2px); }
  .dlg-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 14px 18px; border-bottom: 1px solid var(--line); }
  .dlg-head h2 { margin: 0; font-size: 16px; overflow-wrap: anywhere; letter-spacing: -.01em; }
  .dlg-body { padding: 16px 18px; max-height: 70vh; overflow-y: auto; }
  .dlg-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--line); }
  .field { margin-bottom: 14px; }
  .field label { display: flex; justify-content: space-between; font-weight: 600; font-size: 13px; margin-bottom: 5px; }
  .field label a { font-weight: 500; font-size: 12px; text-decoration: none; }
  .field input, .field select { width: 100%; border: 1px solid var(--line); background: var(--bg); border-radius: 9px; padding: 8px 10px; outline: none; }
  .field input:focus { border-color: var(--accent); }
  .check { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--text-2); }
  .btn { border: 1px solid var(--line); background: var(--bg); border-radius: 9px; padding: 7px 14px; font-weight: 500; }
  .btn:hover { border-color: var(--accent); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); font-weight: 600; }
  .keyres { font-size: 12px; margin-top: 5px; overflow-wrap: anywhere; }
  .keyres.ok { color: var(--ok); } .keyres.bad { color: var(--warn); }
  .keyres .muted { display: block; }
  .themes { display: flex; gap: 6px; }
  .themes button { flex: 1; border: 1px solid var(--line); background: var(--bg); border-radius: 9px; padding: 7px; font-size: 13px; display: inline-flex; gap: 6px; align-items: center; justify-content: center; }
  .themes button.on { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
  .orderlist { list-style: none; margin: 0; padding: 0; }
  .orderlist li { display: flex; align-items: center; gap: 10px; border: 1px solid var(--line); border-radius: 11px; padding: 9px 11px; margin-bottom: 6px; background: var(--panel); }
  .orderlist li.dragging { opacity: .5; } .orderlist li.over { border-color: var(--accent); }
  .orderlist li.off .oname { color: var(--muted); text-decoration: line-through; }
  .orderlist .handle { cursor: grab; color: var(--muted); user-select: none; }
  .orderlist .num { width: 18px; text-align: center; font-weight: 700; color: var(--accent); font-size: 13px; }
  .orderlist .oname { flex: 1; min-width: 0; font-weight: 500; }
  .orderlist .oname small { display: block; color: var(--muted); font-size: 12px; font-weight: 400; }
  .orderlist .oname small.nokey { color: var(--warn); }
  .orderlist .arrows button { border: 1px solid var(--line); background: var(--bg); border-radius: 7px; padding: 0 7px; font-size: 13px; }
  .orderlist .arrows button:disabled { opacity: .35; cursor: default; }
  #fileDlg { width: min(960px, calc(100vw - 32px)); }
  #fileDlg pre.file { margin: 0; background: var(--code); border-radius: 10px; padding: 14px; font: 12.5px/1.55 var(--mono); overflow: auto; max-height: 62vh; white-space: pre; border: 1px solid var(--line); }
  .ftabs { display: inline-flex; gap: 2px; background: var(--hover); border-radius: 9px; padding: 3px; margin-bottom: 10px; }
  .ftabs button { border: 0; background: none; border-radius: 7px; padding: 4px 12px; font-size: 12.5px; font-weight: 600; color: var(--muted); }
  .ftabs button.on { background: var(--panel); color: var(--text); box-shadow: var(--shadow-sm); }

  .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%) translateY(20px); background: var(--text); color: var(--bg); padding: 9px 16px; border-radius: 10px; font-size: 13px; font-weight: 500; box-shadow: var(--shadow-lg); opacity: 0; transition: opacity .2s, transform .2s; pointer-events: none; z-index: 100; }
  .toast.show { opacity: 1; transform: translateX(-50%); }

  /* ---------- responsive ---------- */
  .scrim { display: none; }
  @media (max-width: 1240px) { .debug { position: fixed; top: 0; right: 0; bottom: 0; width: min(500px, 100vw); z-index: 30; box-shadow: var(--shadow-lg); } }
  @media (max-width: 880px) {
    .app { grid-template-columns: minmax(0, 1fr); }
    .side { position: fixed; top: 0; left: 0; bottom: 0; width: 290px; z-index: 40; transform: translateX(-100%); transition: transform .2s; }
    .side.open { transform: none; box-shadow: var(--shadow-lg); }
    .scrim.show { display: block; position: fixed; inset: 0; background: rgba(10,10,16,.4); z-index: 35; }
    .menu-btn { display: inline-flex; }
    .bubble { max-width: 90%; }
    .btn-s .txt { display: none; }
    .proj-hint { display: none; }
  }
</style>
</head>
<body>
<div class="app">
  <aside class="side" id="side" aria-label="Chats">
    <div class="brand">
      <span class="logo">B</span><span class="name">Baton</span>
      <button type="button" class="ghost" id="themeBtn" title="Theme"></button>
    </div>
    <button type="button" class="newchat" id="newChat"><span class="ico" data-icon="plus"></span>New chat</button>
    <div class="search"><span class="ico" data-icon="search"></span><input id="chatSearch" type="search" placeholder="Search chats" aria-label="Search chats" /></div>
    <nav class="chats" id="chats"></nav>
    <div class="side-foot">
      <details id="usageDetails">
        <summary class="side-btn"><span class="ico" data-icon="chart"></span><span>Token usage</span><span class="sub" id="usageSummary"></span></summary>
        <div class="usage-box">
          <span class="seg"><button type="button" id="uToday" class="on">Today</button><button type="button" id="uAll">All time</button></span>
          <div id="usageBody"></div>
        </div>
      </details>
      <button type="button" class="side-btn" id="openSettings"><span class="ico" data-icon="settings"></span><span>Settings &amp; API keys</span><span class="sub" id="keyStatus"></span></button>
      <button type="button" class="side-btn" id="openDebugSide"><span class="ico" data-icon="bug"></span><span>Debug panel</span><span class="sub" id="debugState">off</span></button>
      <a class="side-btn" id="exportAll" href="/api/export/all" title="Every chat: transcripts, full data, files, usage and server info (no API keys)"><span class="ico" data-icon="archive"></span><span>Export all chats</span><span class="sub">.zip</span></a>
    </div>
  </aside>
  <div class="scrim" id="scrim"></div>

  <main class="main">
    <header class="topbar">
      <button type="button" class="ghost menu-btn" id="menuBtn" aria-label="Open chats"><span class="ico" data-icon="menu"></span></button>
      <div class="title-wrap" id="titleWrap"></div>
      <a class="btn-s" id="downloadLatest" hidden title="Download the project as a .zip"><span class="ico" data-icon="download"></span><span class="txt">Download</span></a>
      <a class="btn-s" id="exportChat" hidden title="Transcript + full data + files, as a zip (no API keys)"><span class="ico" data-icon="archive"></span><span class="txt">Export</span></a>
      <button type="button" class="btn-s" id="debugBtn" aria-pressed="false"><span class="ico" data-icon="bug"></span><span class="txt">Debug</span></button>
    </header>
    <div class="thread" id="thread"><div class="thread-inner" id="threadInner"></div></div>
    <div class="composer-wrap">
      <div class="keywarn" id="keyWarn" hidden>No API keys yet. <button type="button" id="keyWarnBtn">Add them in Settings</button> (greetings work without keys).</div>
      <form class="composer" id="composer">
        <textarea id="prompt" rows="1" placeholder="Describe what Baton should build..." aria-label="Message"></textarea>
        <div class="row">
          <select id="taskType" class="chip" aria-label="Task type">
            <option value="code">Code</option>
            <option value="document">Document</option>
            <option value="analysis">Analysis</option>
          </select>
          <button type="button" class="chip" id="orderBtn" title="Choose which AI Baton calls first"><span class="ico" data-icon="layers"></span><span id="orderText">Order</span></button>
          <span class="hint" id="composerHint">New project</span>
          <button type="submit" class="send" id="send" aria-label="Send"><span class="ico" data-icon="send"></span></button>
        </div>
      </form>
      <div class="foot-note">Enter to send · Shift+Enter for a new line · questions get answers, requests get files</div>
    </div>
  </main>

  <aside class="debug" id="debug" hidden aria-label="Debug panel">
    <div class="debug-head">
      <div class="tabs">
        <button type="button" data-tab="run" class="on"><span class="ico" data-icon="list"></span>Run</button>
        <button type="button" data-tab="timeline"><span class="ico" data-icon="clock"></span>Timeline</button>
        <button type="button" data-tab="health"><span class="ico" data-icon="activity"></span>Health</button>
        <button type="button" data-tab="server"><span class="ico" data-icon="server"></span>Server</button>
      </div>
      <button type="button" class="ghost" id="closeDebug" aria-label="Close debug panel"><span class="ico" data-icon="x"></span></button>
    </div>
    <div class="debug-body" id="debugBody"></div>
  </aside>
</div>

<dialog id="settingsDlg">
  <div class="dlg-head"><h2>Settings &amp; API keys</h2><button type="button" class="ghost" id="closeSettings" aria-label="Close"><span class="ico" data-icon="x"></span></button></div>
  <div class="dlg-body">
    <div class="field"><label>Theme</label><div class="themes" id="themePick"></div></div>
    <p class="muted" style="margin:0 0 12px;font-size:13px">Keys go only to your Baton server, which passes them to each provider. They are never saved in history. Order: <span id="orderTextDlg">...</span></p>
    <div id="keyFields"></div>
    <label class="check"><input type="checkbox" id="remember" /> Remember keys in this browser</label>
  </div>
  <div class="dlg-foot"><button type="button" class="btn" id="testKeys">Test keys</button><button type="button" class="btn primary" id="saveSettings">Save</button></div>
</dialog>

<dialog id="orderDlg">
  <div class="dlg-head"><h2>Provider order</h2><button type="button" class="ghost" id="closeOrder" aria-label="Close"><span class="ico" data-icon="x"></span></button></div>
  <div class="dlg-body">
    <p class="muted" style="margin-top:0;font-size:13px">Baton calls providers from top to bottom, for the plan and for every file, trying each provider's models before moving on. Drag rows or use the arrows. Untick a provider to skip it.</p>
    <ol class="orderlist" id="orderList"></ol>
  </div>
  <div class="dlg-foot"><button type="button" class="btn" id="resetOrder">Reset to default</button><button type="button" class="btn primary" id="doneOrder">Done</button></div>
</dialog>

<dialog id="fileDlg">
  <div class="dlg-head"><h2 id="fileName">file</h2><span style="display:flex;gap:6px"><button type="button" class="btn-s" id="copyFile"><span class="ico" data-icon="copy"></span><span class="txt">Copy</span></button><button type="button" class="ghost" id="closeFile" aria-label="Close"><span class="ico" data-icon="x"></span></button></span></div>
  <div class="dlg-body"><div class="ftabs" id="fileTabs" hidden><button type="button" data-ft="content" class="on">Content</button><button type="button" data-ft="diff">Changes</button></div><div id="fileBody"></div></div>
</dialog>

<div class="toast" id="toast" role="status"></div>

<script>
(() => {
  const NL = String.fromCharCode(10);
  const FENCE = "~".repeat(0) + String.fromCharCode(96).repeat(3);
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  };
  const el = (tag, props, ...kids) => {
    const n = Object.assign(document.createElement(tag), props || {});
    for (const k of kids) if (k != null && k !== false) n.append(k);
    return n;
  };
  const fmt = (n) => Math.round(n || 0).toLocaleString();
  const short = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n || 0)));
  const secs = (ms) => (ms / 1000).toFixed(1) + "s";
  const size = (chars) => (chars >= 1024 ? (chars / 1024).toFixed(1) + " KB" : chars + " B");
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  function ago(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    return new Date(iso).toLocaleDateString();
  }
  const PROVIDER_LABEL = { groq: "Groq", google: "Gemini", nvidia: "NVIDIA NIM", openrouter: "OpenRouter", openai: "OpenAI", baton: "Baton" };
  const STATUS_TEXT = { success: "Done", partial: "Partly done", failed: "Failed", error: "Error", gated: "Answered locally", answered: "Answer", stopped: "Stopped" };

  // ---------- icons (static SVG markup; Lucide-style strokes) ----------
  const P = {
    plus: "<path d='M12 5v14M5 12h14'/>",
    search: "<circle cx='11' cy='11' r='7'/><path d='m20 20-3.5-3.5'/>",
    settings: "<circle cx='12' cy='12' r='3'/><path d='M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'/>",
    bug: "<path d='M8 2l1.9 1.9M16 2l-1.9 1.9M9 7.1a3 3 0 1 1 6 0'/><path d='M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6zM12 20v-9M6.5 9H3M6 13H2M6 17l-3 2M17.5 9H21M18 13h4M18 17l3 2'/>",
    archive: "<rect x='2' y='4' width='20' height='5' rx='1'/><path d='M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9M10 13h4'/>",
    download: "<path d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3'/>",
    menu: "<path d='M4 6h16M4 12h16M4 18h16'/>",
    x: "<path d='M18 6 6 18M6 6l12 12'/>",
    send: "<path d='M12 19V5M5 12l7-7 7 7'/>",
    copy: "<rect x='9' y='9' width='13' height='13' rx='2'/><path d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'/>",
    trash: "<path d='M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6'/>",
    edit: "<path d='M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'/>",
    sun: "<circle cx='12' cy='12' r='4'/><path d='M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'/>",
    moon: "<path d='M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'/>",
    monitor: "<rect x='2' y='3' width='20' height='14' rx='2'/><path d='M8 21h8M12 17v4'/>",
    chart: "<path d='M3 3v18h18M7 15l4-4 3 3 5-6'/>",
    layers: "<path d='m12 2 10 5-10 5L2 7z'/><path d='m2 17 10 5 10-5M2 12l10 5 10-5'/>",
    list: "<path d='M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'/>",
    clock: "<circle cx='12' cy='12' r='9'/><path d='M12 7v5l3 2'/>",
    activity: "<path d='M22 12h-4l-3 9L9 3l-3 9H2'/>",
    server: "<rect x='2' y='3' width='20' height='8' rx='2'/><rect x='2' y='13' width='20' height='8' rx='2'/><path d='M6 7h.01M6 17h.01'/>",
    folder: "<path d='M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'/>",
    diff: "<path d='M12 3v14M5 10h14M5 21h14'/>",
    play: "<path d='M6 4l14 8-14 8z'/>",
    stop: "<rect x='6' y='6' width='12' height='12' rx='2'/>",
    refresh: "<path d='M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5'/>",
    code: "<path d='m16 18 6-6-6-6M8 6l-6 6 6 6'/>",
    doc: "<path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'/><path d='M14 2v6h6M8 13h8M8 17h6'/>",
    sparkles: "<path d='M12 3l1.8 4.7L18 9.5l-4.2 1.8L12 16l-1.8-4.7L6 9.5l4.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z'/>",
    globe: "<circle cx='12' cy='12' r='9'/><path d='M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18'/>",
  };
  function icon(name) {
    const s = el("span", { className: "ico" });
    s.innerHTML = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'>" + (P[name] || "") + "</svg>";
    return s;
  }
  function paintIcons(root) {
    for (const n of (root || document).querySelectorAll("[data-icon]")) { n.replaceWith(icon(n.getAttribute("data-icon"))); }
  }
  paintIcons();

  let toastTimer = 0;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
  }

  // ===================== Theme =====================
  let theme = store.get("baton.theme") || "system";
  function applyTheme() {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    const btn = $("themeBtn");
    btn.replaceChildren(icon(theme === "dark" ? "moon" : theme === "light" ? "sun" : "monitor"));
    btn.title = "Theme: " + theme + " (click to change)";
    const pick = $("themePick");
    pick.replaceChildren(...[["system", "monitor", "System"], ["light", "sun", "Light"], ["dark", "moon", "Dark"]].map(([v, ic, label]) => {
      const b = el("button", { type: "button", className: theme === v ? "on" : "" }, icon(ic), label);
      b.onclick = () => { theme = v; store.set("baton.theme", v); applyTheme(); };
      return b;
    }));
  }
  $("themeBtn").onclick = () => { theme = theme === "system" ? "light" : theme === "light" ? "dark" : "system"; store.set("baton.theme", theme); applyTheme(); toast("Theme: " + theme); };
  applyTheme();

  // ===================== API keys (Settings) =====================
  const KEY_FIELDS = [
    ["nvidia", "nvidiaApiKey", "NVIDIA NIM", "nvapi-...", "https://build.nvidia.com"],
    ["groq", "groqApiKey", "Groq", "gsk_...", "https://console.groq.com/keys"],
    ["gemini", "geminiApiKey", "Gemini", "AIza...", "https://aistudio.google.com/apikey"],
    ["openrouter", "openrouterApiKey", "OpenRouter (free models)", "sk-or-...", "https://openrouter.ai/keys"],
    ["openai", "openaiApiKey", "OpenAI (paid)", "sk-...", "https://platform.openai.com/api-keys"],
  ];
  const keys = { nvidia: "", groq: "", gemini: "", openrouter: "", openai: "" };
  let remember = store.get("baton.remember") === "1";
  if (remember) for (const [k] of KEY_FIELDS) keys[k] = store.get("baton." + k) || "";
  const keyCount = () => KEY_FIELDS.filter(([k]) => keys[k].trim()).length;
  const keyPayload = () => Object.fromEntries(KEY_FIELDS.map(([k, field]) => [field, keys[k].trim() || undefined]));

  function renderKeyStatus() {
    const n = keyCount();
    $("keyStatus").textContent = n ? n + " key" + (n === 1 ? "" : "s") : "none";
    $("keyWarn").hidden = n > 0;
  }
  function openSettings() {
    $("keyFields").replaceChildren(...KEY_FIELDS.map(([k, , label, ph, url]) =>
      el("div", { className: "field" },
        el("label", { htmlFor: "key_" + k }, label, el("a", { href: url, target: "_blank", rel: "noopener", textContent: "Get a key" })),
        el("input", { type: "password", id: "key_" + k, value: keys[k], placeholder: ph, autocomplete: "off" }),
        el("div", { className: "keyres", id: "keyres_" + k }))));
    $("remember").checked = remember;
    $("orderTextDlg").textContent = orderSummary();
    applyTheme();
    $("settingsDlg").showModal();
  }
  function saveSettings() {
    for (const [k] of KEY_FIELDS) keys[k] = ($("key_" + k).value || "").trim();
    remember = $("remember").checked;
    store.set("baton.remember", remember ? "1" : null);
    for (const [k] of KEY_FIELDS) store.set("baton." + k, remember && keys[k] ? keys[k] : null);
    $("settingsDlg").close();
    renderKeyStatus();
    renderOrderChip();
    toast("Settings saved");
  }
  $("openSettings").onclick = openSettings;
  $("keyWarnBtn").onclick = openSettings;
  $("saveSettings").onclick = saveSettings;
  $("closeSettings").onclick = () => $("settingsDlg").close();
  const PROVIDER_FIELD = { nvidia: "nvidia", groq: "groq", google: "gemini", openrouter: "openrouter", openai: "openai" };
  $("testKeys").onclick = async () => {
    const draft = Object.fromEntries(KEY_FIELDS.map(([k, field]) => [field, ($("key_" + k).value || "").trim() || undefined]));
    for (const [k] of KEY_FIELDS) { const r = $("keyres_" + k); r.className = "keyres muted"; r.textContent = ($("key_" + k).value || "").trim() ? "Testing..." : ""; }
    $("testKeys").disabled = true;
    try {
      const res = await fetch("/api/keys/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys: draft }) });
      const data = await res.json();
      for (const r of data.results || []) {
        const box = $("keyres_" + PROVIDER_FIELD[r.provider]);
        if (!box) continue;
        box.className = "keyres " + (r.ok ? "ok" : "bad");
        const lines = [(r.ok ? "✓ " : "✗ ") + r.message];
        if (r.missing && r.missing.length) lines.push("Not available to this key: " + r.missing.join(", "));
        if (r.account) lines.push("Account: " + (r.account.label || "") + (r.account.freeTier ? " · free tier" : "") + (r.account.limit != null ? " · limit " + r.account.limit : "") + (r.account.usage != null ? " · used " + r.account.usage : ""));
        box.replaceChildren(el("span", { textContent: lines[0] }), ...lines.slice(1).map((t) => el("span", { className: "muted", textContent: t })));
      }
    } catch {
      for (const [k] of KEY_FIELDS) { const r = $("keyres_" + k); if (r.textContent === "Testing...") { r.className = "keyres bad"; r.textContent = "Could not reach the server"; } }
    } finally { $("testKeys").disabled = false; }
  };

  // ===================== Provider order =====================
  const ALL_PROVIDERS = ["nvidia", "groq", "google", "openrouter", "openai"];
  const KEY_OF = { nvidia: "nvidia", groq: "groq", google: "gemini", openrouter: "openrouter", openai: "openai" };
  const hasKey = (p) => !!(keys[KEY_OF[p]] || "").trim();
  let order = null;
  try {
    const saved = JSON.parse(store.get("baton.order") || "null");
    if (Array.isArray(saved)) order = saved.filter((o) => ALL_PROVIDERS.includes(o.id));
  } catch {}
  const completeOrder = (list) => { const seen = new Set(list.map((o) => o.id)); return list.concat(ALL_PROVIDERS.filter((p) => !seen.has(p)).map((id) => ({ id, on: true }))); };
  async function defaultOrder() {
    const d = await loadDebug();
    const ids = d ? d.providerOrder.relay : ALL_PROVIDERS;
    return completeOrder(ids.filter((p) => ALL_PROVIDERS.includes(p)).map((id) => ({ id, on: true })));
  }
  function saveOrder() { store.set("baton.order", JSON.stringify(order)); renderOrderChip(); }
  const activeOrder = () => (order || []).filter((o) => o.on && hasKey(o.id)).map((o) => o.id);
  const orderSummary = () => { const a = activeOrder(); return a.length ? a.map((p) => PROVIDER_LABEL[p] || p).join(" → ") : "no provider switched on with a key"; };
  function renderOrderChip() {
    const a = activeOrder();
    $("orderText").textContent = a.length ? a.map((p) => PROVIDER_LABEL[p] || p).join(" → ") : "No providers";
    $("orderBtn").title = "Baton tries: " + orderSummary() + ". Click to change.";
  }
  let dragFrom = -1;
  function renderOrderList() {
    let rank = 0;
    $("orderList").replaceChildren(...order.map((o, i) => {
      const keyed = hasKey(o.id), active = o.on && keyed;
      if (active) rank++;
      const cb = el("input", { type: "checkbox", checked: o.on, title: o.on ? "Switch off" : "Switch on" });
      cb.onchange = () => { o.on = cb.checked; saveOrder(); renderOrderList(); };
      const up = el("button", { type: "button", textContent: "↑", disabled: i === 0, title: "Move up" });
      up.onclick = () => { order.splice(i - 1, 0, order.splice(i, 1)[0]); saveOrder(); renderOrderList(); };
      const down = el("button", { type: "button", textContent: "↓", disabled: i === order.length - 1, title: "Move down" });
      down.onclick = () => { order.splice(i + 1, 0, order.splice(i, 1)[0]); saveOrder(); renderOrderList(); };
      const li = el("li", { className: o.on ? "" : "off", draggable: true },
        el("span", { className: "handle", textContent: "⋮⋮", title: "Drag to reorder" }),
        el("span", { className: "num", textContent: active ? String(rank) : "–" }), cb,
        el("span", { className: "oname" }, PROVIDER_LABEL[o.id] || o.id,
          el("small", { className: keyed ? "" : "nokey", textContent: !keyed ? "No API key: add one in Settings" : o.on ? (rank === 1 ? "Called first" : "Fallback #" + (rank - 1)) : "Switched off: never called" })),
        el("span", { className: "arrows" }, up, " ", down));
      li.addEventListener("dragstart", () => { dragFrom = i; li.classList.add("dragging"); });
      li.addEventListener("dragend", () => li.classList.remove("dragging"));
      li.addEventListener("dragover", (e) => { e.preventDefault(); li.classList.add("over"); });
      li.addEventListener("dragleave", () => li.classList.remove("over"));
      li.addEventListener("drop", (e) => { e.preventDefault(); if (dragFrom < 0 || dragFrom === i) return; order.splice(i, 0, order.splice(dragFrom, 1)[0]); dragFrom = -1; saveOrder(); renderOrderList(); });
      return li;
    }));
  }
  $("orderBtn").onclick = async () => { if (!order) { order = await defaultOrder(); saveOrder(); } renderOrderList(); $("orderDlg").showModal(); };
  $("closeOrder").onclick = () => $("orderDlg").close();
  $("doneOrder").onclick = () => $("orderDlg").close();
  $("resetOrder").onclick = async () => { order = await defaultOrder(); saveOrder(); renderOrderList(); };

  // ===================== Data: runs grouped into chats =====================
  let runs = [];
  let chats = [];
  let chatMeta = {};
  const records = new Map();
  let currentChatId = store.get("baton.chat") || null;
  let selectedRunId = null;
  let running = false;
  let liveEvents = [];

  function chatIdOf(r, byId) {
    let c = r;
    const seen = new Set();
    while (!c.chatId && c.parentId && byId.has(c.parentId) && !seen.has(c.id)) { seen.add(c.id); c = byId.get(c.parentId); }
    return c.chatId || c.id;
  }
  function groupChats() {
    const byId = new Map(runs.map((r) => [r.id, r]));
    const map = new Map();
    for (const r of runs) { const id = chatIdOf(r, byId); if (!map.has(id)) map.set(id, []); map.get(id).push(r); }
    chats = [...map].map(([id, rs]) => {
      rs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return { id, runs: rs, prompt: rs[0].userPrompt, updatedAt: rs[rs.length - 1].createdAt };
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  const projectName = (chat) => (chatMeta[chat.id] && chatMeta[chat.id].projectName) || chat.prompt;
  async function loadRuns() {
    try {
      const [h, c] = await Promise.all([fetch("/api/history?limit=1000"), fetch("/api/chats")]);
      if (h.ok) runs = (await h.json()).runs || [];
      if (c.ok) chatMeta = Object.fromEntries(((await c.json()).chats || []).map((m) => [m.chatId, m]));
    } catch {}
    groupChats();
    renderSidebar();
  }
  async function getRecord(id) {
    if (records.has(id)) return records.get(id);
    try {
      const res = await fetch("/api/history/" + encodeURIComponent(id));
      if (!res.ok) return null;
      const rec = await res.json();
      records.set(id, rec);
      return rec;
    } catch { return null; }
  }
  const currentChat = () => chats.find((c) => c.id === currentChatId) || null;

  // ===================== Sidebar =====================
  let search = "";
  $("chatSearch").addEventListener("input", (e) => { search = e.target.value.trim().toLowerCase(); renderSidebar(); });
  function renderSidebar() {
    const box = $("chats");
    const list = chats.filter((c) => !search || projectName(c).toLowerCase().includes(search) || c.runs.some((r) => r.userPrompt.toLowerCase().includes(search)));
    if (!list.length) { box.replaceChildren(el("div", { className: "side-empty", textContent: search ? "No chats match." : "No chats yet. Your projects and follow-ups will appear here." })); return; }
    const day = 86400000, now = Date.now();
    const bucket = (iso) => { const d = new Date(iso); const t = new Date(); t.setHours(0, 0, 0, 0); const ms = d.getTime(); return ms >= t.getTime() ? "Today" : ms >= t.getTime() - day ? "Yesterday" : now - ms < 7 * day ? "Previous 7 days" : "Older"; };
    const out = [];
    let last = "";
    for (const c of list) {
      const b = bucket(c.updatedAt);
      if (b !== last) { out.push(el("h3", { textContent: b })); last = b; }
      const lastRun = c.runs[c.runs.length - 1];
      const files = Math.max(0, ...c.runs.map((r) => r.artifactCount || 0));
      const meta = chatMeta[c.id];
      const item = el("button", { type: "button", className: "chat-item" + (c.id === currentChatId ? " active" : ""), title: c.prompt },
        el("span", { className: "t", textContent: meta && meta.custom ? meta.projectName : c.prompt }),
        el("span", { className: "m", textContent: c.runs.length + " message" + (c.runs.length === 1 ? "" : "s") + (files ? " · " + files + " files" : "") + " · " + ago(lastRun.createdAt) }));
      item.onclick = () => openChat(c.id);
      const del = el("span", { className: "del", title: "Delete chat", role: "button" }, icon("trash"));
      del.onclick = (e) => { e.stopPropagation(); deleteChat(c); };
      item.append(del);
      out.push(item);
    }
    box.replaceChildren(...out);
  }
  async function deleteChat(c) {
    if (!confirm("Delete this chat and its " + c.runs.length + " message(s) from history?")) return;
    for (const r of c.runs) { await fetch("/api/history/" + encodeURIComponent(r.id), { method: "DELETE" }).catch(() => {}); records.delete(r.id); }
    if (c.id === currentChatId) newChat();
    await loadRuns();
    loadUsage();
    toast("Chat deleted");
  }

  // ===================== Project title (editable) =====================
  function renderTitle() {
    const wrap = $("titleWrap");
    const chat = currentChat();
    if (!chat) { wrap.replaceChildren(el("span", { className: "proj" }, el("span", { className: "label", textContent: "New chat" }))); return; }
    const meta = chatMeta[chat.id] || {};
    const name = meta.projectName || chat.prompt;
    const btn = el("button", { type: "button", className: "proj editable", title: "Rename project (used for the .zip download)" },
      icon("folder"), el("span", { className: "label", textContent: name }), icon("edit"));
    btn.onclick = () => {
      const input = el("input", { className: "proj-input", value: meta.custom ? meta.projectName : "", placeholder: meta.projectName || "Project name", maxLength: 80, "aria-label": "Project name" });
      const hint = el("span", { className: "proj-hint", textContent: "Enter to save · Esc to cancel" });
      wrap.replaceChildren(input, hint);
      input.focus();
      let done = false;
      const finish = async (save) => {
        if (done) return; done = true;
        if (save) {
          const v = input.value.trim();
          try {
            const res = await fetch("/api/chats/" + encodeURIComponent(chat.id), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectName: v }) });
            if (!res.ok) throw new Error((await res.json()).message || "Could not save");
            await loadRuns();
            toast(v ? "Project renamed: downloads are now " + (chatMeta[chat.id].slug || "project") + ".zip" : "Project name reset");
          } catch (e) { toast(e.message); }
        }
        renderTitle();
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
      input.addEventListener("blur", () => finish(true));
    };
    wrap.replaceChildren(btn);
  }

  // ===================== Markdown (answers) =====================
  // Small, safe renderer: builds DOM nodes (never innerHTML) for headings, lists, quotes, code blocks and inline code/bold/italic/links.
  function inline(text) {
    const out = [];
    let i = 0, buf = "";
    const flush = () => { if (buf) { out.push(buf); buf = ""; } };
    while (i < text.length) {
      const ch = text[i];
      if (ch === String.fromCharCode(96)) {
        const j = text.indexOf(ch, i + 1);
        if (j > i) { flush(); out.push(el("code", { textContent: text.slice(i + 1, j) })); i = j + 1; continue; }
      }
      if (ch === "*" && text[i + 1] === "*") {
        const j = text.indexOf("**", i + 2);
        if (j > i + 2) { flush(); out.push(el("strong", {}, ...inline(text.slice(i + 2, j)))); i = j + 2; continue; }
      }
      if ((ch === "*" || ch === "_") && text[i + 1] && text[i + 1] !== " ") {
        const j = text.indexOf(ch, i + 1);
        if (j > i + 1 && text[j - 1] !== " ") { flush(); out.push(el("em", {}, ...inline(text.slice(i + 1, j)))); i = j + 1; continue; }
      }
      if (ch === "[") {
        const close = text.indexOf("](", i);
        const end = close > 0 ? text.indexOf(")", close) : -1;
        const url = end > 0 ? text.slice(close + 2, end) : "";
        if (close > i && end > close && /^https?:[/][/]/.test(url)) { flush(); out.push(el("a", { href: url, target: "_blank", rel: "noopener", textContent: text.slice(i + 1, close) })); i = end + 1; continue; }
      }
      buf += ch; i++;
    }
    flush();
    return out;
  }
  function codeBlock(code, lang) {
    const copy = el("button", { type: "button", className: "act" }, icon("copy"), "Copy");
    copy.onclick = async () => { try { await navigator.clipboard.writeText(code); toast("Copied"); } catch { toast("Copy failed"); } };
    return el("div", { className: "codeblock" }, el("div", { className: "cb-head" }, el("span", { textContent: lang || "code" }), copy), el("pre", { textContent: code }));
  }
  function renderMarkdown(src) {
    const root = el("div", { className: "md" });
    const lines = String(src || "").split(NL);
    let i = 0, para = [], list = null;
    const endPara = () => { if (para.length) { root.append(el("p", {}, ...inline(para.join(" ")))); para = []; } };
    const endList = () => { if (list) { root.append(list); list = null; } };
    while (i < lines.length) {
      const line = lines[i];
      const t = line.trim();
      if (t.startsWith(FENCE)) {
        endPara(); endList();
        const lang = t.slice(3).trim();
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(FENCE)) { buf.push(lines[i]); i++; }
        i++;
        root.append(codeBlock(buf.join(NL), lang));
        continue;
      }
      const h = /^(#{1,4})[ ]+(.*)$/.exec(t);
      if (h) { endPara(); endList(); root.append(el("h" + h[1].length, {}, ...inline(h[2]))); i++; continue; }
      const ul = /^[-*+][ ]+(.*)$/.exec(t);
      const ol = /^[0-9]+[.)][ ]+(.*)$/.exec(t);
      if (ul || ol) {
        endPara();
        const tag = ul ? "ul" : "ol";
        if (!list || list.tagName.toLowerCase() !== tag) { endList(); list = el(tag); }
        list.append(el("li", {}, ...inline((ul || ol)[1])));
        i++; continue;
      }
      if (t.startsWith(">")) { endPara(); endList(); root.append(el("blockquote", {}, ...inline(t.replace(/^>[ ]?/, "")))); i++; continue; }
      if (!t) { endPara(); endList(); i++; continue; }
      endList();
      para.push(t);
      i++;
    }
    endPara(); endList();
    return root;
  }

  // ===================== Thread =====================
  const SUGGESTIONS = [
    ["globe", "Todo list app", "One HTML file with JS, saved in the browser", "Create a todo list using HTML and JS in a single index.html that saves items in localStorage"],
    ["code", "Student marks web app", "Register students and score marks", "Create a web app to register students and score their marks using HTML, CSS and JS"],
    ["layers", "REST API", "Express.js auth service with JWT and bcrypt", "Create an Express.js authentication service with JWT and bcrypt"],
    ["doc", "Explain a concept", "Ask anything: you get an answer, not files", "Explain what RAG (retrieval-augmented generation) is in simple terms"],
  ];
  const scrollBottom = () => { const t = $("thread"); t.scrollTop = t.scrollHeight; };

  function showWelcome() {
    renderTitle();
    $("downloadLatest").hidden = true;
    $("exportChat").hidden = true;
    $("threadInner").replaceChildren(el("div", { className: "welcome" },
      el("div", { className: "mark", textContent: "B" }),
      el("h1", { textContent: "What should we build?" }),
      el("p", { textContent: "Describe a project and Baton plans it, writes every file on free AI providers and switches provider automatically when one is busy. Ask a question and you get an answer." }),
      el("div", { className: "suggest" }, ...SUGGESTIONS.map(([ic, title, sub, prompt]) => {
        const b = el("button", { type: "button" }, el("span", { className: "sico" }, icon(ic)), el("span", {}, el("b", { textContent: title }), el("span", { className: "s", textContent: sub })));
        b.onclick = () => { $("prompt").value = prompt; autosize(); $("prompt").focus(); };
        return b;
      }))));
  }
  function newChat() {
    currentChatId = null;
    store.set("baton.chat", null);
    selectedRunId = null;
    showWelcome();
    renderSidebar();
    updateComposer();
    renderDebug();
    closeSide();
    $("prompt").focus();
  }
  $("newChat").onclick = newChat;

  async function openChat(id) {
    currentChatId = id;
    store.set("baton.chat", id);
    renderSidebar();
    closeSide();
    const chat = currentChat();
    if (!chat) { newChat(); return; }
    renderTitle();
    const recs = (await Promise.all(chat.runs.map((r) => getRecord(r.id)))).filter(Boolean);
    $("threadInner").replaceChildren(...recs.flatMap((rec) => [userMsg(rec.userPrompt), botMsg(rec)]));
    const latestFiles = [...recs].reverse().find((r) => Object.keys(r.artifacts || {}).length && r.status !== "error");
    $("downloadLatest").hidden = !latestFiles;
    if (latestFiles) $("downloadLatest").href = "/api/download/" + latestFiles.id;
    $("exportChat").hidden = false;
    $("exportChat").href = "/api/export/chat/" + encodeURIComponent(chat.id);
    selectedRunId = recs.length ? recs[recs.length - 1].id : null;
    updateComposer();
    renderDebug();
    scrollBottom();
  }

  const userMsg = (text) => el("div", { className: "msg user" }, el("div", { className: "bubble", textContent: text }));
  function routeOf(rec) {
    const used = [];
    for (const l of rec.executionLogs || []) if ((l.event === "execute" || l.event === "plan") && !used.includes(l.provider)) used.push(l.provider);
    return used.map((p) => PROVIDER_LABEL[p] || p).join(" → ");
  }
  const extOf = (f) => { const m = /[.]([a-z0-9]+)$/i.exec(f); return m ? m[1].slice(0, 4) : "file"; };

  // Partial completion: which planned files exist, a download of what's there, and a resume button.
  function partialBox(rec) {
    const tasks = (rec.plan && rec.plan.tasks) || [];
    const left = tasks.filter((t) => t.status !== "completed");
    if (!rec.id || !tasks.length || !left.length || ["success", "answered", "gated"].includes(rec.status)) return null;
    const doneN = tasks.length - left.length;
    const meter = el("div", { className: "meter" }, el("span"));
    meter.firstChild.style.width = Math.round(100 * doneN / tasks.length) + "%";
    const why = rec.status === "stopped" ? "stopped" : "not built (providers busy, rate limited or too slow)";
    const list = el("ol", { className: "steplist" }, ...tasks.map((t) => {
      const ok = t.status === "completed";
      const failedT = t.status === "failed";
      return el("li", {}, el("span", { className: ok ? "ok" : failedT ? "bad" : "dim", textContent: ok ? "✓" : failedT ? "✗" : "○" }),
        el("span", {}, "Step " + t.id + " · ", el("code", { textContent: t.targetArtifact }), el("span", { className: "muted", textContent: ok ? (t.assignedModel ? " · " + t.assignedModel : "") : failedT ? " · " + why : " · not started" })));
    }));
    const btns = el("div", { className: "pbtns" });
    if (doneN > 0 && Object.keys(rec.artifacts || {}).length) btns.append(el("a", { className: "btn-s", href: "/api/download/" + rec.id }, icon("download"), "Download partial .zip"));
    const resume = el("button", { type: "button", className: "btn-s", style: "border-color:var(--accent);color:var(--accent)" }, icon("play"), "Resume from step " + left[0].id);
    resume.title = "Build the remaining " + left.length + " file" + (left.length === 1 ? "" : "s") + " with the same plan (no new planning call)";
    resume.onclick = () => runPrompt("Resume from step " + left[0].id + " (" + left.map((t) => t.targetArtifact).join(", ") + ")", { resumeFrom: rec.id, taskType: rec.taskType });
    btns.append(resume);
    return el("div", { className: "partialbox" },
      el("div", { className: "ph" }, el("span", { textContent: doneN + "/" + tasks.length + " files created" }), el("span", { className: "muted", style: "font-weight:400;font-size:12px", textContent: left.length + " left" })),
      meter, list, btns);
  }

  function botMsg(rec) {
    const body = el("div", { className: "bot" });
    const files = Object.keys(rec.artifacts || {});
    const ch = rec.changes;
    const head = el("div", { className: "bot-head" }, el("span", { className: "who", textContent: "Baton" }),
      el("span", { className: "pill " + rec.status, textContent: STATUS_TEXT[rec.status] || rec.status }));
    if (rec.createdAt) head.append(el("span", { className: "when", textContent: new Date(rec.createdAt).toLocaleString([], { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }) }));
    body.append(head);
    if (rec.status === "gated" || rec.status === "answered") {
      body.append(renderMarkdown(rec.message || ""));
    } else if (rec.status === "error") {
      body.append(el("div", { className: "errbox", textContent: rec.message || "Something went wrong." }));
    } else {
      let summary = "";
      if (rec.parentId && ch) summary = [ch.modified.length ? "Changed " + ch.modified.join(", ") : "", ch.added.length ? "Added " + ch.added.join(", ") : ""].filter(Boolean).join(" · ") || "No files changed";
      else if (rec.summary) summary = "Built " + rec.summary.completedTasks + " of " + rec.summary.totalTasks + " file" + (rec.summary.totalTasks === 1 ? "" : "s");
      body.append(el("div", { className: "summary-line", textContent: summary }));
      if (rec.status === "stopped") body.append(el("div", { className: "warnbox", textContent: "Stopped by you. Files finished before that are kept." }));
      const warns = (rec.executionLogs || []).filter((l) => l.event === "execute" && l.message.indexOf("(warning:") > 0);
      if (warns.length) body.append(el("div", { className: "warnbox", textContent: warns.map((l) => l.message.replace("Generated ", "").replace(" successfully", "")).join(" · ") }));
    }
    const partial = partialBox(rec);
    if (partial) body.append(partial);
    if (files.length) {
      const changed = new Set(ch && rec.parentId ? [...ch.modified, ...ch.added] : []);
      body.append(el("div", { className: "files" }, ...files.map((f) => {
        const c = el("button", { type: "button", className: "filecard", title: "View " + f },
          el("span", { className: "fi", textContent: extOf(f) }),
          el("span", { style: "min-width:0" }, el("span", { className: "fn", textContent: f }), el("span", { className: "fs", textContent: size(rec.artifacts[f].length) })),
          changed.has(f) ? el("span", { className: "tag", textContent: ch.added.includes(f) ? "new" : "changed" }) : null);
        c.onclick = () => showFile(rec, f, changed.has(f) && ch.modified.includes(f) ? "diff" : "content");
        return c;
      })));
    }
    const u = rec.usage && rec.usage.total;
    const route = routeOf(rec);
    const meta = [u ? fmt(u.totalTokens) + " tokens" : rec.status === "gated" ? "0 tokens" : "", rec.calls ? rec.calls.length + " provider call" + (rec.calls.length === 1 ? "" : "s") : "", rec.durationMs != null ? secs(rec.durationMs) : "", route ? "via " + route : ""].filter(Boolean).join(" · ");
    if (meta) body.append(el("div", { className: "mmeta", textContent: meta }));
    const actions = el("div", { className: "mactions" });
    const act = (ic, label, fn, primary) => { const b = el("button", { type: "button", className: "act" + (primary ? " primary" : "") }, icon(ic), label); b.onclick = fn; actions.append(b); return b; };
    if (files.length && rec.status !== "error" && rec.id && !partial) actions.append(el("a", { className: "act primary", href: "/api/download/" + rec.id }, icon("download"), "Download"));
    if (rec.parentId && ch && ch.modified.length) act("diff", "Changes", () => { selectedRunId = rec.id; openDebug("run", "diff"); });
    if (rec.status === "answered" || rec.status === "gated") act("copy", "Copy", async () => { try { await navigator.clipboard.writeText(rec.message || ""); toast("Copied"); } catch { toast("Copy failed"); } });
    if (rec.id) act("bug", "Debug", () => { selectedRunId = rec.id; openDebug("run"); });
    act("edit", "Edit & resend", () => { $("prompt").value = rec.userPrompt || ""; autosize(); $("prompt").focus(); });
    body.append(actions);
    return el("div", { className: "msg" }, el("div", { className: "avatar", textContent: "B" }), body);
  }

  // ---------- file viewer with diff ----------
  const diffCache = new Map();
  async function getDiff(runId) {
    if (diffCache.has(runId)) return diffCache.get(runId);
    try { const r = await fetch("/api/history/" + encodeURIComponent(runId) + "/diff"); if (!r.ok) return null; const d = await r.json(); diffCache.set(runId, d); return d; } catch { return null; }
  }
  function renderDiff(fd) {
    if (!fd) return el("p", { className: "muted", textContent: "No changes recorded for this file." });
    if (fd.status === "added") return el("p", { className: "muted", textContent: "New file in this message (" + fd.added + " lines)." });
    const box = el("div", { className: "diff" });
    for (const h of fd.hunks) {
      box.append(el("div", { className: "hunk", textContent: "@@ line " + h.oldStart + " → " + h.newStart + " @@" }));
      for (const l of h.lines) {
        box.append(el("div", { className: "ln" + (l.t === "+" ? " add" : l.t === "-" ? " del" : "") },
          el("span", { className: "n", textContent: l.oldNo || "" }), el("span", { className: "n", textContent: l.newNo || "" }),
          el("span", { className: "s", textContent: l.t === " " ? "" : l.t }), el("span", { textContent: l.text })));
      }
    }
    if (fd.tooLarge) box.append(el("div", { className: "hunk", textContent: "File too large for a line-by-line diff: shown as replaced." }));
    return el("div", {}, el("div", { className: "diffstat", style: "margin-bottom:8px" }, el("span", { className: "a", textContent: "+" + fd.added }), " ", el("span", { className: "r", textContent: "−" + fd.removed }), " lines"), box);
  }
  let fileState = null;
  async function showFile(rec, path, tab) {
    fileState = { rec, path };
    $("fileName").textContent = path;
    const canDiff = rec.parentId && rec.changes && rec.changes.modified.includes(path);
    $("fileTabs").hidden = !canDiff;
    await setFileTab(canDiff ? tab : "content");
    if (!$("fileDlg").open) $("fileDlg").showModal();
  }
  async function setFileTab(tab) {
    for (const b of $("fileTabs").querySelectorAll("button")) b.classList.toggle("on", b.dataset.ft === tab);
    const { rec, path } = fileState;
    if (tab === "diff") {
      $("fileBody").replaceChildren(el("p", { className: "muted", textContent: "Loading changes..." }));
      const d = await getDiff(rec.id);
      $("fileBody").replaceChildren(renderDiff(d && d.files.find((f) => f.path === path)));
    } else {
      $("fileBody").replaceChildren(el("pre", { className: "file", textContent: rec.artifacts[path] || "" }));
    }
  }
  for (const b of $("fileTabs").querySelectorAll("button")) b.onclick = () => setFileTab(b.dataset.ft);
  $("closeFile").onclick = () => $("fileDlg").close();
  $("copyFile").onclick = async () => { try { await navigator.clipboard.writeText(fileState.rec.artifacts[fileState.path] || ""); toast("File copied"); } catch { toast("Copy failed"); } };

  // ===================== Composer =====================
  function continueTarget() {
    const chat = currentChat();
    if (!chat) return null;
    for (let i = chat.runs.length - 1; i >= 0; i--) { const r = chat.runs[i]; if (r.artifactCount && r.status !== "error" && r.status !== "gated" && r.status !== "answered") return r; }
    return null;
  }
  function updateComposer() {
    const t = continueTarget();
    const hint = $("composerHint");
    hint.className = "hint" + (t ? " cont" : "");
    hint.textContent = t ? "Follow-up: changes this project (" + t.artifactCount + " files)" : currentChatId ? "No files yet: your message starts a project" : "New project";
    $("prompt").placeholder = t ? "Ask about the code, or say what to change..." : "Describe what Baton should build, or ask a question...";
    if (t && t.taskType) $("taskType").value = t.taskType;
  }
  function autosize() { const t = $("prompt"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 240) + "px"; }
  $("prompt").addEventListener("input", autosize);
  $("prompt").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("composer").requestSubmit(); } });
  function randomHex(bytes) { const a = new Uint8Array(bytes); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join(""); }

  function pendingMsg() {
    const timer = el("span", { className: "when", textContent: "0.0s" });
    const list = el("ol", { className: "progress" });
    const t0 = Date.now();
    const tick = setInterval(() => (timer.textContent = secs(Date.now() - t0)), 100);
    const node = el("div", { className: "msg" }, el("div", { className: "avatar", textContent: "B" }),
      el("div", { className: "bot" }, el("div", { className: "bot-head" }, el("span", { className: "who", textContent: "Baton" }), el("span", { className: "pill running" }, el("span", { className: "spinner" }), "Working"), timer), list));
    const calls = new Map();
    const add = (ic, cls, text) => { const li = el("li", {}, el("span", { className: "ic " + cls, textContent: ic }), el("span", { className: cls === "dim" ? "dim" : "", textContent: text })); list.append(li); scrollBottom(); return li; };
    return {
      node,
      stop() { clearInterval(tick); },
      onEvent(e) {
        if (e.type === "start") add("·", "dim", e.followUpOf ? "Continuing this project" : "Starting");
        else if (e.type === "plan") add("✓", "ok", "Planned " + e.tasks.length + " file" + (e.tasks.length === 1 ? "" : "s") + ": " + e.tasks.map((t) => t.targetArtifact).join(", "));
        else if (e.type === "call") {
          const c = e.call;
          const key = c.step + "|" + c.provider + "|" + c.model;
          const where = c.step === 0 ? "Planning" : "Step " + c.step;
          if (c.phase === "start") {
            const li = el("li", {}, el("span", { className: "ic wait" }, el("span", { className: "spinner" })), el("span", { textContent: where + ": calling " + c.provider + "/" + c.model + "..." }));
            list.append(li); calls.set(key, li); scrollBottom();
          } else if (c.phase === "progress") {
            const li = calls.get(key);
            if (li && li.lastChild) li.lastChild.textContent = where + ": " + c.provider + "/" + c.model + " is writing... " + short(c.chars || 0) + " chars";
          } else {
            const li = calls.get(key) || add("", "", "");
            const ok = c.outcome === "ok";
            li.replaceChildren(el("span", { className: "ic " + (ok ? "ok" : "bad"), textContent: ok ? "✓" : "✗" }),
              el("span", { textContent: where + ": " + c.provider + "/" + c.model + (ok ? "" : " — " + (c.detail || c.outcome)) + " · " + secs(c.latencyMs || 0) + (c.tokens ? " · " + fmt(c.tokens.totalTokens) + " tok" : "") }));
            calls.delete(key);
          }
        } else if (e.type === "log") {
          const l = e.entry, m = l.message;
          if (l.event === "execute") add("✓", "ok", (m.indexOf("edited in place") >= 0 ? "Edited " : "Wrote ") + m.replace("Generated ", "").replace(" successfully", ""));
          else if (l.event === "plan" && m.indexOf("Answered") === 0) add("✓", "ok", "It's a question: answering directly");
          else if (l.event === "stop") add("■", "wait", m);
          else if (l.event === "plan" && m.indexOf("Resuming") === 0) add("↻", "ok", m);
          else if (l.event === "plan" && m.indexOf("greeting removed") === 0) add("·", "dim", "Greeting removed before planning (saves tokens)");
          else if (l.event === "failover" && m.indexOf("time limit") >= 0) add("⏱", "bad", m.charAt(0).toUpperCase() + m.slice(1));
          else if (l.event === "failover" && m.indexOf("skipped:") === 0) add("↷", "dim", "Skipped " + (PROVIDER_LABEL[l.provider] || l.provider) + ": " + m.split(": ").slice(2).join(": "));
          else if (l.event === "failover" && (m.indexOf("waiting ") === 0 || m.indexOf("pacing:") === 0)) add("⏱", "wait", (PROVIDER_LABEL[l.provider] || l.provider) + ": " + m);
          else if (l.event === "failover" && m.indexOf("cooling down") >= 0) add("⏱", "wait", m.charAt(0).toUpperCase() + m.slice(1));
          else if (l.event === "failover" && m.indexOf("file check failed") === 0) add("↻", "wait", m);
          else if (l.event === "failover" && m.indexOf("passing") >= 0) add("→", "dim", m.slice(m.indexOf(";") + 2));
        }
      },
    };
  }

  let stopRun = null;
  function setSendMode(isRunning) {
    const b = $("send");
    b.classList.toggle("stop", isRunning);
    b.type = isRunning ? "button" : "submit";
    b.setAttribute("aria-label", isRunning ? "Stop" : "Send");
    b.title = isRunning ? "Stop: cancel the AI calls now (finished files are kept)" : "Send";
    b.replaceChildren(icon(isRunning ? "stop" : "send"));
    b.disabled = false;
  }
  $("send").addEventListener("click", (e) => { if (running && stopRun) { e.preventDefault(); stopRun(); } });
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    if (running) return;
    const userPrompt = $("prompt").value.trim();
    if (!userPrompt) return;
    runPrompt(userPrompt, {});
  });

  async function runPrompt(userPrompt, extra) {
    if (running) return;
    running = true;
    setSendMode(true);
    const target = extra.resumeFrom ? null : continueTarget();
    if (!currentChatId) $("threadInner").replaceChildren();
    $("threadInner").append(userMsg(userPrompt));
    const pending = pendingMsg();
    $("threadInner").append(pending.node);
    scrollBottom();
    $("prompt").value = "";
    autosize();
    const clientRunId = randomHex(16);
    liveEvents = [];
    selectedRunId = null;
    renderDebug();
    let es = null;
    let doneEvent = null;
    let onDone = null;
    const ctl = new AbortController();
    let stopped = false;
    stopRun = () => {
      if (stopped) return;
      stopped = true;
      $("send").disabled = true;
      pending.onEvent({ type: "log", entry: { event: "stop", provider: "baton", message: "Stopping..." } });
      fetch("/api/cancel/" + clientRunId, { method: "POST" }).catch(() => {}).finally(() => ctl.abort());
    };
    try {
      es = new EventSource("/api/progress/" + clientRunId);
      es.onmessage = (m) => {
        try {
          const ev = JSON.parse(m.data);
          if (ev.type === "done") { doneEvent = ev; if (onDone) onDone(); }
          pending.onEvent(ev);
          if (ev.type === "call" && ev.call.phase === "progress") return;
          liveEvents.push({ at: new Date().toISOString(), ev });
          if (debugOpen && debugTab === "run" && !selectedRunId) renderRun();
        } catch {}
      };
    } catch {}
    const payload = { userPrompt, taskType: extra.taskType || $("taskType").value, keys: keyPayload(), continueFrom: target ? target.id : undefined, resumeFrom: extra.resumeFrom, chatId: currentChatId || undefined, clientRunId, providerOrder: order ? order.filter((o) => o.on).map((o) => o.id) : undefined };
    let data = {};
    try {
      const res = await fetch("/api/orchestrate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: ctl.signal });
      try { data = await res.json(); } catch {}
      if (!res.ok && !data.historyId) data = { ...data, status: "error", message: data.message || "HTTP " + res.status };
    } catch (err) {
      if (stopped) {
        // Request aborted by Stop: the server saves what was finished and reports it on the progress stream.
        if (!doneEvent) await new Promise((r) => { onDone = r; setTimeout(r, 8000); });
        data = doneEvent && doneEvent.historyId ? { historyId: doneEvent.historyId, status: doneEvent.status } : { status: "error", message: "Stopped. The server did not confirm in time; refresh to see what was saved." };
      } else data = { status: "error", message: "Could not reach the Baton server: " + err.message };
    } finally {
      pending.stop();
      if (es) setTimeout(() => es.close(), 300);
      running = false;
      stopRun = null;
      setSendMode(false);
    }
    await loadRuns();
    if (data.historyId) {
      const run = runs.find((r) => r.id === data.historyId);
      await openChat((run && run.chatId) || data.chatId || data.historyId);
    } else {
      pending.node.replaceWith(botMsg({ id: "", status: "error", message: data.message, userPrompt, artifacts: {} }));
    }
    loadUsage();
    if (debugOpen && debugTab !== "run") renderDebug();
    if (stopped) toast("Stopped. Finished files are kept.");
    $("prompt").focus();
  }

  // ===================== Token usage (sidebar) =====================
  let usagePeriod = store.get("baton.usagePeriod") === "allTime" ? "allTime" : "today";
  let usageData = null;
  function renderUsage() {
    if (!usageData) return;
    $("uToday").classList.toggle("on", usagePeriod === "today");
    $("uAll").classList.toggle("on", usagePeriod === "allTime");
    $("usageSummary").textContent = short(usageData.today.total.totalTokens) + " today";
    const d = usageData[usagePeriod];
    if (!d.byModel.length) { $("usageBody").replaceChildren(el("p", { className: "muted", textContent: usagePeriod === "today" ? "No tokens used today yet." : "No usage recorded yet." })); return; }
    const bd = d.breakdown && Object.values(d.breakdown).some((n) => n > 0) ? breakdownView(d.breakdown, true) : null;
    $("usageBody").replaceChildren(...(bd ? [bd] : []),
      table(["Model", "Calls", "Tokens"], d.byModel.map((m) => [el("span", {}, m.model, el("div", { className: "muted", textContent: PROVIDER_LABEL[m.provider] || m.provider })), fmt(m.calls), short(m.totalTokens)]), [1, 2]),
      el("p", { className: "muted", textContent: fmt(d.total.totalTokens) + " tokens · " + d.runs + " runs" }));
  }
  async function loadUsage() { try { const r = await fetch("/api/usage"); if (r.ok) usageData = await r.json(); } catch {} renderUsage(); }
  $("uToday").onclick = () => { usagePeriod = "today"; store.set("baton.usagePeriod", "today"); renderUsage(); };
  $("uAll").onclick = () => { usagePeriod = "allTime"; store.set("baton.usagePeriod", "allTime"); renderUsage(); };

  // ===================== Debug drawer =====================
  let debugOpen = store.get("baton.debug") === "1";
  let debugTab = ["run", "timeline", "health", "server"].includes(store.get("baton.debugTab")) ? store.get("baton.debugTab") : "run";
  let focusSection = null;
  function table(head, rows, numCols) {
    const nums = new Set(numCols || []);
    return el("div", { className: "tablewrap" }, el("table", { className: "dtable" },
      el("thead", {}, el("tr", {}, ...head.map((h, i) => el("th", { className: nums.has(i) ? "num" : "", textContent: h })))),
      el("tbody", {}, ...rows.map((r) => el("tr", {}, ...r.map((c, i) => { const td = el("td", { className: nums.has(i) ? "num" : (i === r.length - 1 ? "wrap" : "") }); if (c instanceof Node) td.append(c); else td.textContent = c == null ? "" : String(c); return td; }))))));
  }
  const sec = (title, sub, ...kids) => el("div", { className: "dsec" }, el("h4", {}, el("span", { textContent: title }), sub ? (sub instanceof Node ? sub : el("span", { className: "sub", textContent: sub })) : null), ...kids);
  const kv = (pairs) => el("dl", { className: "kv" }, ...pairs.filter((p) => p[1] != null && p[1] !== "").flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: String(v) })]));
  const statusCell = (c) => el("span", { className: c.outcome === "ok" ? "s-ok" : "s-bad", textContent: (c.status || "-") + " " + c.outcome });

  function setDebugOpen(open) {
    debugOpen = open;
    store.set("baton.debug", open ? "1" : null);
    $("debug").hidden = !open;
    $("debugBtn").classList.toggle("on", open);
    $("debugBtn").setAttribute("aria-pressed", String(open));
    $("debugState").textContent = open ? "on" : "off";
    if (open) renderDebug();
  }
  function openDebug(tab, section) { if (tab) setTab(tab); focusSection = section || null; setDebugOpen(true); closeSide(); }
  function setTab(tab) { debugTab = tab; store.set("baton.debugTab", tab); for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("on", b.dataset.tab === tab); }
  for (const b of document.querySelectorAll(".tabs button")) b.onclick = () => { setTab(b.dataset.tab); renderDebug(); };
  $("debugBtn").onclick = () => setDebugOpen(!debugOpen);
  $("openDebugSide").onclick = () => setDebugOpen(!debugOpen);
  $("closeDebug").onclick = () => setDebugOpen(false);
  function renderDebug() {
    if (!debugOpen) return;
    if (debugTab === "server") renderServer();
    else if (debugTab === "health") renderHealth();
    else if (debugTab === "timeline") renderTimeline();
    else renderRun();
  }

  const BREAKDOWN = [
    ["understanding", "Understanding", "planning: reading the request, choosing files", "measured"],
    ["instructions", "Instructions", "Baton's rules + the assignment in each prompt", "estimated share of input"],
    ["request", "Your request", "the goal and earlier requests", "estimated share of input"],
    ["context", "Context", "decisions, file list, files from earlier steps", "estimated share of input"],
    ["code", "Code written", "the file content that went into the project", "measured share of output"],
    ["otherText", "Other reply text", "explanations, fences, chatter around the file", "measured share of output"],
    ["thinking", "Thinking", "hidden reasoning before answering", "reported by provider, or estimated"],
    ["wasted", "Wasted", "replies Baton couldn't use", "measured"],
  ];
  function breakdownView(b, compact) {
    const rows = BREAKDOWN.map(([k, name, what, how], i) => ({ k, name, what, how, color: "var(--c" + (i + 1) + ")", v: b[k] || 0 }));
    const total = rows.reduce((s, r) => s + r.v, 0);
    if (!total) return el("p", { className: "muted", textContent: "No token data for this." });
    const pct = (v) => 100 * v / total;
    const bar = el("div", { className: "segbar", role: "img", "aria-label": "Token breakdown" }, ...rows.filter((r) => r.v > 0).map((r) => { const s = el("span", { title: r.name + ": " + fmt(r.v) + " tokens (" + pct(r.v).toFixed(1) + "%)" }); s.style.flex = String(r.v); s.style.background = r.color; return s; }));
    const shown = rows.filter((r) => r.v > 0 || !compact);
    return el("div", {}, bar, table(compact ? ["Where", "Tokens", "%"] : ["Where the tokens went", "Tokens", "%", "How measured"], shown.map((r) => {
      const name = el("span", {}, el("span", { className: "swatch" }), r.name);
      name.firstChild.style.background = r.color; name.title = r.what;
      return compact ? [name, short(r.v), pct(r.v).toFixed(0) + "%"] : [name, fmt(r.v), pct(r.v).toFixed(1) + "%", r.how];
    }), [1, 2]));
  }

  function liveSection() {
    if (!liveEvents.length) return null;
    return sec("Live events", running ? "streaming..." : liveEvents.length + " events", el("ol", { className: "dlog live" }, ...liveEvents.map(({ at, ev }) => {
      let text = ev.type;
      if (ev.type === "call") text += " " + ev.call.phase + " step=" + ev.call.step + " " + ev.call.provider + "/" + ev.call.model + (ev.call.phase === "end" ? " status=" + (ev.call.status || "-") + " " + ev.call.outcome + " " + ev.call.latencyMs + "ms" : "");
      else if (ev.type === "log") text += " [" + ev.entry.step + "] " + ev.entry.event + " " + ev.entry.provider + ": " + ev.entry.message;
      else if (ev.type === "plan") text += " " + ev.tasks.map((t) => t.targetArtifact).join(", ");
      else if (ev.type === "done") text += " status=" + ev.status + (ev.historyId ? " id=" + ev.historyId : "");
      else if (ev.type === "start") text += " run=" + ev.runId + (ev.followUpOf ? " followUpOf=" + ev.followUpOf : "");
      return el("li", { textContent: time(at) + "  " + text });
    })));
  }
  function emptyRun() { return sec("This run", "", el("p", { className: "muted", textContent: running ? "Waiting for events..." : "Send a message, or click Debug under any reply." })); }

  async function renderRun() {
    const body = $("debugBody");
    if (!selectedRunId) { body.replaceChildren(liveSection() || emptyRun()); return; }
    const rec = await getRecord(selectedRunId);
    if (!rec) { body.replaceChildren(sec("This run", "", el("p", { className: "muted", textContent: "Run not found." }))); return; }
    const u = rec.usage && rec.usage.total;
    const out = [];
    out.push(sec("Overview", el("span", { className: "pill " + rec.status, textContent: STATUS_TEXT[rec.status] || rec.status }), kv([
      ["Run id", rec.id], ["Chat id", rec.chatId], ["Follow-up of", rec.parentId], ["Started", new Date(rec.createdAt).toLocaleString()], ["Duration", rec.durationMs != null ? secs(rec.durationMs) : ""],
      ["Task type", rec.taskType], ["Keys used", (rec.providers || []).join(", ")], ["Provider order", (rec.providerOrder || []).map((p) => PROVIDER_LABEL[p] || p).join(" → ")],
      ["Tokens", u ? fmt(u.totalTokens) + " (" + fmt(u.promptTokens) + " in, " + fmt(u.completionTokens) + " out)" : ""], ["Files", Object.keys(rec.artifacts || {}).length],
    ])));
    if (rec.message && rec.status === "error") out.push(sec("Error", "", el("div", { className: "errbox", textContent: rec.message })));
    const live = liveSection();
    if (live && liveEvents.some((x) => x.ev.type === "done" && x.ev.historyId === rec.id)) out.push(live);
    if (rec.parentId && rec.changes && (rec.changes.modified.length || rec.changes.added.length)) {
      const holder = el("div", {}, el("p", { className: "muted", textContent: "Loading changes..." }));
      const s = sec("Changes in this message", "vs. the previous version", holder);
      s.id = "dsec-diff";
      out.push(s);
      getDiff(rec.id).then((d) => {
        if (!d) { holder.replaceChildren(el("p", { className: "muted", textContent: "Could not load the diff." })); return; }
        holder.replaceChildren(...d.files.map((f) => el("details", { open: d.files.length === 1 }, el("summary", { className: "diffstat", style: "cursor:pointer;margin:4px 0" }, el("b", { textContent: f.path + " " }), el("span", { className: "a", textContent: "+" + f.added }), " ", el("span", { className: "r", textContent: "−" + f.removed }), " · " + f.status), renderDiff(f))));
        if (focusSection === "diff") { s.scrollIntoView({ behavior: "smooth" }); focusSection = null; }
      });
    }
    if (rec.calls && rec.calls.length) {
      out.push(sec("Provider calls", rec.calls.length + " HTTP requests", table(["Step", "Provider / model", "Status", "Time", "Tokens", "Detail"],
        rec.calls.map((c) => [c.step === 0 ? "plan" : c.step, c.provider + "/" + c.model, statusCell(c), (c.latencyMs || 0) + "ms", c.tokens ? fmt(c.tokens.totalTokens) : "", c.detail || ""]), [3, 4])));
    } else if (rec.status !== "gated") out.push(sec("Provider calls", "", el("p", { className: "muted", textContent: "Not recorded for runs made before this feature." })));
    if (rec.breakdown) {
      out.push(sec("Where the tokens went", fmt(Object.values(rec.breakdown).reduce((s, n) => s + n, 0)) + " tokens", breakdownView(rec.breakdown, false)));
      const steps = (rec.calls || []).filter((c) => c.breakdown);
      if (steps.length) out.push(sec("Tokens by step", "", table(["Step", "Model", "Underst.", "Instr.", "Request", "Context", "Code", "Other", "Thinking", "Wasted"],
        steps.map((c) => { const b = c.breakdown; return [c.step === 0 ? "plan" : c.step, c.model, short(b.understanding), short(b.instructions), short(b.request), short(b.context), short(b.code), short(b.otherText), short(b.thinking), short(b.wasted)]; }), [2, 3, 4, 5, 6, 7, 8, 9])));
    }
    if (rec.usage && rec.usage.byModel && rec.usage.byModel.length) out.push(sec("Tokens by model", "", table(["Model", "Calls", "In", "Out", "Total"], rec.usage.byModel.map((m) => [m.provider + "/" + m.model, m.calls, fmt(m.promptTokens), fmt(m.completionTokens), fmt(m.totalTokens)]), [1, 2, 3, 4])));
    if ((rec.executionLogs || []).length) out.push(sec("Relay log", rec.executionLogs.length + " entries", el("ol", { className: "dlog" }, ...rec.executionLogs.map((l) => el("li", {}, el("span", { className: "muted", textContent: time(l.timestamp) + " [" + l.step + "] " }), el("span", { className: "ev " + l.event, textContent: l.event }), " " + l.provider + "/" + l.model + ": " + l.message + (l.tokens ? " (" + fmt(l.tokens.totalTokens) + " tok)" : ""))))));
    if ((rec.contexts || []).length) out.push(contextSection(rec));
    const slim = { ...rec, artifacts: Object.fromEntries(Object.entries(rec.artifacts || {}).map(([k, v]) => [k, "(" + v.length + " chars)"])), contexts: (rec.contexts || []).map((c) => ({ ...c, messages: "(" + (c.messages || []).length + " messages)" })), calls: (rec.calls || []).map((c) => ({ ...c, reply: c.reply ? "(" + c.reply.length + " chars)" : undefined })) };
    out.push(sec("Raw record", "long text shortened", el("details", {}, el("summary", { className: "act", textContent: "Show JSON" }), el("pre", { className: "raw", textContent: JSON.stringify(slim, null, 2) }))));
    const del = el("button", { type: "button", className: "dbtn" }, icon("trash"), "Delete this run");
    del.onclick = async () => { if (!confirm("Delete this run from history?")) return; await fetch("/api/history/" + encodeURIComponent(rec.id), { method: "DELETE" }).catch(() => {}); records.delete(rec.id); selectedRunId = null; await loadRuns(); if (currentChat()) openChat(currentChatId); else newChat(); };
    out.push(el("div", {}, del));
    body.replaceChildren(...out);
  }

  // ---------- context sharing + replay ----------
  let modelCatalog = null;
  async function catalog() {
    if (modelCatalog) return modelCatalog;
    const d = await loadDebug();
    const m = d ? d.models : {};
    modelCatalog = { groq: [...new Set([...(m.groq ? m.groq.code : []), ...(m.groq ? m.groq.general : [])])], google: m.google || [], nvidia: [...new Set([...(m.nvidia ? m.nvidia.code : []), ...(m.nvidia ? m.nvidia.general : [])])], openrouter: [...new Set([...(m.openrouter ? m.openrouter.code : []), ...(m.openrouter ? m.openrouter.general : [])])], openai: m.openai || [] };
    return modelCatalog;
  }
  function replayForm(rec, c) {
    const box = el("div", { className: "dsec", style: "margin-top:8px;background:var(--bg)" });
    const keyed = ALL_PROVIDERS.filter(hasKey);
    if (!keyed.length) { box.append(el("p", { className: "muted", textContent: "Add an API key in Settings to replay." })); return box; }
    const prov = el("select", {}, ...keyed.map((p) => el("option", { value: p, textContent: PROVIDER_LABEL[p] })));
    const listId = "models-" + c.step + "-" + Math.random().toString(36).slice(2, 7);
    const dl = el("datalist", { id: listId });
    const model = el("input", { placeholder: "model (blank = provider's normal list)" });
    model.setAttribute("list", listId);
    const fill = async () => { const cat = await catalog(); dl.replaceChildren(...(cat[prov.value] || []).map((m) => el("option", { value: m }))); };
    prov.onchange = fill; fill();
    const run = el("button", { type: "button", className: "btn primary" }, "Replay");
    const result = el("div");
    run.onclick = async () => {
      run.disabled = true; result.replaceChildren(el("p", { className: "muted" }, el("span", { className: "spinner" }), " Sending the recorded prompt..."));
      try {
        const res = await fetch("/api/replay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ historyId: rec.id, step: c.step, provider: prov.value, model: model.value.trim() || undefined, keys: keyPayload() }) });
        const r = await res.json();
        if (!res.ok) throw new Error(r.message || "HTTP " + res.status);
        const orig = (rec.calls || []).filter((x) => x.step === c.step && x.outcome === "ok" && x.reply).pop();
        result.replaceChildren(
          el("div", { className: r.ok ? "s-ok" : "s-bad", style: "margin:8px 0 4px;font-weight:600", textContent: (r.ok ? "✓ " : "✗ ") + r.provider + "/" + r.model + " · " + secs(r.latencyMs) + (r.usage ? " · " + fmt(r.usage.totalTokens) + " tokens" : "") + (r.ok ? "" : " — " + r.error) }),
          r.ok ? el("details", { open: true }, el("summary", { className: "act", textContent: "Replayed reply" }), el("pre", { className: "raw", textContent: r.reply })) : null,
          orig ? el("details", {}, el("summary", { className: "act", textContent: "Original reply (" + orig.provider + "/" + orig.model + ")" }), el("pre", { className: "raw", textContent: orig.reply })) : null);
      } catch (e) { result.replaceChildren(el("div", { className: "errbox", textContent: e.message })); }
      run.disabled = false;
    };
    box.append(el("div", { className: "muted", style: "margin-bottom:8px;font-size:12px", textContent: "Sends this step's exact recorded prompt to the provider/model you pick. The project is not changed." }),
      el("div", { className: "field", style: "margin-bottom:8px" }, el("label", { textContent: "Provider" }), prov),
      el("div", { className: "field", style: "margin-bottom:8px" }, el("label", { textContent: "Model" }), model, dl), run, result);
    return box;
  }
  function contextSection(rec) {
    const origins = rec.artifactOrigins || {};
    const logs = rec.executionLogs || [];
    return sec("How context was shared", "replay any step", el("p", { className: "muted", style: "margin:0 0 10px", textContent: "Each step gets the goal, decisions and file list, plus the full text of files it depends on (others as outlines). Any model can continue where another stopped." }),
      el("ol", { className: "ctx" }, ...rec.contexts.map((c) => {
        const attempts = logs.filter((l) => l.step === c.step && l.event !== "complete" && l.message.indexOf("skipped:") !== 0 && l.message.indexOf("pacing:") !== 0);
        const sent = attempts.map((l) => l.provider + "/" + l.model + (l.event === "execute" || l.event === "plan" ? " ✓" : " ✗")).join(" → ");
        const chips = el("div", { className: "chips" });
        const chip = (t, tip, cls) => { const n = el("span", { className: "cchip" + (cls ? " " + cls : ""), textContent: t }); if (tip) n.title = tip; chips.append(n); };
        chip("Goal", c.goal);
        if (c.conversation && c.conversation.length) chip("Earlier requests (" + c.conversation.length + ")", c.conversation.join(NL));
        const dec = Object.entries(c.decisions || {});
        if (dec.length) chip("Decisions: " + dec.map(([k, v]) => k + "=" + v).join(", "));
        if (c.manifest && c.manifest.length) chip("File list (" + c.manifest.length + ")", c.manifest.join(NL));
        for (const f of c.files || []) { const o = origins[f.path]; chip(f.path + (f.mode === "outline" ? " (outline)" : "") + " · ~" + short(f.tokens) + " tok · " + (f.source === "previous" ? "earlier run" : (o ? "step " + o.step : "this run")), f.by || "", "file" + (f.source === "previous" ? " prev" : "")); }
        if (c.targetExisted) chip("current " + c.target + " to rewrite", "", "file prev");
        const replayBtn = el("button", { type: "button", className: "dbtn" }, icon("play"), "Replay");
        const holder = el("div");
        replayBtn.onclick = () => { holder.childNodes.length ? holder.replaceChildren() : holder.replaceChildren(replayForm(rec, c)); };
        return el("li", {}, el("h5", {}, el("span", { textContent: c.kind === "plan" ? "Plan" : "Step " + c.step + " · " + c.target + (c.targetExisted ? " (rewrite)" : " (new)") }), replayBtn),
          el("div", { className: "muted", textContent: "Sent to: " + (sent || "-") }), chips,
          el("details", {}, el("summary", { className: "act", textContent: "Exact prompt (~" + fmt(c.promptTokens) + " tokens)" }), el("pre", { className: "raw", textContent: (c.messages || []).map((m) => "[" + m.role + "]" + NL + m.content).join(NL + NL) })),
          holder);
      })));
  }

  // ---------- timeline ----------
  async function renderTimeline() {
    const body = $("debugBody");
    if (!selectedRunId) { body.replaceChildren(sec("Timeline", "", el("p", { className: "muted", textContent: "Open a run (Debug under any reply) to see its timeline." }))); return; }
    const rec = await getRecord(selectedRunId);
    if (!rec || !rec.calls || !rec.calls.length) { body.replaceChildren(sec("Timeline", "", el("p", { className: "muted", textContent: "No provider calls recorded for this run." }))); return; }
    const t0 = new Date(rec.createdAt).getTime();
    const items = [];
    for (const c of rec.calls) { const end = new Date(c.at).getTime(); items.push({ step: c.step, start: end - (c.latencyMs || 0), end, kind: c.outcome === "ok" ? "ok" : "fail", tip: c.provider + "/" + c.model + " · " + (c.outcome === "ok" ? "ok" : (c.status || "-") + " " + c.outcome) + " · " + secs(c.latencyMs || 0) + (c.tokens ? " · " + fmt(c.tokens.totalTokens) + " tok" : "") + (c.detail ? " · " + c.detail : "") }); }
    for (const l of rec.executionLogs || []) {
      const m = /(waiting|cooling down|pacing: waiting) ([0-9.]+)s/.exec(l.message);
      if (m) { const at = new Date(l.timestamp).getTime(); items.push({ step: l.step, start: at, end: at + Number(m[2]) * 1000, kind: "wait", tip: l.message }); }
    }
    const end = Math.max(t0 + (rec.durationMs || 0), ...items.map((i) => i.end));
    const span = Math.max(1, end - t0);
    const steps = [...new Set(items.map((i) => i.step))].sort((a, b) => a - b);
    const label = (s) => { if (s === 0) return "Plan"; const t = ((rec.plan && rec.plan.tasks) || []).find((x) => x.id === s); return "Step " + s + (t ? " · " + t.targetArtifact : ""); };
    const rows = steps.map((s) => {
      const track = el("div", { className: "tl-track" });
      for (const it of items.filter((i) => i.step === s)) {
        const b = el("div", { className: "tl-bar " + it.kind, title: it.tip });
        b.style.left = (100 * (it.start - t0) / span) + "%";
        b.style.width = Math.max(0.6, 100 * (it.end - it.start) / span) + "%";
        track.append(b);
      }
      return el("div", { className: "tl-row" }, el("div", { className: "tl-label", textContent: label(s), title: label(s) }), track);
    });
    const ticks = el("div", { className: "tl-ticks" }, ...[0, 0.25, 0.5, 0.75, 1].map((f) => { const sp = el("span", { textContent: secs(span * f) }); sp.style.left = (f * 100) + "%"; return sp; }));
    const fails = rec.calls.filter((c) => c.outcome !== "ok").length;
    const waits = items.filter((i) => i.kind === "wait");
    body.replaceChildren(
      sec("Timeline", secs(span) + " total", el("div", { className: "legend" },
        el("span", {}, el("i", { style: "background:var(--ok)" }), "Call succeeded"), el("span", {}, el("i", { style: "background:var(--warn)" }), "Call failed"),
        el("span", {}, el("i", { style: "background:repeating-linear-gradient(135deg,var(--muted) 0 3px,transparent 3px 6px);border:1px solid var(--muted)" }), "Waiting (pacing / cool-down / rate limit)")),
        el("div", { className: "tl" }, ...rows), el("div", { className: "tl-axis" }, el("span"), ticks),
        el("p", { className: "muted", style: "margin:10px 0 0;font-size:12px", textContent: rec.calls.length + " calls · " + fails + " failed · " + waits.length + " wait" + (waits.length === 1 ? "" : "s") + " (" + secs(waits.reduce((s, w) => s + w.end - w.start, 0)) + "). Hover a bar for details." })),
      sec("Events in order", "", table(["Start", "Step", "What", "Duration"], items.sort((a, b) => a.start - b.start).map((i) => ["+" + secs(i.start - t0), i.step === 0 ? "plan" : i.step, i.tip, secs(i.end - i.start)]), [3])));
  }

  // ---------- provider health ----------
  let healthDays = 7;
  async function renderHealth() {
    const body = $("debugBody");
    body.replaceChildren(sec("Provider health", "", el("p", { className: "muted" }, el("span", { className: "spinner" }), " Loading...")));
    let h = null;
    try { const r = await fetch("/api/health?days=" + healthDays); if (r.ok) h = await r.json(); } catch {}
    if (!h) { body.replaceChildren(sec("Provider health", "", el("p", { className: "muted", textContent: "Could not load /api/health." }))); return; }
    const days = el("span", { className: "seg", style: "margin:0" }, ...[1, 7, 30].map((d) => { const b = el("button", { type: "button", className: d === healthDays ? "on" : "", textContent: d === 1 ? "24 h" : d + " days" }); b.onclick = () => { healthDays = d; renderHealth(); }; return b; }));
    const rows = h.models.map((m) => {
      const rate = el("span", {}, el("span", { className: "rate" }, el("span")), Math.round(m.successRate * 100) + "%");
      rate.firstChild.firstChild.style.width = Math.round(m.successRate * 100) + "%";
      const fails = Object.entries(m.failures).map(([k, v]) => k + " ×" + v).join(", ");
      return [el("span", {}, m.model, el("div", { className: "muted", textContent: PROVIDER_LABEL[m.provider] || m.provider })), m.calls, rate, m.avgLatencyMs != null ? secs(m.avgLatencyMs) : "-", m.p95LatencyMs != null ? secs(m.p95LatencyMs) : "-", short(m.tokens), (fails || "none") + (m.lastError ? " · last: " + ago(m.lastError.at) + " " + (m.lastError.detail || m.lastError.outcome) : "")];
    });
    const skip = h.skipping || [];
    body.replaceChildren(
      sec("Provider health", days, el("p", { className: "muted", style: "margin:0 0 8px;font-size:12px", textContent: h.runs + " runs since " + new Date(h.since).toLocaleDateString() + ". Success rate, speed and errors per model." }),
        rows.length ? table(["Model", "Calls", "Success", "Avg", "p95", "Tokens", "Failures"], rows, [1, 4, 5]) : el("p", { className: "muted", textContent: "No provider calls in this period." })),
      sec("Skipped right now", skip.length + " provider" + (skip.length === 1 ? "" : "s"), skip.length
        ? table(["Provider", "Key", "Until", "Why"], skip.map((b) => [PROVIDER_LABEL[b.provider] || b.provider, b.keyHash, new Date(b.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), b.reason || "busy"]))
        : el("p", { className: "muted", textContent: "Nothing is being skipped. Busy providers, rejected keys and no-credit accounts appear here." })));
  }

  // ---------- server ----------
  async function loadDebug() { try { const r = await fetch("/api/debug"); return r.ok ? await r.json() : null; } catch { return null; } }
  async function renderServer() {
    const body = $("debugBody");
    const d = await loadDebug();
    if (!d) { body.replaceChildren(sec("Server", "", el("p", { className: "muted", textContent: "Could not load /api/debug." }))); return; }
    const refresh = el("button", { type: "button", className: "dbtn" }, icon("refresh"), "Refresh");
    refresh.onclick = renderServer;
    const forget = el("button", { type: "button", className: "dbtn" }, icon("trash"), "Forget all");
    forget.onclick = async () => { await fetch("/api/debug/memory", { method: "DELETE" }).catch(() => {}); toast("Provider memory cleared"); renderServer(); };
    const label = (p) => PROVIDER_LABEL[p] || p;
    const until = (iso) => "until " + new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const m = d.memory;
    const s = d.settings;
    body.replaceChildren(
      sec("Server", refresh, kv([["Started", new Date(d.server.startedAt).toLocaleString()], ["Uptime", Math.round(d.server.uptimeSec / 60) + " min"], ["Node", d.server.node], ["Data folder", d.server.dataDir], ["Saved runs", d.server.historyRuns]])),
      sec("Provider order (server default)", "", kv([["Planning", d.providerOrder.planner.map(label).join(" → ")], ["Building", d.providerOrder.relay.map(label).join(" → ")]])),
      sec("Models (tried in order)", "", table(["Provider", "Code", "Other tasks"], [["Groq", d.models.groq.code.join(", "), d.models.groq.general.join(", ")], ["Gemini", d.models.google.join(", "), "same"], ["NVIDIA NIM", d.models.nvidia.code.join(", "), d.models.nvidia.general.join(", ")], ["OpenRouter", d.models.openrouter.code.join(", "), d.models.openrouter.general.join(", ")], ["OpenAI", d.models.openai.join(", "), "same"]])),
      sec("Settings", "", kv([["Provider timeout", s.providerTimeoutMs + " ms"], ["Overload retry wait", s.overloadRetryMs + " ms"], ["Busy provider skip", Math.round(s.busySkipMs / 60000) + " min"], ["Daily-limit skip", Math.round((s.dailyLimitSkipMs || 0) / 60000) + " min"], ["Retired model memory", Math.round(s.deadModelTtlMs / 3600000) + " h"], ["Download links", Math.round(s.workspaceTtlSec / 60) + " min, then from history"], ["History limit", s.historyMax + " runs"]])),
      sec("What Baton remembers", forget, m.retiredModels.length || m.discoveredModels.length || m.busyProviders.length
        ? el("div", {}, m.busyProviders.length ? table(["Skipped provider", "Key", "Until", "Why"], m.busyProviders.map((b) => [label(b.provider), b.keyHash, until(b.until), b.reason || "busy"])) : null,
          m.retiredModels.length ? table(["Retired model", "Provider", "Key", "Until"], m.retiredModels.map((r) => [r.model, label(r.provider), r.keyHash, until(r.until)])) : null,
          m.discoveredModels.length ? table(["Discovered replacement", "Provider", "Key", "Until"], m.discoveredModels.map((r) => [r.model, label(r.provider), r.keyHash, until(r.until)])) : null)
        : el("p", { className: "muted", textContent: "Nothing yet. Memory resets when the server restarts." })),
      sec("Recent provider calls", d.recentCalls.length + " (all runs)", d.recentCalls.length
        ? table(["Time", "Step", "Provider / model", "Status", "Latency", "Tokens", "Detail"], d.recentCalls.map((c) => [time(c.at), c.step === 0 ? "plan" : (c.step == null ? "" : c.step), c.provider + "/" + c.model, statusCell(c), (c.latencyMs || 0) + "ms", c.tokens ? fmt(c.tokens.totalTokens) : "", c.detail || ""]), [4, 5])
        : el("p", { className: "muted", textContent: "No provider calls since the server started." })));
  }

  // ===================== Mobile sidebar =====================
  function closeSide() { $("side").classList.remove("open"); $("scrim").classList.remove("show"); }
  $("menuBtn").onclick = () => { $("side").classList.add("open"); $("scrim").classList.add("show"); };
  $("scrim").onclick = closeSide;

  // ===================== Start =====================
  renderKeyStatus();
  if (order) { order = completeOrder(order); renderOrderChip(); } else defaultOrder().then((o) => { order = o; saveOrder(); });
  setTab(debugTab);
  setDebugOpen(debugOpen);
  loadUsage();
  loadRuns().then(() => { if (currentChatId && currentChat()) openChat(currentChatId); else { currentChatId = null; showWelcome(); updateComposer(); } });
})();
</script>
</body>
</html>`;

// Browser UI served at GET /. A self-contained chat-style app (no build step):
// sidebar of chats, message thread with live progress, composer, settings
// dialog for API keys, and a debug drawer showing what the backend did.
//
// NOTE: this page lives inside a TypeScript template literal. Never use
// backticks, dollar-brace sequences or backslash escapes in it; the client
// script uses NL (String.fromCharCode(10)) for newlines instead.

export const UI_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Baton</title>
<style>
  :root {
    --bg: #ffffff; --side: #f7f7f5; --panel: #ffffff; --text: #1d1d1b; --muted: #6b6b66; --line: #e6e6e1;
    --accent: #3b5bdb; --accent-soft: #edf1ff; --ok: #2b8a3e; --warn: #c2410c; --code: #f3f3f0; --bubble: #f1f1ee;
    --shadow: 0 2px 10px rgba(0,0,0,.06);
    --c1: #2a78d6; --c2: #eb6834; --c3: #1baf7a; --c4: #eda100; --c5: #e87ba4; --c6: #008300; --c7: #6250d6; --c8: #e34948;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #171717; --side: #1f1f1f; --panel: #1f1f1f; --text: #ececea; --muted: #9a9a94; --line: #2f2f2d;
      --accent: #7b93ff; --accent-soft: #232a45; --ok: #5cc06e; --warn: #f08a4b; --code: #262626; --bubble: #2a2a2a;
      --shadow: 0 2px 12px rgba(0,0,0,.4);
      --c1: #3987e5; --c2: #d95926; --c3: #199e70; --c4: #c98500; --c5: #d55181; --c6: #0ca30c; --c7: #9085e9; --c8: #e66767; }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; background: var(--bg); color: var(--text); overflow: hidden;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  button { font: inherit; color: inherit; cursor: pointer; }
  input, select, textarea { font: inherit; color: var(--text); }
  .segbar { display: flex; gap: 2px; height: 10px; margin: 2px 0 10px; }
  .segbar span { min-width: 2px; }
  .segbar span:first-child { border-radius: 4px 0 0 4px; }
  .segbar span:last-child { border-radius: 0 4px 4px 0; }
  .segbar span:only-child { border-radius: 4px; }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
  [hidden] { display: none !important; }

  .app { display: grid; grid-template-columns: 272px minmax(0, 1fr) auto; height: 100vh; height: 100dvh; }

  /* ---------- sidebar ---------- */
  .side { background: var(--side); border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
  .brand { display: flex; align-items: center; gap: 8px; padding: 14px 14px 8px; font-weight: 700; font-size: 17px; }
  .brand .logo { width: 26px; height: 26px; border-radius: 8px; background: var(--accent); color: #fff; display: grid; place-items: center; font-size: 14px; }
  .newchat { margin: 6px 12px 10px; padding: 9px 12px; border: 1px solid var(--line); background: var(--panel); border-radius: 10px;
    text-align: left; font-weight: 600; display: flex; gap: 8px; align-items: center; }
  .newchat:hover { border-color: var(--accent); }
  .chats { flex: 1; overflow-y: auto; padding: 0 8px; min-height: 0; }
  .chats h3 { font-size: 12px; color: var(--muted); font-weight: 600; margin: 12px 8px 4px; }
  .chat-item { position: relative; display: block; width: 100%; text-align: left; background: none; border: 0; border-radius: 8px; padding: 8px 30px 8px 10px; margin: 1px 0; }
  .chat-item:hover { background: var(--bubble); }
  .chat-item.active { background: var(--accent-soft); }
  .chat-item .t { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 14px; }
  .chat-item .m { display: block; font-size: 12px; color: var(--muted); }
  .chat-item .del { position: absolute; right: 6px; top: 8px; border: 0; background: none; color: var(--muted); padding: 2px 6px; border-radius: 6px; opacity: 0; }
  .chat-item:hover .del, .chat-item.active .del { opacity: 1; }
  .chat-item .del:hover { color: var(--warn); background: var(--panel); }
  .side-empty { color: var(--muted); font-size: 13px; padding: 8px 10px; }
  .side-foot { border-top: 1px solid var(--line); padding: 8px; display: grid; gap: 4px; }
  .side-btn { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; background: none; border: 0; border-radius: 8px; padding: 8px 10px; text-align: left; font-size: 14px; }
  .side-btn:hover { background: var(--bubble); }
  .side-btn .sub { color: var(--muted); font-size: 12px; }
  summary.side-btn { list-style: none; cursor: pointer; }
  summary.side-btn::-webkit-details-marker { display: none; }
  .usage-box { padding: 4px 10px 8px; font-size: 12px; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; margin-bottom: 6px; }
  .seg button { border: 0; background: none; color: var(--muted); font-size: 12px; font-weight: 600; padding: 2px 8px; }
  .seg button.on { background: var(--accent); color: #fff; }

  /* ---------- main ---------- */
  .main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .topbar { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--line); min-height: 52px; }
  .topbar .title { flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .icon-btn { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 5px 10px; font-size: 13px; white-space: nowrap; color: var(--text); text-decoration: none; }
  .icon-btn:hover, .icon-btn.on { border-color: var(--accent); color: var(--accent); }
  .menu-btn { display: none; }
  .thread { flex: 1; overflow-y: auto; min-height: 0; }
  .thread-inner { max-width: 820px; margin: 0 auto; padding: 24px 16px 12px; }

  .welcome { text-align: center; padding: 8vh 0 0; }
  .welcome h1 { font-size: 26px; margin: 0 0 6px; }
  .welcome p { color: var(--muted); margin: 0 auto 22px; max-width: 560px; }
  .suggest { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; text-align: left; }
  .suggest button { border: 1px solid var(--line); background: var(--panel); border-radius: 12px; padding: 12px 14px; text-align: left; }
  .suggest button:hover { border-color: var(--accent); }
  .suggest b { display: block; font-size: 14px; }
  .suggest span { color: var(--muted); font-size: 13px; }

  .msg { display: flex; gap: 12px; margin: 0 0 22px; }
  .msg.user { justify-content: flex-end; }
  .bubble { background: var(--bubble); padding: 10px 14px; border-radius: 18px; max-width: 80%; white-space: pre-wrap; overflow-wrap: anywhere; }
  .avatar { width: 28px; height: 28px; border-radius: 50%; background: var(--accent); color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 13px; flex: none; margin-top: 2px; }
  .bot { flex: 1; min-width: 0; }
  .bot .line { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .pill { border: 1px solid var(--line); border-radius: 999px; padding: 1px 10px; font-size: 12px; font-weight: 600; }
  .pill.success, .pill.answered { color: var(--ok); border-color: var(--ok); }
  .pill.partial, .pill.failed, .pill.error { color: var(--warn); border-color: var(--warn); }
  .pill.running { color: var(--accent); border-color: var(--accent); }
  .bot .text { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .errbox { color: var(--warn); border: 1px solid var(--warn); border-radius: 10px; padding: 10px 12px; margin-top: 8px; overflow-wrap: anywhere; font-size: 14px; }
  .files { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .filechip { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 4px 10px; font-size: 13px; font-family: ui-monospace, Menlo, monospace; overflow-wrap: anywhere; text-align: left; }
  .filechip:hover { border-color: var(--accent); }
  .filechip.changed { border-color: var(--accent); }
  .filechip .tag { font-family: -apple-system, sans-serif; font-size: 11px; color: var(--accent); margin-left: 6px; }
  .mmeta { color: var(--muted); font-size: 12px; margin-top: 8px; overflow-wrap: anywhere; }
  .mactions { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 6px; }
  .linkbtn { background: none; border: 0; padding: 0; color: var(--accent); font-size: 13px; text-decoration: none; }
  .linkbtn:hover { text-decoration: underline; }
  .linkbtn.muted { color: var(--muted); }

  .progress { list-style: none; margin: 8px 0 0; padding: 0; font-size: 13px; }
  .progress li { display: flex; gap: 8px; padding: 2px 0; overflow-wrap: anywhere; }
  .progress .ic { width: 16px; flex: none; text-align: center; }
  .progress .ok { color: var(--ok); }
  .progress .bad { color: var(--warn); }
  .progress .wait { color: var(--accent); }
  .progress .dim { color: var(--muted); }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spinner { display: inline-block; width: 11px; height: 11px; border: 2px solid var(--accent); border-right-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; vertical-align: -1px; }

  /* ---------- composer ---------- */
  .composer-wrap { padding: 6px 16px 14px; }
  .composer { max-width: 820px; margin: 0 auto; border: 1px solid var(--line); background: var(--panel); border-radius: 16px; padding: 10px 12px 8px; box-shadow: var(--shadow); }
  .composer:focus-within { border-color: var(--accent); }
  .composer textarea { width: 100%; border: 0; outline: none; resize: none; background: transparent; min-height: 26px; max-height: 220px; line-height: 1.5; }
  .composer .row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  .composer select { border: 1px solid var(--line); background: var(--bg); border-radius: 8px; padding: 3px 6px; font-size: 13px; }
  .composer .hint { flex: 1; min-width: 0; color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .composer .hint.cont { color: var(--accent); }
  .send { border: 0; background: var(--accent); color: #fff; border-radius: 10px; padding: 6px 14px; font-weight: 600; }
  .send:disabled { opacity: .5; cursor: default; }
  .keywarn { max-width: 820px; margin: 0 auto 6px; font-size: 13px; color: var(--warn); }

  /* ---------- debug drawer ---------- */
  .debug { width: 460px; border-left: 1px solid var(--line); background: var(--side); display: flex; flex-direction: column; min-height: 0; }
  .debug-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
  .debug-head .tabs { flex: 1; display: flex; gap: 4px; }
  .debug-head .tabs button { border: 0; background: none; border-radius: 6px; padding: 4px 10px; font-size: 13px; font-weight: 600; color: var(--muted); }
  .debug-head .tabs button.on { background: var(--panel); color: var(--text); box-shadow: var(--shadow); }
  .debug-body { flex: 1; overflow-y: auto; padding: 12px; min-height: 0; font-size: 13px; }
  .dsec { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; }
  .dsec h4 { margin: 0 0 8px; font-size: 13px; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .dsec h4 .sub { color: var(--muted); font-weight: 400; font-size: 12px; }
  .kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 3px 12px; margin: 0; }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; overflow-wrap: anywhere; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
  .tablewrap { overflow-x: auto; }
  .dtable { width: 100%; border-collapse: collapse; font-size: 12px; }
  .dtable th, .dtable td { padding: 4px 6px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; white-space: nowrap; }
  .dtable td.wrap { white-space: normal; overflow-wrap: anywhere; min-width: 140px; }
  .dtable th { color: var(--muted); font-weight: 600; }
  .dtable td.num, .dtable th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .s-ok { color: var(--ok); } .s-bad { color: var(--warn); }
  .dlog { list-style: none; margin: 0; padding: 0; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
  .dlog li { padding: 2px 0; border-bottom: 1px dashed var(--line); overflow-wrap: anywhere; }
  .dlog .ev { font-weight: 700; }
  .dlog .ev.failover { color: var(--warn); } .dlog .ev.execute, .dlog .ev.plan { color: var(--ok); }
  pre.raw { background: var(--code); border-radius: 8px; padding: 10px; font-size: 11px; overflow: auto; max-height: 420px; white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0 0; }
  .ctx { list-style: none; margin: 0; padding: 0 0 0 14px; border-left: 2px solid var(--line); }
  .ctx > li { position: relative; margin: 0 0 12px; }
  .ctx > li::before { content: ""; position: absolute; left: -20px; top: 5px; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); }
  .ctx h5 { margin: 0 0 2px; font-size: 13px; overflow-wrap: anywhere; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; }
  .chip { font-size: 11px; border: 1px solid var(--line); background: var(--bg); border-radius: 999px; padding: 1px 8px; overflow-wrap: anywhere; }
  .chip.file { border-color: var(--accent); } .chip.prev { border-style: dashed; }
  .muted { color: var(--muted); }
  .dbtn { border: 1px solid var(--line); background: var(--bg); border-radius: 6px; padding: 2px 8px; font-size: 12px; }
  .dbtn:hover { border-color: var(--accent); color: var(--accent); }
  .live li { font-size: 11px; }

  /* ---------- dialogs ---------- */
  dialog { border: 1px solid var(--line); border-radius: 14px; background: var(--panel); color: var(--text); padding: 0; width: min(560px, calc(100vw - 32px)); box-shadow: var(--shadow); }
  dialog::backdrop { background: rgba(0,0,0,.35); }
  .dlg-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
  .dlg-head h2 { margin: 0; font-size: 17px; overflow-wrap: anywhere; }
  .dlg-body { padding: 14px 16px; max-height: 70vh; overflow-y: auto; }
  .dlg-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); }
  .field { margin-bottom: 12px; }
  .field label { display: flex; justify-content: space-between; font-weight: 600; font-size: 13px; margin-bottom: 4px; }
  .field label a { font-weight: 400; color: var(--accent); font-size: 12px; }
  .field input { width: 100%; border: 1px solid var(--line); background: var(--bg); border-radius: 8px; padding: 8px 10px; }
  .check { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--muted); }
  .btn { border: 1px solid var(--line); background: var(--bg); border-radius: 8px; padding: 6px 14px; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  .orderchip { border: 1px solid var(--line); background: var(--bg); border-radius: 999px; padding: 2px 10px; font-size: 12px; color: var(--text); max-width: 46%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .orderchip:hover { border-color: var(--accent); color: var(--accent); }
  .orderlist { list-style: none; margin: 0; padding: 0; }
  .orderlist li { display: flex; align-items: center; gap: 10px; border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; margin-bottom: 6px; background: var(--panel); }
  .orderlist li.dragging { opacity: .5; }
  .orderlist li.over { border-color: var(--accent); }
  .orderlist li.off .oname { color: var(--muted); text-decoration: line-through; }
  .orderlist .handle { cursor: grab; color: var(--muted); user-select: none; font-size: 16px; line-height: 1; }
  .orderlist .num { width: 18px; text-align: center; font-weight: 700; color: var(--accent); font-size: 13px; }
  .orderlist .oname { flex: 1; min-width: 0; }
  .orderlist .oname small { display: block; color: var(--muted); font-size: 12px; }
  .orderlist .oname small.nokey { color: var(--warn); }
  .orderlist .arrows button { border: 1px solid var(--line); background: var(--bg); border-radius: 6px; padding: 0 7px; font-size: 13px; }
  .orderlist .arrows button:disabled { opacity: .35; cursor: default; }
  .keyres { font-size: 12px; margin-top: 4px; overflow-wrap: anywhere; }
  .keyres.ok { color: var(--ok); } .keyres.bad { color: var(--warn); }
  .keyres .muted { display: block; }
  #fileDlg { width: min(900px, calc(100vw - 32px)); }
  #fileDlg pre { margin: 0; background: var(--code); border-radius: 8px; padding: 12px; font-size: 12px; overflow: auto; max-height: 65vh; white-space: pre; }

  /* ---------- responsive ---------- */
  .scrim { display: none; }
  @media (max-width: 1180px) {
    .debug { position: fixed; top: 0; right: 0; bottom: 0; width: min(460px, 100vw); z-index: 30; box-shadow: var(--shadow); }
  }
  @media (max-width: 860px) {
    .app { grid-template-columns: minmax(0, 1fr); }
    .side { position: fixed; top: 0; left: 0; bottom: 0; width: 280px; z-index: 40; transform: translateX(-100%); transition: transform .2s; }
    .side.open { transform: none; box-shadow: var(--shadow); }
    .scrim.show { display: block; position: fixed; inset: 0; background: rgba(0,0,0,.3); z-index: 35; }
    .menu-btn { display: inline-block; }
    .bubble { max-width: 90%; }
  }
</style>
</head>
<body>
<div class="app">
  <aside class="side" id="side" aria-label="Chats">
    <div class="brand"><span class="logo">B</span> Baton</div>
    <button type="button" class="newchat" id="newChat">+ New chat</button>
    <nav class="chats" id="chats"></nav>
    <div class="side-foot">
      <details id="usageDetails">
        <summary class="side-btn"><span>Token usage</span><span class="sub" id="usageSummary"></span></summary>
        <div class="usage-box">
          <span class="seg"><button type="button" id="uToday" class="on">Today</button><button type="button" id="uAll">All time</button></span>
          <div id="usageBody"></div>
        </div>
      </details>
      <button type="button" class="side-btn" id="openSettings"><span>Settings &amp; API keys</span><span class="sub" id="keyStatus"></span></button>
      <button type="button" class="side-btn" id="openDebugSide"><span>Debug panel</span><span class="sub" id="debugState">off</span></button>
      <a class="side-btn" id="exportAll" href="/api/export/all" title="Every chat: transcripts, full data, files, usage and server info (no API keys)" style="text-decoration:none;color:inherit"><span>Export all chats</span><span class="sub">.zip</span></a>
    </div>
  </aside>
  <div class="scrim" id="scrim"></div>

  <main class="main">
    <header class="topbar">
      <button type="button" class="icon-btn menu-btn" id="menuBtn" aria-label="Open chats">Menu</button>
      <div class="title" id="chatTitle">New chat</div>
      <a class="icon-btn" id="exportChat" hidden title="Transcript + full data + files, as a zip (no API keys)">Export chat</a>
      <a class="icon-btn" id="downloadLatest" hidden>Download project</a>
      <button type="button" class="icon-btn" id="debugBtn" aria-pressed="false">Debug</button>
    </header>
    <div class="thread" id="thread"><div class="thread-inner" id="threadInner"></div></div>
    <div class="composer-wrap">
      <div class="keywarn" id="keyWarn" hidden>No API keys yet. <button type="button" class="linkbtn" id="keyWarnBtn">Add them in Settings</button> (greetings still work without keys).</div>
      <form class="composer" id="composer">
        <textarea id="prompt" rows="1" placeholder="Describe what Baton should build..." aria-label="Message"></textarea>
        <div class="row">
          <select id="taskType" aria-label="Task type">
            <option value="code">Code</option>
            <option value="document">Document</option>
            <option value="analysis">Analysis</option>
          </select>
          <button type="button" class="orderchip" id="orderBtn" title="Choose which AI Baton calls first">Order</button>
          <span class="hint" id="composerHint">New project</span>
          <button type="submit" class="send" id="send">Send</button>
        </div>
      </form>
    </div>
  </main>

  <aside class="debug" id="debug" hidden aria-label="Debug panel">
    <div class="debug-head">
      <div class="tabs"><button type="button" id="tabRun" class="on">This run</button><button type="button" id="tabServer">Server</button></div>
      <button type="button" class="icon-btn" id="closeDebug">Close</button>
    </div>
    <div class="debug-body" id="debugBody"></div>
  </aside>
</div>

<dialog id="settingsDlg">
  <div class="dlg-head"><h2>Settings &amp; API keys</h2><button type="button" class="icon-btn" id="closeSettings">Close</button></div>
  <div class="dlg-body">
    <p class="muted" style="margin-top:0;font-size:13px">Keys go only to your Baton server, which passes them to each provider. They are never saved in history. Order Baton tries providers in: <span id="orderText">...</span></p>
    <div id="keyFields"></div>
    <label class="check"><input type="checkbox" id="remember" /> Remember keys in this browser</label>
  </div>
  <div class="dlg-foot"><button type="button" class="btn" id="testKeys">Test keys</button><button type="button" class="btn primary" id="saveSettings">Save</button></div>
</dialog>

<dialog id="orderDlg">
  <div class="dlg-head"><h2>Provider order</h2><button type="button" class="icon-btn" id="closeOrder">Done</button></div>
  <div class="dlg-body">
    <p class="muted" style="margin-top:0;font-size:13px">Baton calls providers from top to bottom, for the plan and for every file, and moves to the next one when a provider fails. Drag rows or use the arrows to reorder. Untick a provider to skip it completely.</p>
    <ol class="orderlist" id="orderList"></ol>
  </div>
  <div class="dlg-foot"><button type="button" class="btn" id="resetOrder">Reset to default</button><button type="button" class="btn primary" id="doneOrder">Done</button></div>
</dialog>

<dialog id="fileDlg">
  <div class="dlg-head"><h2 id="fileName">file</h2><span><button type="button" class="icon-btn" id="copyFile">Copy</button> <button type="button" class="icon-btn" id="closeFile">Close</button></span></div>
  <div class="dlg-body"><pre id="fileBody"></pre></div>
</dialog>

<script>
(() => {
  const NL = String.fromCharCode(10);
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
  function ago(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    return new Date(iso).toLocaleDateString();
  }
  const PROVIDER_LABEL = { groq: "Groq", google: "Gemini", nvidia: "NVIDIA NIM", openrouter: "OpenRouter", openai: "OpenAI", baton: "Baton" };
  const STATUS_TEXT = { success: "Done", partial: "Partly done", failed: "Failed", error: "Error", gated: "Answered locally", answered: "Answer" };

  // ===================== API keys (Settings) =====================
  const KEY_FIELDS = [
    ["nvidia", "nvidiaApiKey", "NVIDIA NIM", "nvapi-...", "https://build.nvidia.com"],
    ["groq", "groqApiKey", "Groq", "gsk_...", "https://console.groq.com/keys"],
    ["gemini", "geminiApiKey", "Gemini", "AIza...", "https://aistudio.google.com/apikey"],
    ["openrouter", "openrouterApiKey", "OpenRouter (free models, ~50 requests/day)", "sk-or-...", "https://openrouter.ai/keys"],
    ["openai", "openaiApiKey", "OpenAI (paid)", "sk-...", "https://platform.openai.com/api-keys"],
  ];
  const keys = { nvidia: "", groq: "", gemini: "", openrouter: "", openai: "" };
  let remember = store.get("baton.remember") === "1";
  if (remember) for (const [k] of KEY_FIELDS) keys[k] = store.get("baton." + k) || "";
  const keyCount = () => KEY_FIELDS.filter(([k]) => keys[k].trim()).length;

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
    $("settingsDlg").showModal();
    $("orderText").textContent = orderSummary() + " (change it with the Order button next to Send)";
  }
  function saveSettings() {
    for (const [k] of KEY_FIELDS) keys[k] = ($("key_" + k).value || "").trim();
    remember = $("remember").checked;
    store.set("baton.remember", remember ? "1" : null);
    for (const [k] of KEY_FIELDS) store.set("baton." + k, remember && keys[k] ? keys[k] : null);
    $("settingsDlg").close();
    renderKeyStatus();
    renderOrderChip();
  }
  $("openSettings").onclick = openSettings;
  $("keyWarnBtn").onclick = openSettings;
  $("saveSettings").onclick = saveSettings;

  // Test keys: free requests only (model lists / OpenRouter key info), no tokens spent.
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
    } catch (e) {
      for (const [k] of KEY_FIELDS) { const r = $("keyres_" + k); if (r.textContent === "Testing...") { r.className = "keyres bad"; r.textContent = "Could not reach the server"; } }
    } finally {
      $("testKeys").disabled = false;
    }
  };
  $("closeSettings").onclick = () => $("settingsDlg").close();

  // ===================== Provider order (chosen before sending) =====================
  const ALL_PROVIDERS = ["nvidia", "groq", "google", "openrouter", "openai"];
  const KEY_OF = { nvidia: "nvidia", groq: "groq", google: "gemini", openrouter: "openrouter", openai: "openai" };
  const hasKey = (p) => !!(keys[KEY_OF[p]] || "").trim();
  let order = null; // [{ id, on }]
  try {
    const saved = JSON.parse(store.get("baton.order") || "null");
    if (Array.isArray(saved)) order = saved.filter((o) => ALL_PROVIDERS.includes(o.id));
  } catch {}
  function completeOrder(list) {
    const seen = new Set(list.map((o) => o.id));
    return list.concat(ALL_PROVIDERS.filter((p) => !seen.has(p)).map((id) => ({ id, on: true })));
  }
  async function defaultOrder() {
    const d = await loadDebug();
    const ids = d ? d.providerOrder.relay : ALL_PROVIDERS;
    return completeOrder(ids.filter((p) => ALL_PROVIDERS.includes(p)).map((id) => ({ id, on: true })));
  }
  function saveOrder() { store.set("baton.order", JSON.stringify(order)); renderOrderChip(); }
  const activeOrder = () => (order || []).filter((o) => o.on && hasKey(o.id)).map((o) => o.id);
  function orderSummary() {
    const a = activeOrder();
    return a.length ? a.map((p) => PROVIDER_LABEL[p] || p).join(" → ") : "no provider switched on with a key";
  }
  function renderOrderChip() {
    const a = activeOrder();
    $("orderBtn").textContent = "Order: " + (a.length ? a.map((p) => PROVIDER_LABEL[p] || p).join(" → ") : "none");
    $("orderBtn").title = "Baton tries: " + orderSummary() + ". Click to change.";
  }
  let dragFrom = -1;
  function renderOrderList() {
    const list = $("orderList");
    let rank = 0;
    list.replaceChildren(...order.map((o, i) => {
      const keyed = hasKey(o.id);
      const active = o.on && keyed;
      if (active) rank++;
      const cb = el("input", { type: "checkbox", checked: o.on, title: o.on ? "Switch off" : "Switch on" });
      cb.onchange = () => { o.on = cb.checked; saveOrder(); renderOrderList(); };
      const up = el("button", { type: "button", textContent: "↑", disabled: i === 0, title: "Move up" });
      up.onclick = () => { order.splice(i - 1, 0, order.splice(i, 1)[0]); saveOrder(); renderOrderList(); };
      const down = el("button", { type: "button", textContent: "↓", disabled: i === order.length - 1, title: "Move down" });
      down.onclick = () => { order.splice(i + 1, 0, order.splice(i, 1)[0]); saveOrder(); renderOrderList(); };
      const li = el("li", { className: o.on ? "" : "off", draggable: true },
        el("span", { className: "handle", textContent: "⋮⋮", title: "Drag to reorder" }),
        el("span", { className: "num", textContent: active ? String(rank) : "–" }),
        cb,
        el("span", { className: "oname" }, PROVIDER_LABEL[o.id] || o.id,
          el("small", { className: keyed ? "" : "nokey", textContent: !keyed ? "No API key: add one in Settings" : o.on ? (rank === 1 ? "Called first" : "Fallback #" + (rank - 1)) : "Switched off: never called" })),
        el("span", { className: "arrows" }, up, " ", down));
      li.addEventListener("dragstart", () => { dragFrom = i; li.classList.add("dragging"); });
      li.addEventListener("dragend", () => li.classList.remove("dragging"));
      li.addEventListener("dragover", (e) => { e.preventDefault(); li.classList.add("over"); });
      li.addEventListener("dragleave", () => li.classList.remove("over"));
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        if (dragFrom < 0 || dragFrom === i) return;
        order.splice(i, 0, order.splice(dragFrom, 1)[0]);
        dragFrom = -1;
        saveOrder();
        renderOrderList();
      });
      return li;
    }));
  }
  async function openOrder() {
    if (!order) { order = await defaultOrder(); saveOrder(); }
    renderOrderList();
    $("orderDlg").showModal();
  }
  $("orderBtn").onclick = openOrder;
  $("closeOrder").onclick = () => $("orderDlg").close();
  $("doneOrder").onclick = () => $("orderDlg").close();
  $("resetOrder").onclick = async () => { order = await defaultOrder(); saveOrder(); renderOrderList(); };

  // ===================== Data: runs grouped into chats =====================
  let runs = [];
  let chats = [];
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
    for (const r of runs) {
      const id = chatIdOf(r, byId);
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(r);
    }
    chats = [...map].map(([id, rs]) => {
      rs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return { id, runs: rs, title: rs[0].userPrompt, updatedAt: rs[rs.length - 1].createdAt };
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async function loadRuns() {
    try {
      const res = await fetch("/api/history?limit=1000");
      if (res.ok) runs = (await res.json()).runs || [];
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
  function renderSidebar() {
    const box = $("chats");
    if (!chats.length) { box.replaceChildren(el("div", { className: "side-empty", textContent: "No chats yet. Your projects and follow-ups will appear here." })); return; }
    const today = new Date().toDateString();
    const groups = [["Today", chats.filter((c) => new Date(c.updatedAt).toDateString() === today)], ["Earlier", chats.filter((c) => new Date(c.updatedAt).toDateString() !== today)]];
    const out = [];
    for (const [name, list] of groups) {
      if (!list.length) continue;
      out.push(el("h3", { textContent: name }));
      for (const c of list) {
        const last = c.runs[c.runs.length - 1];
        const files = Math.max(0, ...c.runs.map((r) => r.artifactCount || 0));
        const item = el("button", { type: "button", className: "chat-item" + (c.id === currentChatId ? " active" : ""), title: c.title },
          el("span", { className: "t", textContent: c.title }),
          el("span", { className: "m", textContent: c.runs.length + " message" + (c.runs.length === 1 ? "" : "s") + (files ? " · " + files + " files" : "") + " · " + ago(last.createdAt) }));
        item.onclick = () => openChat(c.id);
        const del = el("span", { className: "del", textContent: "×", title: "Delete chat", role: "button" });
        del.onclick = (e) => { e.stopPropagation(); deleteChat(c); };
        item.append(del);
        out.push(item);
      }
    }
    box.replaceChildren(...out);
  }
  async function deleteChat(c) {
    if (!confirm("Delete this chat and its " + c.runs.length + " message(s) from history?")) return;
    for (const r of c.runs) { await fetch("/api/history/" + encodeURIComponent(r.id), { method: "DELETE" }).catch(() => {}); records.delete(r.id); }
    if (c.id === currentChatId) newChat();
    await loadRuns();
    loadUsage();
  }

  // ===================== Thread =====================
  const SUGGESTIONS = [
    ["Todo list app", "One HTML file with JS, saved in the browser", "Create a todo list using HTML and JS in a single index.html that saves items in localStorage"],
    ["Student marks web app", "Register students and score marks", "Create a web app to register students and score their marks using HTML, CSS and JS"],
    ["REST API", "Express.js auth service with JWT and bcrypt", "Create an Express.js authentication service with JWT and bcrypt"],
    ["Project README", "A clear README for a command-line tool", "Write a README.md for a command-line tool that renames photos by date"],
  ];
  function scrollBottom() { const t = $("thread"); t.scrollTop = t.scrollHeight; }

  function showWelcome() {
    $("chatTitle").textContent = "New chat";
    $("downloadLatest").hidden = true;
    $("exportChat").hidden = true;
    $("threadInner").replaceChildren(el("div", { className: "welcome" },
      el("h1", { textContent: "What should Baton build?" }),
      el("p", { textContent: "Describe a project. Baton plans it, builds each file on free AI providers, and switches provider automatically when one is busy or out of quota. Reply in the same chat to change the project." }),
      el("div", { className: "suggest" }, ...SUGGESTIONS.map(([title, sub, prompt]) => {
        const b = el("button", { type: "button" }, el("b", { textContent: title }), el("span", { textContent: sub }));
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
    $("chatTitle").textContent = chat.title;
    const recs = (await Promise.all(chat.runs.map((r) => getRecord(r.id)))).filter(Boolean);
    $("threadInner").replaceChildren(...recs.flatMap((rec) => [userMsg(rec.userPrompt), botMsg(rec)]));
    const latestFiles = [...recs].reverse().find((r) => Object.keys(r.artifacts || {}).length && r.status !== "error");
    $("downloadLatest").hidden = !latestFiles;
    $("exportChat").hidden = false;
    $("exportChat").href = "/api/export/chat/" + encodeURIComponent(chat.id);
    if (latestFiles) $("downloadLatest").href = "/api/download/" + latestFiles.id;
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

  function botMsg(rec) {
    const body = el("div", { className: "bot" });
    const files = Object.keys(rec.artifacts || {});
    const ch = rec.changes;
    const line = el("div", { className: "line" }, el("span", { className: "pill " + rec.status, textContent: STATUS_TEXT[rec.status] || rec.status }));
    if (rec.status === "gated" || rec.status === "answered") {
      body.append(line, el("div", { className: "text", textContent: rec.message || "" }));
    } else if (rec.status === "error") {
      body.append(line, el("div", { className: "errbox", textContent: rec.message || "Something went wrong." }));
    } else {
      let summary = "";
      if (rec.parentId && ch) {
        summary = [ch.modified.length ? "Changed " + ch.modified.join(", ") : "", ch.added.length ? "Added " + ch.added.join(", ") : ""].filter(Boolean).join(" · ") || "No files changed";
      } else if (rec.summary) {
        summary = "Built " + rec.summary.completedTasks + " of " + rec.summary.totalTasks + " file" + (rec.summary.totalTasks === 1 ? "" : "s");
      }
      line.append(el("span", { textContent: summary }));
      body.append(line);
      const failed = ((rec.plan && rec.plan.tasks) || []).filter((t) => t.status === "failed").map((t) => t.targetArtifact);
      if (failed.length) body.append(el("div", { className: "errbox", textContent: "Not built: " + failed.join(", ") + ". Open Debug to see why each provider failed." }));
    }
    if (files.length) {
      const changed = new Set(ch ? [...ch.modified, ...ch.added] : []);
      body.append(el("div", { className: "files" }, ...files.map((f) => {
        const b = el("button", { type: "button", className: "filechip" + (changed.has(f) && rec.parentId ? " changed" : ""), title: "View " + f }, f,
          changed.has(f) && rec.parentId ? el("span", { className: "tag", textContent: ch.added.includes(f) ? "new" : "changed" }) : null);
        b.onclick = () => showFile(f, rec.artifacts[f]);
        return b;
      })));
    }
    const u = rec.usage && rec.usage.total;
    const route = routeOf(rec);
    const meta = [
      u ? fmt(u.totalTokens) + " tokens" : rec.status === "gated" ? "0 tokens" : "",
      rec.calls ? rec.calls.length + " provider call" + (rec.calls.length === 1 ? "" : "s") : "",
      rec.durationMs != null ? secs(rec.durationMs) : "",
      route ? "via " + route : "",
    ].filter(Boolean).join(" · ");
    if (meta) body.append(el("div", { className: "mmeta", textContent: meta }));
    const actions = el("div", { className: "mactions" });
    if (files.length && rec.status !== "error" && rec.id) actions.append(el("a", { className: "linkbtn", href: "/api/download/" + rec.id, textContent: "Download .zip" }));
    if (rec.id) {
      const dbg = el("button", { type: "button", className: "linkbtn", textContent: "Debug this run" });
      dbg.onclick = () => { selectedRunId = rec.id; openDebug("run"); };
      actions.append(dbg);
    }
    const failedFiles = ((rec.plan && rec.plan.tasks) || []).filter((t) => t.status === "failed").map((t) => t.targetArtifact);
    if (failedFiles.length && files.length && rec.id) {
      const retry = el("button", { type: "button", className: "linkbtn", textContent: "Retry missing files" });
      retry.onclick = () => {
        $("prompt").value = "Create the missing file" + (failedFiles.length === 1 ? "" : "s") + " " + failedFiles.join(", ") + " so it works with the existing files (it was planned earlier but not built).";
        autosize();
        $("composer").requestSubmit();
      };
      actions.append(retry);
    }
    const reuse = el("button", { type: "button", className: "linkbtn muted", textContent: "Edit & resend" });
    reuse.onclick = () => { $("prompt").value = rec.userPrompt || ""; autosize(); $("prompt").focus(); };
    actions.append(reuse);
    body.append(actions);
    return el("div", { className: "msg" }, el("div", { className: "avatar", textContent: "B" }), body);
  }

  function showFile(name, content) {
    $("fileName").textContent = name;
    $("fileBody").textContent = content;
    $("fileDlg").showModal();
  }
  $("closeFile").onclick = () => $("fileDlg").close();
  $("copyFile").onclick = async () => {
    try { await navigator.clipboard.writeText($("fileBody").textContent); $("copyFile").textContent = "Copied"; }
    catch { $("copyFile").textContent = "Copy failed"; }
    setTimeout(() => ($("copyFile").textContent = "Copy"), 1200);
  };

  // ===================== Composer =====================
  function continueTarget() {
    const chat = currentChat();
    if (!chat) return null;
    for (let i = chat.runs.length - 1; i >= 0; i--) {
      const r = chat.runs[i];
      if (r.artifactCount && r.status !== "error" && r.status !== "gated") return r;
    }
    return null;
  }
  function updateComposer() {
    const t = continueTarget();
    const hint = $("composerHint");
    hint.className = "hint" + (t ? " cont" : "");
    hint.textContent = t
      ? "Follow-up: Baton will change this project (" + t.artifactCount + " files)"
      : currentChatId ? "No files in this chat yet: your message starts a new project" : "New project";
    $("prompt").placeholder = t ? "What should Baton change? e.g. add a delete button and a logo" : "Describe what Baton should build...";
    if (t && t.taskType) $("taskType").value = t.taskType;
  }
  function autosize() { const t = $("prompt"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 220) + "px"; }
  $("prompt").addEventListener("input", autosize);
  $("prompt").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("composer").requestSubmit(); }
  });

  function randomHex(bytes) {
    const a = new Uint8Array(bytes);
    crypto.getRandomValues(a); // works on plain-http LAN pages too, unlike randomUUID
    return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Live progress shown inside the pending assistant message
  function pendingMsg() {
    const status = el("span", { className: "pill running", textContent: "Working" });
    const timer = el("span", { className: "muted", textContent: "0.0s" });
    const list = el("ol", { className: "progress" });
    const t0 = Date.now();
    const tick = setInterval(() => (timer.textContent = secs(Date.now() - t0)), 100);
    const node = el("div", { className: "msg" }, el("div", { className: "avatar", textContent: "B" }),
      el("div", { className: "bot" }, el("div", { className: "line" }, status, el("span", { className: "spinner" }), timer), list));
    const calls = new Map();
    const add = (ic, cls, text) => {
      const li = el("li", {}, el("span", { className: "ic " + cls, textContent: ic }), el("span", { className: cls === "dim" ? "dim" : "", textContent: text }));
      list.append(li); scrollBottom(); return li;
    };
    return {
      node,
      stop() { clearInterval(tick); },
      onEvent(e) {
        if (e.type === "start") add("·", "dim", e.followUpOf ? "Continuing this project from your previous message" : "Starting a new project");
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
            if (li && li.lastChild) li.lastChild.textContent = where + ": " + c.provider + "/" + c.model + " is writing... " + short(c.chars || 0) + " chars received";
          } else {
            const li = calls.get(key) || add("", "", "");
            const ok = c.outcome === "ok";
            li.replaceChildren(el("span", { className: "ic " + (ok ? "ok" : "bad"), textContent: ok ? "✓" : "✗" }),
              el("span", { textContent: where + ": " + c.provider + "/" + c.model + (ok ? "" : " — " + (c.detail || c.outcome)) + " · " + secs(c.latencyMs || 0) + (c.tokens ? " · " + fmt(c.tokens.totalTokens) + " tok" : "") }));
            calls.delete(key);
          }
        } else if (e.type === "log") {
          const l = e.entry;
          if (l.event === "execute") add("✓", "ok", (l.message.indexOf("edited in place") >= 0 ? "Edited " : "Wrote ") + l.message.replace("Generated ", "").replace(" successfully", ""));
          else if (l.event === "plan" && l.message.indexOf("Answered") === 0) add("✓", "ok", "It's a question: answering directly, no files");
          else if (l.event === "failover" && l.message.indexOf("skipped:") === 0) add("↷", "dim", "Skipped " + (PROVIDER_LABEL[l.provider] || l.provider) + ": " + l.message.split(": ").slice(2).join(": "));
          else if (l.event === "failover" && l.message.indexOf("waiting ") === 0) add("⏱", "wait", (PROVIDER_LABEL[l.provider] || l.provider) + ": " + l.message);
          else if (l.event === "failover" && l.message.indexOf("passing") >= 0) add("→", "dim", l.message.slice(l.message.indexOf(";") + 2));
        }
      },
    };
  }

  $("composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (running) return;
    const userPrompt = $("prompt").value.trim();
    if (!userPrompt) return;
    running = true;
    $("send").disabled = true;
    const target = continueTarget();
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
    try {
      es = new EventSource("/api/progress/" + clientRunId);
      es.onmessage = (m) => {
        try {
          const ev = JSON.parse(m.data);
          pending.onEvent(ev);
          if (ev.type === "call" && ev.call.phase === "progress") return; // streaming ticks: live line only, not the event log
          liveEvents.push({ at: new Date().toISOString(), ev });
          renderLive();
        } catch {}
      };
    } catch {}

    const payload = {
      userPrompt,
      taskType: $("taskType").value,
      keys: Object.fromEntries(KEY_FIELDS.map(([k, field]) => [field, keys[k].trim() || undefined])),
      continueFrom: target ? target.id : undefined,
      chatId: currentChatId || undefined,
      clientRunId,
      providerOrder: order ? order.filter((o) => o.on).map((o) => o.id) : undefined,
    };
    let data = {};
    try {
      const res = await fetch("/api/orchestrate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      try { data = await res.json(); } catch {}
      if (!res.ok && !data.historyId) data = { ...data, status: "error", message: data.message || "HTTP " + res.status };
    } catch (err) {
      data = { status: "error", message: "Could not reach the Baton server: " + err.message };
    } finally {
      pending.stop();
      if (es) setTimeout(() => es.close(), 300);
      running = false;
      $("send").disabled = false;
    }
    await loadRuns();
    if (data.historyId) {
      const run = runs.find((r) => r.id === data.historyId);
      await openChat((run && run.chatId) || data.chatId || data.historyId);
    } else {
      pending.node.replaceWith(botMsg({ id: "", status: "error", message: data.message, userPrompt, artifacts: {} }));
    }
    loadUsage();
    if (debugOpen && debugTab === "server") renderDebug();
    $("prompt").focus();
  });

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
    $("usageBody").replaceChildren(
      ...(bd ? [bd] : []),
      table(["Model", "Calls", "Tokens"], d.byModel.map((m) => [el("span", {}, m.model, el("div", { className: "muted", textContent: PROVIDER_LABEL[m.provider] || m.provider })), fmt(m.calls), short(m.totalTokens)]), [1, 2]),
      el("p", { className: "muted", textContent: fmt(d.total.totalTokens) + " tokens · " + d.runs + " runs" }));
  }
  async function loadUsage() {
    try { const r = await fetch("/api/usage"); if (r.ok) usageData = await r.json(); } catch {}
    renderUsage();
  }
  $("uToday").onclick = () => { usagePeriod = "today"; store.set("baton.usagePeriod", "today"); renderUsage(); };
  $("uAll").onclick = () => { usagePeriod = "allTime"; store.set("baton.usagePeriod", "allTime"); renderUsage(); };

  // ===================== Debug drawer =====================
  let debugOpen = store.get("baton.debug") === "1";
  let debugTab = store.get("baton.debugTab") === "server" ? "server" : "run";

  function table(head, rows, numCols) {
    const nums = new Set(numCols || []);
    return el("div", { className: "tablewrap" }, el("table", { className: "dtable" },
      el("thead", {}, el("tr", {}, ...head.map((h, i) => el("th", { className: nums.has(i) ? "num" : "", textContent: h })))),
      el("tbody", {}, ...rows.map((r) => el("tr", {}, ...r.map((c, i) => {
        const td = el("td", { className: nums.has(i) ? "num" : (i === r.length - 1 ? "wrap" : "") });
        if (c instanceof Node) td.append(c); else td.textContent = c == null ? "" : String(c);
        return td;
      }))))));
  }
  const sec = (title, sub, ...kids) => el("div", { className: "dsec" },
    el("h4", {}, el("span", { textContent: title }), sub ? (sub instanceof Node ? sub : el("span", { className: "sub", textContent: sub })) : null), ...kids);
  const kv = (pairs) => el("dl", { className: "kv" }, ...pairs.filter((p) => p[1] != null && p[1] !== "").flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: String(v) })]));
  const statusCell = (c) => el("span", { className: c.outcome === "ok" ? "s-ok" : "s-bad", textContent: (c.status || "-") + " " + c.outcome });
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  function setDebugOpen(open) {
    debugOpen = open;
    store.set("baton.debug", open ? "1" : null);
    $("debug").hidden = !open;
    $("debugBtn").classList.toggle("on", open);
    $("debugBtn").setAttribute("aria-pressed", String(open));
    $("debugState").textContent = open ? "on" : "off";
    if (open) renderDebug();
  }
  function openDebug(tab) { if (tab) setTab(tab); setDebugOpen(true); closeSide(); }
  function setTab(tab) {
    debugTab = tab;
    store.set("baton.debugTab", tab);
    $("tabRun").classList.toggle("on", tab === "run");
    $("tabServer").classList.toggle("on", tab === "server");
  }
  $("debugBtn").onclick = () => setDebugOpen(!debugOpen);
  $("openDebugSide").onclick = () => setDebugOpen(!debugOpen);
  $("closeDebug").onclick = () => setDebugOpen(false);
  $("tabRun").onclick = () => { setTab("run"); renderDebug(); };
  $("tabServer").onclick = () => { setTab("server"); renderDebug(); };

  function renderDebug() {
    if (!debugOpen) return;
    if (debugTab === "server") renderServer(); else renderRun();
  }
  function renderLive() {
    if (debugOpen && debugTab === "run" && !selectedRunId) renderRun();
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

  async function renderRun() {
    const body = $("debugBody");
    if (!selectedRunId) {
      body.replaceChildren(liveSection() || sec("This run", "", el("p", { className: "muted", textContent: running ? "Waiting for events..." : "Send a message, or click 'Debug this run' under any reply." })));
      return;
    }
    const rec = await getRecord(selectedRunId);
    if (!rec) { body.replaceChildren(sec("This run", "", el("p", { className: "muted", textContent: "Run not found." }))); return; }
    const u = rec.usage && rec.usage.total;
    const out = [];
    out.push(sec("Overview", rec.status, kv([
      ["Run id", rec.id], ["Chat id", rec.chatId], ["Follow-up of", rec.parentId], ["Status", rec.status],
      ["Started", new Date(rec.createdAt).toLocaleString()], ["Duration", rec.durationMs != null ? secs(rec.durationMs) : ""],
      ["Task type", rec.taskType], ["Keys used", (rec.providers || []).join(", ")],
      ["Provider order", (rec.providerOrder || []).map((p) => PROVIDER_LABEL[p] || p).join(" → ")],
      ["Tokens", u ? fmt(u.totalTokens) + " (" + fmt(u.promptTokens) + " in, " + fmt(u.completionTokens) + " out)" : ""],
      ["Files", Object.keys(rec.artifacts || {}).length],
    ])));
    if (rec.message && rec.status === "error") out.push(sec("Error", "", el("div", { className: "errbox", textContent: rec.message })));
    if (rec.calls && rec.calls.length) {
      out.push(sec("Provider calls", rec.calls.length + " HTTP requests", table(["Step", "Provider / model", "Status", "Time", "Tokens", "Detail"],
        rec.calls.map((c) => [c.step === 0 ? "plan" : c.step, c.provider + "/" + c.model, statusCell(c), (c.latencyMs || 0) + "ms", c.tokens ? fmt(c.tokens.totalTokens) : "", c.detail || ""]), [3, 4])));
    } else if (rec.status !== "gated") {
      out.push(sec("Provider calls", "", el("p", { className: "muted", textContent: "Not recorded for runs made before this update." })));
    }
    if (rec.usage && rec.usage.byModel && rec.usage.byModel.length) {
      out.push(sec("Tokens by model", "", table(["Model", "Calls", "In", "Out", "Total"], rec.usage.byModel.map((m) => [m.provider + "/" + m.model, m.calls, fmt(m.promptTokens), fmt(m.completionTokens), fmt(m.totalTokens)]), [1, 2, 3, 4])));
    }
    if (rec.breakdown) {
      out.push(sec("Where the tokens went", fmt(Object.values(rec.breakdown).reduce((s, n) => s + n, 0)) + " tokens", breakdownView(rec.breakdown, false),
        el("p", { className: "muted", style: "margin:6px 0 0", textContent: "Input-side categories split the provider's input total by how much text each part of the prompt takes, so they're estimates. Output and thinking are measured (thinking only when the provider reports it or streams it)." })));
      const steps = (rec.calls || []).filter((c) => c.breakdown);
      if (steps.length) {
        out.push(sec("Tokens by step", "", table(["Step", "Model", "Underst.", "Instr.", "Request", "Context", "Code", "Other", "Thinking", "Wasted"],
          steps.map((c) => { const b = c.breakdown; return [c.step === 0 ? "plan" : c.step, c.model, short(b.understanding), short(b.instructions), short(b.request), short(b.context), short(b.code), short(b.otherText), short(b.thinking), short(b.wasted)]; }),
          [2, 3, 4, 5, 6, 7, 8, 9])));
      }
    } else if (rec.status !== "gated") {
      out.push(sec("Where the tokens went", "", el("p", { className: "muted", textContent: "Not recorded for runs made before this update." })));
    }
    if ((rec.executionLogs || []).length) {
      out.push(sec("Relay log", rec.executionLogs.length + " entries", el("ol", { className: "dlog" }, ...rec.executionLogs.map((l) =>
        el("li", {}, el("span", { className: "muted", textContent: time(l.timestamp) + " [" + l.step + "] " }), el("span", { className: "ev " + l.event, textContent: l.event }),
          " " + l.provider + "/" + l.model + ": " + l.message + (l.tokens ? " (" + fmt(l.tokens.totalTokens) + " tok)" : ""))))));
    }
    if ((rec.contexts || []).length) out.push(contextSection(rec));
    const slim = { ...rec,
      artifacts: Object.fromEntries(Object.entries(rec.artifacts || {}).map(([k, v]) => [k, "(" + v.length + " chars)"])),
      contexts: (rec.contexts || []).map((c) => ({ ...c, messages: "(" + (c.messages || []).length + " messages, see context section)" })) };
    out.push(sec("Raw record", "file contents shortened", el("details", {}, el("summary", { className: "linkbtn", textContent: "Show JSON" }), el("pre", { className: "raw", textContent: JSON.stringify(slim, null, 2) }))));
    const del = el("button", { type: "button", className: "dbtn", textContent: "Delete this run" });
    del.onclick = async () => {
      if (!confirm("Delete this run from history?")) return;
      await fetch("/api/history/" + encodeURIComponent(rec.id), { method: "DELETE" }).catch(() => {});
      records.delete(rec.id);
      selectedRunId = null;
      await loadRuns();
      if (currentChat()) openChat(currentChatId); else newChat();
    };
    out.push(el("div", {}, del));
    const live = liveSection();
    if (live && liveEvents.some((x) => x.ev.type === "done" && x.ev.historyId === rec.id)) out.splice(1, 0, live);
    body.replaceChildren(...out);
  }

  // Token breakdown by purpose. Fixed category order = fixed colour slot (never reassigned).
  const BREAKDOWN = [
    ["understanding", "Understanding", "planning: reading the request, choosing files", "measured"],
    ["instructions", "Instructions", "Baton's rules + the assignment in each prompt", "estimated share of input"],
    ["request", "Your request", "the goal and earlier requests", "estimated share of input"],
    ["context", "Context", "decisions, file list, files from earlier steps", "estimated share of input"],
    ["code", "Code written", "the file content that went into the project", "measured share of output"],
    ["otherText", "Other reply text", "explanations, fences, chatter around the file", "measured share of output"],
    ["thinking", "Thinking", "hidden reasoning before answering", "reported by provider, or estimated"],
    ["wasted", "Wasted", "replies Baton couldn't use (e.g. a bad plan)", "measured"],
  ];
  function breakdownView(b, compact) {
    const rows = BREAKDOWN.map(([k, name, what, how], i) => ({ k, name, what, how, color: "var(--c" + (i + 1) + ")", v: b[k] || 0 }));
    const total = rows.reduce((s, r) => s + r.v, 0);
    if (!total) return el("p", { className: "muted", textContent: "No token data for this." });
    const pct = (v) => (total ? (100 * v / total) : 0);
    const bar = el("div", { className: "segbar", role: "img", "aria-label": "Token breakdown" },
      ...rows.filter((r) => r.v > 0).map((r) => {
        const seg = el("span", { title: r.name + ": " + fmt(r.v) + " tokens (" + pct(r.v).toFixed(1) + "%)" });
        seg.style.flex = String(r.v); seg.style.background = r.color;
        return seg;
      }));
    const shown = rows.filter((r) => r.v > 0 || !compact);
    const t = table(compact ? ["Where", "Tokens", "%"] : ["Where the tokens went", "Tokens", "%", "How measured"],
      shown.map((r) => {
        const nameCell = el("span", {}, el("span", { className: "swatch" }), r.name);
        nameCell.firstChild.style.background = r.color;
        nameCell.title = r.what;
        return compact ? [nameCell, short(r.v), pct(r.v).toFixed(0) + "%"] : [nameCell, fmt(r.v), pct(r.v).toFixed(1) + "%", r.how];
      }), [1, 2]);
    return el("div", {}, bar, t);
  }

  function contextSection(rec) {
    const origins = rec.artifactOrigins || {};
    const logs = rec.executionLogs || [];
    return sec("How context was shared", "",
      el("p", { className: "muted", style: "margin:0 0 8px", textContent: "Each step gets the same shared workspace (goal, decisions, file list, full text of every file so far), so any model can continue where another stopped." }),
      el("ol", { className: "ctx" }, ...rec.contexts.map((c) => {
        const attempts = logs.filter((l) => l.step === c.step && l.event !== "complete" && l.message.indexOf("skipped:") !== 0);
        const sent = attempts.map((l) => l.provider + "/" + l.model + (l.event === "execute" || l.event === "plan" ? " ✓" : " ✗")).join(" → ");
        const chips = el("div", { className: "chips" });
        const chip = (t, tip, cls) => { const n = el("span", { className: "chip" + (cls ? " " + cls : ""), textContent: t }); if (tip) n.title = tip; chips.append(n); };
        chip("Goal", c.goal);
        if (c.conversation && c.conversation.length) chip("Earlier requests (" + c.conversation.length + ")", c.conversation.join(NL));
        const dec = Object.entries(c.decisions || {});
        if (dec.length) chip("Decisions: " + dec.map(([k, v]) => k + "=" + v).join(", "));
        if (c.manifest && c.manifest.length) chip("File list (" + c.manifest.length + ")", c.manifest.join(NL));
        for (const f of c.files || []) {
          const o = origins[f.path];
          const from = f.source === "previous" ? "earlier run" : (o ? "step " + o.step : "this run");
          chip(f.path + (f.mode === "outline" ? " (outline)" : "") + " · ~" + short(f.tokens) + " tok · " + from,
            (f.mode === "outline" ? "Only an outline was sent (names, ids, selectors) to save tokens. " : "") + (f.by || ""), "file" + (f.source === "previous" ? " prev" : ""));
        }
        if (c.targetExisted) chip("current " + c.target + " to rewrite", "", "file prev");
        return el("li", {},
          el("h5", { textContent: c.kind === "plan" ? "Plan" : "Step " + c.step + " · " + c.target + (c.targetExisted ? " (rewrite)" : " (new)") }),
          el("div", { className: "muted", textContent: "Sent to: " + (sent || "-") }),
          chips,
          el("details", {}, el("summary", { className: "linkbtn", textContent: "Exact prompt (~" + fmt(c.promptTokens) + " tokens)" }),
            el("pre", { className: "raw", textContent: (c.messages || []).map((m) => "[" + m.role + "]" + NL + m.content).join(NL + NL) })));
      })));
  }

  async function loadDebug() {
    try { const r = await fetch("/api/debug"); return r.ok ? await r.json() : null; } catch { return null; }
  }

  async function renderServer() {
    const body = $("debugBody");
    const d = await loadDebug();
    if (!d) { body.replaceChildren(sec("Server", "", el("p", { className: "muted", textContent: "Could not load /api/debug." }))); return; }
    const refresh = el("button", { type: "button", className: "dbtn", textContent: "Refresh" });
    refresh.onclick = renderServer;
    const forget = el("button", { type: "button", className: "dbtn", textContent: "Forget all" });
    forget.onclick = async () => { await fetch("/api/debug/memory", { method: "DELETE" }).catch(() => {}); renderServer(); };
    const label = (p) => PROVIDER_LABEL[p] || p;
    const until = (iso) => "until " + new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const m = d.memory;
    const remembered = m.retiredModels.length || m.discoveredModels.length || m.busyProviders.length;
    body.replaceChildren(
      sec("Server", refresh, kv([["Started", new Date(d.server.startedAt).toLocaleString()], ["Uptime", Math.round(d.server.uptimeSec / 60) + " min"], ["Node", d.server.node], ["Data folder", d.server.dataDir], ["Saved runs", d.server.historyRuns]])),
      sec("Provider order", "", kv([["Planning", d.providerOrder.planner.map(label).join(" → ")], ["Building", d.providerOrder.relay.map(label).join(" → ")]])),
      sec("Models (tried in order)", "", table(["Provider", "Code", "Other tasks"], [
        ["Groq", d.models.groq.code.join(", "), d.models.groq.general.join(", ")],
        ["Gemini", d.models.google.join(", "), "same"],
        ["NVIDIA NIM", d.models.nvidia.code.join(", "), d.models.nvidia.general.join(", ")],
        ["OpenRouter", d.models.openrouter.code.join(", "), d.models.openrouter.general.join(", ")],
        ["OpenAI", d.models.openai.join(", "), "same"],
      ])),
      sec("Settings", "", kv([["Provider timeout", d.settings.providerTimeoutMs + " ms"], ["Overload retry wait", d.settings.overloadRetryMs + " ms"], ["Busy provider skip", Math.round(d.settings.busySkipMs / 60000) + " min"], ["Daily-limit skip", Math.round(d.settings.dailyLimitSkipMs / 60000) + " min"], ["Retired model memory", Math.round(d.settings.deadModelTtlMs / 3600000) + " h"], ["Download links", Math.round(d.settings.workspaceTtlSec / 60) + " min, then from history"], ["History limit", d.settings.historyMax + " runs"]])),
      sec("What Baton remembers", forget, remembered
        ? el("div", {},
            m.busyProviders.length ? table(["Skipped provider", "Key", "Until", "Why"], m.busyProviders.map((b) => [label(b.provider), b.keyHash, until(b.until), b.reason || "busy"])) : null,
            m.retiredModels.length ? table(["Retired model", "Provider", "Key", "Until"], m.retiredModels.map((r) => [r.model, label(r.provider), r.keyHash, until(r.until)])) : null,
            m.discoveredModels.length ? table(["Discovered replacement", "Provider", "Key", "Until"], m.discoveredModels.map((r) => [r.model, label(r.provider), r.keyHash, until(r.until)])) : null)
        : el("p", { className: "muted", textContent: "Nothing yet. Retired models, discovered replacements and busy providers appear here. Memory resets when the server restarts." })),
      sec("Recent provider calls", d.recentCalls.length + " (all runs)", d.recentCalls.length
        ? table(["Time", "Step", "Provider / model", "Status", "Latency", "Tokens", "Detail"], d.recentCalls.map((c) => [time(c.at), c.step === 0 ? "plan" : (c.step == null ? "" : c.step), c.provider + "/" + c.model, statusCell(c), (c.latencyMs || 0) + "ms", c.tokens ? fmt(c.tokens.totalTokens) : "", c.detail || ""]), [4, 5])
        : el("p", { className: "muted", textContent: "No provider calls since the server started." })),
    );
  }

  // ===================== Mobile sidebar =====================
  function closeSide() { $("side").classList.remove("open"); $("scrim").classList.remove("show"); }
  $("menuBtn").onclick = () => { $("side").classList.add("open"); $("scrim").classList.add("show"); };
  $("scrim").onclick = closeSide;

  // ===================== Start =====================
  renderKeyStatus();
  if (order) { order = completeOrder(order); renderOrderChip(); }
  else defaultOrder().then((o) => { order = o; saveOrder(); });
  setTab(debugTab);
  setDebugOpen(debugOpen);
  loadUsage();
  loadRuns().then(() => {
    if (currentChatId && currentChat()) openChat(currentChatId);
    else { currentChatId = null; showWelcome(); updateComposer(); }
  });
})();
</script>
</body>
</html>`;

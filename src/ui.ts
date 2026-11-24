// Minimal browser UI served at GET /. Single self-contained page, no build step.
// Keys stay in the browser (localStorage, opt-in) and are sent only to this server.

export const UI_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Baton</title>
<style>
  :root {
    --bg: #f7f7f5; --panel: #ffffff; --text: #1d1d1b; --muted: #6b6b66; --line: #e3e3de;
    --accent: #3b5bdb; --ok: #2b8a3e; --warn: #c2410c; --code: #f1f1ee;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #151515; --panel: #1e1e1e; --text: #ececea; --muted: #9a9a94; --line: #2e2e2c;
      --accent: #7b93ff; --ok: #5cc06e; --warn: #f08a4b; --code: #262626; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 920px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { margin: 0 0 4px; font-size: 26px; }
  .sub { color: var(--muted); margin: 0 0 24px; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 20px; margin-bottom: 20px; }
  label { display: block; font-weight: 600; font-size: 13px; margin: 0 0 6px; }
  .opt { font-weight: 400; color: var(--muted); }
  textarea, input, select { width: 100%; font: inherit; color: var(--text); background: var(--bg);
    border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
  textarea { min-height: 96px; resize: vertical; }
  .row { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-top: 14px; }
  .check { display: flex; gap: 8px; align-items: center; font-weight: 400; margin-top: 12px; color: var(--muted); }
  .check input { width: auto; }
  button { margin-top: 18px; background: var(--accent); color: #fff; border: 0; border-radius: 8px;
    padding: 11px 20px; font: inherit; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .55; cursor: wait; }
  .status { margin-top: 14px; color: var(--muted); min-height: 1.5em; }
  .status.err { color: var(--warn); }
  h2 { font-size: 17px; margin: 0 0 12px; }
  .summary { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
  .pill { border: 1px solid var(--line); border-radius: 999px; padding: 3px 12px; font-size: 13px; }
  .pill.success { color: var(--ok); border-color: var(--ok); }
  .pill.partial, .pill.failed { color: var(--warn); border-color: var(--warn); }
  a.dl { color: var(--accent); font-weight: 600; }
  ol.logs { margin: 0; padding-left: 20px; }
  ol.logs li { margin: 4px 0; }
  .ev { font-family: ui-monospace, Menlo, monospace; font-size: 12px; padding: 1px 6px; border-radius: 4px; background: var(--code); }
  .ev.failover { color: var(--warn); }
  .ev.execute, .ev.complete { color: var(--ok); }
  .meta { color: var(--muted); font-size: 13px; }
  details { border-top: 1px solid var(--line); padding: 10px 0; }
  details:first-of-type { border-top: 0; }
  summary { cursor: pointer; font-family: ui-monospace, Menlo, monospace; font-size: 14px; }
  pre { background: var(--code); border-radius: 8px; padding: 12px; overflow-x: auto; font-size: 13px; margin: 10px 0 0; }
  /* ---- layout with history sidebar ---- */
  main { max-width: 1200px; }
  .layout { display: grid; gap: 20px; grid-template-columns: 1fr; grid-template-areas: "content" "history"; }
  .content { grid-area: content; min-width: 0; }
  .history { grid-area: history; min-width: 0; }
  @media (min-width: 960px) {
    .layout { grid-template-columns: 300px minmax(0, 1fr); grid-template-areas: "history content"; align-items: start; }
    .history { position: sticky; top: 16px; max-height: calc(100vh - 32px); display: flex; flex-direction: column; }
    .history .runs { overflow-y: auto; }
  }
  .history .head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
  .history h2 { margin: 0; }
  .linkbtn { background: none; border: 0; color: var(--muted); font: inherit; font-size: 13px; padding: 0; margin: 0; cursor: pointer; text-decoration: underline; }
  .linkbtn:hover { color: var(--warn); }
  .runs { list-style: none; margin: 0; padding: 0; }
  .run { width: 100%; text-align: left; background: none; color: var(--text); border: 1px solid transparent; border-radius: 8px;
    padding: 9px 10px; margin: 0 0 4px; font: inherit; font-weight: 400; cursor: pointer; display: block; }
  .run:hover { background: var(--bg); }
  .run.active { border-color: var(--accent); background: var(--bg); }
  .run .p { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 14px; overflow-wrap: anywhere; }
  .run .m { display: flex; gap: 6px; align-items: center; color: var(--muted); font-size: 12px; margin-top: 3px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
  .dot.success { background: var(--ok); }
  .dot.partial, .dot.failed, .dot.error { background: var(--warn); }
  .empty { color: var(--muted); font-size: 14px; }
  .pill.error { color: var(--warn); border-color: var(--warn); }
  .prompt-view { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--bg); border-radius: 8px; padding: 10px 12px; margin: 0 0 12px; }
  .errbox { color: var(--warn); border: 1px solid var(--warn); border-radius: 8px; padding: 10px 12px; margin-top: 12px; overflow-wrap: anywhere; }
  .actions { display: flex; gap: 16px; margin-top: 12px; flex-wrap: wrap; }
  .actions .linkbtn { color: var(--accent); }
  .actions .linkbtn.danger { color: var(--muted); }
  .keys { grid-template-columns: 1fr; }
  @media (min-width: 600px) { .keys { grid-template-columns: 1fr 1fr; } }
  .tokens { display: flex; flex-wrap: wrap; flex-direction: row; gap: 6px 14px; align-items: baseline; margin-top: 12px; font-size: 14px; }
  .tokens strong { font-variant-numeric: tabular-nums; }
  .tokens .by { color: var(--muted); font-size: 13px; }
  .tok { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .alltime { color: var(--muted); font-size: 12px; margin: -4px 0 10px; }
  .utable { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 10px; }
  .utable th, .utable td { padding: 5px 6px; border-bottom: 1px solid var(--line); text-align: right; font-variant-numeric: tabular-nums; vertical-align: top; }
  .utable th { color: var(--muted); font-weight: 600; font-size: 12px; }
  .utable th:first-child, .utable td:first-child { text-align: left; overflow-wrap: anywhere; }
  .utable td .prov { display: block; color: var(--muted); font-size: 11px; }
  .utable tfoot td { font-weight: 600; border-bottom: 0; }
  .usage { border-bottom: 1px solid var(--line); padding-bottom: 12px; margin-bottom: 12px; }
  .usage .head { margin-bottom: 4px; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
  .seg button { margin: 0; border: 0; border-radius: 0; background: none; color: var(--muted); font-size: 12px; font-weight: 600; padding: 3px 9px; }
  .seg button.on { background: var(--accent); color: #fff; }
  .usage .note { color: var(--muted); font-size: 12px; margin: 6px 0 0; }
  .usage .utable { font-size: 12px; }
  .usage .utable th, .usage .utable td { padding: 4px 3px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <h1>Baton</h1>
  <p class="sub">Describe a project. Baton plans it, builds each file on Groq, and fails over to Gemini, NVIDIA NIM and then OpenAI (for whichever keys you add) when a provider hits its limit.</p>

  <div class="layout">
  <aside class="panel history" aria-label="Token usage and run history">
    <section class="usage" id="usage" hidden aria-label="Token usage by model">
      <div class="head">
        <h2>Token usage</h2>
        <span class="seg" role="group" aria-label="Period">
          <button type="button" id="uToday" class="on" aria-pressed="true">Today</button>
          <button type="button" id="uAll" aria-pressed="false">All time</button>
        </span>
      </div>
      <div id="usageBody"></div>
    </section>
    <div class="head">
      <h2>History</h2>
      <button type="button" class="linkbtn" id="clearAll" hidden>Clear all</button>
    </div>
    <p class="empty" id="historyEmpty">No runs yet. Every prompt you send, with its log and files, will be saved here.</p>
    <ul class="runs" id="runs"></ul>
  </aside>

  <div class="content">
  <form class="panel" id="form">
    <label for="prompt">What should Baton build?</label>
    <textarea id="prompt" required placeholder="Create an Express.js authentication service with JWT and bcrypt"></textarea>

    <div class="row">
      <div>
        <label for="taskType">Task type</label>
        <select id="taskType">
          <option value="code">Code</option>
          <option value="document">Document</option>
          <option value="analysis">Analysis</option>
        </select>
      </div>
    </div>

    <div class="row keys">
      <div>
        <label for="groq">Groq API key</label>
        <input id="groq" type="password" autocomplete="off" placeholder="gsk_..." />
      </div>
      <div>
        <label for="gemini">Gemini API key</label>
        <input id="gemini" type="password" autocomplete="off" placeholder="AIza..." />
      </div>
      <div>
        <label for="nvidia">NVIDIA NIM API key</label>
        <input id="nvidia" type="password" autocomplete="off" placeholder="nvapi-..." />
      </div>
      <div>
        <label for="openai">OpenAI API key <span class="opt">(optional, paid)</span></label>
        <input id="openai" type="password" autocomplete="off" placeholder="sk-..." />
      </div>
    </div>
    <label class="check"><input type="checkbox" id="remember" /> Remember keys in this browser</label>

    <button type="submit" id="go">Run</button>
    <div class="status" id="status" role="status"></div>
  </form>

  <section class="panel" id="results" hidden>
    <h2>Result</h2>
    <p class="meta" id="runMeta"></p>
    <div class="prompt-view" id="runPrompt"></div>
    <div class="summary" id="summary"></div>
    <div class="tokens" id="runTokens" hidden></div>
    <div class="errbox" id="runError" hidden></div>
    <div class="actions">
      <button type="button" class="linkbtn" id="reuse">Use this prompt again</button>
      <button type="button" class="linkbtn danger" id="deleteRun">Delete from history</button>
    </div>
  </section>

  <section class="panel" id="logPanel" hidden>
    <h2>Relay log</h2>
    <ol class="logs" id="logs"></ol>
  </section>

  <section class="panel" id="artifactPanel" hidden>
    <h2>Artifacts</h2>
    <div id="artifacts"></div>
  </section>
  </div>
  </div>
</main>

<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  };

  if (store.get("baton.remember") === "1") {
    $("remember").checked = true;
    $("groq").value = store.get("baton.groq") || "";
    $("gemini").value = store.get("baton.gemini") || "";
    $("openai").value = store.get("baton.openai") || "";
    $("nvidia").value = store.get("baton.nvidia") || "";
  }

  const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    for (const k of kids) n.append(k);
    return n;
  };

  function setStatus(text, isErr = false) {
    $("status").textContent = text;
    $("status").className = "status" + (isErr ? " err" : "");
  }

  function ago(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    return new Date(iso).toLocaleDateString();
  }

  const fmt = (n) => Math.round(n || 0).toLocaleString();
  const short = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n || 0)));
  const PROVIDER_LABEL = { groq: "Groq", google: "Gemini", nvidia: "NVIDIA NIM", openai: "OpenAI", baton: "Baton" };

  /** Table of per-model usage. "compact" drops the in/out columns (sidebar). */
  function usageTable(byModel, total, compact) {
    const head = compact ? ["Model", "Calls", "Tokens"] : ["Model", "Calls", "In", "Out", "Total"];
    const cells = (m) => compact
      ? [fmt(m.calls), short(m.totalTokens)]
      : [fmt(m.calls), fmt(m.promptTokens), fmt(m.completionTokens), fmt(m.totalTokens)];
    const row = (m) => {
      const tr = el("tr", {},
        el("td", {}, m.model, el("span", { className: "prov", textContent: PROVIDER_LABEL[m.provider] || m.provider })),
        ...cells(m).map((c) => el("td", { textContent: c })));
      tr.title = fmt(m.promptTokens) + " in · " + fmt(m.completionTokens) + " out" + (m.estimated ? " (some estimated)" : "");
      return tr;
    };
    return el("table", { className: "utable" },
      el("thead", {}, el("tr", {}, ...head.map((h) => el("th", { textContent: h })))),
      el("tbody", {}, ...byModel.map(row)),
      ...(byModel.length > 1 && total ? [el("tfoot", {}, el("tr", {}, el("td", { textContent: "Total" }), ...cells(total).map((c) => el("td", { textContent: c }))))] : []));
  }

  let usagePeriod = store.get("baton.usagePeriod") === "allTime" ? "allTime" : "today";
  let usageData = null;

  function renderUsage() {
    if (!usageData) return;
    const hasAny = usageData.allTime.runs > 0;
    $("usage").hidden = !hasAny;
    if (!hasAny) return;
    $("uToday").classList.toggle("on", usagePeriod === "today");
    $("uAll").classList.toggle("on", usagePeriod === "allTime");
    $("uToday").setAttribute("aria-pressed", String(usagePeriod === "today"));
    $("uAll").setAttribute("aria-pressed", String(usagePeriod === "allTime"));
    const d = usageData[usagePeriod];
    const body = $("usageBody");
    if (!d.byModel.length) {
      body.replaceChildren(el("p", { className: "note", textContent: usagePeriod === "today" ? "No tokens used today yet." : "No token usage recorded yet." }));
      return;
    }
    const since = usagePeriod === "allTime" && d.since ? " since " + new Date(d.since).toLocaleDateString() : "";
    body.replaceChildren(
      usageTable(d.byModel, d.total, true),
      el("p", { className: "note", textContent: fmt(d.total.totalTokens) + " tokens · " + d.runs + " run" + (d.runs === 1 ? "" : "s") + since }));
  }

  async function loadUsage() {
    try {
      const res = await fetch("/api/usage");
      if (res.ok) usageData = await res.json();
    } catch {}
    renderUsage();
  }

  for (const [id, period] of [["uToday", "today"], ["uAll", "allTime"]]) {
    $(id).addEventListener("click", () => { usagePeriod = period; store.set("baton.usagePeriod", period); renderUsage(); });
  }

  const STATUS_TEXT = { success: "success", partial: "partial", failed: "failed", error: "error", gated: "answered locally" };

  // ---------- history ----------
  let current = null; // the run being shown

  async function loadHistory() {
    let runs = [];
    try {
      const res = await fetch("/api/history");
      if (res.ok) runs = (await res.json()).runs || [];
    } catch {}
    loadUsage();
    $("historyEmpty").hidden = runs.length > 0;
    $("clearAll").hidden = runs.length === 0;
    $("runs").replaceChildren(...runs.map((r) => {
      const files = r.artifactCount ? " · " + r.artifactCount + " file" + (r.artifactCount === 1 ? "" : "s") : "";
      const toks = r.usage && r.usage.total.totalTokens ? " · " + short(r.usage.total.totalTokens) + " tok" : "";
      const btn = el("button", { type: "button", className: "run" + (current && current.id === r.id ? " active" : "") },
        el("span", { className: "p", textContent: r.userPrompt }),
        el("span", { className: "m" },
          el("span", { className: "dot " + r.status }),
          el("span", { textContent: (STATUS_TEXT[r.status] || r.status) + " · " + ago(r.createdAt) + files + toks })));
      btn.title = new Date(r.createdAt).toLocaleString();
      btn.dataset.id = r.id;
      btn.addEventListener("click", () => openRun(r.id));
      return el("li", {}, btn);
    }));
    return runs;
  }

  async function openRun(id) {
    try {
      const res = await fetch("/api/history/" + encodeURIComponent(id));
      if (!res.ok) throw new Error("not found");
      render(await res.json());
      store.set("baton.selected", id);
    } catch {
      store.set("baton.selected", null);
    }
  }

  function markActive() {
    for (const b of document.querySelectorAll(".run")) b.classList.toggle("active", !!current && b.dataset.id === current.id);
  }

  // ---------- result view ----------
  function render(run) {
    current = run;
    markActive();
    $("results").hidden = false;
    const when = run.createdAt ? new Date(run.createdAt).toLocaleString() : "";
    const secs = run.durationMs != null ? " · took " + (run.durationMs / 1000).toFixed(1) + "s" : "";
    const via = run.providers && run.providers.length ? " · keys: " + run.providers.join(", ") : "";
    $("runMeta").textContent = [when, run.taskType].filter(Boolean).join(" · ") + secs + via;
    $("runPrompt").textContent = run.userPrompt || "";
    $("deleteRun").hidden = !run.id;

    const summary = $("summary");
    summary.replaceChildren(el("span", { className: "pill " + run.status, textContent: STATUS_TEXT[run.status] || run.status }));
    if (run.status === "gated") {
      summary.append(el("span", { textContent: (run.message || run.response || "") + " (0 tokens used)" }));
    } else if (run.summary) {
      summary.append(el("span", { textContent: " " + run.summary.completedTasks + " of " + run.summary.totalTasks + " files built " }));
    }
    const files = Object.keys(run.artifacts || {}).length;
    if (files && run.downloadUrl) summary.append(el("a", { className: "dl", href: run.downloadUrl, textContent: "Download .zip" }));

    const u = run.usage;
    const tokBox = $("runTokens");
    if (run.status === "gated") {
      tokBox.hidden = false;
      tokBox.replaceChildren(el("span", {}, "Tokens: ", el("strong", { textContent: "0" })));
    } else if (u && u.total) {
      tokBox.hidden = false;
      tokBox.replaceChildren(
        el("span", {}, "Tokens: ", el("strong", { textContent: fmt(u.total.totalTokens) }), " "),
        el("span", { className: "by", textContent: "(" + fmt(u.total.promptTokens) + " in, " + fmt(u.total.completionTokens) + " out" + (u.total.estimated ? ", some estimated" : "") + ")" }),
        ...(u.byModel && u.byModel.length ? [usageTable(u.byModel, u.total, false)] : []),
      );
    } else {
      tokBox.hidden = true;
    }

    const isErr = run.status === "error";
    $("runError").hidden = !isErr;
    $("runError").textContent = isErr ? run.message || "Something went wrong." : "";

    const logs = run.executionLogs || [];
    $("logPanel").hidden = logs.length === 0;
    $("logs").replaceChildren(...logs.map((l) =>
      el("li", {},
        el("span", { className: "ev " + l.event, textContent: l.event }), " ",
        l.message, " ",
        el("span", { className: "meta", textContent: "(" + l.provider + " / " + l.model + ")" }),
        ...(l.tokens ? [" ", el("span", { className: "tok", textContent: "· " + fmt(l.tokens.totalTokens) + " tokens" + (l.tokens.estimated ? " (est.)" : "") })] : []),
      )));

    const entries = Object.entries(run.artifacts || {});
    $("artifactPanel").hidden = entries.length === 0;
    $("artifacts").replaceChildren(...entries.map(([path, content], i) =>
      el("details", { open: i === 0 }, el("summary", { textContent: path }), el("pre", { textContent: content }))));
  }

  $("reuse").addEventListener("click", () => {
    if (!current) return;
    $("prompt").value = current.userPrompt || "";
    if (current.taskType) $("taskType").value = current.taskType;
    $("prompt").focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  $("deleteRun").addEventListener("click", async () => {
    if (!current || !current.id || !confirm("Delete this run from history?")) return;
    await fetch("/api/history/" + encodeURIComponent(current.id), { method: "DELETE" }).catch(() => {});
    current = null;
    store.set("baton.selected", null);
    $("results").hidden = $("logPanel").hidden = $("artifactPanel").hidden = true;
    await loadHistory();
  });

  $("clearAll").addEventListener("click", async () => {
    if (!confirm("Delete ALL runs from history? This cannot be undone.")) return;
    await fetch("/api/history", { method: "DELETE" }).catch(() => {});
    current = null;
    store.set("baton.selected", null);
    $("results").hidden = $("logPanel").hidden = $("artifactPanel").hidden = true;
    await loadHistory();
  });

  // ---------- run a prompt ----------
  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const remember = $("remember").checked;
    store.set("baton.remember", remember ? "1" : null);
    store.set("baton.groq", remember ? $("groq").value : null);
    store.set("baton.gemini", remember ? $("gemini").value : null);
    store.set("baton.openai", remember ? $("openai").value : null);
    store.set("baton.nvidia", remember ? $("nvidia").value : null);

    $("go").disabled = true;
    setStatus("Planning and building. This can take a minute…");
    const userPrompt = $("prompt").value;
    const taskType = $("taskType").value;
    try {
      const res = await fetch("/api/orchestrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userPrompt,
          taskType,
          keys: {
            groqApiKey: $("groq").value.trim() || undefined,
            geminiApiKey: $("gemini").value.trim() || undefined,
            openaiApiKey: $("openai").value.trim() || undefined,
            nvidiaApiKey: $("nvidia").value.trim() || undefined,
          },
        }),
      });
      let data = {};
      try { data = await res.json(); } catch {}
      setStatus(data.error === "missing_keys" ? "Add at least one API key (Groq, Gemini, NVIDIA NIM or OpenAI) to run a project." : "", data.error === "missing_keys");
      await loadHistory();
      if (data.historyId) {
        await openRun(data.historyId);
      } else {
        // History unavailable: show the response directly.
        render({ ...data, userPrompt, taskType, status: res.ok ? data.status : "error",
          message: data.message || data.response || (res.ok ? "" : "HTTP " + res.status) });
      }
    } catch (err) {
      setStatus("Could not reach the Baton server: " + err.message, true);
    } finally {
      $("go").disabled = false;
    }
  });

  // ---------- restore after refresh ----------
  loadHistory().then((runs) => {
    const saved = store.get("baton.selected");
    const pick = runs.find((r) => r.id === saved) || runs[0];
    if (pick) openRun(pick.id);
  });
})();
</script>
</body>
</html>`;

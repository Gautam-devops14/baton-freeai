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
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <h1>Baton</h1>
  <p class="sub">Describe a project. Baton plans it, builds each file on Groq, and fails over to Gemini when a provider hits its limit.</p>

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
      <div>
        <label for="groq">Groq API key</label>
        <input id="groq" type="password" autocomplete="off" placeholder="gsk_..." />
      </div>
      <div>
        <label for="gemini">Gemini API key</label>
        <input id="gemini" type="password" autocomplete="off" placeholder="AIza..." />
      </div>
    </div>
    <label class="check"><input type="checkbox" id="remember" /> Remember keys in this browser</label>

    <button type="submit" id="go">Run</button>
    <div class="status" id="status" role="status"></div>
  </form>

  <section class="panel" id="results" hidden>
    <h2>Result</h2>
    <div class="summary" id="summary"></div>
  </section>

  <section class="panel" id="logPanel" hidden>
    <h2>Relay log</h2>
    <ol class="logs" id="logs"></ol>
  </section>

  <section class="panel" id="artifactPanel" hidden>
    <h2>Artifacts</h2>
    <div id="artifacts"></div>
  </section>
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

  function render(data) {
    $("results").hidden = false;
    const summary = $("summary");
    summary.replaceChildren();

    if (data.status === "gated") {
      summary.append(el("span", { className: "pill", textContent: "answered locally, 0 tokens" }), el("span", { textContent: data.response }));
      $("logPanel").hidden = $("artifactPanel").hidden = true;
      return;
    }

    const s = data.summary;
    summary.append(
      el("span", { className: "pill " + data.status, textContent: data.status }),
      el("span", { textContent: s.completedTasks + " of " + s.totalTasks + " files built" }),
      el("a", { className: "dl", href: data.downloadUrl, textContent: "Download .zip" }),
    );

    $("logPanel").hidden = false;
    $("logs").replaceChildren(...data.executionLogs.map((l) =>
      el("li", {},
        el("span", { className: "ev " + l.event, textContent: l.event }), " ",
        l.message, " ",
        el("span", { className: "meta", textContent: "(" + l.provider + " / " + l.model + ")" }),
      )));

    const entries = Object.entries(data.artifacts);
    $("artifactPanel").hidden = entries.length === 0;
    $("artifacts").replaceChildren(...entries.map(([path, content], i) =>
      el("details", { open: i === 0 }, el("summary", { textContent: path }), el("pre", { textContent: content }))));
  }

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const remember = $("remember").checked;
    store.set("baton.remember", remember ? "1" : null);
    store.set("baton.groq", remember ? $("groq").value : null);
    store.set("baton.gemini", remember ? $("gemini").value : null);

    $("go").disabled = true;
    $("results").hidden = $("logPanel").hidden = $("artifactPanel").hidden = true;
    setStatus("Planning and building. This can take a minute…");
    try {
      const res = await fetch("/api/orchestrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userPrompt: $("prompt").value,
          taskType: $("taskType").value,
          keys: { groqApiKey: $("groq").value.trim() || undefined, geminiApiKey: $("gemini").value.trim() || undefined },
        }),
      });
      const data = await res.json();
      if (data.error === "missing_keys") throw new Error("Add a Groq or Gemini API key (or both) to run a project.");
      if (!res.ok) throw new Error(data.message || ("HTTP " + res.status));
      setStatus("");
      render(data);
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      $("go").disabled = false;
    }
  });
})();
</script>
</body>
</html>`;

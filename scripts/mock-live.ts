/** 实时回放：本地起一个 WS 服务，把 mock 时间线按真实 flush 节奏推进——
 *  卡片按虚拟 2s（= 真机 flushMs）推一次，**只推内容变化的段**（局部刷新，与真机同口径），
 *  事件流与 CardKit API 日志同步滚。
 *
 *  运行：bun run preview:live   →   http://localhost:8791 （PORT 可覆盖）
 *
 *  与真机的对应关系（这就是「动起来的 mock」的意义）：
 *  - 世界推进 = frontend 的 flush drain：今天发生了什么 → ingestStatus 折进 StatusState；
 *  - 卡片内容 = renderStatusSections（同一个函数，无替身语义）；
 *  - 传输日志 = 真实 CardKit 端点（按 element_id 逐段 PUT + PATCH …/cards/:card_id/settings 收尾关流式）；
 *  - 倍速/暂停/跳转只改**回放**时钟，不改事件顺序与渲染口径。
 */

import { MOCK_DURATION_MS, MockWorld, mmss } from "./mock-data";
import type { LooongerEvent } from "looonger-sdk";

const PORT = Number(process.env.PORT ?? 8791);
const CARD_ID = "7691716951009332185"; // 与真机同型
const MESSAGE_ID = "om_mock_9f2c1d";
const FLUSH_MS = 2000; // 虚拟时间的卡片刷新节奏（真机 flushMs）
const SPEEDS = [1, 4, 16] as const;
const TICK_MS = 100;

type ClientMsg =
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "restart" }
  | { readonly type: "speed"; readonly value: number }
  | { readonly type: "jump"; readonly value: number };

// ============ 回放世界（服务端唯一状态） ============

let world: MockWorld;
let virtualMs = 0;
let speed = 4;
let paused = false;
let finished = false;
let seq = 0; // 与真机同口径：每次流式更新严格递增
let firedPushed = 0;
let lastFlushSlot = -1;
/** 每个 element 最后一次推送的正文（局部刷新：没变的段不推、不占 sequence）。 */
let lastSections = new Map<string, string>();
let lastTick = Date.now();
let viewers = 0; // 连着的观众数（自动重播只在有人看时发生）
let finishedAt: number | undefined; // 自然播完的时刻（跳转到的终态不触发重播）
let replayHint = false; // 「即将重播」提示是否已发

function resetWorld(): void {
  world = new MockWorld(Date.now() - 12 * 60_000); // attach 于 12 分钟前 → elapsed 从 0 长
  virtualMs = 0;
  finished = false;
  seq = 0;
  firedPushed = 0;
  lastFlushSlot = -1;
  lastSections = new Map();
  finishedAt = undefined;
  replayHint = false;
  apiLog("POST /open-apis/cardkit/v1/cards", `type=card_json → card_id=${CARD_ID}`);
  apiLog("POST /open-apis/im/v1/messages?receive_id_type=open_id", `card 实体 → message_id=${MESSAGE_ID}`);
  // 首屏各段随建卡实体下发（不占 sequence）——之后只有内容变化的段才走 PUT
  for (const section of world.sections()) lastSections.set(section.id, section.content);
  peekCard();
}

/** 分段拼回整卡（空段不出现在预览里——与卡片上的视觉效果一致）。 */
function assemble(sections: readonly { readonly id: string; readonly content: string }[]): string {
  return sections
    .map((s) => s.content)
    .filter((c) => c.trim().length > 0)
    .join("\n");
}

function broadcastState(): void {
  server.publish(
    "room",
    JSON.stringify({ t: "state", paused, speed, finished, replayHint, vms: virtualMs, clock: mmss(virtualMs) }),
  );
}

/** 心跳 API 日志之外的推送：一次 flush = 真机一次局部刷新（逐段 PUT，没变的段不推）。 */
function pushCard(): void {
  const sections = world.sections();
  const pushed: string[] = [];
  for (const section of sections) {
    if (lastSections.get(section.id) === section.content) continue; // 局部刷新：没变的段不推
    lastSections.set(section.id, section.content);
    seq += 1;
    pushed.push(section.id);
    apiLog(
      `PUT /open-apis/cardkit/v1/cards/${CARD_ID}/elements/${section.id}/content`,
      `sequence=${seq} · ${new TextEncoder().encode(section.content).length}B · 全量文本（平台算增量）`,
    );
  }
  server.publish(
    "room",
    JSON.stringify({ t: "card", md: assemble(sections), title: world.headerTitle(), seq, pushed }),
  );
}

function peekCard(): void {
  server.publish(
    "room",
    JSON.stringify({ t: "card", md: assemble(world.sections()), title: world.headerTitle(), seq, pushed: [] }),
  );
}

function apiLog(op: string, detail: string): void {
  server.publish("room", JSON.stringify({ t: "api", op, detail }));
}

function eventLog(fired: { atMs: number; note: string; event: LooongerEvent }): void {
  server.publish(
    "room",
    JSON.stringify({ t: "event", at: mmss(fired.atMs), note: fired.note, type: fired.event.type }),
  );
}

/** 收尾：最后一次 flush（含 outcome）+ 关流式（真机 dispose 顺序）。 */
function finish(): void {
  pushCard();
  seq += 1;
  apiLog(
    `PATCH /open-apis/cardkit/v1/cards/${CARD_ID}/settings`,
    `sequence=${seq} · settings={"config":{"streaming_mode":false}}`,
  );
  finished = true;
  finishedAt = Date.now();
  broadcastState();
}

function tick(): void {
  const now = Date.now();
  const dt = Math.min(400, now - lastTick); // 掉帧保护：暂停/调试器回来不跳变
  lastTick = now;
  if (!paused && !finished) virtualMs += dt * speed;

  world.advanceTo(virtualMs);
  for (; firedPushed < world.fired.length; firedPushed += 1) {
    const fired = world.fired[firedPushed];
    if (fired !== undefined) eventLog(fired);
  }

  const slot = Math.floor(virtualMs / FLUSH_MS);
  if (world.done && !finished) {
    lastFlushSlot = slot;
    finish();
    return;
  }
  if (slot !== lastFlushSlot) {
    lastFlushSlot = slot;
    pushCard();
  }
  // 自然播完：有人看就循环重播（演示页不该停在终帧）；跳转到的终态不重播
  if (finished && finishedAt !== undefined && viewers > 0) {
    const since = Date.now() - finishedAt;
    if (since > 5000) {
      resetWorld();
      broadcastState();
    } else if (since > 1500 && !replayHint) {
      replayHint = true;
      broadcastState();
    }
  }
}

const server = (() => {
  try {
    return Bun.serve({
      port: PORT,
      fetch(req, srv): Response {
        let pathname: string;
        try {
          pathname = new URL(req.url).pathname;
        } catch {
          return new Response("bad request", { status: 400 });
        }
        if (pathname === "/ws") {
          if (srv.upgrade(req)) return new Response(null, { status: 101 });
          return new Response("websocket upgrade failed", { status: 426 });
        }
        return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
      },
      websocket: {
        open(ws): void {
          viewers += 1;
          ws.subscribe("room");
          if (world.done) resetWorld(); // 连上时世界已播完（刷新/晚到）→ 重开一局
          peekCard(); // 新观众只补当前帧（不产生新的 sequence）
          broadcastState();
        },
        close(): void {
          viewers = Math.max(0, viewers - 1);
        },
        message(_ws, raw): void {
          let cmd: ClientMsg;
          try {
            cmd = JSON.parse(String(raw)) as ClientMsg;
          } catch {
            return;
          }
          switch (cmd.type) {
            case "pause":
              paused = true;
              break;
            case "resume":
              paused = false;
              break;
            case "speed":
              if (SPEEDS.includes(cmd.value as (typeof SPEEDS)[number])) speed = cmd.value;
              break;
            case "restart":
              resetWorld();
              break;
            case "jump":
              virtualMs = Math.max(0, Math.min(MOCK_DURATION_MS, cmd.value));
              // advanceTo 只能向前。回退（或重复跳同一帧）必须重开世界再快进，否则画面停在更晚的状态。
              world = new MockWorld(Date.now() - 12 * 60_000);
              world.advanceTo(virtualMs);
              firedPushed = world.fired.length;
              lastFlushSlot = Math.floor(virtualMs / FLUSH_MS);
              finished = world.done;
              finishedAt = undefined;
              replayHint = false;
              pushCard();
              break;
          }
          broadcastState();
        },
      },
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
  if (code === "EADDRINUSE") {
    console.error(
      `\u274c \u7aef\u53e3 ${PORT} \u5df2\u88ab\u5360\u7528\u2014\u2014\u5f88\u53ef\u80fd\u5df2\u7ecf\u6709\u4e00\u4e2a preview:live \u5728\u8dd1\u3002\n` +
        `   \u76f4\u63a5\u6253\u5f00 http://localhost:${PORT} \u5373\u53ef\uff1b\n` +
        `   \u60f3\u6362\u7aef\u53e3\u91cd\u8dd1\uff1aPORT=8899 bun run preview:live\n` +
        `   \u60f3\u505c\u6389\u65e7\u7684\uff1apkill -f mock-live`,
    );
      process.exit(1);
    }
    throw err;
  }
})();

resetWorld();
setInterval(tick, TICK_MS);
console.log(`🎬 mock 回放中：http://localhost:${PORT}  （总时长 ${mmss(MOCK_DURATION_MS)}，默认 4×）`);

// ============ 页面（飞书卡片皮 + 事件流 / API 日志 + 播放控制） ============

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>looonger 飞书观察面 · mock live</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #f0f2f5; color: #1f2329;
         font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .page { max-width: 1180px; margin: 0 auto; padding: 20px 20px 60px; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
  .t { font-size: 17px; font-weight: 650; }
  .dim { color: #8f959e; font-weight: 400; font-size: 12px; }
  .pill { font-size: 12px; padding: 2px 10px; border-radius: 999px; color: #fff; }
  .pill.run { background: #34a853; } .pill.pause { background: #f2994a; } .pill.done { background: #3370ff; }
  .clock { font-variant-numeric: tabular-nums; color: #646a73; font-size: 13px; }
  .ctrls { margin-left: auto; display: flex; align-items: center; gap: 6px; }
  button { border: 1px solid #dee0e3; background: #fff; color: #1f2329; border-radius: 6px;
           padding: 4px 10px; font-size: 12px; cursor: pointer; }
  button:hover { border-color: #3370ff; color: #3370ff; }
  button.on { background: #3370ff; border-color: #3370ff; color: #fff; }
  .banner { background: #fef0f0; color: #d83931; border: 1px solid #fde2e2; border-radius: 8px;
            padding: 9px 14px; margin-bottom: 12px; font-size: 13px; }
  .banner.hidden { display: none; }
  .progress { height: 3px; background: #e4e6eb; border-radius: 2px; margin-bottom: 18px; overflow: hidden; }
  .progress i { display: block; height: 100%; width: 0; background: #3370ff; transition: width .2s; }
  main { display: grid; grid-template-columns: minmax(460px, 640px) 1fr; gap: 20px; align-items: start; }
  @media (max-width: 940px) { main { grid-template-columns: 1fr; } }
  .cardbox { position: sticky; top: 16px; }
  .card { background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 12px rgba(31,35,41,.10); }
  .chead { background: #eff3fa; color: #1f2329; padding: 11px 16px; border-bottom: 1px solid #e4e8ef;
           display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .ctitle { font-weight: 600; font-size: 14px; line-height: 1.4; }
  .csum { font-size: 11px; color: #8f959e; white-space: nowrap; }
  .cbody { padding: 16px 18px 14px; font-size: 13.5px; line-height: 1.55; }
  .ln { min-height: 1.55em; }
  .ln.blank { min-height: .7em; }
  .ln.hero { font-size: 18px; line-height: 1.35; margin: 0 0 2px; letter-spacing: .01em; }
  .ln.head { font-weight: 650; line-height: 1.3; margin: 0 0 4px; letter-spacing: .01em; }
  .ln.head.h1 { font-size: 24px; } .ln.head.h2 { font-size: 21px; } .ln.head.h3 { font-size: 19px; }
  .ln.head.h4 { font-size: 17px; } .ln.head.h5 { font-size: 16px; } .ln.head.h6 { font-size: 14px; }
  .ln.rail { padding-left: 13px; }
  .ln.quote { margin: 2px 0 10px; padding: 7px 12px; background: #f4f7ff; border-left: 3px solid #3370ff;
              border-radius: 0 8px 8px 0; color: #1f2329; }
  .ln.rule { min-height: 0; height: 0; border-top: 1px solid #e8eaed; margin: 10px 0 8px; }
  .ln.sect { font-size: 11.5px; color: #8f959e; letter-spacing: .16em; margin: 10px 0 2px; }
  .ln.flow { padding: 1px 0 1px 2px; }
  .ln strong { font-weight: 650; }
  .ln code { background: rgba(31,35,41,.06); border-radius: 3px; padding: 1px 5px;
             font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 12px; color: #d83931; }
  .ln.new { animation: slidein .35s ease; }
  .ln.chg { animation: hl .7s ease; }
  @keyframes slidein { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  @keyframes hl { 0% { background: rgba(51,112,255,.14); } 100% { background: transparent; } }
  .foot { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; color: #8f959e;
          padding: 8px 4px 0; font-variant-numeric: tabular-nums; }
  .jumps { padding: 10px 4px 0; font-size: 12px; color: #646a73; display: flex; gap: 6px; align-items: center; }
  aside { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  .panel { background: #fff; border-radius: 10px; box-shadow: 0 2px 12px rgba(31,35,41,.08); overflow: hidden; }
  .panel h2 { margin: 0; font-size: 13px; padding: 10px 14px; border-bottom: 1px solid #eff0f1; font-weight: 650; }
  .log { height: 300px; overflow-y: auto; padding: 8px 14px; font-size: 12.5px; }
  .log .row { padding: 3px 0; border-bottom: 1px dashed #f2f3f5; display: flex; gap: 8px; }
  .log .row:last-child { border-bottom: 0; }
  .log .tm { color: #8f959e; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .log .ty { color: #3370ff; font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 11.5px; white-space: nowrap; }
  .log .nn { color: #1f2329; }
  .log .op { color: #d83931; font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 11px; word-break: break-all; }
  .log .dt { color: #646a73; }
  .tb { width: 100%; border-collapse: collapse; margin: 2px 0 8px; font-size: 12.5px; table-layout: auto; }
  .tb th { text-align: left; color: #646a73; font-weight: 600; padding: 4px 10px; background: #f5f6f7; white-space: nowrap; }
  .tb th:first-child { border-radius: 4px 0 0 4px; } .tb th:last-child { border-radius: 0 4px 4px 0; }
  .tb td { padding: 4px 10px; border-bottom: 1px solid #f2f3f5; color: #1f2329; vertical-align: top; }
  .tb tr:last-child td { border-bottom: 0; }
</style>
</head>
<body>
<div class="page">
  <header>
    <span class="t">looonger 飞书观察面 <span class="dim">· mock live（真实 ingest/render）</span></span>
    <span id="pill" class="pill run">运行中</span>
    <span id="clock" class="clock">00:00</span>
    <div class="ctrls">
      <button id="pp">⏸ 暂停</button>
      <button id="restart">↻ 重播</button>
      <span class="dim">倍速</span>
      <button class="spd" data-v="1">1×</button>
      <button class="spd on" data-v="4">4×</button>
      <button class="spd" data-v="16">16×</button>
    </div>
  </header>
  <div id="banner" class="banner hidden"></div>
  <div class="progress"><i id="bar"></i></div>
  <main>
    <section class="cardbox">
      <div class="card">
        <div class="chead"><span id="card-title" class="ctitle">连接中…</span><span class="csum">looonger 运行状态</span></div>
        <div id="card-body" class="cbody"></div>
      </div>
      <div class="foot"><span id="seq">sequence –</span><span>flush 2s（虚拟）· 局部刷新 · 只推变化的段</span><span id="els">已运行 0s</span></div>
      <div class="jumps">跳到：
        <button class="jmp" data-v="145000">① 流式中</button>
        <button class="jmp" data-v="200000">② 压缩中</button>
        <button class="jmp" data-v="312000">③ 完成</button>
      </div>
    </section>
    <aside>
      <div class="panel"><h2>事件流 <span class="dim">LooongerEvent → ingestStatus（状态机）</span></h2><div id="events" class="log"></div></div>
      <div class="panel"><h2>CardKit API <span class="dim">卡片传输（真实端点）</span></h2><div id="api" class="log"></div></div>
    </aside>
  </main>
</div>
<script>
  const ws = new WebSocket(location.protocol.replace(/^http/, "ws") + "//" + location.host + "/ws");
  const body = document.getElementById("card-body");
  const eventsEl = document.getElementById("events");
  const apiEl = document.getElementById("api");
  const pill = document.getElementById("pill");
  const bar = document.getElementById("bar");
  let prevLines = [];
  const DURATION = ${MOCK_DURATION_MS};

  const COLORS = { red: "#d83931", green: "#2ba471", blue: "#3370ff", orange: "#f2994a", purple: "#8b5cd6", grey: "#8f959e" };
  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function inline(s) {
    return esc(s)
      .replace(/&lt;font color='([a-z]+)'&gt;/g, function (m, c) { return '<span style="color:' + (COLORS[c] || "#1f2329") + '">'; })
      .replace(/&lt;\\/font&gt;/g, "</span>")
      .replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
      .replace(/\`([^\`]+)\`/g, "<code>$1</code>");
  }
  function renderCard(md) {
    const next = md.split("\\n");
    body.innerHTML = "";
    let table = null;
    const flushTable = function () { if (table !== null) { body.appendChild(table); table = null; } };
    next.forEach(function (line, i) {
      if (line.indexOf("|") === 0) {
        if (/^\\|\\s*-+/.test(line)) return; // 表格分隔行不进 DOM
        if (table === null) { table = document.createElement("table"); table.className = "tb"; }
        const cells = line.slice(1, -1).split("|").map(function (c) { return c.trim(); });
        const tr = document.createElement("tr");
        const head = table.childElementCount === 0;
        cells.forEach(function (c) {
          const cell = document.createElement(head ? "th" : "td");
          cell.innerHTML = inline(c);
          tr.appendChild(cell);
        });
        table.appendChild(tr);
        return;
      }
      flushTable();
      const div = document.createElement("div");
      const hm = /^(#{1,6})\\s+/.exec(line);
      const quoted = line.indexOf("> ") === 0;
      const rule = line === "---" || line === "<hr>";
      const flow = line.indexOf("─▶") !== -1;
      const rail = !flow && /^(│|▼|<font color='grey'>│)/.test(line);
      const sect = !quoted && !rule && !hm && line.indexOf("**") === 0 && line.lastIndexOf("**") === line.length - 2;
      var cls = "ln";
      if (hm) cls += " head h" + hm[1].length;
      if (line.length === 0) cls += " blank";
      if (quoted) cls += " quote";
      if (rule) cls += " rule";
      if (flow) cls += " flow";
      if (rail) cls += " rail";
      if (sect) cls += " sect";
      div.className = cls;
      if (prevLines[i] === undefined) div.classList.add("new");
      else if (prevLines[i] !== line) div.classList.add("chg");
      const shown = hm ? line.slice(hm[0].length) : quoted ? line.slice(2) : line;
      div.innerHTML = line.length === 0 || rule ? "&nbsp;" : inline(shown);
      body.appendChild(div);
    });
    flushTable();
    prevLines = next;
  }
  function appendLog(el, cells, cap) {
    const row = document.createElement("div");
    row.className = "row";
    cells.forEach(function (c) {
      const s = document.createElement("span");
      s.textContent = c.text;
      s.className = c.cls;
      row.appendChild(s);
    });
    el.appendChild(row);
    while (el.childElementCount > cap) el.removeChild(el.firstElementChild);
    el.scrollTop = el.scrollHeight;
  }
  ws.onmessage = function (e) {
    const m = JSON.parse(e.data);
    if (m.t === "card") {
      renderCard(m.md);
      document.getElementById("card-title").textContent = m.title;
      document.getElementById("seq").textContent = m.pushed && m.pushed.length
        ? "sequence " + m.seq + " · 推送 " + m.pushed.join(" + ")
        : "sequence " + m.seq + " · 无变化";
    } else if (m.t === "event") {
      appendLog(eventsEl, [{ text: m.at, cls: "tm" }, { text: m.type, cls: "ty" }, { text: m.note, cls: "nn" }], 160);
    } else if (m.t === "api") {
      appendLog(apiEl, [{ text: m.op, cls: "op" }, { text: m.detail, cls: "dt" }], 160);
    } else if (m.t === "state") {
      pill.textContent = m.paused ? "已暂停" : m.finished ? (m.replayHint ? "已完成 · 即将重播" : "已完成") : "运行中";
      pill.className = "pill " + (m.paused ? "pause" : m.finished ? "done" : "run");
      document.getElementById("clock").textContent = m.clock;
      document.getElementById("els").textContent = "已运行 " + Math.floor(m.vms / 1000) + "s";
      bar.style.width = Math.min(100, (m.vms / DURATION) * 100) + "%";
      document.querySelectorAll(".spd").forEach(function (b) {
        b.classList.toggle("on", Number(b.dataset.v) === m.speed);
      });
      document.getElementById("pp").textContent = m.paused ? "▶ 继续" : "⏸ 暂停";
    }
  };
  var opened = false;
  var banner = document.getElementById("banner");
  function showBanner(text) {
    banner.textContent = text;
    banner.className = "banner";
  }
  ws.onopen = function () { opened = true; banner.className = "banner hidden"; };
  ws.onerror = function () {
    showBanner("\u26a0\ufe0f \u8fde\u4e0d\u4e0a ws://" + location.host + "/ws \u2014\u2014 \u8bf7\u786e\u8ba4\u7ec8\u7aef\u91cc\u8fd0\u884c\u7740 bun run preview:live \u6b63\u5728\u8fd0\u884c\uff08\u670d\u52a1\u542f\u52a8\u540e\u5237\u65b0\u672c\u9875\uff09");
  };
  ws.onclose = function () {
    if (opened) { setTimeout(function () { location.reload(); }, 800); return; }
    showBanner("\u26a0\ufe0f \u8fde\u63a5\u4e2d\u65ad\uff08\u670d\u52a1\u53ef\u80fd\u5df2\u505c\u6b62\uff09\u2014\u2014 \u5728\u9879\u76ee\u76ee\u5f55\u8fd0\u884c bun run preview:live \u540e\u5237\u65b0\u672c\u9875\uff1b3s \u540e\u81ea\u52a8\u91cd\u8bd5\u2026");
    setTimeout(function () { location.reload(); }, 3000);
  };
  function send(o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }
  document.getElementById("pp").onclick = function () {
    send({ type: pill.classList.contains("pause") ? "resume" : "pause" });
  };
  document.getElementById("restart").onclick = function () { send({ type: "restart" }); };
  document.querySelectorAll(".spd").forEach(function (b) {
    b.onclick = function () { send({ type: "speed", value: Number(b.dataset.v) }); };
  });
  document.querySelectorAll(".jmp").forEach(function (b) {
    b.onclick = function () { send({ type: "jump", value: Number(b.dataset.v) }); };
  });
</script>
</body>
</html>
`;

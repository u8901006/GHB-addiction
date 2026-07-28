import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const API_BASE = process.env.NVIDIA_API_BASE || "https://integrate.api.nvidia.com/v1";
const MODELS = ["nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3-nano-30b-a3b"];
const TIMEOUT_MS = 480_000;

const SYSTEM_PROMPT = `你是 GHB（gamma-hydroxybutyrate）成癮研究領域的資深研究員與科學傳播者。你的任務是：
1. 從提供的醫學文獻中，篩選出最具臨床意義與研究價值的 GHB 相關論文
2. 對每篇論文進行繁體中文摘要、分類、PICO 分析
3. 評估其臨床實用性（高/中/低）
4. 生成適合醫療專業人員閱讀的日報

輸出格式要求：
- 語言：繁體中文（台灣用語）
- 專業但易懂
- 每篇論文需包含：中文標題、一句話總結、PICO分析、臨床實用性、分類標籤
- 最後提供今日精選 TOP 3（最重要/最影響臨床實踐的論文）
回傳格式必須是純 JSON，不要用 markdown code block 包裹。`;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { input: "papers.json", output: "docs/ghb-report.html" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input") opts.input = args[++i];
    else if (args[i] === "--output") opts.output = args[++i];
  }
  return opts;
}

function getDateStr() {
  const env = process.env.TARGET_DATE;
  if (env) return env;
  const d = new Date();
  d.setHours(d.getHours() + 8);
  return d.toISOString().slice(0, 10);
}

function extractJson(text) {
  if (text.startsWith("```")) {
    text = text.split("\n").slice(1).join("\n").replace(/```$/, "").trim();
  }
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    text = text.slice(jsonStart, jsonEnd + 1);
  }
  return JSON.parse(text);
}

async function callNvidia(apiKey, model, messages) {
  const resp = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 1.0,
      top_p: 0.95,
      max_tokens: 16384,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

async function analyzePapers(apiKey, papersData) {
  const dateStr = papersData.date || getDateStr();
  const papersText = JSON.stringify(papersData.papers || [], null, 2);

  const prompt = `以下是 ${dateStr} 從 PubMed 抓取的最新 GHB（gamma-hydroxybutyrate）成癮相關文獻（共 ${papersData.count} 篇）。

請進行以下分析，並以 JSON 格式回傳（不要用 markdown code block）：

{
  "date": "${dateStr}",
  "market_summary": "1-2句話總結今天文獻的整體趨勢與亮點",
  "top_picks": [
    {
      "rank": 1,
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結（繁體中文，點出核心發現與臨床意義）",
      "pico": {
        "population": "研究對象",
        "intervention": "介入措施",
        "comparison": "對照組",
        "outcome": "主要結果"
      },
      "clinical_utility": "高/中/低",
      "utility_reason": "為什麼實用的一句話說明",
      "tags": ["標籤1", "標籤2"],
      "url": "原文連結",
      "emoji": "相關emoji"
    }
  ],
  "all_papers": [
    {
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結",
      "clinical_utility": "高/中/低",
      "tags": ["標籤1"],
      "url": "連結",
      "emoji": "emoji"
    }
  ],
  "keywords": ["關鍵字1", "關鍵字2"],
  "topic_distribution": {
    "GHB戒斷": 3,
    "化學性行為": 2
  }
}

原始文獻資料：
${papersText}

請篩選出最重要的 TOP 5-8 篇論文放入 top_picks（按重要性排序），其餘放入 all_papers。
每篇 paper 的 tags 請從以下選擇：GHB成癮、GHB戒斷、GHB中毒、化學性行為(chemsex)、GHB神經生物學、GHB藥理學、GHB治療、減害策略、急診醫學、毒理學、GHB過量、多重物質使用、司法鑑識、藥物輔助性侵、政策與法規、社會學、GHB與HIV、睡眠醫學、流行病學、復發預防。
記住：回傳純 JSON，不要用 \`\`\`json\`\`\` 包裹。`;

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];

  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.error(`[INFO] Trying ${model} (attempt ${attempt + 1})...`);
        const text = await callNvidia(apiKey, model, messages);
        const result = extractJson(text);
        console.error(
          `[INFO] Analysis complete: ${result.top_picks?.length || 0} top picks, ${result.all_papers?.length || 0} total`
        );
        result._model = model;
        return result;
      } catch (e) {
        if (e.message.includes("429") || e.message.includes("rate")) {
          const wait = 60 * (attempt + 1);
          console.error(`[WARN] Rate limited, waiting ${wait}s...`);
          await new Promise((r) => setTimeout(r, wait * 1000));
          continue;
        }
        console.error(`[WARN] ${model} attempt ${attempt + 1} failed: ${e.message}`);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  console.error("[ERROR] All models and attempts failed");
  return null;
}

function escapeHtml(s) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generateHtml(analysis) {
  const dateStr = analysis.date || getDateStr();
  const dp = dateStr.split("-");
  const dateDisplay = dp.length === 3 ? `${dp[0]}年${parseInt(dp[1])}月${parseInt(dp[2])}日` : dateStr;
  const summary = escapeHtml(analysis.market_summary || "");
  const topPicks = analysis.top_picks || [];
  const allPapers = analysis.all_papers || [];
  const keywords = analysis.keywords || [];
  const topicDist = analysis.topic_distribution || {};
  const usedModel = analysis._model || MODELS[0];
  const totalCount = topPicks.length + allPapers.length;

  const topPicksHtml = topPicks
    .map((p) => {
      const tags = (p.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
      const util = p.clinical_utility || "中";
      const uClass = util === "高" ? "utility-high" : util === "中" ? "utility-mid" : "utility-low";
      const pico = p.pico || {};
      const picoHtml = pico.population
        ? `<div class="pico-grid">
          <div class="pico-item"><span class="pico-label">P</span><span class="pico-text">${escapeHtml(pico.population || "-")}</span></div>
          <div class="pico-item"><span class="pico-label">I</span><span class="pico-text">${escapeHtml(pico.intervention || "-")}</span></div>
          <div class="pico-item"><span class="pico-label">C</span><span class="pico-text">${escapeHtml(pico.comparison || "-")}</span></div>
          <div class="pico-item"><span class="pico-label">O</span><span class="pico-text">${escapeHtml(pico.outcome || "-")}</span></div>
        </div>`
        : "";
      return `<div class="news-card featured">
        <div class="card-header">
          <span class="rank-badge">#${p.rank || ""}</span>
          <span class="emoji-icon">${p.emoji || "📄"}</span>
          <span class="${uClass}">${escapeHtml(util)}實用性</span>
        </div>
        <h3>${escapeHtml(p.title_zh || p.title_en || "")}</h3>
        <p class="journal-source">${escapeHtml(p.journal || "")} &middot; ${escapeHtml(p.title_en || "")}</p>
        <p>${escapeHtml(p.summary || "")}</p>
        ${picoHtml}
        <div class="card-footer">
          ${tags}
          <a href="${escapeHtml(p.url || "#")}" target="_blank" rel="noopener">閱讀原文 →</a>
        </div>
      </div>`;
    })
    .join("\n");

  const allPapersHtml = allPapers
    .map((p) => {
      const tags = (p.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
      const util = p.clinical_utility || "中";
      const uClass = util === "高" ? "utility-high" : util === "中" ? "utility-mid" : "utility-low";
      return `<div class="news-card">
        <div class="card-header-row">
          <span class="emoji-sm">${p.emoji || "📄"}</span>
          <span class="${uClass} utility-sm">${escapeHtml(util)}</span>
        </div>
        <h3>${escapeHtml(p.title_zh || p.title_en || "")}</h3>
        <p class="journal-source">${escapeHtml(p.journal || "")}</p>
        <p>${escapeHtml(p.summary || "")}</p>
        <div class="card-footer">
          ${tags}
          <a href="${escapeHtml(p.url || "#")}" target="_blank" rel="noopener">PubMed →</a>
        </div>
      </div>`;
    })
    .join("\n");

  const keywordsHtml = keywords.map((k) => `<span class="keyword">${escapeHtml(k)}</span>`).join("");

  const maxCount = Math.max(...Object.values(topicDist), 1);
  const topicBarsHtml = Object.entries(topicDist)
    .map(
      ([topic, count]) => `<div class="topic-row">
        <span class="topic-name">${escapeHtml(topic)}</span>
        <div class="topic-bar-bg"><div class="topic-bar" style="width:${Math.round((count / maxCount) * 100)}%"></div></div>
        <span class="topic-count">${count}</span>
      </div>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>GHB Addiction Research &middot; GHB成癮研究文獻日報 &middot; ${dateDisplay}</title>
<meta name="description" content="${dateDisplay} GHB成癮研究文獻日報，由 AI 自動彙整 PubMed 最新論文"/>
<style>
  :root { --bg: #f6f1e8; --surface: #fffaf2; --line: #d8c5ab; --text: #2b2118; --muted: #766453; --accent: #8c4f2b; --accent-soft: #ead2bf; --card-bg: color-mix(in srgb, var(--surface) 92%, white); }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(circle at top, #fff6ea 0, var(--bg) 55%, #ead8c6 100%); color: var(--text); font-family: "Noto Sans TC", "PingFang TC", "Helvetica Neue", Arial, sans-serif; min-height: 100vh; overflow-x: hidden; }
  .container { position: relative; z-index: 1; max-width: 880px; margin: 0 auto; padding: 60px 32px 80px; }
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 52px; animation: fadeDown 0.6s ease both; }
  .logo { width: 48px; height: 48px; border-radius: 14px; background: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0; box-shadow: 0 4px 20px rgba(140,79,43,0.25); }
  .header-text h1 { font-size: 22px; font-weight: 700; color: var(--text); letter-spacing: -0.3px; }
  .header-meta { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; align-items: center; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; letter-spacing: 0.3px; }
  .badge-date { background: var(--accent-soft); border: 1px solid var(--line); color: var(--accent); }
  .badge-count { background: rgba(140,79,43,0.06); border: 1px solid var(--line); color: var(--muted); }
  .badge-source { background: transparent; color: var(--muted); font-size: 11px; padding: 0 4px; }
  .summary-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 28px 32px; margin-bottom: 32px; box-shadow: 0 20px 60px rgba(61,36,15,0.06); animation: fadeUp 0.5s ease 0.1s both; }
  .summary-card h2 { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.6px; color: var(--accent); margin-bottom: 16px; }
  .summary-text { font-size: 15px; line-height: 1.8; color: var(--text); }
  .section { margin-bottom: 36px; animation: fadeUp 0.5s ease both; }
  .section-title { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 700; color: var(--text); margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
  .section-icon { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; background: var(--accent-soft); }
  .news-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 22px 26px; margin-bottom: 12px; box-shadow: 0 8px 30px rgba(61,36,15,0.04); transition: background 0.2s, border-color 0.2s, transform 0.2s; }
  .news-card:hover { transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .news-card.featured { border-left: 3px solid var(--accent); }
  .news-card.featured:hover { border-color: var(--accent); }
  .card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .rank-badge { background: var(--accent); color: #fff7f0; font-weight: 700; font-size: 12px; padding: 2px 8px; border-radius: 6px; }
  .emoji-icon { font-size: 18px; }
  .card-header-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .emoji-sm { font-size: 14px; }
  .news-card h3 { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 8px; line-height: 1.5; }
  .journal-source { font-size: 12px; color: var(--accent); margin-bottom: 8px; opacity: 0.8; }
  .news-card p { font-size: 13.5px; line-height: 1.75; color: var(--muted); }
  .card-footer { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .tag { padding: 2px 9px; background: var(--accent-soft); border-radius: 999px; font-size: 11px; color: var(--accent); }
  .news-card a { font-size: 12px; color: var(--accent); text-decoration: none; opacity: 0.7; margin-left: auto; }
  .news-card a:hover { opacity: 1; }
  .utility-high { color: #5a7a3a; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(90,122,58,0.1); border-radius: 4px; }
  .utility-mid { color: #9f7a2e; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(159,122,46,0.1); border-radius: 4px; }
  .utility-low { color: var(--muted); font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(118,100,83,0.08); border-radius: 4px; }
  .utility-sm { font-size: 10px; }
  .pico-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; padding: 12px; background: rgba(255,253,249,0.8); border-radius: 14px; border: 1px solid var(--line); }
  .pico-item { display: flex; gap: 8px; align-items: baseline; }
  .pico-label { font-size: 10px; font-weight: 700; color: #fff7f0; background: var(--accent); padding: 2px 6px; border-radius: 4px; flex-shrink: 0; }
  .pico-text { font-size: 12px; color: var(--muted); line-height: 1.4; }
  .keywords-section { margin-bottom: 36px; }
  .keywords { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .keyword { padding: 5px 14px; background: var(--accent-soft); border: 1px solid var(--line); border-radius: 20px; font-size: 12px; color: var(--accent); cursor: default; transition: background 0.2s; }
  .keyword:hover { background: rgba(140,79,43,0.18); }
  .topic-section { margin-bottom: 36px; }
  .topic-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .topic-name { font-size: 13px; color: var(--muted); width: 120px; flex-shrink: 0; text-align: right; }
  .topic-bar-bg { flex: 1; height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
  .topic-bar { height: 100%; background: linear-gradient(90deg, var(--accent), #c47a4a); border-radius: 4px; transition: width 0.6s ease; }
  .topic-count { font-size: 12px; color: var(--accent); width: 24px; }
  .clinic-banner { margin-top: 48px; animation: fadeUp 0.5s ease 0.4s both; }
  .clinic-links { display: flex; flex-direction: column; gap: 10px; }
  .clinic-link { display: flex; align-items: center; gap: 14px; padding: 18px 24px; background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; text-decoration: none; color: var(--text); transition: all 0.2s; box-shadow: 0 8px 30px rgba(61,36,15,0.04); }
  .clinic-link:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .clinic-icon { font-size: 28px; flex-shrink: 0; }
  .clinic-name { font-size: 15px; font-weight: 700; color: var(--text); flex: 1; }
  .clinic-arrow { font-size: 18px; color: var(--accent); font-weight: 700; }
  footer { margin-top: 32px; padding-top: 22px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--muted); display: flex; justify-content: space-between; animation: fadeUp 0.5s ease 0.5s both; }
  footer a { color: var(--muted); text-decoration: none; }
  footer a:hover { color: var(--accent); }
  @keyframes fadeDown { from { opacity: 0; transform: translateY(-16px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  @media (max-width: 600px) { .container { padding: 36px 18px 60px; } .summary-card, .news-card { padding: 20px 18px; } .pico-grid { grid-template-columns: 1fr; } footer { flex-direction: column; gap: 6px; text-align: center; } .topic-name { width: 70px; font-size: 11px; } }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo">💊</div>
    <div class="header-text">
      <h1>GHB Addiction Research &middot; GHB成癮研究文獻日報</h1>
      <div class="header-meta">
        <span class="badge badge-date">📅 ${dateDisplay}</span>
        <span class="badge badge-count">📊 ${totalCount} 篇文獻</span>
        <span class="badge badge-source">Powered by PubMed + NVIDIA Nemotron</span>
      </div>
    </div>
  </header>

  <div class="summary-card">
    <h2>📋 今日文獻趨勢</h2>
    <p class="summary-text">${summary}</p>
  </div>

  ${topPicksHtml ? `<div class="section"><div class="section-title"><span class="section-icon">⭐</span>今日精選 TOP Picks</div>${topPicksHtml}</div>` : ""}

  ${allPapersHtml ? `<div class="section"><div class="section-title"><span class="section-icon">📚</span>其他值得關注的文獻</div>${allPapersHtml}</div>` : ""}

  ${topicBarsHtml ? `<div class="topic-section section"><div class="section-title"><span class="section-icon">📊</span>主題分佈</div>${topicBarsHtml}</div>` : ""}

  ${keywordsHtml ? `<div class="keywords-section section"><div class="section-title"><span class="section-icon">🏷️</span>關鍵字</div><div class="keywords">${keywordsHtml}</div></div>` : ""}

  <div class="clinic-banner">
    <div class="clinic-links">
      <a href="https://www.leepsyclinic.com/" class="clinic-link" target="_blank" rel="noopener">
        <span class="clinic-icon">🏥</span>
        <span class="clinic-name">李政洋身心診所首頁</span>
        <span class="clinic-arrow">→</span>
      </a>
      <a href="https://blog.leepsyclinic.com/" class="clinic-link" target="_blank" rel="noopener">
        <span class="clinic-icon">📬</span>
        <span class="clinic-name">訂閱電子報</span>
        <span class="clinic-arrow">→</span>
      </a>
      <a href="https://buymeacoffee.com/CYlee" class="clinic-link" target="_blank" rel="noopener">
        <span class="clinic-icon">☕</span>
        <span class="clinic-name">Buy Me a Coffee</span>
        <span class="clinic-arrow">→</span>
      </a>
    </div>
  </div>

  <footer>
    <span>資料來源：PubMed &middot; 分析模型：${usedModel}</span>
    <span><a href="https://github.com/u8901006/GHB-addiction">GitHub</a></span>
  </footer>
</div>
</body>
</html>`;
}

async function main() {
  const opts = parseArgs();
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    console.error("[ERROR] NVIDIA_API_KEY env var is required");
    process.exit(1);
  }

  const papersData = JSON.parse(readFileSync(opts.input, "utf-8"));
  let analysis;

  if (!papersData?.papers?.length) {
    console.error("[WARN] No papers found, generating empty report");
    analysis = {
      date: getDateStr(),
      market_summary: "今日 PubMed 暫無新的 GHB 成癮相關文獻更新。請明天再查看。",
      top_picks: [],
      all_papers: [],
      keywords: [],
      topic_distribution: {},
    };
  } else {
    analysis = await analyzePapers(apiKey, papersData);
    if (!analysis) {
      console.error("[ERROR] Analysis failed, cannot generate report");
      process.exit(1);
    }
  }

  const html = generateHtml(analysis);
  mkdirSync(dirname(resolve(opts.output)), { recursive: true });
  writeFileSync(opts.output, html, "utf-8");
  console.error(`[INFO] Report saved to ${opts.output}`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});

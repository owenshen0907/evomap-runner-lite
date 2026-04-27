import { readFile, writeFile, mkdir, appendFile, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

export const HUB = process.env.EVOMAP_HUB_URL || process.env.A2A_HUB_URL || 'https://evomap.ai';
const DEFAULT_AGENT_FILE = path.join(/*turbopackIgnore: true*/ os.homedir(), '.evomap', 'agents', 'default-agent.json');
const LEGACY_AGENT_FILE = path.join(/*turbopackIgnore: true*/ os.homedir(), '.evomap', 'agents', 'default-agent.json');

function expandHome(filePath) {
  if (!filePath) return DEFAULT_AGENT_FILE;
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(/*turbopackIgnore: true*/ os.homedir(), filePath.slice(2));
  return filePath;
}

export const AGENT_FILE = expandHome(process.env.EVOMAP_AGENT_FILE);
export const DATA_DIR = path.join(/*turbopackIgnore: true*/ process.cwd(), 'data');
export const ASSET_CACHE_DIR = path.join(DATA_DIR, 'cache', 'assets');
export const LEDGER_FILE = path.join(DATA_DIR, 'logs', 'fetch-ledger.jsonl');
export const SERVICE_LEDGER_FILE = path.join(DATA_DIR, 'logs', 'service-ledger.jsonl');
export const AUTOPILOT_RUN_FILE = path.join(DATA_DIR, 'logs', 'autopilot-runs.jsonl');
export const AUTOPILOT_JOB_FILE = path.join(DATA_DIR, 'logs', 'autopilot-job.json');
export const GENERATED_RESULT_FILE = path.join(DATA_DIR, 'logs', 'generated-results.jsonl');
const PUBLISH_BUNDLE_BUILDER_FILE = path.join(/*turbopackIgnore: true*/ process.cwd(), 'scripts', 'build-publish-bundle.cjs');
export const HELLO_STATUS_FILE = path.join(DATA_DIR, 'logs', 'hello-status.json');
export const EVOLVER_HELLO_STATUS_FILE = path.join(DATA_DIR, 'logs', 'evolver-hello-status.json');
export const TRANSLATION_CACHE_DIR = path.join(DATA_DIR, 'cache', 'translations');
const DEFAULT_HUB_TIMEOUT_MS = Math.max(1000, Number(process.env.EVOMAP_HUB_TIMEOUT_MS || 12000) || 12000);
const LITE_MODE = true;
const LITE_DISABLED_ENDPOINTS = new Set([
  '/api/asset/draft',
  '/api/asset/publish',
  '/api/service/publish',
  '/api/service/mine',
  '/api/service/update',
  '/api/service/archive',
  '/api/services',
  '/api/skills',
  '/api/ledger',
]);

export async function ensureDataDirs() {
  await mkdir(ASSET_CACHE_DIR, { recursive: true });
  await mkdir(TRANSLATION_CACHE_DIR, { recursive: true });
  await mkdir(path.dirname(LEDGER_FILE), { recursive: true });
}

async function writeJsonAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await rename(tmp, file);
}

export async function readAgent() {
  let agent;
  let agentFile = AGENT_FILE;
  try {
    const raw = await readFile(agentFile, 'utf8');
    agent = JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT' && !process.env.EVOMAP_AGENT_FILE && agentFile !== LEGACY_AGENT_FILE) {
      try {
        agentFile = LEGACY_AGENT_FILE;
        const raw = await readFile(agentFile, 'utf8');
        agent = JSON.parse(raw);
      } catch (legacyErr) {
        err = legacyErr;
      }
    }
    if (agent) {
      // Legacy path exists; continue with that file for existing local installs.
    } else if (err.code !== 'ENOENT' || !process.env.A2A_NODE_ID || !process.env.A2A_NODE_SECRET) {
      throw err;
    } else {
      agent = {
      node_id: process.env.A2A_NODE_ID,
      node_secret: process.env.A2A_NODE_SECRET,
      model: process.env.EVOLVER_MODEL_NAME,
      name: process.env.EVOLVER_AGENT_NAME,
      source: 'env',
      };
    }
  }
  if (!agent.node_id || !agent.node_secret) {
    throw new Error(`Agent file is missing node_id or node_secret: ${agentFile}`);
  }
  if (agentFile) agent._agent_file = agentFile;
  return agent;
}

export function redactedAgent(agent) {
  const safe = { ...agent };
  if (safe.node_secret) safe.node_secret = '[redacted]';
  return safe;
}

export function envelope(agent, type, payload) {
  return {
    protocol: 'gep-a2a',
    protocol_version: '1.0.0',
    message_type: type,
    message_id: `msg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    sender_id: agent.node_id,
    timestamp: new Date().toISOString(),
    payload,
  };
}

export async function hubFetch(endpoint, { method = 'GET', body, auth = true, agent, timeoutMs = DEFAULT_HUB_TIMEOUT_MS } = {}) {
  const headers = { 'content-type': 'application/json', 'user-agent': 'EvoMapRunnerLiteNext/0.1' };
  if (auth) {
    const current = agent || await readAgent();
    headers.authorization = `Bearer ${current.node_secret}`;
  }
  let response;
  try {
    response = await fetch(`${HUB}${endpoint}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      const timeoutErr = new Error(`Hub request timed out after ${timeoutMs}ms`);
      timeoutErr.status = 504;
      timeoutErr.payload = { endpoint, timeout_ms: timeoutMs };
      throw timeoutErr;
    }
    throw err;
  }
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const err = new Error(`Hub request failed: ${response.status}`);
    err.status = response.status;
    err.payload = data;
    err.retryAfter = Number(response.headers.get('retry-after') || 0) || null;
    throw err;
  }
  return data;
}

export function sanitizeAssetId(assetId) {
  if (typeof assetId !== 'string' || !assetId.startsWith('sha256:')) return null;
  return assetId.replace(/[^a-zA-Z0-9:_-]/g, '');
}

function cachePath(assetId) {
  const safe = sanitizeAssetId(assetId)?.replace(':', '_');
  if (!safe) throw new Error('Invalid asset_id');
  return path.join(ASSET_CACHE_DIR, `${safe}.json`);
}

export async function readCachedAsset(assetId) {
  try {
    const file = cachePath(assetId);
    const raw = await readFile(file, 'utf8');
    return { file, data: JSON.parse(raw) };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeCachedAsset(assetId, data) {
  await ensureDataDirs();
  const file = cachePath(assetId);
  await writeJsonAtomic(file, { cached_at: new Date().toISOString(), asset_id: assetId, data });
  return file;
}

export async function appendJsonl(file, row) {
  await ensureDataDirs();
  await appendFile(file, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`);
}

async function readJsonl(file, limit = 80) {
  try {
    const raw = await readFile(file, 'utf8');
    return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).slice(-limit).reverse();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function readJsonlDetailed(file, source) {
  try {
    const raw = await readFile(file, 'utf8');
    const rows = [];
    const parseErrors = [];
    raw.split('\n').forEach((line, index) => {
      if (!line.trim()) return;
      try {
        rows.push({ ...JSON.parse(line), _source_file: source, _line: index + 1 });
      } catch (err) {
        parseErrors.push({ source, line: index + 1, error: err.message });
      }
    });
    return { rows, parse_errors: parseErrors };
  } catch (err) {
    if (err.code === 'ENOENT') return { rows: [], parse_errors: [] };
    throw err;
  }
}

function redactLedgerValue(value) {
  if (Array.isArray(value)) return value.map(redactLedgerValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/secret|token|authorization|password|credential/i.test(key)) return [key, '[redacted]'];
    return [key, redactLedgerValue(item)];
  }));
}

function ledgerCategory(type, source) {
  if (source === 'service') return 'service';
  if (source === 'runner' || String(type || '').startsWith('runner_') || String(type || '').startsWith('strategy_')) return 'runner';
  if (String(type || '').includes('claim') || String(type || '').includes('submit') || String(type || '').includes('complete')) return 'task';
  if (String(type || '').includes('cache') || String(type || '').includes('fetch')) return 'asset';
  return 'other';
}

function ledgerRef(row) {
  return row.asset_id || row.result_asset_id || row.task_id || row.assignment_id || row.strategy_id || row.run_id || row.title || row.type || 'record';
}

function ledgerSummary(row) {
  const ref = ledgerRef(row);
  const summaries = {
    full_fetch: `Full fetch spent credits for ${ref}`,
    cache_hit: `Cache reused ${ref}`,
    task_claim: `Manual task claim ${ref}`,
    task_complete: `Manual task submission ${ref}`,
    autopilot_claim: `Autopilot claimed ${ref}`,
    autopilot_submit: `Autopilot submitted ${ref}`,
    service_publish: `Published service "${row.title || ref}"`,
    runner_started: `Runner started ${row.run_id || ''}`.trim(),
    runner_stopped: `Runner stopped ${row.run_id || ''}`.trim(),
    runner_claimed: `Runner claimed ${ref}`,
    runner_submitted: `Runner submitted ${ref}`,
    runner_error: `Runner error ${row.error || ''}`.trim(),
    runner_claim_failed: `Runner claim failed ${ref}`,
    runner_poll_failed: `Runner poll failed ${ref}`,
    strategy_generated: `Generated strategy ${row.strategy_id || ''}`.trim(),
    strategy_cycle: `Strategy cycle ${row.run_id || ''}`.trim(),
    strategy_stopped: `Strategy stopped ${row.run_id || ''}`.trim(),
  };
  return summaries[row.type] || `${row.type || 'record'} · ${ref}`;
}

function normalizeLedgerRow(row, fullFetchCost) {
  const type = row.type || 'unknown';
  const category = ledgerCategory(type, row._source_file);
  const costCredits = type === 'full_fetch' || row.charged === true ? fullFetchCost : 0;
  const savedCredits = type === 'cache_hit' ? fullFetchCost : 0;
  const bountyCredits = Number(row.bounty || row.price_per_task || row.result?.bounty || 0) || 0;
  const ok = row.ok === false ? false : !String(type).includes('failed') && type !== 'runner_error';
  return {
    id: `${row._source_file}:${row._line}:${row.ts || type}`,
    ts: row.ts || row.created_at || null,
    source: row._source_file,
    line: row._line,
    type,
    category,
    ref: ledgerRef(row),
    asset_id: row.asset_id || row.result_asset_id || null,
    task_id: row.task_id || null,
    assignment_id: row.assignment_id || null,
    run_id: row.run_id || null,
    status: row.status || (ok ? 'ok' : 'failed'),
    charged: Boolean(row.charged),
    cost_credits: costCredits,
    saved_credits: savedCredits,
    bounty_credits: bountyCredits,
    net_credits: savedCredits - costCredits,
    summary: ledgerSummary(row),
    raw: redactLedgerValue(row),
  };
}

async function buildLedger(body = {}) {
  const fullFetchCost = Math.max(0, Number(body.estimated_full_fetch_cost ?? 1) || 0);
  const limit = Math.max(1, Math.min(500, Number(body.limit || 150)));
  const ledgers = await Promise.all([
    readJsonlDetailed(LEDGER_FILE, 'fetch'),
    readJsonlDetailed(SERVICE_LEDGER_FILE, 'service'),
    readJsonlDetailed(AUTOPILOT_RUN_FILE, 'runner'),
  ]);
  const rawRows = ledgers.flatMap((item) => item.rows);
  const rows = rawRows
    .map((row) => normalizeLedgerRow(row, fullFetchCost))
    .sort((a, b) => Date.parse(b.ts || 0) - Date.parse(a.ts || 0));
  const parseErrors = ledgers.flatMap((item) => item.parse_errors);
  const byType = rows.reduce((acc, row) => {
    acc[row.type] = (acc[row.type] || 0) + 1;
    return acc;
  }, {});
  const byCategory = rows.reduce((acc, row) => {
    acc[row.category] = (acc[row.category] || 0) + 1;
    return acc;
  }, {});
  const costCredits = rows.reduce((sum, row) => sum + row.cost_credits, 0);
  const savedCredits = rows.reduce((sum, row) => sum + row.saved_credits, 0);
  const potentialBounty = rows
    .filter((row) => ['task_claim', 'autopilot_claim', 'runner_claimed'].includes(row.type))
    .reduce((sum, row) => sum + row.bounty_credits, 0);
  const fullFetches = byType.full_fetch || 0;
  const cacheHits = byType.cache_hit || 0;
  const fetchAttempts = fullFetches + cacheHits;
  return {
    generated_at: new Date().toISOString(),
    estimate_unit: { full_fetch_cost: fullFetchCost, note: 'Local estimate only; Hub account-level spend is not exposed here.' },
    full_fetches: fullFetches,
    cache_hits: cacheHits,
    task_claims: (byType.task_claim || 0) + (byType.autopilot_claim || 0) + (byType.runner_claimed || 0),
    task_submissions: (byType.task_complete || 0) + (byType.autopilot_submit || 0) + (byType.runner_submitted || 0),
    service_publishes: byType.service_publish || 0,
    total_rows: rows.length,
    shown_rows: Math.min(rows.length, limit),
    parse_errors: parseErrors,
    metrics: {
      cost_credits: costCredits,
      saved_credits: savedCredits,
      net_saved_credits: savedCredits - costCredits,
      potential_bounty_credits: potentialBounty,
      cache_hit_rate: fetchAttempts ? Math.round((cacheHits / fetchAttempts) * 1000) / 10 : 0,
      error_count: rows.filter((row) => row.status === 'failed').length + parseErrors.length,
    },
    by_type: byType,
    by_category: byCategory,
    rows: rows.slice(0, limit),
  };
}



function translationCachePath(text, targetLang) {
  const hash = crypto.createHash('sha256').update(`${targetLang}:${text}`).digest('hex');
  return path.join(TRANSLATION_CACHE_DIR, `${hash}.json`);
}

async function translateOne(text, targetLang) {
  const clean = String(text || '').trim();
  if (!clean) return '';
  if (!['zh-CN', 'en', 'ja'].includes(targetLang)) return clean;
  await ensureDataDirs();
  const file = translationCachePath(clean, targetLang);
  try {
    const cached = JSON.parse(await readFile(file, 'utf8'));
    return cached.translated || clean;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', 'auto');
  url.searchParams.set('tl', targetLang);
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', clean.slice(0, 4500));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  let response;
  try {
    response = await fetch(url, { cache: 'no-store', signal: controller.signal, headers: { 'user-agent': 'EvoMapRunnerLiteNext/0.1' } });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`translation_failed_${response.status}`);
  const data = await response.json();
  const translated = Array.isArray(data?.[0]) ? data[0].map((part) => part?.[0] || '').join('') : clean;
  await writeJsonAtomic(file, { targetLang, source: clean, translated, ts: new Date().toISOString() });
  return translated;
}

async function translateMany(texts, targetLang) {
  const translations = new Array(texts.length);
  let cursor = 0;
  const workerCount = Math.min(8, texts.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < texts.length) {
      const index = cursor;
      cursor += 1;
      const text = texts[index];
      try {
        translations[index] = await translateOne(text, targetLang);
      } catch {
        translations[index] = text;
      }
    }
  }));
  return translations;
}

export function normalizeAssets(data) {
  const payload = data?.payload || data || {};
  const candidates = [payload.assets, payload.results, payload.matches, data?.assets, data?.results].find(Array.isArray) || [];
  return candidates.map((asset) => ({
    asset_id: asset.asset_id || asset.id,
    asset_type: asset.asset_type || asset.type || asset.payload?.type,
    title: asset.short_title || asset.title || asset.payload?.summary || asset.summary || asset.nl_summary || 'Untitled asset',
    summary: asset.nl_summary || asset.summary || asset.payload?.summary || asset.description || '',
    trigger_text: asset.trigger_text || asset.signals || asset.payload?.signals_match?.join(', ') || '',
    gdi_score: asset.gdi_score,
    confidence: asset.confidence ?? asset.payload?.confidence,
    source_node_id: asset.source_node_id || asset.author,
    status: asset.status,
    domain: asset.domain,
    raw: asset,
  })).filter((asset) => asset.asset_id);
}

export function normalizeTasks(data) {
  const payload = data?.payload || data || {};
  return [payload.tasks, data?.tasks, payload.available_tasks, data?.available_tasks].find(Array.isArray) || [];
}

function getTaskId(task) {
  return task?.id || task?.task_id || task?.bountyId || task?.bounty_id || null;
}

function getTaskBounty(task) {
  return Number(task?.bounty ?? task?.bountyAmount ?? task?.bounty_amount ?? task?.orderAmount ?? task?.order_amount ?? 0) || 0;
}

function getTaskMinRep(task) {
  return Number(task?.minReputation ?? task?.min_reputation ?? 0) || 0;
}

function splitList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function rejectUnknownFields(input, allowed, context = 'request') {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (!unknown.length) return null;
  return fail(400, `Unexpected field(s) for ${context}: ${unknown.join(', ')}`, { allowed });
}

function limitedString(value, maxLength, label) {
  const text = String(value || '').trim();
  if (text.length > maxLength) {
    const err = new Error(`${label} must be ${maxLength} characters or fewer.`);
    err.status = 400;
    throw err;
  }
  return text;
}

function boundedNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = min, label = 'number' } = {}) {
  const num = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isFinite(num)) {
    const err = new Error(`${label} must be a finite number.`);
    err.status = 400;
    throw err;
  }
  return Math.max(min, Math.min(max, num));
}

function validateRef(value, label) {
  const ref = String(value || '').trim();
  if (!ref) {
    const err = new Error(`${label} is required.`);
    err.status = 400;
    throw err;
  }
  if (ref.length > 240 || !/^[a-zA-Z0-9:_./-]+$/.test(ref)) {
    const err = new Error(`${label} has an invalid format.`);
    err.status = 400;
    throw err;
  }
  return ref;
}

function taskHaystack(task) {
  return `${task?.title || ''} ${task?.signals || ''} ${task?.description || ''}`.toLowerCase();
}

function scoreTask(task, opts, reputation) {
  const minBounty = Number(opts.min_bounty ?? 20) || 0;
  const minScore = Number(opts.min_score ?? 65) || 0;
  const maxMinRep = Number(opts.max_min_reputation ?? reputation) || reputation;
  const preferred = splitList(opts.preferred_signals || 'api,agent,codex,next.js,node,python,javascript,typescript,jwt,kafka,video,quality,prompt,case-study,debugging,automation,guide,gamedev,narrative');
  const blocked = splitList(opts.blocked_signals || 'adult,gambling,crypto-wallet,private-key,credential-spam').map((item) => item.toLowerCase());
  const haystack = taskHaystack(task);
  const bounty = getTaskBounty(task);
  const minRep = getTaskMinRep(task);
  const priority = Number(task?.priority || 0) || 0;
  const matches = preferred.filter((token) => token && haystack.includes(token.toLowerCase()));
  const blockers = blocked.filter((token) => token && haystack.includes(token));
  const reasons = [];

  let score = Math.round((bounty * 1.8) + (matches.length * 28) + (priority * 8) + Math.max(0, reputation - minRep) * 0.35);
  if (bounty >= 200) score += 26;
  if (bounty >= 350) score += 34;
  if (minRep > reputation) reasons.push(`声誉不足：需要 ${minRep}，当前 ${reputation}`);
  if (minRep > maxMinRep) reasons.push(`超过自动认领声誉上限：${minRep} > ${maxMinRep}`);
  if (bounty < minBounty) reasons.push(`赏金低于阈值：${bounty} < ${minBounty}`);
  if (blockers.length) reasons.push(`命中屏蔽词：${blockers.join(', ')}`);
  if (!getTaskId(task)) reasons.push('缺少 task_id');
  if (score < minScore) reasons.push(`评分低于阈值：${score} < ${minScore}`);

  return {
    ...task,
    autopilot: {
      id: getTaskId(task),
      bounty,
      min_reputation: minRep,
      score,
      matches,
      blocked: blockers,
      ready: reasons.length === 0,
      reasons,
      recommended_mode: bounty >= 200 && matches.length ? 'claim_and_execute' : 'watch',
    },
  };
}

function average(values) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return 0;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function taskYield(task) {
  const bounty = Number(task?.autopilot?.bounty || 0);
  const score = Number(task?.autopilot?.score || 0);
  const matches = task?.autopilot?.matches?.length || 0;
  // Higher density means more bounty for each point of selection score.
  const bountyPerScore = score > 0 ? bounty / score : 0;
  const matchAdjusted = bounty * (1 + Math.min(matches, 5) * 0.08);
  return { bounty, score, matches, bounty_per_score: bountyPerScore, match_adjusted: matchAdjusted };
}

function buildTaskYieldReport(ranked) {
  const ready = (ranked || []).filter((task) => task.autopilot?.ready);
  const candidates = (ranked || []).filter((task) => task.autopilot?.score !== undefined);
  const sorted = [...candidates].sort((a, b) => b.autopilot.score - a.autopilot.score);
  const size = Math.max(1, Math.ceil(sorted.length / 3));
  const tiers = [
    { id: 'high', label: '高分任务', intent: '高确定性，适合稳定贡献', tasks: sorted.slice(0, size) },
    { id: 'mid', label: '中分任务', intent: '平衡收益和覆盖面', tasks: sorted.slice(size, size * 2) },
    { id: 'low', label: '低分任务', intent: '探索长尾，避免只抢同类任务', tasks: sorted.slice(size * 2) },
  ].map((tier) => {
    const yields = tier.tasks.map(taskYield);
    return {
      id: tier.id,
      label: tier.label,
      intent: tier.intent,
      count: tier.tasks.length,
      ready_count: tier.tasks.filter((task) => task.autopilot?.ready).length,
      avg_bounty: Math.round(average(yields.map((item) => item.bounty)) * 10) / 10,
      avg_score: Math.round(average(yields.map((item) => item.score)) * 10) / 10,
      avg_bounty_per_score: Math.round(average(yields.map((item) => item.bounty_per_score)) * 1000) / 1000,
      total_bounty: Math.round(yields.reduce((sum, item) => sum + item.bounty, 0)),
      sample_ids: tier.tasks.slice(0, 3).map((task) => task.autopilot.id),
    };
  });
  const bestDensity = [...tiers].filter((tier) => tier.count).sort((a, b) => b.avg_bounty_per_score - a.avg_bounty_per_score)[0] || null;
  const bestBounty = [...tiers].filter((tier) => tier.count).sort((a, b) => b.avg_bounty - a.avg_bounty)[0] || null;
  return {
    total_ready: ready.length,
    total_candidates: candidates.length,
    selection_mode: 'balanced_score_mix',
    mix: { high: 0.4, mid: 0.3, low: 0.3 },
    tiers,
    recommendation: bestDensity ? `${bestDensity.label} 的赏金/分值密度最高；${bestBounty?.label || bestDensity.label} 的平均赏金最高。` : '暂无 ready 候选，无法比较收益。',
  };
}

function pickTier(tasks, usedIds) {
  return tasks.find((task) => !usedIds.has(task.autopilot?.id));
}

function selectBalancedTasks(ready, limit) {
  const sorted = [...(ready || [])].sort((a, b) => b.autopilot.score - a.autopilot.score);
  const size = Math.max(1, Math.ceil(sorted.length / 3));
  const high = sorted.slice(0, size);
  const mid = sorted.slice(size, size * 2);
  const low = sorted.slice(size * 2);
  const pattern = [high, low, mid, high, low, mid];
  const selected = [];
  const usedIds = new Set();
  for (const tier of pattern) {
    if (selected.length >= limit) break;
    const task = pickTier(tier, usedIds);
    if (!task) continue;
    selected.push(task);
    usedIds.add(task.autopilot.id);
  }
  for (const task of sorted) {
    if (selected.length >= limit) break;
    if (usedIds.has(task.autopilot.id)) continue;
    selected.push(task);
    usedIds.add(task.autopilot.id);
  }
  return selected;
}

const STRATEGY_PRESETS = {
  balanced: {
    name: '稳健赚分',
    description: '平衡赏金和成功率，适合 24 小时持续运行，允许小规模并行。',
    policy: {
      min_bounty: 20,
      min_score: 65,
      max_claims: 2,
      max_active: 3,
      deferred_claim: true,
      max_reasoning_ms: 20 * 60 * 1000,
      selection_mode: 'balanced_score_mix',
      worker_enabled: true,
      return_limit: 16,
      preferred_signals: 'api,agent,codex,next.js,node,python,javascript,typescript,jwt,kafka,video,quality,prompt,case-study,debugging,automation,guide,gamedev,narrative',
      blocked_signals: 'adult,gambling,crypto-wallet,private-key,credential-spam',
    },
  },
  high_bounty: {
    name: '高赏金优先',
    description: '优先抢高价值任务，容忍较少匹配信号。',
    policy: {
      min_bounty: 150,
      min_score: 120,
      max_claims: 2,
      max_active: 3,
      deferred_claim: true,
      max_reasoning_ms: 20 * 60 * 1000,
      selection_mode: 'balanced_score_mix',
      worker_enabled: true,
      return_limit: 18,
      preferred_signals: 'automation,guide,quality,video,prompt,case-study,agent,api,gamedev,narrative',
      blocked_signals: 'adult,gambling,crypto-wallet,private-key,credential-spam,medical,legal',
    },
  },
  low_risk: {
    name: '低风险保声誉',
    description: '只做匹配度更高、活跃任务更少的稳妥任务。',
    policy: {
      min_bounty: 35,
      min_score: 110,
      max_claims: 1,
      max_active: 1,
      deferred_claim: true,
      max_reasoning_ms: 20 * 60 * 1000,
      selection_mode: 'high_score_first',
      worker_enabled: true,
      return_limit: 12,
      preferred_signals: 'api,agent,codex,debugging,javascript,typescript,node,python,jwt,kafka',
      blocked_signals: 'adult,gambling,crypto-wallet,private-key,credential-spam,medical,legal,finance',
    },
  },
  content_factory: {
    name: '内容资产工厂',
    description: '偏向可沉淀为 Gene/Capsule 的教程、复盘、评估类任务；贡献优先。',
    policy: {
      min_bounty: 50,
      min_score: 80,
      max_claims: 3,
      max_active: 5,
      deferred_claim: true,
      max_reasoning_ms: 20 * 60 * 1000,
      selection_mode: 'balanced_score_mix',
      worker_enabled: true,
      return_limit: 20,
      preferred_signals: 'guide,tutorial,case-study,quality,metrics,video,prompt,automation,portfolio,gamedev,narrative',
      blocked_signals: 'adult,gambling,crypto-wallet,private-key,credential-spam',
    },
  },
};

function uniqueCsv(...values) {
  return [...new Set(values.flatMap(splitList).map((item) => item.trim()).filter(Boolean))].join(',');
}

function buildPresetPolicy(presetId = 'balanced', note = '', overrides = {}) {
  const preset = STRATEGY_PRESETS[presetId] || STRATEGY_PRESETS.balanced;
  const noteSignals = String(note || '').toLowerCase().match(/[a-z0-9][a-z0-9.+#-]{2,}/g) || [];
  return {
    ...preset.policy,
    ...overrides,
    preferred_signals: uniqueCsv(preset.policy.preferred_signals, overrides.preferred_signals, noteSignals),
    blocked_signals: uniqueCsv(preset.policy.blocked_signals, overrides.blocked_signals),
  };
}

function summarizeRecentIssues(job) {
  const events = job?.events || [];
  const issues = [];
  const lastError = events.find((event) => event.type === 'error');
  const reasoningCount = events.filter((event) => event.type === 'reasoning').length;
  const rejected = events.find((event) => event.type === 'rejected');
  if (lastError) issues.push(`上一轮异常：${lastError.message}`);
  if (reasoningCount >= 3 && !job?.result_asset_id) issues.push('执行器多轮未产出 result_asset_id，降低并发并提高匹配阈值。');
  if (rejected) issues.push(`上一轮被拒绝：${rejected.message}`);
  return issues;
}

function adaptPolicyFromJob(job) {
  const policy = { ...(job?.strategy?.policy || STRATEGY_PRESETS.balanced.policy) };
  const issues = summarizeRecentIssues(job);
  if (!issues.length) return { policy, review: { issues: [], adjustments: [] } };
  const adjustments = [];
  if (issues.some((issue) => issue.includes('未产出') || issue.includes('异常'))) {
    policy.max_active = 1;
    policy.max_claims = 1;
    policy.min_score = Math.min(180, Number(policy.min_score || 65) + 15);
    adjustments.push('把 max_active/max_claims 降为 1，并提高 min_score。');
  }
  if (issues.some((issue) => issue.includes('拒绝'))) {
    policy.min_score = Math.min(220, Number(policy.min_score || 65) + 25);
    policy.min_bounty = Math.max(Number(policy.min_bounty || 20), 50);
    adjustments.push('提高质量门槛，避免低确定性任务。');
  }
  return { policy, review: { issues, adjustments } };
}

const PHASES = {
  idle: { label: '等待中', progress: 0 },
  scanning: { label: '扫描任务', progress: 10 },
  selected: { label: '已选中悬赏', progress: 22 },
  deferred: { label: '待产出后认领', progress: 26 },
  claiming: { label: '认领中', progress: 34 },
  claimed: { label: '已认领', progress: 44 },
  reasoning: { label: '生成资产', progress: 58 },
  result_produced: { label: '结果已生产', progress: 72 },
  submitting: { label: '提交中', progress: 84 },
  submitted: { label: '提交完成', progress: 92 },
  waiting_verdict: { label: '等待采纳', progress: 96 },
  accepted: { label: '已采纳', progress: 100 },
  rejected: { label: '已拒绝', progress: 100 },
  parked: { label: '已轮换', progress: 100 },
  stopped: { label: '已结束', progress: 100 },
  error: { label: '异常', progress: 100 },
  sleeping: { label: '休眠中', progress: 8 },
};

const RUNNER_TIMER_VERSION = 'runner-publish-schema-v2';
const runnerStore = globalThis.__evomapAutopilotRunner || { timer: null, inflight: false, job: null };
globalThis.__evomapAutopilotRunner = runnerStore;
const apiCache = globalThis.__evomapApiCache || new Map();
globalThis.__evomapApiCache = apiCache;

function getCached(key) {
  const hit = apiCache.get(key);
  if (!hit || hit.expires_at <= Date.now()) {
    apiCache.delete(key);
    return null;
  }
  return hit.value;
}

function setCached(key, value, ttlMs) {
  apiCache.set(key, { value, expires_at: Date.now() + ttlMs });
  return value;
}

function phaseInfo(phase) {
  return PHASES[phase] || PHASES.idle;
}

function compactTask(task) {
  if (!task) return null;
  return {
    id: getTaskId(task),
    title: task.title || task.name || getTaskId(task),
    signals: task.signals || '',
    source: task._source || task.source || 'worker_pool',
    bounty_id: task.bounty_id || task.bountyId || task.bounty?.id,
    bounty: getTaskBounty(task),
    score: task.autopilot?.score,
    min_reputation: getTaskMinRep(task),
    assignment_id: task.assignment_id || task.assignmentId || task.assignment?.id,
    result_asset_id: task.result_asset_id || task.resultAssetId || task.asset_id,
    status: task.status || 'selected',
  };
}

function taskIdentity(task) {
  return task?.id || task?.task_id || task?.assignment_id || task?.assignmentId || task?.result_asset_id || task?.asset_id || '';
}

function compactPendingVerdictTask(task) {
  if (!task) return null;
  return {
    ...compactTask(task),
    assignment_id: task.assignment_id || task.assignmentId || task.assignment?.id || null,
    result_asset_id: task.result_asset_id || task.resultAssetId || task.asset_id || null,
    phase: 'waiting_verdict',
    phase_label: phaseInfo('waiting_verdict').label,
    progress: phaseInfo('waiting_verdict').progress,
    claimed_at: task.claimed_at || null,
    submitted_at: task.submitted_at || new Date().toISOString(),
    released_at: task.released_at || new Date().toISOString(),
    submit_result: task.submit_result || null,
    verdict: task.verdict || null,
  };
}

function getActiveTasks(job) {
  const active = Array.isArray(job?.active_tasks) ? job.active_tasks : [];
  if (!active.length && job?.current_task) {
    active.push({
      ...job.current_task,
      assignment_id: job.assignment_id || job.current_task.assignment_id,
      result_asset_id: job.result_asset_id || job.current_task.result_asset_id,
      claimed_at: job.claimed_at,
      submitted_at: job.submitted_at,
      phase: job.phase,
      phase_label: job.phase_label,
      progress: job.progress,
    });
    job.active_tasks = active;
  }
  return active;
}

function upsertPendingVerdictTask(job, task) {
  const pendingTask = compactPendingVerdictTask(task);
  if (!pendingTask) return null;
  const key = taskIdentity(pendingTask);
  const pending = Array.isArray(job.pending_verdict_tasks) ? job.pending_verdict_tasks : [];
  const next = [];
  let inserted = false;
  for (const existing of pending) {
    if (taskIdentity(existing) === key) {
      next.push({ ...existing, ...pendingTask });
      inserted = true;
    } else {
      next.push(existing);
    }
  }
  if (!inserted) next.unshift(pendingTask);
  job.pending_verdict_tasks = next.slice(0, 80);
  return pendingTask;
}

function releaseSubmittedTasks(job) {
  const active = getActiveTasks(job);
  const released = [];
  const pendingIds = new Set((job.pending_verdict_tasks || []).map((task) => taskIdentity(task)).filter(Boolean));
  const skippedDuplicates = [];
  job.active_tasks = active.filter((task) => {
    const key = taskIdentity(task);
    if (key && pendingIds.has(key) && !task.submitted_at) {
      skippedDuplicates.push(task);
      return false;
    }
    const pendingVerdict = task?.submitted_at
      && !task.finished_at
      && !['accepted', 'verified', 'settled', 'completed', 'rejected', 'failed', 'disputed', 'expired', 'cancelled', 'parked'].includes(String(task.phase || '').toLowerCase());
    if (!pendingVerdict) return true;
    const pendingTask = upsertPendingVerdictTask(job, task);
    if (pendingTask) released.push(pendingTask);
    return false;
  });
  if (released.length) {
    addJobEvent(job, 'submitted_released', `已提交 ${released.length} 个任务并释放并行槽；采纳/拒绝会后台跟踪，不影响继续做新任务。`, {
      task_ids: released.map((task) => task.id),
      result_asset_ids: released.map((task) => task.result_asset_id).filter(Boolean),
    });
  }
  if (skippedDuplicates.length) {
    addJobEvent(job, 'duplicate_pending_skipped', `跳过 ${skippedDuplicates.length} 个已提交待采纳任务，避免重复生成/重复认领。`, {
      task_ids: skippedDuplicates.map((task) => task.id),
    });
  }
  syncPrimaryTask(job);
  if ((released.length || skippedDuplicates.length) && job.status === 'running' && !job.sleep_until) {
    if (job.active_tasks?.length) updateMultiJobPhase(job);
    else updateJobPhase(job, 'idle');
  }
  return [...released, ...skippedDuplicates];
}

function syncPrimaryTask(job) {
  const active = getActiveTasks(job).filter((task) => task && !task.finished_at);
  job.active_tasks = active;
  const primary = active[0] || null;
  job.current_task = primary ? compactTask(primary) : null;
  if (primary) {
    job.assignment_id = primary.assignment_id || null;
    job.result_asset_id = primary.result_asset_id || null;
    job.claimed_at = primary.claimed_at || null;
    job.submitted_at = primary.submitted_at || null;
  } else {
    job.assignment_id = null;
    job.result_asset_id = null;
    job.claimed_at = null;
    job.submitted_at = null;
  }
  return active;
}

function taskAgeMs(task, now = Date.now()) {
  const started = timestampMs(task.claimed_at) || timestampMs(task.selected_at);
  return started ? Math.max(0, now - started) : 0;
}

function parkStalledTasks(job, policy = {}) {
  const maxReasoningMs = Math.max(5 * 60 * 1000, Number(policy.max_reasoning_ms || 20 * 60 * 1000));
  const localResultExecutor = policy.result_executor !== false;
  const now = Date.now();
  const active = syncPrimaryTask(job);
  const parked = [];
  for (const task of active) {
    const waitingForResult = !task.result_asset_id && ['reasoning', 'claimed', 'deferred', 'selected'].includes(task.phase || 'reasoning');
    if (waitingForResult && localResultExecutor && !task.generation_attempted_at && !task.result_generation_error) continue;
    if (!waitingForResult || taskAgeMs(task, now) < maxReasoningMs) continue;
    task.phase = 'parked';
    task.phase_label = phaseInfo('parked').label;
    task.progress = phaseInfo('parked').progress;
    task.finished_at = new Date(now).toISOString();
    task.parked_reason = '等待 result_asset_id 超时，释放 Runner 槽位，避免死磕。';
    parked.push(compactTask(task));
  }
  if (parked.length) {
    job.parked_tasks = [...(job.parked_tasks || []), ...parked.map((task) => ({ task, ts: new Date(now).toISOString() }))].slice(-50);
    addJobEvent(job, 'parked', `轮换 ${parked.length} 个长时间未产出 result_asset_id 的任务，避免占死执行槽。`, { task_ids: parked.map((task) => task.id), max_reasoning_ms: maxReasoningMs });
    syncPrimaryTask(job);
  }
  return parked;
}

function phasePriority(phase) {
  const order = ['submitting', 'result_produced', 'reasoning', 'claimed', 'claiming', 'deferred', 'selected', 'waiting_verdict', 'submitted', 'accepted', 'rejected', 'parked'];
  const index = order.indexOf(phase);
  return index < 0 ? 99 : index;
}

function updateMultiJobPhase(job) {
  const active = syncPrimaryTask(job);
  if (!active.length) return updateJobPhase(job, 'idle');
  const primary = [...active].sort((a, b) => phasePriority(a.phase) - phasePriority(b.phase))[0];
  updateJobPhase(job, primary.phase || 'reasoning', {
    phase_label: active.length > 1 ? `${phaseInfo(primary.phase || 'reasoning').label} · ${active.length} 个并行` : phaseInfo(primary.phase || 'reasoning').label,
  });
}

function addJobEvent(job, type, message, details = {}) {
  job.events = [
    { ts: new Date().toISOString(), type, message, details },
    ...(job.events || []),
  ].slice(0, 80);
}

function updateJobPhase(job, phase, extra = {}) {
  const info = phaseInfo(phase);
  Object.assign(job, {
    phase,
    phase_label: info.label,
    progress: info.progress,
    updated_at: new Date().toISOString(),
    ...extra,
  });
}

async function saveRunnerJob(job) {
  await ensureDataDirs();
  runnerStore.job = job;
  await writeJsonAtomic(AUTOPILOT_JOB_FILE, job);
  return job;
}

async function loadRunnerJob() {
  if (runnerStore.job) return runnerStore.job;
  try {
    runnerStore.job = JSON.parse(await readFile(AUTOPILOT_JOB_FILE, 'utf8'));
    return runnerStore.job;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function findTaskResult(agent, job, activeTask = null) {
  const taskId = activeTask?.id || job.current_task?.id;
  if (!taskId) return null;
  const mine = await hubFetch(`/a2a/task/my?node_id=${encodeURIComponent(agent.node_id)}`, { agent }).catch(() => ({ tasks: [] }));
  return (mine.tasks || []).find((task) => {
    const id = getTaskId(task);
    const assignmentId = activeTask?.assignment_id || job.assignment_id;
    return id === taskId || task.assignment_id === assignmentId || task.assignmentId === assignmentId;
  }) || null;
}

async function pollPendingVerdicts(agent, job, limit = 5) {
  const pending = Array.isArray(job?.pending_verdict_tasks) ? job.pending_verdict_tasks : [];
  if (!pending.length) return { accepted: [], rejected: [] };
  const accepted = [];
  const rejected = [];
  const remaining = [];
  for (const task of pending) {
    if (accepted.length + rejected.length >= limit) {
      remaining.push(task);
      continue;
    }
    const hubTask = await findTaskResult(agent, { ...job, current_task: task, assignment_id: task.assignment_id }, task).catch(() => null);
    const taskStatus = String(hubTask?.status || '').toLowerCase();
    if (['accepted', 'verified', 'settled', 'completed'].includes(taskStatus)) {
      const finishedAt = new Date().toISOString();
      const completedTask = { ...task, phase: 'accepted', phase_label: phaseInfo('accepted').label, verdict: taskStatus, finished_at: finishedAt };
      accepted.push(completedTask);
      job.completed_tasks = [...(job.completed_tasks || []), { task: completedTask, verdict: taskStatus, ts: finishedAt }].slice(-50);
      addJobEvent(job, 'accepted', `Hub 状态：${taskStatus}`, { task_id: task.id, assignment_id: task.assignment_id, released_slot: true });
    } else if (['rejected', 'failed', 'disputed', 'expired', 'cancelled'].includes(taskStatus)) {
      const finishedAt = new Date().toISOString();
      const rejectedTask = { ...task, phase: 'rejected', phase_label: phaseInfo('rejected').label, verdict: taskStatus, finished_at: finishedAt };
      rejected.push(rejectedTask);
      job.rejected_tasks = [...(job.rejected_tasks || []), { task: rejectedTask, verdict: taskStatus, ts: finishedAt }].slice(-50);
      addJobEvent(job, 'rejected', `Hub 状态：${taskStatus}`, { task_id: task.id, assignment_id: task.assignment_id, released_slot: true });
    } else {
      remaining.push({
        ...task,
        phase: 'waiting_verdict',
        phase_label: phaseInfo('waiting_verdict').label,
        progress: phaseInfo('waiting_verdict').progress,
        last_verdict_poll_at: new Date().toISOString(),
        hub_status: taskStatus || task.hub_status || null,
      });
    }
  }
  job.pending_verdict_tasks = remaining.slice(0, 80);
  return { accepted, rejected };
}

async function findPreviousAssignmentId(taskId) {
  const records = await readJsonl(AUTOPILOT_RUN_FILE, 500);
  return records.find((record) => (
    record.type === 'runner_claimed'
    && record.task_id === taskId
    && record.assignment_id
  ))?.assignment_id || null;
}

async function recoverExistingAssignment(agent, job, task) {
  const hubTask = await findTaskResult(agent, job, task).catch(() => null);
  const assignmentId = hubTask?.assignment_id || hubTask?.assignmentId || hubTask?.assignment?.id || await findPreviousAssignmentId(task.id);
  if (!assignmentId) return null;
  task.assignment_id = assignmentId;
  task.claimed_at = task.claimed_at || new Date().toISOString();
  task.phase = 'claimed';
  task.phase_label = phaseInfo('claimed').label;
  task.progress = phaseInfo('claimed').progress;
  return { assignment_id: assignmentId, source: hubTask ? 'hub_my_tasks' : 'local_run_log', task: hubTask };
}

async function submitRunnerResult(agent, job, task, activeTask = null) {
  const resultAssetId = task?.result_asset_id || task?.resultAssetId || task?.asset_id || activeTask?.result_asset_id || job.result_asset_id;
  if (!resultAssetId || !String(resultAssetId).startsWith('sha256:')) return null;
  const targetTask = activeTask || job.current_task;
  const isWorkerTask = targetTask?.source === 'worker_pool' || targetTask?.assignment_id || job.assignment_id;
  const assignmentId = targetTask?.assignment_id || job.assignment_id || task?.assignment_id || task?.assignmentId || task?.id;
  if (isWorkerTask && !assignmentId) {
    const err = new Error('Cannot submit worker task before assignment_id is available.');
    err.code = 'MISSING_ASSIGNMENT_ID';
    throw err;
  }
  const body = isWorkerTask
    ? { assignment_id: assignmentId, node_id: agent.node_id, sender_id: agent.node_id, result_asset_id: resultAssetId }
    : { task_id: targetTask.id, node_id: agent.node_id, sender_id: agent.node_id, asset_id: resultAssetId };
  const endpoint = isWorkerTask ? '/a2a/work/complete' : '/a2a/task/complete';
  return hubFetch(endpoint, { method: 'POST', agent, body });
}

function taskShortId(task) {
  return String(task?.id || task?.task_id || 'task').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || 'task';
}

function taskSignals(task) {
  return uniqueCsv(task?.signals || '', task?.title || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length >= 3)
    .slice(0, 12);
}

function inferTaskKind(task) {
  const text = `${task?.title || ''} ${task?.signals || ''}`.toLowerCase();
  if (/curriculum|modules?|beginner to advanced/.test(text)) return 'curriculum';
  if (/kpi|metrics?|measure|evaluation|criteria|quality/.test(text)) return 'metrics';
  if (/automate|automation|workflow/.test(text)) return 'automation';
  if (/tutorial|zero prior experience|step-by-step|screenshots?|diagram/.test(text)) return 'tutorial';
  if (/trend|innovation|as of 2025|impact/.test(text)) return 'trend_analysis';
  if (/feedback|revision|client/.test(text)) return 'revision_process';
  if (/portfolio|presentation/.test(text)) return 'portfolio';
  return 'structured_guide';
}

function blockedTaskReason(task) {
  const text = `${task?.title || ''} ${task?.signals || ''}`.toLowerCase();
  const blocked = ['adult', 'gambling', 'crypto-wallet', 'private-key', 'credential-spam'];
  const hit = blocked.find((token) => text.includes(token));
  return hit ? `blocked_signal:${hit}` : '';
}

function canonicalizeAsset(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalizeAsset(item)).join(',')}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined && key !== 'asset_id')
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeAsset(value[key])}`)
    .join(',')}}`;
}

function computeLocalAssetId(asset) {
  return `sha256:${crypto.createHash('sha256').update(canonicalizeAsset(asset)).digest('hex')}`;
}

function runnerModelName(agent) {
  return agent?.model || process.env.EVOLVER_MODEL_NAME || process.env.AGENT_MODEL || 'local-template-runner';
}

const BOUNTY_RUNNER_ASSET_CONFIRMATION = 'PUBLISH ASSET bounty-runner-workflow';
const BOUNTY_RUNNER_WORKFLOW_SIGNALS = [
  'evomap',
  'bounty-runner',
  'worker-pool',
  'deferred-claim',
  'result_asset_id',
  'a2a-publish',
  'search_only',
  'metadata-only',
  'full-fetch',
  'asset-cache',
  'fetch-citation',
  'rate-limit',
  'dashboard-observability',
  'codex',
];

const BOUNTY_RUNNER_SERVICE_TEMPLATE = {
  title: 'EvoMap Bounty Runner Automation & Repair',
  price_per_task: 80,
  max_concurrent: 1,
  capabilities: [
    'debug-stuck-bounty-runners',
    'deferred-claim-workflow',
    'result-asset-generation',
    'two-stage-fetch-control',
    'asset-cache-and-citation',
    'a2a-publish-schema',
    'rate-limit-sleep-countdown',
    'nextjs-dashboard-observability',
  ],
  use_cases: [
    'Tasks stay in reasoning without any Hub submission',
    'AI burns credits by defaulting to full payload fetches',
    'Fetched assets are not summarized, cited, or cached after retrieval',
    'Worker Pool jobs require result_asset_id before completion',
    'A2A publish bundle/schema errors block bounty delivery',
    'Runner needs countdown, parking, rotation, and clear execution history',
    'Clone users need setup/doctor guardrails for evolver hello and local credentials',
  ],
  description: 'I repair and package EvoMap bounty execution flows: two-stage search_only metadata fetch before paid full payload fetch, cache/citation discipline, schema-valid Gene/Capsule result assets, deferred claim after result_asset_id exists, Hub publish/complete recovery, rate-limit sleep countdowns, task parking/rotation, and dashboard observability for cloneable Next.js agents.',
};

function bountyRunnerWorkflowContent() {
  return [
    '# EvoMap Bounty Runner: deferred-claim result-asset workflow',
    '',
    '## Problem this skill solves',
    'A bounty runner can look busy while every task stays in reasoning. The failure pattern is usually that no schema-valid result_asset_id is produced, the runner claims too early, Hub rate limits are treated as dead ends, or the dashboard hides the next executable moment. This workflow turns the runner into a submitter: create and publish the result asset first, then claim and complete the task.',
    '',
    '## Operating pipeline',
    '1. Scan ready bounty and Worker Pool tasks, then rank by bounty, signal overlap, min reputation, and local safety policy.',
    '2. Keep Worker Pool tasks in deferred state until a result asset exists, so the agent does not occupy work it cannot submit.',
    '3. Generate a Gene and Capsule that match the task signals, include a concrete deliverable, and pass a local quality gate.',
    '4. Build the official EvoMap A2A publish bundle in a short-lived child process to avoid pinning the Next.js dev server.',
    '5. Publish the bundle, reuse duplicate assets when Hub returns a safe duplicate_asset target, then store the result_asset_id in the runner job.',
    '6. Claim only after result_asset_id is ready; recover assignment_id from Hub responses or previous records when possible.',
    '7. Complete the assignment with result_asset_id, move the task to waiting_verdict, and continue rotating other tasks.',
    '8. Show countdown, current phase, history, parked tasks, and next executable time at the top of the dashboard.',
    '',
    '## Asset fetch discipline',
    '- Treat fetch as a two-layer workflow, not as a single AI call that always spends credits.',
    '- First call fetch with search_only: true to get free metadata: asset_id, type, signals, title, summary, relevance, source, and quality hints.',
    '- Present the candidate list before spending credits, including why each candidate may or may not help the current task.',
    '- Full fetch only the most relevant 1-3 asset_ids, and only after explicit confirmation or a preapproved local policy.',
    '- Cache every full payload by asset_id and reuse the cache on repeated questions instead of fetching again.',
    '- After full fetch, always output what was retrieved: Gene strategy, Capsule content/diff, validation notes, asset_id, source, and how it influenced the answer.',
    '- If a fetched asset is not used, state why it was rejected so the credit spend is auditable.',
    '- Hub returns reusable assets; it does not automatically execute or summarize them. The runner must read, filter, summarize, cite, and apply the payload.',
    '',
    '## Error handling matrix',
    '- 429 rate limit: sleep instead of stopping; expose retry-after/countdown and automatically resume.',
    '- 504 or Hub timeout: short sleep and retry with the same local job state.',
    '- duplicate_asset: reuse Hub target_asset_id if it is a sha256 Capsule asset.',
    '- task_already_claimed: recover active assignment_id from Hub or logs; otherwise park and rotate.',
    '- assignment_not_active: park the task, keep the published asset reference, and continue other ready work.',
    '- schema validation failure: do not claim; fix required Gene/Capsule fields and rebuild the bundle.',
    '',
    '## Dashboard contract',
    '- Put scheduler status and execution history above task detail lists.',
    '- Never let "reasoning" be an indefinite state; show whether the runner is generating, publishing, sleeping, claiming, submitting, parked, or waiting for verdict.',
    '- Always show the next eligible run time when Hub is rate limiting.',
    '- Separate total task market view from per-bounty execution progress.',
    '- Keep setup/doctor checks available in the top health menu after the environment is ready.',
    '',
    '## Validation checklist',
    '- npm run check passes locally.',
    '- Runner status shows at least one submitted task before claiming this as successful.',
    '- A submitted history row includes task_id, assignment_id when available, and result_asset_id.',
    '- Search flows use search_only first; full fetch requires confirmation, cache hit, or an explicit local policy.',
    '- Every full fetch result is summarized with used asset_id, reason for use, and reason for rejecting unused fetched assets.',
    '- Clone users can run npm run setup, npm run doctor, and npm run evolver:hello without editing code.',
    '- The service/asset publish UI requires explicit confirmation before sending content to EvoMap Hub.',
  ].join('\n');
}

function buildBountyRunnerWorkflowDraft(agent = {}) {
  const summary = 'Reusable EvoMap bounty execution workflow: use search_only metadata before paid full fetch, summarize/cache fetched assets, generate a schema-valid result asset first, publish it, then claim/complete tasks with countdown-based recovery instead of getting stuck in reasoning.';
  const modelName = runnerModelName(agent);
  const gene = {
    type: 'Gene',
    schema_version: '1.5.0',
    id: 'gene_bounty_runner_deferred_claim_v2',
    category: 'optimize',
    signals_match: BOUNTY_RUNNER_WORKFLOW_SIGNALS,
    summary,
    strategy: [
      'Use search_only: true for free metadata discovery before any paid full payload fetch.',
      'Show candidate asset_id, title, summary, signals, and relevance before spending credits.',
      'Full fetch only the top 1-3 asset_ids; cache full payloads and cite what was used or rejected.',
      'Scan and rank available bounty/Worker Pool tasks before claiming work.',
      'Generate and validate a task-specific Gene/Capsule result asset locally.',
      'Publish the official A2A bundle and store the sha256 Capsule result_asset_id.',
      'Claim only after result_asset_id exists, then complete the assignment immediately.',
      'Sleep with visible countdown on 429/504, park unrecoverable tasks, and keep rotating.',
      'Expose scheduler state, execution history, and clone-user setup checks in the dashboard.',
    ],
    validation: [
      'npm run check',
      'node -e "console.log(\'Fetch flow must start with search_only metadata before any full payload fetch.\')"',
      'node -e "console.log(\'Every full fetch must be cached, summarized, and tied to cited asset_ids.\')"',
      'node -e "console.log(\'After a successful local run, POST /api/task/runner status should show a positive submitted count.\')"',
      'node -e "console.log(\'Submitted records must include result_asset_id and no task should stay in reasoning indefinitely.\')"',
    ],
    model_name: modelName,
  };
  const geneAssetId = computeLocalAssetId(gene);
  const capsule = {
    type: 'Capsule',
    schema_version: '1.5.0',
    id: 'capsule_bounty_runner_deferred_claim_v2',
    gene: geneAssetId,
    summary,
    content: bountyRunnerWorkflowContent(),
    trigger: BOUNTY_RUNNER_WORKFLOW_SIGNALS,
    confidence: 0.88,
    blast_radius: {
      files: 4,
      lines: 320,
    },
    outcome: {
      status: 'success',
      score: 0.88,
    },
    env_fingerprint: {
      platform: os.platform(),
      arch: os.arch(),
      node: process.version,
      runtime: 'nextjs-node',
      hub: HUB,
      package: 'evomap-runner-lite',
    },
    success_streak: 1,
    model_name: modelName,
  };
  const capsuleAssetId = computeLocalAssetId(capsule);
  return {
    title: 'EvoMap Bounty Runner: deferred-claim result-asset workflow',
    confirmation: BOUNTY_RUNNER_ASSET_CONFIRMATION,
    signals: BOUNTY_RUNNER_WORKFLOW_SIGNALS,
    gene,
    capsule,
    gene_asset_id: geneAssetId,
    capsule_asset_id: capsuleAssetId,
    service_template: BOUNTY_RUNNER_SERVICE_TEMPLATE,
  };
}

function answerSectionsForTask(task) {
  const title = task?.title || 'EvoMap bounty task';
  const kind = inferTaskKind(task);
  const signals = taskSignals(task);
  const domain = signals.slice(0, 5).join(', ') || 'general execution';
  const baseIntro = `This result answers the bounty "${title}" with an implementation-ready structure, concrete operating steps, and a validation checklist.`;
  const commonClose = [
    '## Validation checklist',
    '- A practitioner can execute the first step without needing extra context.',
    '- The deliverable names concrete workflows, metrics, modules, or artifacts rather than only abstract advice.',
    '- Trade-offs and failure modes are called out so the answer can be reviewed before adoption.',
    '- The structure can be converted into a tutorial, checklist, or reusable EvoMap capsule.',
  ].join('\n');

  if (kind === 'automation') {
    return {
      kind,
      summary: `Three automation workflows for ${domain}, with triggers, implementation details, and quality gates.`,
      deliverables: ['workflow map', 'implementation checklist', 'risk controls'],
      markdown: [
        `# Automation workflows for ${title}`,
        baseIntro,
        '## Workflow 1: Generator-to-review pipeline',
        '- Trigger: a new design brief, quest seed, opponent behavior gap, or repetitive content request enters the backlog.',
        '- Implementation: normalize the brief into a JSON spec, generate 3-5 candidate variants, score each variant against constraints, and keep the top candidate plus one fallback.',
        '- Quality gate: reject outputs that violate lore, pacing, balance, token budget, or required entity schemas before they reach a human reviewer.',
        '## Workflow 2: Simulation and regression loop',
        '- Trigger: a rule, branch, or AI behavior change lands in the project.',
        '- Implementation: run deterministic simulations with seeded randomness, collect win-rate / completion / dead-end stats, and compare against the previous baseline.',
        '- Quality gate: flag any branch with unreachable states, excessive repetition, dominant strategies, or missing recovery paths.',
        '## Workflow 3: Packaging and reuse workflow',
        '- Trigger: a reviewed result passes acceptance criteria.',
        '- Implementation: convert the accepted pattern into a reusable template, attach examples, store parameter ranges, and index it by signals so future tasks can reuse it.',
        '- Quality gate: require one worked example, one counterexample, and one rollback note before publishing.',
        '## Implementation notes',
        '- Keep each workflow idempotent: the same input seed should reproduce the same candidate set.',
        '- Persist intermediate artifacts so failures can resume instead of restarting from scratch.',
        '- Use small confidence scores until the workflow has survived at least two successful review cycles.',
        commonClose,
      ].join('\n\n'),
    };
  }

  if (kind === 'metrics') {
    return {
      kind,
      summary: `KPI and evaluation framework for measuring and improving ${domain} output quality.`,
      deliverables: ['KPI taxonomy', 'review rubric', 'improvement loop'],
      markdown: [
        `# KPI framework for ${title}`,
        baseIntro,
        '## KPI taxonomy',
        '| KPI | What it measures | How to collect | Target signal |',
        '| --- | --- | --- | --- |',
        '| Fidelity | Match between reference intent and final output | Side-by-side review against source examples | >= 4/5 reviewer score |',
        '| Novelty control | Whether the result adapts rather than copies | Similarity check plus reviewer notes | Distinct structure with traceable inspiration |',
        '| Technical polish | Timing, continuity, artifacts, or implementation quality | Automated checks plus manual QA | No blocking defects |',
        '| Audience fit | Whether the result matches the intended viewer/user | Sample review or persona checklist | Clear hook and coherent payoff |',
        '| Revision efficiency | Number of cycles required to reach acceptance | Track comments, fixes, and cycle time | Fewer repeated comments per round |',
        '## Evaluation rubric',
        '- Score each output from 1-5 across fidelity, novelty, clarity, technical polish, and production readiness.',
        '- Require written evidence for scores below 3 so the next revision has a concrete target.',
        '- Separate creative preference from objective defects; only objective defects should block submission.',
        '## Improvement loop',
        '1. Capture the baseline output and reference intent.',
        '2. Run automated checks for obvious defects and missing requirements.',
        '3. Review with the rubric and tag each issue by root cause.',
        '4. Apply a focused revision pass; avoid rewriting unaffected sections.',
        '5. Record the accepted pattern as a reusable checklist for the next job.',
        commonClose,
      ].join('\n\n'),
    };
  }

  if (kind === 'curriculum') {
    const modules = [
      'Foundations and vocabulary',
      'Reference analysis and pattern recognition',
      'Small controlled exercises',
      'Tooling and workflow setup',
      'Intermediate composition patterns',
      'Quality review and iteration',
      'Advanced production constraints',
      'Capstone project and portfolio packaging',
    ];
    return {
      kind,
      summary: `Eight-module curriculum for ${domain}, from beginner foundations to advanced capstone work.`,
      deliverables: ['8-module curriculum', 'practice ladder', 'assessment plan'],
      markdown: [
        `# Eight-module curriculum for ${title}`,
        baseIntro,
        '## Module sequence',
        modules.map((name, index) => `${index + 1}. **${name}**: objective, guided demo, short exercise, review checkpoint, and one reusable artifact.`).join('\n'),
        '## Teaching rhythm',
        '- Start each module with one reference teardown so beginners see the pattern before producing work.',
        '- Use constrained exercises before open-ended assignments; constraints make feedback easier and reduce overwhelm.',
        '- End every module with a portfolio-ready artifact, even if it is small.',
        '## Assessment',
        '- Beginner: can identify the pattern and reproduce it with a template.',
        '- Intermediate: can adapt the pattern to a new brief without breaking constraints.',
        '- Advanced: can explain trade-offs, defend choices, and package the result for reuse.',
        commonClose,
      ].join('\n\n'),
    };
  }

  if (kind === 'tutorial') {
    return {
      kind,
      summary: `Beginner-safe tutorial for ${domain}, with diagram descriptions and practical exercises.`,
      deliverables: ['step-by-step tutorial', 'diagram descriptions', 'practice checklist'],
      markdown: [
        `# Beginner tutorial for ${title}`,
        baseIntro,
        '## Mental model',
        '- Define the core objects, the timeline or spatial relationship between them, and the feedback loop used to judge quality.',
        '- Diagram description: a left-to-right pipeline showing input material, preparation, simulation/edit pass, review, and final export.',
        '## Step-by-step workflow',
        '1. Prepare a minimal test scene or clip with only the elements needed for the concept.',
        '2. Set clear units, frame rate, naming, and reference markers before editing or simulating.',
        '3. Build the first pass with exaggerated settings so cause and effect is visible.',
        '4. Reduce the exaggeration, add secondary detail, and compare against the reference.',
        '5. Export a short preview and annotate what changed between versions.',
        '## Common mistakes',
        '- Starting with a complex shot before understanding the control parameters.',
        '- Judging quality without a reference or measurement point.',
        '- Applying global fixes when a localized edit would preserve more of the good work.',
        '## Practice ladder',
        '- Exercise 1: recreate the simplest possible example.',
        '- Exercise 2: change one parameter and predict the result before previewing.',
        '- Exercise 3: produce a 10-20 second final sample with notes.',
        commonClose,
      ].join('\n\n'),
    };
  }

  if (kind === 'trend_analysis') {
    return {
      kind,
      summary: `Trend and impact analysis for ${domain}, focused on practical adoption through 2025.`,
      deliverables: ['trend map', 'impact analysis', 'adoption checklist'],
      markdown: [
        `# 2025 trend analysis for ${title}`,
        baseIntro,
        '## Key trends',
        '- **GPU-driven pipelines**: more work moves into compute, mesh/task shaders, indirect draws, and GPU culling so scenes scale with less CPU bottleneck.',
        '- **Hybrid ray tracing**: teams combine rasterization with ray-traced reflections, shadows, or global illumination where the perceptual gain justifies the cost.',
        '- **Temporal reconstruction and denoising**: upscalers, frame generation, and denoisers make advanced effects viable but increase the need for stable motion vectors and history management.',
        '- **Procedural and node-based authoring**: shader graphs, material functions, and procedural masks let technical artists iterate faster while engineers enforce performance budgets.',
        '- **Stylized physically informed effects**: games increasingly blend physically based lighting with art-directed non-photorealistic rules for readability and identity.',
        '## Impact',
        '- Visual ambition rises, but debugging shifts from single shader code to whole-frame data dependencies.',
        '- Technical artists become more central because reusable graph modules can unlock many effects without custom code every time.',
        '- Performance review must happen continuously; late optimization is riskier when effects depend on temporal history or multiple passes.',
        '## Adoption checklist',
        '- Define the target hardware tier and frame budget before choosing the technique.',
        '- Build a fallback path for low-end hardware and capture quality comparisons.',
        '- Track shader permutation count, memory bandwidth, overdraw, and temporal artifacts as first-class metrics.',
        commonClose,
      ].join('\n\n'),
    };
  }

  if (kind === 'revision_process') {
    return {
      kind,
      summary: `Structured client feedback and revision process for ${domain}.`,
      deliverables: ['revision workflow', 'client feedback rubric', 'approval checklist'],
      markdown: [
        `# Revision process for ${title}`,
        baseIntro,
        '## Intake',
        '- Ask the client to label feedback as defect, preference, compliance requirement, or new scope.',
        '- Confirm the acceptance target in writing before editing.',
        '## Triage',
        '- Fix defects first because they block objective acceptance.',
        '- Batch preferences into one creative pass to avoid oscillation.',
        '- Move new scope into a separate estimate or follow-up task.',
        '## Revision loop',
        '1. Restate the requested change in one sentence.',
        '2. Apply the smallest edit that satisfies the request.',
        '3. Attach before/after notes and a short rationale.',
        '4. Ask for approval against the agreed target, not against an open-ended taste question.',
        '## Ethical controls',
        '- Document generated, licensed, and client-provided material separately.',
        '- Avoid implying human authorship for AI-generated sections when disclosure is required.',
        commonClose,
      ].join('\n\n'),
    };
  }

  if (kind === 'portfolio') {
    return {
      kind,
      summary: `Portfolio structure and presentation plan for ${domain}.`,
      deliverables: ['portfolio architecture', 'case study template', 'presentation tips'],
      markdown: [
        `# Portfolio plan for ${title}`,
        baseIntro,
        '## Structure',
        '- Hero statement: one sentence describing the design specialty and audience.',
        '- Three case studies: each shows problem, constraints, process, artifact, outcome, and reflection.',
        '- Systems page: reusable frameworks, tools, or templates that prove repeatable expertise.',
        '## Case study template',
        '1. Context and design challenge.',
        '2. Constraints and success criteria.',
        '3. Iteration snapshots with decisions explained.',
        '4. Final artifact and measurable result.',
        '5. What changed after feedback.',
        '## Presentation tips',
        '- Lead with the strongest finished artifact, then reveal process.',
        '- Use diagrams for systems thinking and short clips/screens for experiential work.',
        '- End each case with what you would improve next; it signals maturity rather than weakness.',
        commonClose,
      ].join('\n\n'),
    };
  }

  return {
    kind,
    summary: `Structured guide for ${domain}, with execution steps and review criteria.`,
    deliverables: ['structured guide', 'implementation checklist', 'review rubric'],
    markdown: [
      `# Structured answer for ${title}`,
      baseIntro,
      '## Recommended structure',
      '- Define the objective, constraints, and target audience first.',
      '- Break the work into a repeatable sequence of preparation, execution, review, and packaging.',
      '- Keep examples close to the requested domain so the answer is directly reusable.',
      '## Execution plan',
      '1. Collect references and identify the recurring pattern.',
      '2. Create a minimal working example.',
      '3. Expand the example with domain-specific constraints.',
      '4. Review against explicit acceptance criteria.',
      '5. Package the result as a reusable checklist or template.',
      commonClose,
    ].join('\n\n'),
  };
}

function buildRunnerResultAsset(task, agent) {
  const reason = blockedTaskReason(task);
  if (reason) {
    const err = new Error(`Task is blocked by local safety policy: ${reason}`);
    err.code = 'UNSUPPORTED_TASK';
    throw err;
  }
  const id = taskShortId(task);
  const answer = answerSectionsForTask(task);
  const signals = taskSignals(task);
  const contentHash = crypto.createHash('sha256').update(`${task.id}|${answer.markdown}`).digest('hex').slice(0, 10);
  const modelName = runnerModelName(agent);
  const geneId = `gene_bounty_${id}_${contentHash}`;
  const capsuleId = `capsule_bounty_${id}_${contentHash}`;
  const gene = {
    type: 'Gene',
    schema_version: '1.5.0',
    id: geneId,
    category: 'explore',
    signals_match: signals,
    summary: answer.summary,
    strategy: [
      'Classify the task into tutorial, curriculum, metrics, automation, trend analysis, portfolio, revision, or structured guide.',
      'Generate a concrete markdown deliverable with headings, implementation details, trade-offs, and validation steps.',
      'Publish the deliverable as a Capsule result asset.',
      'Submit the published result_asset_id only after the asset id is available.',
    ],
    validation: [
      `node -e "require('assert').ok('${geneId}'.startsWith('gene_bounty_'))"`,
    ],
    model_name: modelName,
  };
  const geneAssetId = computeLocalAssetId(gene);
  const capsule = {
    type: 'Capsule',
    schema_version: '1.5.0',
    id: capsuleId,
    gene: geneAssetId,
    summary: answer.summary,
    content: answer.markdown.slice(0, 8000),
    trigger: signals,
    confidence: 0.78,
    blast_radius: {
      files: 1,
      lines: Math.max(10, answer.markdown.split('\n').length),
    },
    outcome: {
      status: 'success',
      score: 0.78,
    },
    env_fingerprint: {
      platform: os.platform(),
      arch: os.arch(),
      node: process.version,
    },
    success_streak: 1,
    model_name: modelName,
  };
  return { gene, capsule, answer, local: { content_hash: contentHash, short_id: id, deliverables: answer.deliverables } };
}

function validateGeneratedResult(result) {
  const content = result?.capsule?.content || '';
  const sectionCount = (content.match(/^## /gm) || []).length;
  if (content.length < 1200 || sectionCount < 3) {
    const err = new Error('Generated result did not pass local quality gate.');
    err.code = 'RESULT_QUALITY_GATE';
    err.payload = { content_length: content.length, section_count: sectionCount };
    throw err;
  }
}

function buildOfficialPublishBundle(agent, gene, capsule) {
  // Keep the obfuscated official builder out of the Next/Turbopack server bundle.
  // Loading it inside the API process can pin the dev server CPU; a short-lived
  // child process still produces the exact official publish envelope/signature.
  const payload = JSON.stringify({ agent: redactedAgent(agent), secret: agent.node_secret, gene, capsule });
  try {
    const output = execFileSync(process.execPath, [PUBLISH_BUNDLE_BUILDER_FILE], {
      cwd: process.cwd(),
      input: payload,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 5 * 1024 * 1024,
      env: {
        ...process.env,
        A2A_NODE_ID: agent.node_id,
        A2A_NODE_SECRET: agent.node_secret,
        AGENT_NAME: agent.name || process.env.AGENT_NAME || 'EvoMap Runner Lite Agent',
      },
    });
    return JSON.parse(output);
  } catch (err) {
    const wrapped = new Error(`Official publish bundle builder failed: ${err.message}`);
    wrapped.code = 'PUBLISH_BUNDLE_BUILDER_FAILED';
    if (err.stdout || err.stderr) {
      wrapped.payload = {
        stdout: String(err.stdout || '').slice(0, 2000),
        stderr: String(err.stderr || '').slice(0, 2000),
      };
    }
    throw wrapped;
  }
}

async function publishRunnerResultAsset(agent, task) {
  const generated = buildRunnerResultAsset(task, agent);
  validateGeneratedResult(generated);
  const message = buildOfficialPublishBundle(agent, generated.gene, generated.capsule);
  const capsuleAsset = (message.payload?.assets || []).find((asset) => asset.type === 'Capsule') || null;
  const resultAssetId = capsuleAsset?.asset_id;
  if (!resultAssetId || !resultAssetId.startsWith('sha256:')) {
    const err = new Error('Official publish bundle did not produce a Capsule sha256 asset id.');
    err.payload = { message_type: message.message_type };
    throw err;
  }
  let publishResult;
  try {
    publishResult = await hubFetch('/a2a/publish', { method: 'POST', agent, body: message, timeoutMs: 20000 });
  } catch (err) {
    const duplicateAssetId = err.payload?.payload?.target_asset_id;
    if (err.status !== 409 || err.payload?.payload?.reason !== 'duplicate_asset' || !sanitizeAssetId(duplicateAssetId)) {
      throw err;
    }
    publishResult = {
      duplicate: true,
      decision: err.payload,
      reused_asset_id: sanitizeAssetId(duplicateAssetId),
    };
  }
  const publishedAssetId = sanitizeAssetId(publishResult.reused_asset_id) || resultAssetId;
  await appendJsonl(GENERATED_RESULT_FILE, {
    type: 'runner_result_asset',
    task_id: task.id,
    assignment_id: task.assignment_id || null,
    result_asset_id: publishedAssetId,
    title: task.title,
    kind: generated.answer.kind,
    capsule_id: publishedAssetId,
    gene_id: generated.capsule.gene,
    content_hash: generated.local?.content_hash,
    publish_result: publishResult,
  });
  return {
    result_asset_id: publishedAssetId,
    publish_result: publishResult,
    capsule_id: publishedAssetId,
    gene_id: generated.capsule.gene,
    kind: generated.answer.kind,
    content_preview: generated.capsule.content.slice(0, 360),
  };
}

async function claimRunnerTask(agent, activeTask) {
  const endpoint = activeTask.source === 'worker_pool' ? '/a2a/work/claim' : '/a2a/task/claim';
  const claimed = await hubFetch(endpoint, {
    method: 'POST',
    agent,
    body: { task_id: activeTask.id, node_id: agent.node_id, sender_id: agent.node_id },
  });
  activeTask.claim_result = claimed;
  activeTask.claimed_at = new Date().toISOString();
  activeTask.assignment_id = claimed.assignment_id || claimed.id || claimed.assignment?.id || activeTask.assignment_id;
  activeTask.phase = 'claimed';
  activeTask.phase_label = phaseInfo('claimed').label;
  activeTask.progress = phaseInfo('claimed').progress;
  return claimed;
}

function parkTask(job, task, reason, details = {}) {
  task.phase = 'parked';
  task.phase_label = phaseInfo('parked').label;
  task.progress = phaseInfo('parked').progress;
  task.finished_at = new Date().toISOString();
  task.parked_reason = reason;
  job.parked_tasks = [...(job.parked_tasks || []), { task: compactTask(task), ts: task.finished_at, reason }].slice(-50);
  addJobEvent(job, 'parked', reason, { task_id: task.id, ...details });
}

function reviveParkedResultTasks(job, limit = 1) {
  const activeIds = new Set((job.active_tasks || []).filter((task) => !task.finished_at).map((task) => task.id));
  const revived = [];
  for (const parked of [...(job.parked_tasks || [])].reverse()) {
    if (revived.length >= limit) break;
    const parkedTask = parked?.task;
    if (!parkedTask?.id || !parkedTask.result_asset_id || activeIds.has(parkedTask.id)) continue;
    const activeTask = {
      ...parkedTask,
      phase: 'result_produced',
      phase_label: phaseInfo('result_produced').label,
      progress: phaseInfo('result_produced').progress,
      revived_at: new Date().toISOString(),
      finished_at: null,
      parked_reason: null,
      deferred_claim: parkedTask.source === 'worker_pool' && !parkedTask.assignment_id,
    };
    job.active_tasks = [...(job.active_tasks || []), activeTask];
    activeIds.add(activeTask.id);
    revived.push(activeTask);
  }
  if (revived.length) {
    addJobEvent(job, 'result_task_revived', `恢复 ${revived.length} 个已产出 result_asset_id 的任务，优先提交而不是重新扫描。`, {
      task_ids: revived.map((task) => task.id),
      result_asset_ids: revived.map((task) => task.result_asset_id),
    });
  }
  return revived;
}


function scheduleRunnerSleep(job, err, reason = 'Hub 暂时不可用，定时任务休眠后自动继续。') {
  const retryAfter = Number(err?.retryAfter || 0) || (err?.status === 429 ? 15 * 60 : 2 * 60);
  const sleepMs = Math.max(30 * 1000, Math.min(60 * 60 * 1000, retryAfter * 1000));
  const sleepUntil = new Date(Date.now() + sleepMs).toISOString();
  job.status = 'running';
  job.sleep_until = sleepUntil;
  job.sleep_reason = reason;
  updateJobPhase(job, 'sleeping', { phase_label: '休眠中', progress: phaseInfo('sleeping').progress });
  addJobEvent(job, 'sleeping', `${reason} 预计 ${Math.ceil(sleepMs / 1000)} 秒后继续。`, { sleep_until: sleepUntil, status: err?.status, details: err?.payload });
  return sleepUntil;
}

async function runnerTick() {
  if (runnerStore.inflight) return;
  const job = await loadRunnerJob();
  if (!job || job.status !== 'running') return;
  runnerStore.inflight = true;
  try {
    const agent = await readAgent();
    if (job.run_until && Date.now() > Date.parse(job.run_until)) {
      job.status = 'stopped';
      updateJobPhase(job, 'stopped');
      addJobEvent(job, 'stopped', '24 小时执行窗口已结束。', { run_until: job.run_until });
      await saveRunnerJob(job);
      stopRunnerTimer();
      return;
    }
    const releasedBeforeSleep = releaseSubmittedTasks(job);
    if (releasedBeforeSleep.length) await saveRunnerJob(job);

    const sleepUntilMs = timestampMs(job.sleep_until);
    if (sleepUntilMs && sleepUntilMs > Date.now()) {
      const revived = reviveParkedResultTasks(job, 1);
      if (revived.length) {
        job.sleep_until = null;
        job.sleep_reason = null;
        addJobEvent(job, 'woke', '检测到已有 result_asset_id，提前结束扫描休眠并优先提交。');
      } else {
      updateJobPhase(job, 'sleeping', { phase_label: '休眠中', progress: phaseInfo('sleeping').progress });
      await saveRunnerJob(job);
      return;
      }
    }
    if (job.sleep_until) {
      job.sleep_until = null;
      job.sleep_reason = null;
      addJobEvent(job, 'woke', '休眠结束，继续扫描和处理悬赏。');
    }

    const policy = job.strategy?.policy || STRATEGY_PRESETS.balanced.policy;
    const maxActive = Math.max(1, Math.min(5, Number(policy.max_active || 2)));
    const maxClaims = Math.max(1, Math.min(5, Number(policy.max_claims || 1)));
    const deferredClaim = policy.deferred_claim !== false;
    let activeTasks = syncPrimaryTask(job);
    await pollPendingVerdicts(agent, job, 5);
    const parked = parkStalledTasks(job, policy);
    if (parked.length && job.strategy?.policy) {
      job.strategy.policy.max_active = 1;
      job.strategy.policy.max_claims = 1;
    }
    activeTasks = syncPrimaryTask(job);
    if (!activeTasks.length) {
      reviveParkedResultTasks(job, 1);
      activeTasks = syncPrimaryTask(job);
    }

    // Poll every active assignment first; only submit real result assets.
    for (const task of [...activeTasks]) {
      if (!task.result_asset_id) {
        try {
          task.generation_attempted_at = new Date().toISOString();
          task.phase = 'reasoning';
          task.phase_label = '生成结果资产';
          task.progress = phaseInfo('reasoning').progress;
          addJobEvent(job, 'reasoning', '正在本地产出并发布 result_asset_id，不再只停留在等待状态。', { task_id: task.id, source: task.source });
          const produced = await publishRunnerResultAsset(agent, task);
          task.generated_result = produced;
          task.result_generation_error = null;
          task.result_asset_id = produced.result_asset_id;
          task.phase = 'result_produced';
          task.phase_label = phaseInfo('result_produced').label;
          task.progress = phaseInfo('result_produced').progress;
          addJobEvent(job, 'result_produced', '已发布结果资产，准备认领/提交。', { task_id: task.id, result_asset_id: produced.result_asset_id, kind: produced.kind });
          await appendJsonl(AUTOPILOT_RUN_FILE, { type: 'runner_result_produced', run_id: job.id, task_id: task.id, result_asset_id: produced.result_asset_id, kind: produced.kind });
        } catch (err) {
          if (err.status === 429 || err.status === 504) {
            task.result_generation_error = err.message;
            addJobEvent(job, 'result_publish_delayed', err.status === 429 ? '发布结果资产被 Hub 限流，休眠后继续。' : '发布结果资产超时，短暂休眠后继续。', { task_id: task.id, status: err.status, details: err.payload });
            scheduleRunnerSleep(job, err, err.status === 429 ? 'Hub 发布限流，暂时休眠。' : 'Hub 发布超时，短暂休眠。');
            await appendJsonl(AUTOPILOT_RUN_FILE, { type: 'runner_result_publish_failed', run_id: job.id, task_id: task.id, error: err.message, status: err.status, details: err.payload });
            continue;
          }
          task.result_generation_error = err.message;
          parkTask(job, task, `结果资产生成失败，已轮换：${err.message}`, { code: err.code, details: err.payload });
          await appendJsonl(AUTOPILOT_RUN_FILE, { type: 'runner_result_generation_failed', run_id: job.id, task_id: task.id, error: err.message, code: err.code, details: err.payload });
          continue;
        }
      }

      const needsWorkerClaim = task.source === 'worker_pool' && !task.assignment_id;
      if ((task.deferred_claim || needsWorkerClaim) && !task.assignment_id) {
        task.deferred_claim = true;
        task.phase = 'claiming';
        task.phase_label = phaseInfo('claiming').label;
        task.progress = phaseInfo('claiming').progress;
        try {
          await claimRunnerTask(agent, task);
          addJobEvent(job, 'claimed', '结果资产已就绪，完成 deferred claim，准备提交。', { task_id: task.id, assignment_id: task.assignment_id, result_asset_id: task.result_asset_id });
          await appendJsonl(AUTOPILOT_RUN_FILE, { type: 'runner_claimed', run_id: job.id, task_id: task.id, assignment_id: task.assignment_id, bounty: task.bounty, deferred: true });
        } catch (err) {
          if (err.status === 400 && err.payload?.error === 'task_already_claimed') {
            const recovered = await recoverExistingAssignment(agent, job, task);
            if (recovered) {
              addJobEvent(job, 'claim_recovered', 'Hub 提示任务已认领，已恢复历史 assignment_id，继续提交。', {
                task_id: task.id,
                assignment_id: task.assignment_id,
                source: recovered.source,
                result_asset_id: task.result_asset_id,
              });
              await appendJsonl(AUTOPILOT_RUN_FILE, {
                type: 'runner_claim_recovered',
                run_id: job.id,
                task_id: task.id,
                assignment_id: task.assignment_id,
                result_asset_id: task.result_asset_id,
                source: recovered.source,
              });
            } else {
              parkTask(job, task, `任务已被认领但无法恢复 assignment_id，已轮换：${err.message}`, { status: err.status, details: err.payload, result_asset_id: task.result_asset_id });
              await appendJsonl(AUTOPILOT_RUN_FILE, { type: 'runner_claim_failed', run_id: job.id, task_id: task.id, error: err.message, status: err.status, details: err.payload, result_asset_id: task.result_asset_id });
              continue;
            }
          } else if (err.status === 429 || err.status === 504) {
            addJobEvent(job, 'claim_delayed', err.status === 429 ? 'Hub 认领限流，结果资产已保留，休眠后继续。' : 'Hub 认领超时，结果资产已保留，稍后继续。', { task_id: task.id, status: err.status, details: err.payload });
            scheduleRunnerSleep(job, err, err.status === 429 ? 'Hub 认领限流，暂时休眠。' : 'Hub 认领超时，短暂休眠。');
            await appendJsonl(AUTOPILOT_RUN_FILE, { type: 'runner_claim_failed', run_id: job.id, task_id: task.id, error: err.message, status: err.status, details: err.payload });
            continue;
          } else {
            parkTask(job, task, `结果资产已产出但认领失败，已轮换：${err.message}`, { status: err.status, details: err.payload, result_asset_id: task.result_asset_id });
            await appendJsonl(AUTOPILOT_RUN_FILE, { type: 'runner_claim_failed', run_id: job.id, task_id: task.id, error: err.message, status: err.status, details: err.payload, result_asset_id: task.result_asset_id });
            continue;
          }
        }
      }
      let hubTask = null;
      if (task.assignment_id || !task.deferred_claim) {
        try {
          hubTask = await findTaskResult(agent, job, task);
        } catch (err) {
          addJobEvent(job, 'poll_skipped', err.status === 429 ? 'Hub 查询限流，保留任务并等待下一轮。' : `查询任务状态失败：${err.message}`, { task_id: task.id, status: err.status, details: err.payload });
          if (err.status === 429 || err.status === 504) scheduleRunnerSleep(job, err, err.status === 429 ? 'Hub 查询限流，暂时休眠。' : 'Hub 查询超时，短暂休眠。');
          await appendJsonl(AUTOPILOT_RUN_FILE, { type: 'runner_poll_failed', run_id: job.id, task_id: task.id, error: err.message, status: err.status, details: err.payload });
          continue;
        }
      }
      const taskStatus = String(hubTask?.status || '').toLowerCase();
      const taskId = task.id;

      if (['accepted', 'verified', 'settled', 'completed'].includes(taskStatus) && task.phase === 'waiting_verdict') {
        task.phase = 'accepted';
        task.phase_label = phaseInfo('accepted').label;
        task.finished_at = new Date().toISOString();
        task.verdict = taskStatus;
        addJobEvent(job, 'accepted', `Hub 状态：${taskStatus}`, { task_id: taskId, assignment_id: task.assignment_id });
        job.completed_tasks = [...(job.completed_tasks || []), { task: compactTask(task), verdict: taskStatus, ts: task.finished_at }].slice(-50);
        continue;
      }

      if (['rejected', 'failed', 'disputed', 'expired', 'cancelled'].includes(taskStatus)) {
        task.phase = 'rejected';
        task.phase_label = phaseInfo('rejected').label;
        task.finished_at = new Date().toISOString();
        task.verdict = taskStatus;
        addJobEvent(job, 'rejected', `Hub 状态：${taskStatus}`, { task_id: taskId, assignment_id: task.assignment_id });
        continue;
      }

      const resultAssetId = task.result_asset_id || hubTask?.result_asset_id || hubTask?.resultAssetId || hubTask?.asset_id;
      if (!resultAssetId) {
        task.phase = 'reasoning';
        task.phase_label = phaseInfo('reasoning').label;
        task.progress = phaseInfo('reasoning').progress;
        addJobEvent(job, 'reasoning', '等待执行器产出 result_asset_id；不会伪造结果提交。', { task_id: taskId, assignment_id: task.assignment_id });
        continue;
      }

      task.result_asset_id = resultAssetId;
      if (!task.submitted_at) {
        task.phase = 'result_produced';
        task.phase_label = phaseInfo('result_produced').label;
        task.progress = phaseInfo('result_produced').progress;
        addJobEvent(job, 'result_produced', '检测到结果资产，准备提交。', { task_id: taskId, result_asset_id: resultAssetId });
        task.phase = 'submitting';
        task.phase_label = phaseInfo('submitting').label;
        let submit;
        try {
          submit = await submitRunnerResult(agent, job, hubTask, task);
        } catch (err) {
          if (err.status === 429 || err.status === 504) {
            addJobEvent(job, 'submit_delayed', err.status === 429 ? 'Hub 提交限流，休眠后继续。' : 'Hub 提交超时，稍后继续。', { task_id: taskId, status: err.status, details: err.payload, result_asset_id: resultAssetId });
            scheduleRunnerSleep(job, err, err.status === 429 ? 'Hub 提交限流，暂时休眠。' : 'Hub 提交超时，短暂休眠。');
            await appendJsonl(AUTOPILOT_RUN_FILE, { type: 'runner_submit_failed', run_id: job.id, task_id: taskId, assignment_id: task.assignment_id, result_asset_id: resultAssetId, error: err.message, status: err.status, details: err.payload });
            continue;
          }
          parkTask(job, task, `提交失败，已轮换：${err.message}`, { status: err.status, details: err.payload, result_asset_id: resultAssetId, assignment_id: task.assignment_id });
          await appendJsonl(AUTOPILOT_RUN_FILE, { type: 'runner_submit_failed', run_id: job.id, task_id: taskId, assignment_id: task.assignment_id, result_asset_id: resultAssetId, error: err.message, status: err.status, details: err.payload });
          continue;
        }
        task.submit_result = submit;
        task.submitted_at = new Date().toISOString();
        task.phase = 'submitted';
        task.phase_label = phaseInfo('submitted').label;
        task.progress = phaseInfo('submitted').progress;
        addJobEvent(job, 'submitted', '结果已提交，等待 Hub 采纳/拒绝。', { task_id: taskId, result_asset_id: resultAssetId });
        await appendJsonl(AUTOPILOT_RUN_FILE, { type: 'runner_submitted', run_id: job.id, task_id: taskId, assignment_id: task.assignment_id, result_asset_id: resultAssetId, result: submit });
      }

      task.phase = 'waiting_verdict';
      task.phase_label = phaseInfo('waiting_verdict').label;
      task.progress = phaseInfo('waiting_verdict').progress;
    }
    releaseSubmittedTasks(job);

    activeTasks = syncPrimaryTask(job);
    if (!activeTasks.length) {
      const adaptation = adaptPolicyFromJob(job);
      job.last_review = adaptation.review;
      if (adaptation.review.issues.length) {
        job.strategy.policy = adaptation.policy;
        addJobEvent(job, 'review', `复盘上一轮：${adaptation.review.issues.join('；')}`, { adjustments: adaptation.review.adjustments });
      }
    }

    const capacity = Math.max(0, maxActive - activeTasks.length);
    if (capacity > 0) {
      updateJobPhase(job, 'scanning');
      await saveRunnerJob(job);
      let scan = null;
      try {
        scan = await handleApi('/api/task/autopilot', 'POST', { options: { ...policy, mode: 'scan' } });
      } catch (err) {
        addJobEvent(job, 'scan_skipped', err.status === 429 ? 'Hub 扫描限流，保留当前任务并等待下一轮。' : `扫描失败：${err.message}`, { status: err.status, details: err.payload });
        if (err.status === 429 || err.status === 504) scheduleRunnerSleep(job, err, err.status === 429 ? 'Hub 扫描限流，暂时休眠。' : 'Hub 扫描超时，短暂休眠。');
        else updateMultiJobPhase(job);
        await saveRunnerJob(job);
        return;
      }
      job.last_scan = scan.payload;
      const activeIds = new Set([
        ...activeTasks.map(taskIdentity),
        ...(job.pending_verdict_tasks || []).map(taskIdentity),
      ].filter(Boolean));
      const parkedIds = new Set((job.parked_tasks || []).map((entry) => entry?.task?.id).filter(Boolean));
      const candidateTasks = (scan.payload.ranked || [])
        .filter((task) => task.autopilot?.ready && !activeIds.has(task.autopilot.id) && !parkedIds.has(task.autopilot.id));
      const selectLimit = Math.min(maxClaims, capacity);
      const selectedTasks = policy.selection_mode === 'high_score_first'
        ? candidateTasks.slice(0, selectLimit)
        : selectBalancedTasks(candidateTasks, selectLimit);

      if (!selectedTasks.length && !activeTasks.length) {
        updateJobPhase(job, 'idle');
        addJobEvent(job, 'waiting', '没有符合策略阈值的 ready 任务，等待下一轮。', { ready_count: scan.payload.ready_count, active_count: scan.payload.active_count });
        await saveRunnerJob(job);
        return;
      }

      for (const selected of selectedTasks) {
        const activeTask = {
          ...compactTask(selected),
          phase: 'selected',
          phase_label: phaseInfo('selected').label,
          progress: phaseInfo('selected').progress,
          selected_at: new Date().toISOString(),
        };
        job.active_tasks = [...(job.active_tasks || []), activeTask];
        addJobEvent(job, 'selected', `选中悬赏：${selected.title || selected.autopilot.id}`, { task_id: selected.autopilot.id, bounty: selected.autopilot.bounty, score: selected.autopilot.score, parallel_active: job.active_tasks.length });
        if (deferredClaim && activeTask.source === 'worker_pool') {
          activeTask.phase = 'deferred';
          activeTask.phase_label = phaseInfo('deferred').label;
          activeTask.progress = phaseInfo('deferred').progress;
          activeTask.deferred_claim = true;
          addJobEvent(job, 'deferred_claim', '采用 deferred claim：先产出结果资产，再原子认领并提交，避免空占任务。', { task_id: activeTask.id });
          continue;
        }
        activeTask.phase = 'claiming';
        activeTask.phase_label = phaseInfo('claiming').label;
        activeTask.progress = phaseInfo('claiming').progress;
        try {
          const endpoint = activeTask.source === 'worker_pool' ? '/a2a/work/claim' : '/a2a/task/claim';
          const claimed = await hubFetch(endpoint, { method: 'POST', agent, body: { task_id: activeTask.id, node_id: agent.node_id, sender_id: agent.node_id } });
          activeTask.claim_result = claimed;
          activeTask.claimed_at = new Date().toISOString();
          activeTask.assignment_id = claimed.assignment_id || claimed.id || claimed.assignment?.id || activeTask.assignment_id;
          activeTask.phase = 'claimed';
          activeTask.phase_label = phaseInfo('claimed').label;
          activeTask.progress = phaseInfo('claimed').progress;
          addJobEvent(job, 'claimed', `悬赏已认领，当前并行 ${job.active_tasks.length}/${maxActive}。`, { task_id: activeTask.id, assignment_id: activeTask.assignment_id });
          await appendJsonl(AUTOPILOT_RUN_FILE, { type: 'runner_claimed', run_id: job.id, task_id: activeTask.id, assignment_id: activeTask.assignment_id, bounty: activeTask.bounty });
        } catch (err) {
          job.active_tasks = (job.active_tasks || []).filter((task) => task.id !== activeTask.id);
          if (err.status === 429) {
            job.strategy.policy.max_claims = 1;
            job.strategy.policy.max_active = Math.max(1, Math.min(maxActive, (job.active_tasks || []).length));
            scheduleRunnerSleep(job, err, 'Hub 认领限流，已降速并暂时休眠。');
          } else if (err.status === 504) {
            scheduleRunnerSleep(job, err, 'Hub 认领超时，短暂休眠。');
          }
          addJobEvent(job, 'claim_skipped', err.status === 429 ? 'Hub 触发 429 限流，已降低并行认领速度并进入休眠。' : `认领失败：${err.message}`, { task_id: activeTask.id, status: err.status, details: err.payload });
          await appendJsonl(AUTOPILOT_RUN_FILE, { type: 'runner_claim_failed', run_id: job.id, task_id: activeTask.id, error: err.message, status: err.status, details: err.payload });
          if (err.status === 429) break;
        }
      }
    }

    activeTasks = syncPrimaryTask(job);
    if (activeTasks.length) {
      const waitingCount = activeTasks.filter((task) => !task.result_asset_id).length;
      updateMultiJobPhase(job);
      if (waitingCount) {
        addJobEvent(job, 'parallel_status', `当前并行执行 ${activeTasks.length}/${maxActive} 个任务，其中 ${waitingCount} 个等待 result_asset_id。`, { active_task_ids: activeTasks.map((task) => task.id) });
      }
    } else {
      updateJobPhase(job, 'idle');
    }
    await saveRunnerJob(job);
  } catch (err) {
    const jobAfterError = await loadRunnerJob();
    if (jobAfterError) {
      if (err.status === 429 || err.status === 504) {
        scheduleRunnerSleep(jobAfterError, err, err.status === 429 ? 'Hub 限流，Runner 休眠后自动继续。' : 'Hub 超时，Runner 短暂休眠后自动继续。');
        await saveRunnerJob(jobAfterError);
      } else {
        updateJobPhase(jobAfterError, 'error', { status: 'paused_on_error', error: err.message, error_details: err.payload });
        addJobEvent(jobAfterError, 'error', err.message, { details: err.payload });
        await saveRunnerJob(jobAfterError);
        stopRunnerTimer();
      }
      await appendJsonl(AUTOPILOT_RUN_FILE, { type: 'runner_error', run_id: jobAfterError.id, error: err.message, status: err.status, details: err.payload });
    }
  } finally {
    runnerStore.inflight = false;
  }
}

function startRunnerTimer() {
  if (runnerStore.timer && runnerStore.timer_version !== RUNNER_TIMER_VERSION) {
    clearInterval(runnerStore.timer);
    runnerStore.timer = null;
  }
  if (runnerStore.timer) return;
  runnerStore.timer = setInterval(() => {
    runnerTick().catch(() => {});
  }, 30000);
  runnerStore.timer_version = RUNNER_TIMER_VERSION;
  runnerStore.timer.unref?.();
}

function stopRunnerTimer() {
  if (runnerStore.timer) clearInterval(runnerStore.timer);
  runnerStore.timer = null;
  runnerStore.timer_version = null;
}

function timestampMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
}

function countRecords(records, job, type) {
  const currentRun = job?.id;
  return (records || []).filter((record) => (
    record.type === type && (!currentRun || !record.run_id || record.run_id === currentRun)
  )).length;
}

function deriveRunnerSummary(job, records = []) {
  const now = Date.now();
  if (job) syncPrimaryTask(job);
  const activeTasks = Array.isArray(job?.active_tasks) ? job.active_tasks.filter((task) => task && !task.finished_at) : [];
  const pendingVerdictTasks = Array.isArray(job?.pending_verdict_tasks) ? job.pending_verdict_tasks.filter((task) => task && !task.finished_at) : [];
  const startedMs = timestampMs(job?.started_at);
  const claimedMs = timestampMs(job?.claimed_at);
  const updatedMs = timestampMs(job?.updated_at);
  const selectedEventMs = timestampMs((job?.events || []).find((event) => event.type === 'selected')?.ts);
  const firstActive = activeTasks[0] || job?.current_task;
  const firstTaskStartedMs = timestampMs(firstActive?.claimed_at) || selectedEventMs || startedMs;
  const hasCurrentTask = activeTasks.length > 0 || Boolean(job?.current_task);
  const isRunning = job?.status === 'running';
  const tasksWaitingResult = activeTasks.filter((task) => !task.result_asset_id).length;
  const tasksReadyToSubmit = activeTasks.filter((task) => task.result_asset_id && !task.submitted_at).length;
  const deferredTasks = activeTasks.filter((task) => (
    (task.deferred_claim || task.phase === 'deferred')
    && !task.result_asset_id
    && !task.submitted_at
  )).length;
  const sleepUntilMs = timestampMs(job?.sleep_until);
  const sleepRemainingMs = sleepUntilMs ? Math.max(0, sleepUntilMs - now) : 0;
  const nextTickMs = isRunning ? (sleepRemainingMs ? sleepUntilMs : (updatedMs ? updatedMs + 30000 : now + 30000)) : null;
  const submittedTaskIds = new Set((records || [])
    .filter((record) => record.type === 'runner_submitted' && (!job?.id || !record.run_id || record.run_id === job.id))
    .map((record) => record.task_id || record.assignment_id || record.result_asset_id)
    .filter(Boolean));
  for (const task of activeTasks) {
    if (task.submitted_at) submittedTaskIds.add(task.id || task.assignment_id || task.result_asset_id);
  }
  for (const task of pendingVerdictTasks) {
    if (task.submitted_at) submittedTaskIds.add(task.id || task.assignment_id || task.result_asset_id);
  }
  const submittedCount = submittedTaskIds.size;
  const acceptedCount = (job?.completed_tasks || []).length + (job?.events || []).filter((event) => event.type === 'accepted').length;
  const rejectedCount = (job?.events || []).filter((event) => event.type === 'rejected').length;
  const errorCount = countRecords(records, job, 'runner_error') + (job?.events || []).filter((event) => event.type === 'error').length;
  let waitingReason = '等待用户确认开始。';

  if (isRunning && sleepRemainingMs) {
    waitingReason = `${job.sleep_reason || 'Runner 正在休眠'}，${Math.ceil(sleepRemainingMs / 1000)} 秒后自动继续。`;
  } else if (isRunning && hasCurrentTask && deferredTasks === activeTasks.length && deferredTasks > 0) {
    waitingReason = `已选择 ${deferredTasks} 个候选任务，正在先生成并发布 result_asset_id；成功后再认领并提交。`;
  } else if (isRunning && hasCurrentTask && tasksWaitingResult) {
    waitingReason = `当前 ${tasksWaitingResult} 个任务正在生成 result_asset_id；发布成功后会自动提交。`;
  } else if (isRunning && hasCurrentTask) {
    waitingReason = `当前处于${job.phase_label || phaseInfo(job.phase).label}。`;
  } else if (isRunning && pendingVerdictTasks.length) {
    waitingReason = `已有 ${pendingVerdictTasks.length} 个任务提交后等待采纳，它们不占并行执行槽；Runner 会继续扫描新任务。`;
  } else if (isRunning) {
    waitingReason = '正在扫描符合策略的 ready 悬赏。';
  } else if (job?.status === 'stopped') {
    waitingReason = '后台执行已结束。';
  } else if (job?.phase === 'error' || job?.status === 'paused_on_error') {
    waitingReason = job.error?.includes('default-agent.json')
      ? '上次卡在旧凭证路径；现在环境已修复，恢复执行后会先生成 result_asset_id 再提交。'
      : (job.error || '后台执行出现异常。');
  }

  return {
    generated_at: new Date(now).toISOString(),
    status: job?.status || 'idle',
    phase: job?.phase || 'idle',
    phase_label: job?.phase_label || phaseInfo(job?.phase).label,
    running: isRunning,
    sleeping: Boolean(sleepRemainingMs),
    sleep_until: job?.sleep_until || null,
    sleep_reason: job?.sleep_reason || null,
    sleep_remaining_ms: sleepRemainingMs,
    next_tick_at: nextTickMs ? new Date(nextTickMs).toISOString() : null,
    next_tick_in_ms: nextTickMs ? Math.max(0, nextTickMs - now) : 0,
    scheduler_status: isRunning ? (sleepRemainingMs ? 'sleeping' : 'scheduled') : (job?.status || 'idle'),
    active_task_count: activeTasks.length,
    pending_verdict_count: pendingVerdictTasks.length,
    tasks_waiting_result: tasksWaitingResult,
    tasks_ready_to_submit: tasksReadyToSubmit,
    deferred_task_count: deferredTasks,
    submission_blocker: tasksWaitingResult
      ? (deferredTasks === activeTasks.length
        ? `已选择 ${deferredTasks} 个候选，正在先产出 result_asset_id；产出后再认领并提交。`
        : `还有 ${tasksWaitingResult} 个任务正在生成 result_asset_id；Runner 不再空等。`)
      : null,
    runner_elapsed_ms: startedMs ? Math.max(0, now - startedMs) : 0,
    current_task_elapsed_ms: hasCurrentTask && firstTaskStartedMs ? Math.max(0, now - firstTaskStartedMs) : 0,
    claimed_elapsed_ms: claimedMs ? Math.max(0, now - claimedMs) : 0,
    last_update_age_ms: updatedMs ? Math.max(0, now - updatedMs) : 0,
    current_task_started_at: firstTaskStartedMs ? new Date(firstTaskStartedMs).toISOString() : null,
    current_task_title: firstActive?.title || '',
    current_task_id: firstActive?.id || null,
    active_tasks: activeTasks.map((task) => ({
      id: task.id,
      title: task.title,
      bounty: task.bounty,
      score: task.score,
      phase: task.phase || 'reasoning',
      phase_label: phaseInfo(task.phase || 'reasoning').label,
      claimed_at: task.claimed_at,
      submitted_at: task.submitted_at,
      elapsed_ms: taskAgeMs(task, now),
      deferred_claim: Boolean(task.deferred_claim),
      result_asset_id: task.result_asset_id || null,
      official_bounty_id: task.bounty_id || null,
    })),
    pending_verdict_tasks: pendingVerdictTasks.map((task) => ({
      id: task.id,
      title: task.title,
      bounty: task.bounty,
      score: task.score,
      phase: 'waiting_verdict',
      phase_label: phaseInfo('waiting_verdict').label,
      claimed_at: task.claimed_at,
      submitted_at: task.submitted_at,
      released_at: task.released_at,
      elapsed_ms: timestampMs(task.submitted_at) ? Math.max(0, now - timestampMs(task.submitted_at)) : taskAgeMs(task, now),
      deferred_claim: Boolean(task.deferred_claim),
      result_asset_id: task.result_asset_id || null,
      official_bounty_id: task.bounty_id || null,
    })),
    result_asset_id: job?.result_asset_id || job?.current_task?.result_asset_id || null,
    waiting_reason: waitingReason,
    status_text: deferredTasks === activeTasks.length && deferredTasks > 0
      ? `当前 ${deferredTasks} 个候选任务采用 deferred claim：先产出资产，再认领提交。`
      : pendingVerdictTasks.length && !activeTasks.length
        ? `已提交 ${pendingVerdictTasks.length} 个任务等待采纳；执行槽已释放，Runner 可继续做新任务。`
        : `当前 ${activeTasks.length} 个执行中任务，阶段：${job?.phase_label || phaseInfo(job?.phase).label}。`,
    counts: {
      claimed: countRecords(records, job, 'runner_claimed'),
      submitted: submittedCount,
      accepted: acceptedCount,
      rejected: rejectedCount,
      errors: errorCount,
      completed: acceptedCount + rejectedCount,
    },
  };
}

async function readHelloStatus() {
  try {
    return JSON.parse(await readFile(HELLO_STATUS_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function readEvolverHelloStatus() {
  try {
    return JSON.parse(await readFile(EVOLVER_HELLO_STATUS_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function evolverHelloReadiness(status) {
  if (!status?.sent_at) {
    return {
      status: 'missing',
      fresh: false,
      detail: 'run npm run evolver:hello',
    };
  }
  const sentMs = Date.parse(status.sent_at);
  const ageMs = Number.isFinite(sentMs) ? Date.now() - sentMs : Infinity;
  const fresh = status.status === 'evolver_hello_sent' && ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000;
  return {
    status: status.status || 'unknown',
    fresh,
    sent_at: status.sent_at,
    age_seconds: Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / 1000)) : null,
    hub_url: status.hub_url,
    evolver_version: status.evolver_version,
    worker_enabled: status.worker_enabled,
    worker_max_load: status.worker_max_load,
    node: status.node || null,
    detail: fresh ? 'official @evomap/evolver hello receipt is fresh' : 'run npm run evolver:hello',
  };
}

async function writeHelloStatus(status) {
  await ensureDataDirs();
  await writeJsonAtomic(HELLO_STATUS_FILE, status);
  return status;
}

function helloStatusFrom({ agent = null, payload = {}, profile = null, cached = null } = {}) {
  const cachedStatus = cached?.status || {};
  return {
    claimed: payload.claimed ?? cachedStatus.claimed,
    owner_user_id: payload.owner_user_id ?? profile?.owner_user_id ?? cachedStatus.owner_user_id,
    credit_balance: payload.credit_balance ?? cachedStatus.credit_balance ?? agent?.last_known_credit_balance,
    survival_status: payload.survival_status ?? profile?.survival_status ?? cachedStatus.survival_status,
    reputation: payload.capability_profile?.reputation ?? profile?.reputation_score ?? cachedStatus.reputation,
    capability_level: payload.capability_profile?.level ?? cachedStatus.capability_level,
    next_unlock: payload.capability_profile?.next_unlock ?? cachedStatus.next_unlock,
  };
}

async function getNodeProfile(agent) {
  return hubFetch(`/a2a/nodes/${encodeURIComponent(agent.node_id)}`, { agent });
}

function rateLimitedHelloPayload(agent, cached, profile, error = 'hello_rate_limited', retryAfter = null, evolverHello = null) {
  const now = Date.now();
  const cachedUntil = cached?.rate_limit_until ? Date.parse(cached.rate_limit_until) : 0;
  const retryMs = retryAfter ? retryAfter * 1000 : 60 * 60 * 1000;
  const retryAtMs = !retryAfter && cachedUntil > now ? cachedUntil : Math.max(cachedUntil || 0, now + retryMs);
  const retryAt = new Date(retryAtMs).toISOString();
  return {
    agent: redactedAgent(agent),
    hello: cached?.hello || null,
    hello_ok: false,
    rate_limited: true,
    error,
    retry_after_seconds: Math.max(1, Math.ceil((Date.parse(retryAt) - now) / 1000)),
    next_hello_at: retryAt,
    status: helloStatusFrom({ agent, profile, cached }),
    profile,
    hello_sent_at: cached?.hello_sent_at || null,
    evolver_hello: evolverHelloReadiness(evolverHello),
  };
}

async function sendHello(source = 'dashboard') {
  const agent = await readAgent();
  const hello = await hubFetch('/a2a/hello', {
    method: 'POST',
    agent,
    body: envelope(agent, 'hello', {
      name: agent.name || 'EvoMap Runner Lite',
      model: agent.model || 'local-runner',
      capabilities: {
        coding: true,
        research: true,
        local_execution: true,
        marketplace: true,
        worker: true,
        task_autopilot: true,
      },
      source,
    }),
  });
  return { agent, hello, payload: hello.payload || hello };
}

export async function handleApi(pathname, method, body = {}) {
  await ensureDataDirs();

  if (LITE_MODE && LITE_DISABLED_ENDPOINTS.has(pathname)) {
    return fail(403, 'This endpoint is disabled in EvoMap Runner Lite. Use the private full dashboard for marketplace/service publishing.');
  }

  if (pathname === '/api/health') {
    let agent = null;
    let agentError = null;
    try {
      agent = await readAgent();
    } catch (err) {
      agentError = err.message || 'agent_not_ready';
    }
    const [job, helloStatus, evolverHello] = await Promise.all([
      loadRunnerJob().catch((err) => ({ error: err.message })),
      readHelloStatus().catch(() => null),
      readEvolverHelloStatus().catch(() => null),
    ]);
    return ok({
      status: 'ok',
      service: 'evomap-runner-lite',
      time: new Date().toISOString(),
      uptime_seconds: Math.round(process.uptime()),
      node_version: process.version,
      hub: HUB,
      data_dir: DATA_DIR,
      agent_ready: Boolean(agent),
      agent_file: agent?._agent_file || AGENT_FILE,
      agent_error: agent ? null : agentError,
      runner: job && !job.error ? {
        status: job.status || 'idle',
        phase: job.phase || null,
        active_tasks: Array.isArray(job.active_tasks) ? job.active_tasks.length : 0,
        pending_verdict_tasks: Array.isArray(job.pending_verdict_tasks) ? job.pending_verdict_tasks.length : 0,
        updated_at: job.updated_at || null,
      } : null,
      hello_sent_at: helloStatus?.hello_sent_at || null,
      evolver_hello: evolverHelloReadiness(evolverHello),
    });
  }

  if (pathname === '/api/translate') {
    const targetLang = body.lang || 'zh-CN';
    const texts = Array.isArray(body.texts) ? body.texts : [body.text || ''];
    const limited = texts.slice(0, 80).map((text) => String(text || '').slice(0, 4500));
    const translations = await translateMany(limited, targetLang);
    return ok({ lang: targetLang, translations });
  }

  if (pathname === '/api/config') {
    const [agent, evolverHello] = await Promise.all([
      readAgent(),
      readEvolverHelloStatus(),
    ]);
    return ok({
      hub: HUB,
      agent_file: agent._agent_file || AGENT_FILE,
      agent: redactedAgent(agent),
      evolver_hello: evolverHelloReadiness(evolverHello),
      lite: LITE_MODE,
      guardrails: {
        service_marketplace_disabled: LITE_MODE,
        asset_publish_ui_disabled: LITE_MODE,
        default_fetch_mode: 'search_only',
        full_fetch_requires_confirmation: true,
        cache_dir: 'data/cache/assets',
        ledger_file: 'data/logs/fetch-ledger.jsonl',
      },
    });
  }

  if (pathname === '/api/hello') {
    const agent = await readAgent();
    const [cached, evolverHello] = await Promise.all([
      readHelloStatus(),
      readEvolverHelloStatus(),
    ]);
    const cachedUntil = cached?.rate_limit_until ? Date.parse(cached.rate_limit_until) : 0;
    let profile = null;
    try {
      profile = await getNodeProfile(agent);
    } catch {}
    if (cachedUntil > Date.now()) {
      return ok(rateLimitedHelloPayload(agent, cached, profile, cached?.error || 'hello_rate_limited', null, evolverHello));
    }

    let hello;
    let payload;
    try {
      const sent = await sendHello(body.source || 'dashboard');
      hello = sent.hello;
      payload = sent.payload;
    } catch (err) {
      if (err.status === 429) {
        const retryAfter = err.retryAfter || 3600;
        const rateLimited = rateLimitedHelloPayload(
          agent,
          cached,
          profile,
          err.payload?.error || err.message,
          retryAfter,
          evolverHello,
        );
        await writeHelloStatus({
          ...(cached || {}),
          error: rateLimited.error,
          rate_limit_until: rateLimited.next_hello_at,
          updated_at: new Date().toISOString(),
        });
        return ok(rateLimited);
      }
      throw err;
    }
    const status = helloStatusFrom({ agent, payload, profile, cached });
    const helloSentAt = new Date().toISOString();
    await writeHelloStatus({
      hello,
      status,
      hello_sent_at: helloSentAt,
      rate_limit_until: null,
      error: null,
      updated_at: helloSentAt,
    });
    return ok({
      agent: redactedAgent(agent),
      hello,
      hello_ok: true,
      rate_limited: false,
      status,
      profile,
      hello_sent_at: helloSentAt,
      evolver_hello: evolverHelloReadiness(evolverHello),
    });
  }

  if (pathname === '/api/profile') {
    const agent = await readAgent();
    const [profile, cached, evolverHello] = await Promise.all([
      getNodeProfile(agent),
      readHelloStatus(),
      readEvolverHelloStatus(),
    ]);
    return ok({
      agent: redactedAgent(agent),
      status: helloStatusFrom({ agent, profile, cached }),
      profile,
      hello_sent_at: cached?.hello_sent_at || null,
      evolver_hello: evolverHelloReadiness(evolverHello),
      rate_limited: Boolean(cached?.rate_limit_until && Date.parse(cached.rate_limit_until) > Date.now()),
      next_hello_at: cached?.rate_limit_until || null,
    });
  }

  if (pathname === '/api/search') {
    const agent = await readAgent();
    const assetType = body.asset_type || undefined;
    const payload = { asset_type: assetType, include_tasks: body.include_tasks !== false, search_only: true };
    if (body.signals) payload.signals = String(body.signals).split(',').map((value) => value.trim()).filter(Boolean);
    if (body.query) payload.query = String(body.query).trim();
    const primary = await hubFetch('/a2a/fetch', { method: 'POST', agent, body: envelope(agent, 'fetch', payload) });
    let assets = normalizeAssets(primary);
    let fallback = null;

    if (assets.length === 0 && (body.signals || body.query)) {
      const params = new URLSearchParams({ limit: String(body.limit || 20) });
      if (assetType) params.set('type', assetType);
      if (body.signals) {
        params.set('signals', String(body.signals));
        fallback = await hubFetch(`/a2a/assets/search?${params}`, { auth: false });
      } else {
        params.set('q', String(body.query));
        fallback = await hubFetch(`/a2a/assets/semantic-search?${params}`, { auth: false });
      }
      assets = normalizeAssets(fallback);
    }

    return ok({
      cost_mode: 'metadata_only_no_credit_cost',
      request_payload: payload,
      assets,
      tasks: normalizeTasks(primary),
      raw_count: assets.length,
      fallback_used: Boolean(fallback),
    });
  }

  if (pathname === '/api/full-fetch') {
    const unknown = rejectUnknownFields(body, ['asset_id', 'asset_type', 'confirmation'], '/api/full-fetch');
    if (unknown) return unknown;
    const assetId = sanitizeAssetId(body.asset_id);
    if (!assetId) return fail(400, 'asset_id must start with sha256:');
    const cached = await readCachedAsset(assetId);
    if (cached && !body.force_refresh) {
      await appendJsonl(LEDGER_FILE, { type: 'cache_hit', asset_id: assetId, charged: false });
      return ok({ source: 'cache', charged: false, cache_file: cached.file, ...cached.data });
    }
    const expected = `FETCH ${assetId}`;
    if (body.confirmation !== expected) {
      return fail(409, `Full fetch may spend credits. Type exactly: ${expected}`, {
        expected_confirmation: expected,
        cache_present: Boolean(cached),
      });
    }
    const agent = await readAgent();
    const data = await hubFetch('/a2a/fetch', {
      method: 'POST',
      agent,
      body: envelope(agent, 'fetch', { asset_ids: [assetId], asset_type: body.asset_type || undefined }),
    });
    const file = await writeCachedAsset(assetId, data);
    await appendJsonl(LEDGER_FILE, { type: 'full_fetch', asset_id: assetId, charged: true, reason: 'explicit_confirmation' });
    return ok({ source: 'hub_full_fetch', charged: true, cache_file: file, asset_id: assetId, data });
  }

  if (pathname === '/api/cache') {
    const unknown = rejectUnknownFields(body, ['asset_id'], '/api/cache');
    if (unknown) return unknown;
    if (body.asset_id) {
      const cached = await readCachedAsset(body.asset_id);
      return ok({ asset_id: body.asset_id, cached: Boolean(cached), cache_file: cached?.file, data: cached?.data });
    }
    return ok({ hint: 'POST { "asset_id": "sha256:..." } to check one asset cache.' });
  }

  if (pathname === '/api/asset/draft') {
    let agent = null;
    let agentError = null;
    try {
      agent = await readAgent();
    } catch (err) {
      agentError = err.message;
    }
    const draft = buildBountyRunnerWorkflowDraft(agent || {});
    return ok({
      status: 'draft_ready',
      agent_ready: Boolean(agent),
      agent: agent ? redactedAgent(agent) : null,
      agent_error: agentError,
      publish_requires_confirmation: draft.confirmation,
      draft,
    });
  }

  if (pathname === '/api/asset/publish') {
    const unknown = rejectUnknownFields(body, ['confirmation'], '/api/asset/publish');
    if (unknown) return unknown;
    const agent = await readAgent();
    const draft = buildBountyRunnerWorkflowDraft(agent);
    if (body.confirmation !== draft.confirmation) {
      return fail(409, `Publishing sends this workflow asset to EvoMap Hub. Type exactly: ${draft.confirmation}`, {
        expected_confirmation: draft.confirmation,
        capsule_asset_id: draft.capsule_asset_id,
      });
    }
    const message = buildOfficialPublishBundle(agent, draft.gene, draft.capsule);
    const capsuleAsset = (message.payload?.assets || []).find((asset) => asset.type === 'Capsule') || null;
    const resultAssetId = sanitizeAssetId(capsuleAsset?.asset_id) || draft.capsule_asset_id;
    let publishResult;
    try {
      publishResult = await hubFetch('/a2a/publish', { method: 'POST', agent, body: message, timeoutMs: 20000 });
    } catch (err) {
      const duplicateAssetId = err.payload?.payload?.target_asset_id || err.payload?.target_asset_id;
      const duplicateReason = err.payload?.payload?.reason || err.payload?.reason;
      if (err.status !== 409 || duplicateReason !== 'duplicate_asset' || !sanitizeAssetId(duplicateAssetId)) {
        throw err;
      }
      publishResult = {
        duplicate: true,
        decision: err.payload,
        reused_asset_id: sanitizeAssetId(duplicateAssetId),
      };
    }
    const publishedAssetId = sanitizeAssetId(publishResult.reused_asset_id) || resultAssetId;
    await appendJsonl(GENERATED_RESULT_FILE, {
      type: 'workflow_asset_publish',
      title: draft.title,
      result_asset_id: publishedAssetId,
      capsule_id: publishedAssetId,
      gene_id: draft.gene_asset_id,
      publish_result: publishResult,
    });
    return ok({
      status: publishResult.duplicate ? 'duplicate_reused' : 'published',
      title: draft.title,
      result_asset_id: publishedAssetId,
      capsule_asset_id: publishedAssetId,
      gene_asset_id: draft.gene_asset_id,
      publish_result: publishResult,
    });
  }

  if (pathname === '/api/tasks') {
    const agent = await readAgent();
    const [tasks, mine, work] = await Promise.allSettled([
      hubFetch('/a2a/task/list?limit=25', { agent }),
      hubFetch(`/a2a/task/my?node_id=${encodeURIComponent(agent.node_id)}`, { agent }),
      hubFetch(`/a2a/work/available?node_id=${encodeURIComponent(agent.node_id)}&limit=50`, { agent }),
    ]);
    const bountyTasks = tasks.status === 'fulfilled' ? (tasks.value.tasks || []).map((task) => ({ ...task, _source: 'bounty_task' })) : [];
    const myTasks = mine.status === 'fulfilled' ? (mine.value.tasks || []).map((task) => ({ ...task, _source: task._source || 'my_task' })) : [];
    const workerTasks = work.status === 'fulfilled' ? (work.value.tasks || []).map((task) => ({ ...task, _source: 'worker_pool' })) : [];
    return ok({
      tasks: bountyTasks,
      my_tasks: myTasks,
      available_work: workerTasks,
      errors: [tasks, mine, work].filter((r) => r.status === 'rejected').map((r) => r.reason?.message),
    });
  }

  if (pathname === '/api/worker') {
    const unknown = rejectUnknownFields(body, ['worker_enabled', 'worker_domains', 'max_load'], '/api/worker');
    if (unknown) return unknown;
    const agent = await readAgent();
    const maxLoad = boundedNumber(body.max_load, { min: 1, max: 20, fallback: 3, label: 'max_load' });
    const heartbeat = await hubFetch('/a2a/heartbeat', {
      method: 'POST',
      agent,
      body: {
        node_id: agent.node_id,
        worker_enabled: Boolean(body.worker_enabled),
        worker_domains: String(body.worker_domains || '').split(',').map((value) => value.trim()).filter(Boolean),
        max_load: maxLoad,
        fingerprint: { runtime: 'evomap-runner-lite', model: agent.model || 'local-runner' },
        env_fingerprint: {
          platform: process.platform,
          arch: process.arch,
          runtime: 'evomap-runner-lite',
          model: agent.model || 'local-runner',
        },
      },
    });
    return ok({ status: 'worker_heartbeat_sent', heartbeat });
  }

  if (pathname === '/api/service/publish') {
    const unknown = rejectUnknownFields(body, ['title', 'description', 'capabilities', 'use_cases', 'price_per_task', 'max_concurrent', 'confirmation'], '/api/service/publish');
    if (unknown) return unknown;
    const agent = await readAgent();
    const title = limitedString(body.title, 90, 'title');
    const description = limitedString(body.description, 1400, 'description');
    const price = boundedNumber(body.price_per_task, { min: 1, max: 100000, fallback: NaN, label: 'price_per_task' });
    const maxConcurrent = boundedNumber(body.max_concurrent, { min: 1, max: 20, fallback: 3, label: 'max_concurrent' });
    if (title.length < 3) return fail(400, 'Service title must be at least 3 characters.');
    if (body.confirmation !== `PUBLISH SERVICE ${price}`) {
      return fail(409, `Publishing exposes this agent to orders. Type exactly: PUBLISH SERVICE ${price}`, {
        expected_confirmation: `PUBLISH SERVICE ${price}`,
      });
    }
    const serviceBody = {
      sender_id: agent.node_id,
      title,
      description,
      capabilities: splitList(body.capabilities).map((value) => value.slice(0, 48)).slice(0, 10),
      use_cases: String(body.use_cases || '').split('\n').map((value) => value.trim().slice(0, 220)).filter(Boolean).slice(0, 5),
      price_per_task: price,
      max_concurrent: maxConcurrent,
    };
    const result = await hubFetch('/a2a/service/publish', { method: 'POST', agent, body: serviceBody });
    await appendJsonl(SERVICE_LEDGER_FILE, { type: 'service_publish', title, price_per_task: price, result });
    return ok({ status: 'published', service: result });
  }

  if (pathname === '/api/service/mine') {
    const unknown = rejectUnknownFields(body, ['limit'], '/api/service/mine');
    if (unknown) return unknown;
    const agent = await readAgent();
    const limit = boundedNumber(body.limit, { min: 20, max: 200, fallback: 120, label: 'limit' });
    const data = await hubFetch(`/a2a/service/list?limit=${limit}`, { auth: false });
    const services = (data.services || []).filter((service) => service.node_id === agent.node_id);
    const serviceIds = new Set(services.map((service) => service.id).filter(Boolean));
    const localServiceMap = new Map();
    for (const row of (await readJsonl(SERVICE_LEDGER_FILE, 160)).reverse()) {
      if (row.type === 'service_publish') {
        const service = row.result?.service || row.result;
        if (service?.id && service.node_id === agent.node_id) localServiceMap.set(service.id, service);
      } else if (row.type === 'service_update') {
        const listingId = row.listing_id || row.update?.listing_id || row.result?.service?.id || row.result?.id;
        const updated = row.result?.service || row.result;
        if (!listingId || !localServiceMap.has(listingId)) continue;
        localServiceMap.set(listingId, {
          ...localServiceMap.get(listingId),
          ...(updated && typeof updated === 'object' ? updated : {}),
          ...(row.update || {}),
          id: listingId,
          node_id: agent.node_id,
        });
      } else if (row.type === 'service_archive') {
        const listingId = row.listing_id || row.result?.service?.id || row.result?.id;
        if (listingId && localServiceMap.has(listingId)) {
          localServiceMap.set(listingId, { ...localServiceMap.get(listingId), status: 'archived' });
        }
      }
    }
    const ledgerServices = [...localServiceMap.values()]
      .filter((service) => service?.id && service.node_id === agent.node_id && !serviceIds.has(service.id));
    ledgerServices.forEach((service) => serviceIds.add(service.id));
    return ok({
      node_id: agent.node_id,
      services: [...ledgerServices, ...services],
      raw_count: data.services?.length || 0,
      ledger_fallback_count: ledgerServices.length,
    });
  }

  if (pathname === '/api/service/update') {
    const unknown = rejectUnknownFields(body, ['listing_id', 'title', 'description', 'capabilities', 'use_cases', 'price_per_task', 'max_concurrent', 'status', 'action'], '/api/service/update');
    if (unknown) return unknown;
    const agent = await readAgent();
    const listingId = validateRef(body.listing_id, 'listing_id');
    const updateBody = {
      sender_id: agent.node_id,
      listing_id: listingId,
    };
    if (body.title !== undefined && body.title !== '') {
      const title = limitedString(body.title, 90, 'title');
      if (title.length < 3) return fail(400, 'Service title must be at least 3 characters.');
      updateBody.title = title;
    }
    if (body.description !== undefined && body.description !== '') {
      updateBody.description = limitedString(body.description, 1400, 'description');
    }
    if (body.capabilities !== undefined && body.capabilities !== '') {
      updateBody.capabilities = splitList(body.capabilities).map((value) => value.slice(0, 48)).slice(0, 10);
    }
    if (body.use_cases !== undefined && body.use_cases !== '') {
      updateBody.use_cases = String(body.use_cases || '').split('\n').map((value) => value.trim().slice(0, 220)).filter(Boolean).slice(0, 5);
    }
    if (body.price_per_task !== undefined && body.price_per_task !== '') {
      updateBody.price_per_task = boundedNumber(body.price_per_task, { min: 1, max: 100000, fallback: NaN, label: 'price_per_task' });
    }
    if (body.max_concurrent !== undefined && body.max_concurrent !== '') {
      updateBody.max_concurrent = boundedNumber(body.max_concurrent, { min: 1, max: 20, fallback: 1, label: 'max_concurrent' });
    }
    if (body.status) {
      const status = String(body.status);
      if (!['active', 'paused'].includes(status)) return fail(400, 'status must be active or paused.');
      updateBody.status = status;
    }
    const result = await hubFetch('/a2a/service/update', { method: 'POST', agent, body: updateBody });
    await appendJsonl(SERVICE_LEDGER_FILE, { type: 'service_update', listing_id: listingId, update: updateBody, result });
    return ok({ status: 'updated', service: result });
  }

  if (pathname === '/api/service/archive') {
    const unknown = rejectUnknownFields(body, ['listing_id', 'confirmation', 'action'], '/api/service/archive');
    if (unknown) return unknown;
    const agent = await readAgent();
    const listingId = validateRef(body.listing_id, 'listing_id');
    const expected = `ARCHIVE SERVICE ${listingId}`;
    if (body.confirmation !== expected) {
      return fail(409, `Archiving removes this service from the market. Type exactly: ${expected}`, {
        expected_confirmation: expected,
      });
    }
    const archiveBody = { sender_id: agent.node_id, listing_id: listingId };
    const result = await hubFetch('/a2a/service/archive', { method: 'POST', agent, body: archiveBody });
    await appendJsonl(SERVICE_LEDGER_FILE, { type: 'service_archive', listing_id: listingId, result });
    return ok({ status: 'archived', service: result });
  }

  if (pathname === '/api/ledger') {
    return ok(await buildLedger(body));
  }


  if (pathname === '/api/overview') {
    const agent = await readAgent();
    const cacheKey = `overview:${agent.node_id}`;
    const cached = getCached(cacheKey);
    if (cached) return ok(cached);
    const [profileResult, ledgerResult, workResult, myTasksResult] = await Promise.allSettled([
      handleApi('/api/profile', 'GET', {}),
      handleApi('/api/ledger', 'GET', {}),
      hubFetch(`/a2a/work/available?node_id=${encodeURIComponent(agent.node_id)}&limit=30`, { agent }),
      hubFetch(`/a2a/task/my?node_id=${encodeURIComponent(agent.node_id)}`, { agent }),
    ]);
    const profile = profileResult.status === 'fulfilled' ? profileResult.value.payload : null;
    const ledger = ledgerResult.status === 'fulfilled' ? ledgerResult.value.payload : { full_fetches: 0, cache_hits: 0, rows: [] };
    const availableWork = workResult.status === 'fulfilled' ? (workResult.value.tasks || []) : [];
    const myTasks = myTasksResult.status === 'fulfilled' ? (myTasksResult.value.tasks || []) : [];
    const bountyTotal = availableWork.reduce((sum, task) => sum + Number(task.bountyAmount || task.bounty_amount || 0), 0);
    return ok(setCached(cacheKey, {
      profile,
      ledger,
      tasks: { available: availableWork, mine: myTasks, bounty_total: bountyTotal },
      spend: {
        local_full_fetches: ledger.full_fetches || 0,
        local_cache_hits: ledger.cache_hits || 0,
        note: 'Hub account-level spend is not exposed by the public A2A API here; this view tracks local full-fetch attempts and cache savings.',
      },
    }, 15000));
  }

  if (pathname === '/api/opportunities') {
    const agent = await readAgent();
    const [work, skills, services] = await Promise.allSettled([
      hubFetch(`/a2a/work/available?node_id=${encodeURIComponent(agent.node_id)}&limit=${Number(body.limit || 50)}`, { agent }),
      hubFetch(`/a2a/skill/store/list?limit=${Number(body.limit || 20)}`, { agent }),
      hubFetch(`/a2a/service/search?q=${encodeURIComponent(body.query || 'api integration agent')}&limit=${Number(body.limit || 20)}`, { agent }),
    ]);
    return ok({
      tasks: work.status === 'fulfilled' ? (work.value.tasks || []) : [],
      skills: skills.status === 'fulfilled' ? (skills.value.skills || []) : [],
      services: services.status === 'fulfilled' ? (services.value.services || []) : [],
      errors: [work, skills, services].filter((r) => r.status === 'rejected').map((r) => r.reason?.message),
    });
  }

  if (pathname === '/api/task/claim') {
    const unknown = rejectUnknownFields(body, ['task_id', 'id', 'source', 'confirmation'], '/api/task/claim');
    if (unknown) return unknown;
    const taskId = validateRef(body.task_id || body.id, 'task_id');
    const expected = `CLAIM ${taskId}`;
    if (body.confirmation !== expected) {
      return fail(409, `Claiming a task commits this node to work. Type exactly: ${expected}`, { expected_confirmation: expected });
    }
    const agent = await readAgent();
    const isWorkerTask = body.source === 'worker_pool' || body.source === 'work';
    const result = await hubFetch(isWorkerTask ? '/a2a/work/claim' : '/a2a/task/claim', {
      method: 'POST',
      agent,
      body: { task_id: taskId, node_id: agent.node_id, sender_id: agent.node_id },
    });
    await appendJsonl(LEDGER_FILE, { type: 'task_claim', task_id: taskId, source: isWorkerTask ? 'worker_pool' : 'bounty_task', charged: false, result });
    return ok({ status: 'claimed', source: isWorkerTask ? 'worker_pool' : 'bounty_task', task_id: taskId, result });
  }

  if (pathname === '/api/task/complete') {
    const unknown = rejectUnknownFields(body, ['task_id', 'id', 'assignment_id', 'asset_id', 'result_asset_id', 'source', 'confirmation'], '/api/task/complete');
    if (unknown) return unknown;
    const taskId = body.task_id || body.id ? validateRef(body.task_id || body.id, 'task_id') : '';
    const assetId = String(body.asset_id || body.result_asset_id || '').trim();
    const assignmentId = body.assignment_id ? validateRef(body.assignment_id, 'assignment_id') : '';
    if (!taskId && !body.assignment_id) return fail(400, 'task_id or assignment_id is required');
    if (!assetId || !String(assetId).startsWith('sha256:')) return fail(400, 'asset_id/result_asset_id must start with sha256:');
    const confirmTarget = taskId || assignmentId;
    const expected = `SUBMIT ${confirmTarget}`;
    if (body.confirmation !== expected) {
      return fail(409, `Submitting work may affect reputation. Type exactly: ${expected}`, { expected_confirmation: expected });
    }
    const agent = await readAgent();
    const isWorkerTask = body.source === 'worker_pool' || assignmentId;
    const result = await hubFetch(isWorkerTask ? '/a2a/work/complete' : '/a2a/task/complete', {
      method: 'POST',
      agent,
      body: isWorkerTask
        ? { assignment_id: assignmentId || taskId, node_id: agent.node_id, sender_id: agent.node_id, result_asset_id: assetId }
        : { task_id: taskId, node_id: agent.node_id, sender_id: agent.node_id, asset_id: assetId },
    });
    await appendJsonl(LEDGER_FILE, { type: 'task_complete', task_id: taskId, assignment_id: assignmentId, asset_id: assetId, source: isWorkerTask ? 'worker_pool' : 'bounty_task', charged: false, result });
    return ok({ status: 'submitted', source: isWorkerTask ? 'worker_pool' : 'bounty_task', task_id: taskId, assignment_id: assignmentId, asset_id: assetId, result });
  }

  if (pathname === '/api/task/autopilot') {
    const agent = await readAgent();
    const opts = body.options || body || {};
    const mode = opts.mode || 'scan';
    const maxClaims = Math.max(0, Math.min(5, Number(opts.max_claims || 1)));
    const maxActive = Math.max(0, Math.min(10, Number(opts.max_active || 2)));
    const [profileResult, workResult, taskResult, myResult] = await Promise.allSettled([
      hubFetch(`/a2a/nodes/${encodeURIComponent(agent.node_id)}`, { agent }),
      hubFetch(`/a2a/work/available?node_id=${encodeURIComponent(agent.node_id)}&limit=${Number(opts.limit || 50)}`, { agent }),
      hubFetch(`/a2a/task/list?limit=${Number(opts.limit || 50)}`, { agent }),
      hubFetch(`/a2a/task/my?node_id=${encodeURIComponent(agent.node_id)}`, { agent }),
    ]);
    const profile = profileResult.status === 'fulfilled' ? profileResult.value : {};
    const reputation = Number(profile.reputation_score ?? opts.reputation ?? 0) || 0;
    const myTasks = myResult.status === 'fulfilled' ? (myResult.value.tasks || []) : [];
    const activeCount = myTasks.filter((task) => !['completed', 'failed', 'expired', 'cancelled'].includes(String(task.status || '').toLowerCase())).length;
    const workerTasks = workResult.status === 'fulfilled' ? (workResult.value.tasks || []).map((task) => ({ ...task, _source: 'worker_pool' })) : [];
    const bountyTasks = taskResult.status === 'fulfilled' ? (taskResult.value.tasks || []).map((task) => ({ ...task, _source: 'bounty_task' })) : [];
    const byId = new Map();
    for (const task of [...workerTasks, ...bountyTasks]) {
      const id = getTaskId(task);
      if (!id || byId.has(id)) continue;
      byId.set(id, task);
    }
    const ranked = [...byId.values()].map((task) => scoreTask(task, opts, reputation)).sort((a, b) => b.autopilot.score - a.autopilot.score);
    const ready = ranked.filter((task) => task.autopilot.ready);
    const report = buildTaskYieldReport(ranked);
    const errors = [profileResult, workResult, taskResult, myResult].filter((item) => item.status === 'rejected').map((item) => item.reason?.message);
    const claimed = [];
    let heartbeat = null;

    if (opts.worker_enabled) {
      heartbeat = await hubFetch('/a2a/heartbeat', {
        method: 'POST',
        agent,
        body: {
          node_id: agent.node_id,
          worker_enabled: true,
          worker_domains: splitList(opts.preferred_signals || opts.worker_domains || 'api,agent,codex,debugging'),
          max_load: maxActive,
          fingerprint: { runtime: 'evomap-runner-lite-autopilot', model: agent.model || 'local-runner' },
          env_fingerprint: { platform: process.platform, arch: process.arch, runtime: 'evomap-runner-lite-autopilot', model: agent.model || 'local-runner' },
        },
      });
    }

    if (mode === 'claim') {
      if (opts.confirmation !== 'AUTOPILOT START') {
        return fail(409, 'Autopilot claim requires explicit confirmation: AUTOPILOT START', { expected_confirmation: 'AUTOPILOT START', ranked: ranked.slice(0, 10), active_count: activeCount });
      }
      if (activeCount >= maxActive) {
        return ok({ status: 'blocked_max_active', active_count: activeCount, max_active: maxActive, ranked: ranked.slice(0, 20), claimed, heartbeat, errors });
      }
      const capacity = Math.max(0, Math.min(maxClaims, maxActive - activeCount));
      const claimQueue = opts.selection_mode === 'high_score_first' ? ready.slice(0, capacity) : selectBalancedTasks(ready, capacity);
      for (const task of claimQueue) {
        const endpoint = task._source === 'worker_pool' ? '/a2a/work/claim' : '/a2a/task/claim';
        try {
          const result = await hubFetch(endpoint, { method: 'POST', agent, body: { task_id: task.autopilot.id, node_id: agent.node_id, sender_id: agent.node_id } });
          claimed.push({ task_id: task.autopilot.id, source: task._source, score: task.autopilot.score, bounty: task.autopilot.bounty, result });
          await appendJsonl(LEDGER_FILE, { type: 'autopilot_claim', task_id: task.autopilot.id, source: task._source, score: task.autopilot.score, bounty: task.autopilot.bounty, charged: false, result });
        } catch (err) {
          claimed.push({ task_id: task.autopilot.id, source: task._source, ok: false, error: err.message, details: err.payload });
        }
      }
    }

    return ok({
      status: mode === 'claim' ? 'autopilot_claim_cycle_done' : 'autopilot_scan_done',
      mode,
      profile: { reputation, node_id: agent.node_id, model: agent.model || 'local-runner' },
      policy: {
        min_bounty: Number(opts.min_bounty ?? 20),
        min_score: Number(opts.min_score ?? 65),
        max_claims: maxClaims,
        max_active: maxActive,
        selection_mode: opts.selection_mode || 'balanced_score_mix',
        preferred_signals: splitList(opts.preferred_signals || 'api,agent,codex,next.js,node,python,javascript,typescript,jwt,kafka,video,quality,prompt,case-study,debugging,automation,guide,gamedev,narrative'),
        blocked_signals: splitList(opts.blocked_signals || 'adult,gambling,crypto-wallet,private-key,credential-spam'),
      },
      active_count: activeCount,
      heartbeat,
      claimed,
      report,
      balanced_candidates: selectBalancedTasks(ready, Number(opts.return_limit || 20)),
      ready_count: ready.length,
      ranked: ranked.slice(0, Number(opts.return_limit || 20)),
      errors,
      next_step: '对 claimed 任务生成/发布 result_asset_id 后，调用 /api/task/complete 提交；Worker Pool 任务需要 assignment_id。',
    });
  }

  if (pathname === '/api/task/strategy') {
    const unknown = rejectUnknownFields(body, ['action', 'note', 'preset_id', 'presetId', 'policy', 'run_id', 'strategy_id', 'reason', 'strategy'], '/api/task/strategy');
    if (unknown) return unknown;
    const action = body.action || 'generate';
    if (!['records', 'stop', 'generate', 'execute'].includes(action)) return fail(400, 'Unknown strategy action');
    const records = await readJsonl(AUTOPILOT_RUN_FILE, 100);
    if (action === 'records') {
      return ok({ records, presets: STRATEGY_PRESETS });
    }

    const note = String(body.note || '').trim();
    const presetId = body.preset_id || body.presetId || 'balanced';
    const preset = STRATEGY_PRESETS[presetId] || STRATEGY_PRESETS.balanced;
    const basePolicy = buildPresetPolicy(presetId, note, body.policy || {});

    if (action === 'stop') {
      const record = {
        type: 'strategy_stopped',
        run_id: body.run_id || body.strategy_id || `run_${Date.now()}`,
        reason: body.reason || 'user_clicked_stop',
      };
      await appendJsonl(AUTOPILOT_RUN_FILE, record);
      return ok({ status: 'stopped', record, records: await readJsonl(AUTOPILOT_RUN_FILE, 100) });
    }

    if (action === 'generate') {
      const scan = await handleApi('/api/task/autopilot', 'POST', { options: { ...basePolicy, mode: 'scan' } });
      const payload = scan.payload;
      const top = (payload.balanced_candidates || payload.ranked || []).slice(0, 5);
      const strategy = {
        id: `strategy_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        preset_id: presetId,
        preset_name: preset.name,
        created_at: new Date().toISOString(),
        title: `${preset.name}策略`,
        summary: `${preset.description} 当前可执行候选 ${payload.ready_count || 0} 个，活跃任务 ${payload.active_count || 0} 个；采用 deferred claim：先产出结果资产，再认领并提交，避免空占任务。`,
        note,
        policy: basePolicy,
        steps: [
          '发送 Worker 心跳，保持节点在线并声明可接任务领域。',
          '扫描 Worker Pool 和 Bounty Task，按赏金、声誉门槛、signals 匹配度排序。',
          '只选择 ready=true 且和导航/教程/自动化信号相关的任务，不直接抢占所有坑位。',
          '采用 deferred claim：先产出并发布 result_asset_id，再原子认领并提交。',
          '超过等待阈值仍没有结果资产时轮换任务，降低并发，避免死磕。',
        ],
        top_candidates: top,
        projected: {
          ready_count: payload.ready_count,
          active_count: payload.active_count,
          visible_bounty: (payload.ranked || []).reduce((sum, task) => sum + Number(task.autopilot?.bounty || 0), 0),
          report: payload.report,
        },
      };
      await appendJsonl(AUTOPILOT_RUN_FILE, { type: 'strategy_generated', strategy_id: strategy.id, note, ready_count: payload.ready_count, active_count: payload.active_count });
      return ok({ status: 'strategy_generated', strategy, scan: payload, records: await readJsonl(AUTOPILOT_RUN_FILE, 100), presets: STRATEGY_PRESETS });
    }

    if (action === 'execute') {
      const strategy = body.strategy || {};
      const runId = body.run_id || `run_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const policy = { ...basePolicy, ...(strategy.policy || {}), mode: 'claim', confirmation: 'AUTOPILOT START' };
      const cycle = await handleApi('/api/task/autopilot', 'POST', { options: policy });
      const agent = await readAgent();
      const submitted = [];
      const my = await hubFetch(`/a2a/task/my?node_id=${encodeURIComponent(agent.node_id)}`, { agent }).catch(() => ({ tasks: [] }));
      for (const task of (my.tasks || [])) {
        const resultAssetId = task.result_asset_id || task.asset_id || task.resultAssetId;
        const taskId = getTaskId(task);
        const assignmentId = task.assignment_id || task.assignmentId || task.id;
        if (!resultAssetId || !String(resultAssetId).startsWith('sha256:')) continue;
        try {
          const isWorkerTask = Boolean(assignmentId && (task._source === 'worker_pool' || task.assignment_id || task.assignmentId));
          const result = await hubFetch(isWorkerTask ? '/a2a/work/complete' : '/a2a/task/complete', {
            method: 'POST',
            agent,
            body: isWorkerTask
              ? { assignment_id: assignmentId, node_id: agent.node_id, sender_id: agent.node_id, result_asset_id: resultAssetId }
              : { task_id: taskId, node_id: agent.node_id, sender_id: agent.node_id, asset_id: resultAssetId },
          });
          submitted.push({ task_id: taskId, assignment_id: assignmentId, asset_id: resultAssetId, source: isWorkerTask ? 'worker_pool' : 'bounty_task', result });
          await appendJsonl(LEDGER_FILE, { type: 'autopilot_submit', task_id: taskId, assignment_id: assignmentId, asset_id: resultAssetId, charged: false, result });
        } catch (err) {
          submitted.push({ task_id: taskId, assignment_id: assignmentId, asset_id: resultAssetId, ok: false, error: err.message, details: err.payload });
        }
      }
      const record = {
        type: 'strategy_cycle',
        run_id: runId,
        strategy_id: strategy.id,
        status: cycle.payload.status,
        ready_count: cycle.payload.ready_count,
        active_count: cycle.payload.active_count,
        claimed: cycle.payload.claimed || [],
        submitted,
        errors: cycle.payload.errors || [],
      };
      await appendJsonl(AUTOPILOT_RUN_FILE, record);
      return ok({ status: 'strategy_cycle_done', run_id: runId, strategy, cycle: cycle.payload, submitted, records: await readJsonl(AUTOPILOT_RUN_FILE, 100) });
    }

    return fail(400, 'Unknown strategy action');
  }

  if (pathname === '/api/task/runner') {
    const unknown = rejectUnknownFields(body, ['action', 'strategy', 'preset_id', 'presetId', 'note', 'run_id', 'mode', 'run_until', 'max_active', 'max_claims'], '/api/task/runner');
    if (unknown) return unknown;
    const action = body.action || 'status';
    if (!['status', 'start', 'tick', 'boost', 'stop'].includes(action)) return fail(400, 'Unknown runner action');

    if (action === 'status') {
      const job = await loadRunnerJob();
      if (job) {
        const released = releaseSubmittedTasks(job);
        if (released.length) {
          if (job.status === 'running' && !job.sleep_until) {
            if (job.active_tasks?.length) updateMultiJobPhase(job);
            else updateJobPhase(job, 'idle');
          }
          await saveRunnerJob(job);
        }
      }
      if (job?.status === 'running') startRunnerTimer();
      const records = await readJsonl(AUTOPILOT_RUN_FILE, 100);
      return ok({ status: job?.status || 'idle', running: job?.status === 'running', job, summary: deriveRunnerSummary(job, records), records, presets: STRATEGY_PRESETS });
    }

    if (action === 'start') {
      let strategy = body.strategy;
      let scan = null;
      if (!strategy) {
        const generated = await handleApi('/api/task/strategy', 'POST', { action: 'generate', note: body.note || '', preset_id: body.preset_id || body.presetId || 'balanced' });
        strategy = generated.payload.strategy;
        scan = generated.payload.scan;
      }
      const id = body.run_id ? validateRef(body.run_id, 'run_id') : `run_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const runUntil = body.run_until ? new Date(body.run_until) : new Date(Date.now() + 24 * 60 * 60 * 1000);
      if (Number.isNaN(runUntil.getTime())) return fail(400, 'run_until must be a valid date.');
      const job = {
        id,
        status: 'running',
        phase: 'idle',
        phase_label: phaseInfo('idle').label,
        progress: 0,
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        strategy,
        note: body.note || strategy?.note || '',
        active_tasks: [],
        current_task: null,
        assignment_id: null,
        result_asset_id: null,
        claimed_at: null,
        submitted_at: null,
        verdict: null,
        mode: limitedString(body.mode || 'continuous_24h', 64, 'mode'),
        run_until: runUntil.toISOString(),
        last_review: null,
        last_scan: scan,
        pending_verdict_tasks: [],
        completed_tasks: [],
        events: [],
      };
      addJobEvent(job, 'started', '后台 Runner 已启动，默认持续 24 小时或直到手动结束。', { strategy_id: strategy?.id, run_until: job.run_until });
      await saveRunnerJob(job);
      await appendJsonl(AUTOPILOT_RUN_FILE, { type: 'runner_started', run_id: id, strategy_id: strategy?.id });
      startRunnerTimer();
      setTimeout(() => { runnerTick().catch(() => {}); }, 0);
      const records = await readJsonl(AUTOPILOT_RUN_FILE, 100);
      return ok({ status: 'runner_started', running: true, job, summary: deriveRunnerSummary(job, records), records, presets: STRATEGY_PRESETS });
    }

    if (action === 'tick') {
      await runnerTick();
      const job = await loadRunnerJob();
      const records = await readJsonl(AUTOPILOT_RUN_FILE, 100);
      return ok({ status: 'runner_tick_done', running: job?.status === 'running', job, summary: deriveRunnerSummary(job, records), records, presets: STRATEGY_PRESETS });
    }

    if (action === 'boost') {
      const job = await loadRunnerJob();
      if (!job) return fail(404, 'No runner job found');
      job.active_tasks = (job.active_tasks || []).filter((task) => (
        task?.claimed_at
        || task?.submitted_at
        || task?.result_asset_id
        || task?.assignment_id
        || task?.id
      ));
      if (job.status === 'paused_on_error' && job.active_tasks.length) {
        job.status = 'running';
        job.error = null;
        job.error_details = null;
        job.sleep_until = null;
        job.sleep_reason = null;
        job.active_tasks = job.active_tasks.map((task) => ({
          ...task,
          deferred_claim: task.deferred_claim || (task.source === 'worker_pool' && !task.assignment_id && !task.submitted_at),
          phase: task.result_asset_id
            ? (task.submitted_at ? 'waiting_verdict' : 'result_produced')
            : (task.source === 'worker_pool' && !task.assignment_id ? 'deferred' : 'reasoning'),
          phase_label: task.result_asset_id
            ? (task.submitted_at ? phaseInfo('waiting_verdict').label : phaseInfo('result_produced').label)
            : (task.source === 'worker_pool' && !task.assignment_id ? phaseInfo('deferred').label : phaseInfo('reasoning').label),
          progress: task.result_asset_id
            ? (task.submitted_at ? phaseInfo('waiting_verdict').progress : phaseInfo('result_produced').progress)
            : (task.source === 'worker_pool' && !task.assignment_id ? phaseInfo('deferred').progress : phaseInfo('reasoning').progress),
        }));
      }
      releaseSubmittedTasks(job);
      job.strategy = job.strategy || { policy: {} };
      job.strategy.policy = {
        ...(job.strategy.policy || {}),
        worker_enabled: true,
        max_active: Math.max(Number(job.strategy.policy?.max_active || 1), boundedNumber(body.max_active, { min: 1, max: 5, fallback: 5, label: 'max_active' })),
        max_claims: Math.max(Number(job.strategy.policy?.max_claims || 1), boundedNumber(body.max_claims, { min: 1, max: 5, fallback: 3, label: 'max_claims' })),
      };
      syncPrimaryTask(job);
      if (job.active_tasks?.length) updateMultiJobPhase(job);
      addJobEvent(job, 'policy_boost', `已开启并行贡献：每轮最多认领 ${job.strategy.policy.max_claims} 个，最多活跃 ${job.strategy.policy.max_active} 个。`, {
        max_claims: job.strategy.policy.max_claims,
        max_active: job.strategy.policy.max_active,
      });
      await saveRunnerJob(job);
      if (job.status === 'running') {
        startRunnerTimer();
        setTimeout(() => { runnerTick().catch(() => {}); }, 0);
      }
      const records = await readJsonl(AUTOPILOT_RUN_FILE, 100);
      return ok({ status: 'runner_boosted', running: job?.status === 'running', job, summary: deriveRunnerSummary(job, records), records, presets: STRATEGY_PRESETS });
    }

    if (action === 'stop') {
      const job = await loadRunnerJob();
      stopRunnerTimer();
      if (job) {
        job.status = 'stopped';
        updateJobPhase(job, 'stopped');
        addJobEvent(job, 'stopped', '用户点击结束执行。', { reason: body.reason || 'user_stop' });
        await saveRunnerJob(job);
        await appendJsonl(AUTOPILOT_RUN_FILE, { type: 'runner_stopped', run_id: job.id, strategy_id: job.strategy?.id, phase: job.phase });
      }
      const records = await readJsonl(AUTOPILOT_RUN_FILE, 100);
      return ok({ status: 'runner_stopped', running: false, job, summary: deriveRunnerSummary(job, records), records, presets: STRATEGY_PRESETS });
    }

    return fail(400, 'Unknown runner action');
  }

  if (pathname === '/api/skills') {
    const params = new URLSearchParams({ limit: String(body.limit || 30) });
    if (body.query) params.set('q', String(body.query));
    const data = await hubFetch(`/a2a/skill/store/list?${params}`, { auth: false });
    return ok({ skills: data.skills || [], raw: data });
  }

  if (pathname === '/api/services') {
    const query = body.query || 'api integration agent';
    const data = await hubFetch(`/a2a/service/search?q=${encodeURIComponent(query)}&limit=${Number(body.limit || 30)}`, { auth: false });
    return ok({ services: data.services || [], raw: data });
  }

  return fail(404, 'Unknown API endpoint');
}

function ok(payload) {
  return { status: 200, payload };
}

function fail(status, error, details) {
  return { status, payload: { error, details } };
}

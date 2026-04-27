'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { PageHero } from '../components.jsx';
import { api, pretty } from '../client-utils.js';
import { useI18n, useTranslatedItems } from '../i18n.jsx';

const PHASE_FLOW = [
  ['selected', '选中悬赏'],
  ['deferred', '待产出后认领'],
  ['reasoning', '生成资产'],
  ['result_produced', '结果已生产'],
  ['submitting', '提交中'],
  ['submitted', '提交完成'],
  ['waiting_verdict', '等待采纳'],
  ['accepted', '已采纳'],
  ['rejected', '已拒绝'],
  ['parked', '已轮换'],
];

const DEFAULT_PRESETS = {
  balanced: { name: '稳健赚分', description: '平衡赏金和成功率，适合 24 小时持续运行。' },
  high_bounty: { name: '高赏金优先', description: '优先抢高价值任务，容忍较少匹配信号。' },
  low_risk: { name: '低风险保声誉', description: '只做匹配度更高、活跃任务更少的稳妥任务。' },
  content_factory: { name: '内容资产工厂', description: '偏向可沉淀为 Gene/Capsule 的教程、复盘、评估类任务。' },
};

function getTaskId(task) {
  return task?.id || task?.task_id || task?.autopilot?.id;
}

function getOfficialBountyId(task, sourceTask) {
  return task?.official_bounty_id || task?.bounty_id || task?.bountyId || task?.bounty?.id || sourceTask?.bounty_id || sourceTask?.bountyId || sourceTask?.bounty?.id || getTaskId(task);
}

function officialBountyUrl(task, sourceTask, lang) {
  const id = getOfficialBountyId(task, sourceTask);
  if (!id) return '';
  const locale = lang === 'zh-CN' ? '/zh' : lang === 'ja' ? '/ja' : '';
  return `https://evomap.ai${locale}/bounty/${encodeURIComponent(id)}`;
}

function formatNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num.toLocaleString(undefined, { maximumFractionDigits: 1 }) : value;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function formatHistoryTime(value) {
  if (!value) return '刚刚';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function phaseIndex(phase) {
  const index = PHASE_FLOW.findIndex(([key]) => key === phase);
  return index < 0 ? -1 : index;
}

export default function TasksPage() {
  const { t, lang } = useI18n();
  const [note, setNote] = useState('');
  const [presetId, setPresetId] = useState('balanced');
  const [presets, setPresets] = useState(DEFAULT_PRESETS);
  const [strategy, setStrategy] = useState(null);
  const [scan, setScan] = useState(null);
  const [runnerJob, setRunnerJob] = useState(null);
  const [runnerSummary, setRunnerSummary] = useState(null);
  const [records, setRecords] = useState([]);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(null);
  const [output, setOutput] = useState('点击“生成策略”，系统会基于当前积分、声誉、可见任务和 Worker 状态生成执行方案。');
  const [clockNow, setClockNow] = useState(() => Date.now());

  const loadRunnerStatus = useCallback(async () => {
    try {
      const result = await api('/api/task/runner', { method: 'POST', body: JSON.stringify({ action: 'status' }) });
      setRunnerJob(result.job || null);
      setRunnerSummary(result.summary || null);
      setRecords(result.records || []);
      if (result.presets) setPresets(result.presets);
      if (result.job?.strategy) {
        setStrategy(result.job.strategy);
        setPresetId(result.job.strategy.preset_id || 'balanced');
      }
      if (result.job?.last_scan) setScan(result.job.last_scan);
      return result;
    } catch {
      return null;
    }
  }, []);

  async function generateStrategy() {
    setBusy(true);
    try {
      const result = await api('/api/task/strategy', { method: 'POST', body: JSON.stringify({ action: 'generate', note, preset_id: presetId }) });
      setStrategy(result.strategy);
      setScan(result.scan);
      setRecords(result.records || []);
      if (result.presets) setPresets(result.presets);
      setOutput(pretty({ status: result.status, preset: result.strategy.preset_name, summary: result.strategy.summary, projected: result.strategy.projected }));
    } catch (err) {
      setOutput(pretty(err.data || err.message));
    } finally {
      setBusy(false);
    }
  }

  async function startRunner() {
    if (isRunning) {
      const result = await loadRunnerStatus();
      setOutput(`Runner 已经在运行，不会重复启动。\n\n${pretty({ status: 'already_running', run_id: result?.job?.id, phase: result?.job?.phase_label, summary: result?.summary })}`);
      return;
    }
    setBusy(true);
    try {
      const result = await api('/api/task/runner', { method: 'POST', body: JSON.stringify({ action: 'start', strategy, preset_id: presetId, note }) });
      setRunnerJob(result.job);
      setRunnerSummary(result.summary || null);
      setStrategy(result.job?.strategy || strategy);
      setPresetId(result.job?.strategy?.preset_id || presetId);
      setScan(result.job?.last_scan || scan);
      setRecords(result.records || []);
      setOutput(pretty({ status: result.status, run_id: result.job?.id, phase: result.job?.phase_label, run_until: result.job?.run_until }));
    } catch (err) {
      setOutput(`启动失败\n\n${pretty(err.data || err.message)}`);
    } finally {
      setBusy(false);
    }
  }

  async function stopRunner() {
    setBusy(true);
    try {
      const result = await api('/api/task/runner', { method: 'POST', body: JSON.stringify({ action: 'stop' }) });
      setRunnerJob(result.job || null);
      setRunnerSummary(result.summary || null);
      setRecords(result.records || []);
      setOutput(pretty({ status: result.status, run_id: result.job?.id, phase: result.job?.phase_label }));
    } catch (err) {
      setOutput(`停止失败\n\n${pretty(err.data || err.message)}`);
    } finally {
      setBusy(false);
    }
  }

  async function boostRunner() {
    setBusy(true);
    try {
      const result = await api('/api/task/runner', { method: 'POST', body: JSON.stringify({ action: 'boost', max_active: 5, max_claims: 3 }) });
      setRunnerJob(result.job || null);
      setRunnerSummary(result.summary || null);
      setRecords(result.records || []);
      setOutput(pretty({ status: result.status, policy: result.job?.strategy?.policy, summary: result.summary }));
    } catch (err) {
      setOutput(`提升并行失败\n\n${pretty(err.data || err.message)}`);
    } finally {
      setBusy(false);
    }
  }

  async function forceRefresh() {
    const result = await loadRunnerStatus();
    setOutput(pretty({ status: result?.status || 'idle', phase: result?.job?.phase_label, progress: result?.job?.progress, summary: result?.summary, review: result?.job?.last_review }));
  }

  useEffect(() => { loadRunnerStatus(); }, [loadRunnerStatus]);

  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const isRunning = runnerJob?.status === 'running';
  const isPaused = runnerJob?.status === 'paused_on_error' || runnerJob?.phase === 'error';

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') loadRunnerStatus();
    }, isRunning ? 5000 : 20000);
    return () => clearInterval(timer);
  }, [isRunning, loadRunnerStatus]);

  const translatedSummary = useTranslatedItems(runnerSummary ? [{ id: 'runner-summary', ...runnerSummary }] : [], ['status_text', 'waiting_reason', 'current_task_title'])[0] || runnerSummary;
  const translatedActiveTasks = useTranslatedItems(runnerSummary?.active_tasks || [], ['title']);
  const translatedPendingVerdictTasks = useTranslatedItems(runnerSummary?.pending_verdict_tasks || [], ['title']);
  const displayedTaskFlows = [...translatedActiveTasks, ...translatedPendingVerdictTasks];
  const translatedEvents = useTranslatedItems(runnerJob?.events || [], ['message']);
  const translatedPresets = useTranslatedItems(Object.entries(presets).map(([id, preset]) => ({ id, ...preset })), ['name', 'description']);
  const translatedPhaseFlow = useTranslatedItems(PHASE_FLOW.map(([id, label]) => ({ id, label })), ['label']);
  const rankedRaw = runnerJob?.last_scan?.ranked || scan?.ranked || strategy?.top_candidates || [];
  const yieldReport = runnerJob?.last_scan?.report || scan?.report || strategy?.projected?.report || null;
  const reportTiers = yieldReport?.tiers || [];
  const selectedPreset = presets[presetId] || DEFAULT_PRESETS.balanced;
  const translatedSelectedPreset = translatedPresets.find((preset) => preset.id === presetId) || selectedPreset;
  const maxActive = runnerJob?.strategy?.policy?.max_active || strategy?.policy?.max_active || 0;
  const maxClaims = runnerJob?.strategy?.policy?.max_claims || strategy?.policy?.max_claims || 0;

  const historyItems = useMemo(() => {
    const labelMap = {
      started: ['启动', '后台 Runner 已启动'],
      selected: ['选中', '选中了一个悬赏任务'],
      deferred_claim: ['延迟认领', '先产出结果资产，再认领并提交'],
      claimed: ['认领', '任务已认领，等待执行器处理'],
      reasoning: ['生成资产', '任务正在生成 result_asset_id'],
      runner_result_produced: ['结果资产', '已发布 result_asset_id'],
      runner_result_publish_failed: ['发布延迟', '发布 result_asset_id 失败或被限流'],
      runner_result_generation_failed: ['生成失败', '结果资产生成失败，已轮换'],
      result_publish_delayed: ['发布延迟', 'Hub 发布限流/超时，稍后继续'],
      claim_delayed: ['认领延迟', '结果资产已保留，稍后继续认领'],
      parked: ['轮换任务', '长时间未产出结果，已释放执行槽'],
      parallel_status: ['并行状态', '后台正在并行处理多个任务'],
      poll_skipped: ['等待', 'Hub 查询暂时受限，下一轮继续'],
      scan_skipped: ['等待', 'Hub 扫描暂时受限，下一轮继续'],
      claim_skipped: ['跳过认领', '本次认领失败或被限流'],
      policy_boost: ['提速', '已调整并行执行策略'],
      submitted: ['已提交', '结果资产已提交'],
      accepted: ['已采纳', '任务结果已被采纳'],
      rejected: ['已拒绝', '任务结果被拒绝或失败'],
      error: ['异常', '后台执行遇到错误'],
      stopped: ['停止', '后台执行已停止'],
      sleeping: ['休眠', 'Runner 暂时休眠，稍后自动继续'],
      submitted_released: ['释放槽位', '提交后已释放并行槽，继续做新任务'],
      woke: ['唤醒', '休眠结束，继续执行'],
      waiting: ['等待任务', '没有 ready 任务，等待下一轮'],
      review: ['复盘', '根据上一轮结果调整策略'],
      result_produced: ['结果资产', '检测到 result_asset_id'],
    };
    const compact = new Map();
    const push = (raw, index = 0) => {
      const type = raw.type || 'record';
      const [label, fallback] = labelMap[type] || [type, raw.status || raw.reason || raw.message || '历史记录'];
      const taskId = raw.details?.task_id || raw.task_id || raw.details?.assignment_id || raw.assignment_id || '';
      const key = type === 'reasoning' ? `reasoning:${taskId}` : type === 'parallel_status' ? 'parallel_status' : `${raw.ts || index}:${type}:${taskId}`;
      const existing = compact.get(key);
      const time = raw.ts || raw.time || raw.created_at || '';
      const next = existing || { id: key, type, label, message: raw.message || raw.status || raw.reason || fallback, time, taskId, count: 0, raw };
      next.count += 1;
      next.time = existing?.time || time;
      if (type === 'reasoning' && taskId && !raw.message) next.message = `任务 ${taskId.slice(0, 8)} 正在生成 result_asset_id`;
      compact.set(key, next);
    };
    translatedEvents.forEach(push);
    records.slice(0, 8).forEach(push);
    return [...compact.values()].slice(0, 24);
  }, [translatedEvents, records]);

  const metrics = useMemo(() => ({
    ready: runnerJob?.last_scan?.ready_count ?? scan?.ready_count ?? strategy?.projected?.ready_count ?? 0,
    active: runnerJob?.last_scan?.active_count ?? scan?.active_count ?? strategy?.projected?.active_count ?? 0,
    visibleBounty: Math.round(strategy?.projected?.visible_bounty || rankedRaw.reduce((sum, task) => sum + Number(task.autopilot?.bounty || 0), 0)),
    claimed: records.filter((record) => ['strategy_cycle', 'runner_claimed'].includes(record.type)).reduce((sum, record) => sum + (record.claimed?.length || (record.type === 'runner_claimed' ? 1 : 0)), 0),
    activeRunning: runnerSummary?.active_task_count || 0,
    pendingVerdict: runnerSummary?.pending_verdict_count || 0,
    waitingResult: runnerSummary?.tasks_waiting_result || 0,
    readyToSubmit: runnerSummary?.tasks_ready_to_submit || 0,
    deferred: runnerSummary?.deferred_task_count || 0,
    submitted: runnerSummary?.counts?.submitted || 0,
    accepted: runnerSummary?.counts?.accepted || 0,
    rejected: runnerSummary?.counts?.rejected || 0,
    errors: runnerSummary?.counts?.errors || 0,
  }), [runnerJob, scan, strategy, rankedRaw, records, runnerSummary]);
  const sleepUntilMs = runnerSummary?.sleep_until ? Date.parse(runnerSummary.sleep_until) : 0;
  const sleepRemainingMs = Number.isFinite(sleepUntilMs) && sleepUntilMs > 0 ? Math.max(0, sleepUntilMs - clockNow) : 0;
  const nextTickMs = runnerSummary?.next_tick_at ? Date.parse(runnerSummary.next_tick_at) : 0;
  const nextTickInMs = Number.isFinite(nextTickMs) && nextTickMs > 0 ? Math.max(0, nextTickMs - clockNow) : 0;
  const schedulerLabel = runnerSummary?.sleeping ? '休眠中' : isRunning ? '持续运行' : isPaused ? '等待处理' : '未启动';
  const schedulerCountdown = runnerSummary?.sleeping ? formatDuration(sleepRemainingMs) : isRunning ? formatDuration(nextTickInMs) : '-';
  const schedulerHint = runnerSummary?.sleeping
    ? `${runnerSummary.sleep_reason || 'Hub 限速/超时，暂时休眠'}；到点后自动继续。`
    : isRunning
      ? '定时任务不会因为没有 ready 任务而停止；下一轮 tick 到点后继续扫描。'
      : '点击“生成并开始”后，Runner 会持续扫描、认领和提交。';

  return (
    <>
      <PageHero eyebrow="Bounties" title={t('tasks')} description="顶部关注定时 Runner 和历史；下面看总体任务情况与每个悬赏进展。" />
      <main className="tasks-command-page flow-page">
        <section className="panel scheduler-history-panel wide-panel">
          <header className="panel-head compact">
            <div><p className="eyebrow">Level 1 · Automation & History</p><h2>定时任务与执行历史</h2></div>
            <span className={`badge ${runnerSummary?.sleeping ? 'warn' : isRunning ? 'good' : 'warn'}`}>{schedulerLabel}</span>
          </header>
          <div className="scheduler-grid scheduler-grid-primary">
            <article className="scheduler-countdown-card">
              <small>{runnerSummary?.sleeping ? '休眠倒计时' : '下次执行'}</small>
              <strong>{schedulerCountdown}</strong>
              <span>{schedulerHint}</span>
            </article>
            <article>
              <small>后台 Runner</small>
              <strong>{runnerJob?.mode || '未启动'}</strong>
              <span>服务端每 30 秒 tick；限速/超时时进入休眠，不直接停止。</span>
            </article>
            <article>
              <small>运行窗口</small>
              <strong>{runnerJob?.run_until ? '24h' : '-'}</strong>
              <span>开始：{runnerJob?.started_at || '-'}<br />结束：{runnerJob?.run_until || '-'}</span>
            </article>
            <article>
              <small>收益选择</small>
              <strong>{yieldReport?.selection_mode === 'balanced_score_mix' ? '高低分均衡' : '等待扫描'}</strong>
              <span>{yieldReport?.recommendation || '下一次扫描成功后会生成收益报表。'}</span>
            </article>
          </div>

          <div className="scheduler-history-preview">
            <div className="history-preview-head"><strong>最近执行历史</strong><span>{translatedEvents.length + Math.min(records.length, 12)} logs</span></div>
            <div className="history-preview-list">
              {historyItems.slice(0, 5).map((item) => <article className={`history-preview-item history-type-${item.type}`} key={item.id}>
                <span>{item.label}</span>
                <strong>{item.message}</strong>
                <small>{formatHistoryTime(item.time)}{item.count > 1 ? ` · 重复 ${item.count} 次` : ''}</small>
              </article>)}
              {!historyItems.length ? <p className="mini-list empty">暂无执行记录；启动 Runner 后会展示扫描、认领、休眠和提交记录。</p> : null}
            </div>
          </div>

          <div className="modal-button-row">
            <button type="button" className="ghost" onClick={() => setModal('control')}>策略与运行控制</button>
            {yieldReport ? <button type="button" className="ghost" onClick={() => setModal('yield')}>收益报表</button> : null}
            {strategy ? <button type="button" className="ghost" onClick={() => setModal('strategy')}>当前策略</button> : null}
            <button type="button" className="ghost" onClick={() => setModal('history')}>完整执行历史</button>
          </div>
        </section>

        <section className="panel flow-overview-panel wide-panel">
          <header className="panel-head compact">
            <div><p className="eyebrow">Level 2 · Overview</p><h2>现在的任务情况</h2></div>
            <span className={`badge ${isRunning ? 'good' : 'warn'}`}>{isRunning ? '运行中' : isPaused ? '异常待处理' : '未运行'}</span>
          </header>
          <div className="flow-overview-grid">
            <article className="flow-hero-card">
              <small>当前状态</small>
              <strong>{runnerJob?.phase_label || (isRunning ? '运行中' : '等待启动')}</strong>
              <span>{translatedSummary?.waiting_reason || translatedSummary?.status_text || '选择策略后开始自动扫描和认领。'}</span>
            </article>
            <article><small>执行槽位</small><strong>{metrics.activeRunning}<em> / {maxActive || '-'}</em></strong><span>等待采纳 {metrics.pendingVerdict} 个不占槽；每轮最多新认领 {maxClaims || '-'} 个</span></article>
            <article><small>本轮运行</small><strong>{formatDuration(runnerSummary?.runner_elapsed_ms)}</strong><span>前台每 5 秒刷新</span></article>
            <article className={metrics.waitingResult ? 'submission-blocked-card' : ''}>
              <small>{metrics.waitingResult ? (metrics.deferred ? '生成后认领' : '生成资产') : '提交结果'}</small>
              <strong>{metrics.submitted}</strong>
              <span>{metrics.waitingResult ? (metrics.deferred ? `${metrics.deferred} 个候选会先发布资产，再认领提交` : `${metrics.waitingResult} 个任务正在产出 result_asset_id`) : `等待采纳 ${metrics.pendingVerdict} · 采纳 ${metrics.accepted} · 拒绝 ${metrics.rejected}`}</span>
            </article>
          </div>
        </section>


        <section className="panel task-flow-panel wide-panel">
          <header className="panel-head compact">
            <div><p className="eyebrow">Level 3 · Task Flows</p><h2>每个悬赏的进展</h2></div>
            <span className="badge good">{displayedTaskFlows.length} tasks</span>
          </header>
          <div className="task-flow-list">
            {displayedTaskFlows.map((task, index) => {
              const url = officialBountyUrl(task, null, lang);
              const taskIndex = phaseIndex(task.phase);
              return <details className="task-flow-card" key={task.id} open={index === 0}>
                <summary>
                  <span className="task-number">#{String(index + 1).padStart(2, '0')}</span>
                  <span className="task-phase-pill">{task.phase_label || task.phase || '执行中'}</span>
                  <div><strong>{task.title}</strong><small>{task.id}</small></div>
                  <b>{formatDuration(task.elapsed_ms)}</b>
                </summary>
                <div className="task-flow-body">
                  <div className="mini-flow-line">
                    {translatedPhaseFlow.map((item, stepIndex) => <span className={stepIndex <= taskIndex ? 'active' : ''} key={item.id}>{item.label}</span>)}
                  </div>
                  <div className="task-flow-meta">
                    <article><small>赏金</small><strong>{formatNumber(task.bounty)}</strong></article>
                    <article><small>Score</small><strong>{task.score ?? '-'}</strong></article>
                    <article><small>结果资产</small><code>{task.result_asset_id || '等待 result_asset_id'}</code></article>
                    <article><small>官网</small>{url ? <a className="text-link" href={url} target="_blank" rel="noreferrer">打开悬赏</a> : <span>-</span>}</article>
                  </div>
                </div>
              </details>;
            })}
            {!translatedActiveTasks.length ? <article className="empty-flow-card"><h3>暂无活跃悬赏</h3><p>点击“生成并开始”后，这里会按任务展示流程图。</p></article> : null}
          </div>
        </section>

        {modal && typeof document !== 'undefined' ? createPortal(<div className="flow-modal-backdrop" role="presentation" onClick={() => setModal(null)}>
          <section className={`flow-modal ${modal === 'history' ? 'history-modal' : ''}`} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <p className="eyebrow">Details</p>
                <h2>{modal === 'control' ? '策略与运行控制' : modal === 'yield' ? '收益报表' : modal === 'strategy' ? '当前策略' : '执行历史'}</h2>
              </div>
              <button className="ghost" type="button" onClick={() => setModal(null)}>关闭</button>
            </header>

            {modal === 'control' ? <div className="control-drawer-body modal-section">
              <div className="preset-grid compact">
                {translatedPresets.map((preset) => <button type="button" className={`preset-card ${preset.id === presetId ? 'active' : ''}`} key={preset.id} onClick={() => setPresetId(preset.id)} disabled={isRunning}>
                  <strong>{preset.name}</strong><span>{preset.description}</span>
                </button>)}
              </div>
              <div className="strategy-controls inline-controls">
                <button className="ghost" onClick={generateStrategy} disabled={busy || isRunning} title={isRunning ? 'Runner 已在运行，先结束后再生成新策略。' : ''}>{busy ? '处理中...' : isRunning ? '运行中不可改策略' : '生成策略'}</button>
                <button onClick={startRunner} disabled={busy}>{busy ? '处理中...' : isRunning ? '已在运行 · 刷新' : strategy ? '确认开始' : '生成并开始'}</button>
                <button className="ghost" onClick={boostRunner} disabled={busy || (!isRunning && !isPaused)}>并行贡献 x5</button>
                <button className="ghost danger-ghost" onClick={stopRunner} disabled={busy || (!isRunning && !isPaused)}>结束执行</button>
                <button className="ghost" onClick={forceRefresh}>刷新</button>
              </div>
              <div className="runner-control-feedback">
                <article className={isRunning ? 'live' : isPaused ? 'warn' : ''}>
                  <small>当前 Runner</small>
                  <strong>{runnerJob?.phase_label || (isRunning ? '运行中' : isPaused ? '异常待处理' : '未启动')}</strong>
                  <span>{runnerSummary?.submission_blocker || (isRunning ? `下次执行 ${schedulerCountdown}` : isPaused ? '可以刷新或结束后重新开始。' : '生成策略后即可开始。')}</span>
                </article>
                <pre>{output}</pre>
              </div>
              <details className="strategy-note compact-note">
                <summary>可选：补充偏好</summary>
                <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="可不填。比如：优先视频质量、API 集成、Codex 自动化；避开纯数学题。" />
              </details>
            </div> : null}

            {modal === 'yield' && yieldReport ? <div className="yield-report-grid slim modal-section">
              {reportTiers.map((tier) => <article key={tier.id} className={`yield-tier ${tier.id}`}>
                <div><small>{tier.label}</small><strong>{formatNumber(tier.avg_bounty)}</strong><span>平均赏金</span></div>
                <div><b>{tier.ready_count}/{tier.count}</b><span>ready / 可见</span></div>
                <div><b>{formatNumber(tier.avg_score)}</b><span>平均分值</span></div>
                <div><b>{tier.avg_bounty_per_score}</b><span>赏金/分值</span></div>
                <p>{tier.intent}</p>
              </article>)}
            </div> : null}

            {modal === 'strategy' && strategy ? <div className="strategy-steps compact-steps modal-section">
              {strategy.steps.map((step, index) => <article key={step}><span>{String(index + 1).padStart(2, '0')}</span><p>{step}</p></article>)}
            </div> : null}

            {modal === 'history' ? <div className="history-friendly-list modal-section">
              <div className="history-explain">
                <div>
                  <strong>当前历史主要是在记录后台心跳。</strong>
                  <span>Runner 每 30 秒检查一次任务状态；现在会先生成并发布 result_asset_id，再认领和提交，遇到限流则休眠后继续。</span>
                </div>
                <b>{historyItems.length} 条最近记录</b>
              </div>
              <div className="history-timeline">
                {historyItems.map((item, index) => <article className={`history-friendly-item history-type-${item.type}`} key={item.id}>
                  <div className="history-index">{String(index + 1).padStart(2, '0')}</div>
                  <div className="history-row-main">
                    <span>{item.label}</span>
                    <div>
                      <strong>{item.message}</strong>
                      <small>
                        <time>{formatHistoryTime(item.time)}</time>
                        {item.taskId ? <code>{item.taskId}</code> : null}
                        {item.count > 1 ? <em>重复 {item.count} 次</em> : null}
                      </small>
                    </div>
                  </div>
                  <details className="history-raw">
                    <summary>查看原始记录</summary>
                    <pre>{pretty(item.raw)}</pre>
                  </details>
                </article>)}
              </div>
              {!historyItems.length ? <p className="mini-list empty">暂无执行记录</p> : null}
            </div> : null}
          </section>
        </div>, document.body) : null}
      </main>
    </>
  );
}

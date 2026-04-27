'use client';

import { useEffect, useMemo, useState } from 'react';
import { MiniList } from './components.jsx';
import { api, pretty } from './client-utils.js';
import { useI18n, useTranslatedItems } from './i18n.jsx';

function formatNumber(value) {
  if (value === null || value === undefined || value === 'n/a') return 'n/a';
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function TaskRow({ task, index }) {
  const bounty = Number(task.bountyAmount || task.bounty || 0);
  return (
    <li className="overview-task-row">
      <span className="task-rank">{String(index + 1).padStart(2, '0')}</span>
      <div className="task-copy">
        <strong>{task.title || task.id}</strong>
        <small>{task.signals || 'no signals'}</small>
      </div>
      <div className="task-meta">
        <output>{formatNumber(bounty)}</output>
        <small>rep {task.minReputation ?? task.min_reputation ?? '-'}</small>
      </div>
    </li>
  );
}

function StatPill({ label, value, tone = 'default' }) {
  return (
    <output className={`overview-stat ${tone}`}>
      <small>{label}</small>
      <b>{value}</b>
    </output>
  );
}

export default function OverviewPage() {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [output, setOutput] = useState('加载总览中...');

  useEffect(() => {
    api('/api/overview')
      .then((next) => {
        setData(next);
        setOutput(pretty({ tasks: { mine: next.tasks.mine.length, available: next.tasks.available.length, bounty_total: next.tasks.bounty_total }, safety: next.lite }));
      })
      .catch((err) => setOutput(pretty(err.data || err.message)));
  }, []);

  const status = data?.profile?.status || {};
  const node = data?.profile?.profile || {};
  const availableRaw = data?.tasks?.available || [];
  const mineRaw = data?.tasks?.mine || [];
  const available = useTranslatedItems(availableRaw, ['title', 'signals']);
  const mine = useTranslatedItems(mineRaw, ['title', 'signals']);
  const displayAvailable = available.length === availableRaw.length ? available : availableRaw;
  const topBounties = useMemo(() => [...displayAvailable].sort((a, b) => Number(b.bountyAmount || b.bounty || 0) - Number(a.bountyAmount || a.bounty || 0)).slice(0, 6), [displayAvailable]);
  const totalBounty = Math.round(data?.tasks?.bounty_total || 0);
  const highestBounty = Math.max(0, ...availableRaw.map((task) => Number(task.bountyAmount || task.bounty || 0)));
  const reputation = Number(node.reputation_score ?? status.reputation ?? 0);
  const claimable = availableRaw.filter((task) => Number(task.minReputation ?? task.min_reputation ?? 0) <= reputation).length;

  return (
    <main className="overview-dashboard">
      <section className="overview-command panel" aria-label="Runner 总览">
        <div className="balance-block">
          <p className="eyebrow">EvoMap Runner Lite</p>
          <h2>{formatNumber(status.credit_balance ?? 'n/a')}</h2>
          <p>这是给群友自用的精简版：只保留环境自检、Hello 注册、悬赏 Runner、search_only 优先和 Full Fetch 确认/缓存。</p>
          <div className="balance-actions">
            <a className="button-link" href="/tasks">进入悬赏任务</a>
            <a className="button-link ghost-link" href="/setup">配置节点</a>
          </div>
        </div>

        <div className="overview-stat-grid">
          <StatPill label={t('reputation')} value={formatNumber(reputation || 'n/a')} tone="trust" />
          <StatPill label="可认领" value={`${claimable}/${availableRaw.length}`} />
          <StatPill label="可见赏金" value={formatNumber(totalBounty)} tone="money" />
          <StatPill label="最高赏金" value={formatNumber(highestBounty)} tone="hot" />
        </div>

        <aside className="guardrail-card">
          <strong>Lite 安全边界</strong>
          <span>禁用服务市场发布</span>
          <span>禁用资产发布模板</span>
          <span>Full Fetch 需要确认码</span>
        </aside>
      </section>

      <section className="overview-workflow panel">
        <header className="panel-head compact"><div><p className="eyebrow">Workflow</p><h2>推荐使用流程</h2></div></header>
        <div className="action-grid">
          <article><span>01</span><strong>先做健康检查</strong><p>用顶部健康按钮确认本地凭证、Hub 连接、官方 Evolver hello 都正常。</p></article>
          <article><span>02</span><strong>小并发跑悬赏</strong><p>默认低并发，遇到限速只休眠并显示倒计时，不死磕单个任务。</p></article>
          <article><span>03</span><strong>把问题反馈给维护者</strong><p>群友遇到的失败样本可以反哺到维护版流程里继续迭代。</p></article>
        </div>
      </section>

      <section className="overview-content-grid">
        <article className="panel bounty-panel">
          <header className="panel-head compact"><div><p className="eyebrow">Top Bounties</p><h2>高价值机会</h2></div><a className="text-link" href="/tasks">全部任务</a></header>
          <ul className="overview-task-list">
            {topBounties.length ? topBounties.map((task, index) => <TaskRow task={task} index={index} key={task.id || task.task_id} />) : <li className="empty-line">暂无可见任务</li>}
          </ul>
        </article>
        <article className="panel work-panel">
          <header className="panel-head compact"><div><p className="eyebrow">My Work</p><h2>我的任务</h2></div></header>
          <MiniList items={mine} />
          {!mine.length ? <div className="empty-action"><span>还没有本地任务记录</span><a className="text-link" href="/tasks">去启动 Runner</a></div> : null}
        </article>
      </section>

      <details className="panel snapshot-details">
        <summary>结构化快照</summary>
        <output className="native-output"><pre>{output}</pre></output>
      </details>
    </main>
  );
}

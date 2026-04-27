'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { I18nProvider, LanguageSelect, useI18n } from './i18n.jsx';
import { api } from './client-utils.js';
import { ROUTES, routeForPath } from './nav-config.js';

const HELLO_INTERVAL_MS = 5 * 60000;
const HELLO_RETRY_MS = 60 * 60000;

function HealthCheckControl({ profile }) {
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState(null);

  async function runHealthCheck() {
    setOpen(true);
    setChecking(true);
    try {
      const [configResult, profileResult] = await Promise.allSettled([
        api('/api/config'),
        profile ? Promise.resolve(profile) : api('/api/profile'),
      ]);
      const config = configResult.status === 'fulfilled' ? configResult.value : null;
      const nodeProfile = profileResult.status === 'fulfilled' ? profileResult.value : null;
      const configError = configResult.status === 'rejected' ? configResult.reason : null;
      const profileError = profileResult.status === 'rejected' ? profileResult.reason : null;
      const evolverHello = config?.evolver_hello || nodeProfile?.evolver_hello;
      const checks = [
        {
          id: 'agent',
          label: 'Agent 凭证',
          ok: Boolean(config?.agent?.node_id && config?.agent?.node_secret === '[redacted]'),
          detail: config?.agent_file || configError?.message || '未找到本地 agent 文件。',
        },
        {
          id: 'hub',
          label: 'Hub 连接',
          ok: Boolean(nodeProfile?.profile?.node_id || nodeProfile?.agent?.node_id),
          warn: Boolean(nodeProfile?.rate_limited),
          detail: nodeProfile?.rate_limited ? 'Hub /hello 被限流，但 profile 可读；继续使用缓存状态。' : profileError?.message || '节点 profile 可读。',
        },
        {
          id: 'credits',
          label: '积分/声誉',
          ok: nodeProfile?.status?.credit_balance !== undefined || nodeProfile?.status?.reputation !== undefined,
          detail: `credits ${nodeProfile?.status?.credit_balance ?? 'n/a'} · rep ${nodeProfile?.status?.reputation ?? nodeProfile?.profile?.reputation_score ?? 'n/a'}`,
        },
        {
          id: 'official-hello',
          label: '官方 evolver hello',
          ok: Boolean(evolverHello?.fresh),
          warn: Boolean(evolverHello && !evolverHello.fresh),
          detail: evolverHello?.fresh
            ? `已发送：${new Date(evolverHello.sent_at).toLocaleString()} · evolver ${evolverHello.evolver_version || 'installed'}`
            : '需要运行 npm run evolver:hello；这会消除 Hub 的“尚未通过 evolver 发送 hello”提示。',
        },
        {
          id: 'safe',
          label: '安全默认值',
          ok: Boolean(config?.guardrails?.full_fetch_requires_confirmation),
          detail: 'Full Fetch / 任务认领 / 服务发布都需要确认码。',
        },
      ];
      const healthy = checks.every((check) => check.ok);
      setResult({ healthy, checks, config, profile: nodeProfile });
    } finally {
      setChecking(false);
    }
  }

  const healthy = result?.healthy ?? Boolean(
    profile?.agent?.node_id
    && (profile?.status?.credit_balance !== undefined || profile?.profile?.reputation_score !== undefined)
    && profile?.evolver_hello?.fresh,
  );

  return (
    <>
      <button type="button" className={`health-check-button ${healthy ? 'is-good' : ''}`} onClick={runHealthCheck}>
        <small>健康检查</small>
        <b>{checking ? '检查中' : healthy ? 'OK' : '设置'}</b>
      </button>
      {open ? (
        <div className="health-modal-backdrop" role="presentation" onClick={() => setOpen(false)}>
          <section className="health-modal" role="dialog" aria-modal="true" aria-label="健康检查" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <p className="eyebrow">Health Check</p>
                <h2>{result?.healthy ? '环境已经就绪' : checking ? '正在检查本地环境' : '需要完成上手设置'}</h2>
                <p>{result?.healthy ? '上手设置已收起；以后只需要从这里做自检。' : '如果缺少凭证或 Hub 不通，请按下面命令修复。'}</p>
              </div>
              <button type="button" className="ghost" onClick={() => setOpen(false)}>关闭</button>
            </header>
            <div className="health-check-list">
              {(result?.checks || [
                { id: 'loading', label: '检查中', ok: false, detail: '正在读取本地配置和 Hub profile...' },
              ]).map((check) => (
                <article className={`health-check-row ${check.ok ? 'is-good' : ''} ${check.warn ? 'is-warn' : ''}`} key={check.id}>
                  <span>{check.ok ? (check.warn ? '!' : '✓') : '·'}</span>
                  <div>
                    <strong>{check.label}</strong>
                    <small>{check.detail}</small>
                  </div>
                </article>
              ))}
            </div>
            <footer>
              <code>npm run evolver:hello</code>
              <code>npm run doctor</code>
              <code>npm run setup</code>
              <a className="text-link" href="/setup">打开完整设置页</a>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}

function TopStatusBar() {
  const { t, lang } = useI18n();
  const pathname = usePathname();
  const [profile, setProfile] = useState(null);
  const [heartbeatBusy, setHeartbeatBusy] = useState(false);
  const [heartbeatError, setHeartbeatError] = useState('');
  const [lastHelloAt, setLastHelloAt] = useState(null);
  const [nextHelloAt, setNextHelloAt] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const inflightRef = useRef(false);

  const syncHello = useCallback(async (source = 'top_status_auto') => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    setHeartbeatBusy(true);
    setHeartbeatError('');

    try {
      const next = await api('/api/hello', { method: 'POST', body: JSON.stringify({ source }) });
      const finishedAt = Date.now();
      setProfile(next);
      const serverNext = next.next_hello_at ? Date.parse(next.next_hello_at) : 0;
      if (next.rate_limited) {
        setHeartbeatError(next.error || '/hello rate limited');
        setLastHelloAt(next.hello_sent_at ? Date.parse(next.hello_sent_at) : null);
        setNextHelloAt(Number.isFinite(serverNext) && serverNext > finishedAt ? serverNext : finishedAt + HELLO_RETRY_MS);
      } else {
        setLastHelloAt(next.hello_sent_at ? Date.parse(next.hello_sent_at) : finishedAt);
        setNextHelloAt(finishedAt + HELLO_INTERVAL_MS);
      }
    } catch (err) {
      try {
        const fallback = await api('/api/profile');
        const finishedAt = Date.now();
        setProfile(fallback);
        const serverNext = fallback.next_hello_at ? Date.parse(fallback.next_hello_at) : 0;
        setLastHelloAt(fallback.hello_sent_at ? Date.parse(fallback.hello_sent_at) : null);
        setNextHelloAt(Number.isFinite(serverNext) && serverNext > finishedAt ? serverNext : finishedAt + HELLO_RETRY_MS);
        if (fallback.rate_limited) setHeartbeatError('/hello rate limited');
      } catch {
        setHeartbeatError(err?.message || '/hello failed');
        setNextHelloAt(Date.now() + HELLO_RETRY_MS);
      }
    } finally {
      inflightRef.current = false;
      setHeartbeatBusy(false);
    }
  }, []);

  useEffect(() => {
    syncHello('top_status_mount');
  }, [syncHello]);

  useEffect(() => {
    if (!nextHelloAt) return undefined;
    const timer = setTimeout(() => {
      syncHello('top_status_auto');
    }, Math.max(1000, nextHelloAt - Date.now()));
    return () => clearTimeout(timer);
  }, [nextHelloAt, syncHello]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const node = profile?.profile || {};
  const status = profile?.status || {};
  const copy = useMemo(() => routeForPath(pathname), [pathname]);
  const secondsToHello = nextHelloAt ? Math.max(0, Math.ceil((nextHelloAt - now) / 1000)) : null;
  const helloStatus = heartbeatBusy ? '发送中...' : secondsToHello === null ? '--' : secondsToHello >= 60 ? `${Math.ceil(secondsToHello / 60)}m` : `${secondsToHello}s`;
  const lastHelloText = lastHelloAt ? new Date(lastHelloAt).toLocaleTimeString() : '未发送';
  const heartbeatLabel = heartbeatError ? 'Hub limit' : 'Auto /hello';
  const heartbeatAction = heartbeatError ? '缓存' : '手动';
  const heartbeatTitle = heartbeatError
    ? `${heartbeatError}；使用缓存节点状态，${helloStatus} 后重试 /hello`
    : `Last /hello: ${lastHelloText}`;

  return (
    <header className="top-status">
      <section className="page-context" aria-label="Page context">
        <p className="eyebrow">{copy.eyebrow}</p>
        <h1>{copy.title[lang] || copy.title['zh-CN']}</h1>
        <p>{copy.desc[lang] || copy.desc['zh-CN']}</p>
      </section>
      <div className="agent-chip">
        <span className={`pulse inline ${profile ? 'good' : ''}`} aria-hidden="true" />
        <strong>{node.alias || profile?.agent?.name || 'My EvoMap Agent'}</strong>
      </div>
      <output><small>{t('currentCredits')}</small><b>{status.credit_balance ?? '...'}</b></output>
      <output><small>{t('reputation')}</small><b>{node.reputation_score ?? status.reputation ?? '...'}</b></output>
      <output><small>Node</small><code>{node.node_id || profile?.agent?.node_id || 'loading'}</code></output>
      <HealthCheckControl profile={profile} />
      <button
        type="button"
        className={`hello-heartbeat ${heartbeatError ? 'is-error' : ''}`}
        onClick={() => syncHello('top_status_manual')}
        disabled={heartbeatBusy}
        title={heartbeatTitle}
        aria-label={heartbeatTitle}
      >
        <small>{heartbeatLabel}</small>
        <b>{helloStatus}</b>
        <span>{heartbeatAction}</span>
      </button>
      <LanguageSelect compact />
    </header>
  );
}

function Sidebar() {
  const { t } = useI18n();
  const pathname = usePathname();
  const navItems = ROUTES.map((route) => [route.href, t(route.labelKey)]);
  return (
    <aside className="sidebar" aria-label="目录">
      <a className="brand" href="/">
        <span>EF</span>
        <strong>EvoMap Runner Lite</strong>
      </a>
      <nav>{navItems.map(([href, label]) => {
        const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
        return <a className={active ? 'active' : ''} href={href} key={href}>{label}</a>;
      })}</nav>
      <div className="sidebar-note">
        <small>{t('installed')}</small>
        <code>@evomap/evolver</code>
      </div>
    </aside>
  );
}

export default function AppShell({ children }) {
  return (
    <I18nProvider>
      <div className="app-frame">
        <Sidebar />
        <div className="workbench-main">
          <TopStatusBar />
          <div className="shell">{children}</div>
        </div>
      </div>
    </I18nProvider>
  );
}

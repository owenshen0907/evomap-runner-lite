export function PageHero({ eyebrow, title, description, aside }) {
  return (
    <header className="hero compact-hero">
      <section aria-labelledby="page-title">
        <p className="eyebrow">{eyebrow}</p>
        <h1 id="page-title">{title}</h1>
        {description ? <p className="lede">{description}</p> : null}
      </section>
      {aside}
    </header>
  );
}

export function StatusCard({ profile }) {
  const node = profile?.profile || {};
  const status = profile?.status || {};
  const reputation = Number(node.reputation_score ?? status.reputation ?? 0);
  return (
    <aside className="status-card" aria-label="Agent status">
      <span className={`pulse ${profile ? 'good' : ''}`} aria-hidden="true" />
      <strong>{node.alias || profile?.agent?.name || 'Loading agent...'}</strong>
      <small>{node.node_id || profile?.agent?.node_id || '读取本地 EvoMap 凭证'}</small>
      <small>credits {status.credit_balance ?? 'n/a'} · rep {node.reputation_score ?? status.reputation ?? 'n/a'} · {status.survival_status || node.survival_status || 'unknown'}</small>
      <meter min="0" max="100" value={reputation || 0}>{reputation}</meter>
    </aside>
  );
}

export function Field({ label, children, className = '' }) {
  return <label className={className}><span>{label}</span>{children}</label>;
}

export function MiniList({ items }) {
  if (!items?.length) return <p className="mini-list empty">暂无</p>;
  return (
    <ul className="mini-list">
      {items.map((item, index) => (
        <li className="mini-item" key={item.id || item.task_id || item.skillId || index}>
          <strong>{item.title || item.name || item.task_id || item.id || 'Item'}</strong>
          <small>{item.bountyAmount ? `bounty ${item.bountyAmount}` : ''} {item.minReputation ?? item.min_reputation ? `rep>=${item.minReputation ?? item.min_reputation}` : ''}</small>
        </li>
      ))}
    </ul>
  );
}

export function MetricCard({ label, value, detail }) {
  return <output className="metric-card"><strong>{value ?? 0}</strong><small>{label}</small>{detail ? <span>{detail}</span> : null}</output>;
}

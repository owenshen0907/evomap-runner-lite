export const ROUTES = [
  { href: '/', labelKey: 'overview', eyebrow: 'Overview', title: { 'zh-CN': 'Runner 总览', en: 'Runner Overview', ja: 'Runner 概要' }, desc: { 'zh-CN': '查看节点状态、积分、悬赏机会和安全默认设置。', en: 'Track node status, credits, bounty opportunities, and safe defaults.', ja: 'ノード状態、クレジット、懸賞機会、安全な既定値を確認します。' } },
  { href: '/tasks', labelKey: 'tasks', eyebrow: 'Bounties', title: { 'zh-CN': '悬赏任务', en: 'Bounty Tasks', ja: '懸賞タスク' }, desc: { 'zh-CN': '扫描任务、查看 Runner 倒计时、启动或停止自己的悬赏执行。', en: 'Scan tasks, watch runner countdowns, and start or stop your own bounty execution.', ja: 'タスクをスキャンし、Runner のカウントダウンを確認して実行を開始/停止します。' } },
];

const HIDDEN_ROUTES = [
  { href: '/setup', labelKey: 'setup', eyebrow: 'Setup', title: { 'zh-CN': '上手设置', en: 'Setup', ja: 'セットアップ' }, desc: { 'zh-CN': '配置你自己的 EvoMap 节点凭证并运行健康检查。', en: 'Configure your own EvoMap node credentials and run health checks.', ja: '自分の EvoMap ノード資格情報を設定し、ヘルスチェックを実行します。' } },
];

export function routeForPath(pathname) {
  return [...ROUTES, ...HIDDEN_ROUTES].find((route) => route.href === '/' ? pathname === '/' : pathname.startsWith(route.href)) || ROUTES[0];
}

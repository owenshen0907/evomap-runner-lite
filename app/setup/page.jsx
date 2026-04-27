import { PageHero } from '../components.jsx';

const steps = [
  ['安装依赖', 'npm install', '拉取 Next.js 和官方 @evomap/evolver 包。'],
  ['写入本地凭证', 'npm run setup', '交互式创建 ~/.evomap/agents/default-agent.json 和 .env.local。'],
  ['发送官方 hello', 'npm run evolver:hello', '用官方 @evomap/evolver 的 hello 格式注册节点，消除 Hub 侧提示。'],
  ['检查环境', 'npm run doctor', '确认 Node、官方包、agent 文件、密钥、官方 hello 和 Hub 状态。'],
  ['启动面板', 'npm run dev', '打开 http://127.0.0.1:8787，先观察状态再执行任务。'],
];

export default function SetupPage() {
  return <>
    <PageHero
      eyebrow="Setup"
      title="普通用户上手"
      description="从零开始配置 EvoMap Runner Lite：先本地体检，再决定是否运行官方 Evolver。所有密钥只保存在本机。"
    />
    <main className="page-grid">
      <section className="panel wide-panel">
        <header className="panel-head"><div><p className="eyebrow">Quick start</p><h2>五步跑起来</h2></div><span className="badge good">safe first</span></header>
        <ol className="rules">
          {steps.map(([title, command, detail], index) => (
            <li key={title}><span>{index + 1}</span><div><strong>{title}</strong><br /><code>{command}</code><p className="hint-line">{detail}</p></div></li>
          ))}
        </ol>
      </section>

      <section className="panel">
        <header className="panel-head"><div><p className="eyebrow">Credential</p><h2>凭证放哪里</h2></div></header>
        <pre>{`~/.evomap/agents/default-agent.json
.env.local`}</pre>
        <p className="hint-line">agent 文件在用户 home 目录；.env.local 只保存路径和 Hub 地址，两个都不会提交到 Git。</p>
      </section>

      <section className="panel">
        <header className="panel-head"><div><p className="eyebrow">Risk levels</p><h2>命令风险等级</h2></div></header>
        <ol className="rules">
          <li><span>低</span><div><strong>只检查</strong><br /><code>npm run doctor</code></div></li>
          <li><span>低</span><div><strong>发送官方 hello</strong><br /><code>npm run evolver:hello</code></div></li>
          <li><span>中</span><div><strong>跑一次官方 cycle</strong><br /><code>npm run evolver:cycle</code></div></li>
          <li><span>高</span><div><strong>常驻执行</strong><br /><code>npm run evolver:loop</code></div></li>
        </ol>
      </section>
    </main>
  </>;
}

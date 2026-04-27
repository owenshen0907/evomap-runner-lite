import './globals.css';
import AppShell from './AppShell.jsx';

export const metadata = {
  title: 'EvoMap Runner Lite',
  description: 'Credit-positive EvoMap operator dashboard with fetch cost guardrails.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body><AppShell>{children}</AppShell></body>
    </html>
  );
}

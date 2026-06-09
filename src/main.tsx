import { createRoot } from 'react-dom/client';
// 副作用导入：注入 window.electronAPI（Tauri invoke/listen 实现），必须在渲染前执行
import './renderer/lib/electronApiShim';
import './renderer/styles/design-tokens.css';
import './renderer/styles/components.css';
import SimpleApp from './renderer/SimpleApp';

// 应用 Design System 基础样式（背景/字体/字号），对应 design-tokens.css 的 body.adm 规则。
document.body.classList.add('adm');

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<SimpleApp />);
}

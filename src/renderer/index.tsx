import { createRoot } from 'react-dom/client';
import './styles/design-tokens.css';
import './styles/components.css';
import SimpleApp from './SimpleApp';

// 应用 Design System 的基础样式（背景/字体/字号），对应 design-tokens.css 的 body.adm 规则。
document.body.classList.add('adm');

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<SimpleApp />);
}

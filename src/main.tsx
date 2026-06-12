import { createRoot } from 'react-dom/client';
// 副作用导入：注入 window.electronAPI（Tauri invoke/listen 实现），必须在渲染前执行
import './renderer/lib/electronApiShim';
import './renderer/styles/design-tokens.css';
import './renderer/styles/components.css';
import SimpleApp from './renderer/SimpleApp';
import CapturePopout from './renderer/components/CapturePopout';
import { isCapturePopoutWindow } from './renderer/lib/capturePopout';

// 应用 Design System 基础样式（背景/字体/字号），对应 design-tokens.css 的 body.adm 规则。
document.body.classList.add('adm');

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  // ?popout=capture 的独立窗口只渲染视频播放器；主窗口渲染完整应用。
  root.render(isCapturePopoutWindow() ? <CapturePopout /> : <SimpleApp />);
}

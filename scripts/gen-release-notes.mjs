// 自动生成「本次更新说明」写入 release-notes.md（供 make-update-package 打进 latest.json 的 notes）。
// 移植自老工具 gen-release-notes.js，逻辑一致。
//
// 来源：自上次发版以来的 git 提交（取 feat/fix/perf，去前缀作为更新条目）。
// 「上次发版点」锚点优先级：
//   1) git 版本 tag（v*）——进库、跟 commit 走，由 build-update 发版时自动打（最可靠）。
//   2) update-releases/.last-release-commit 文件标记——兼容兜底（该目录 gitignore，易丢）。
//   3) 都没有 → 取最近 N 条提交并大声告警，绝不静默把整段历史当本次更新。
//
// 设计：永不让打包失败——git 不可用 / 无新提交等任何异常都兜底，exit 0。

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const notesFile = path.join(projectRoot, 'release-notes.md');
const markerDir = path.join(projectRoot, 'update-releases');
const markerFile = path.join(markerDir, '.last-release-commit');
const NO_ANCHOR_LOG_COUNT = 20;

const readVersion = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version || '';
  } catch {
    return '';
  }
};

const git = (args) => execSync(`git ${args}`, { cwd: projectRoot, encoding: 'utf8' }).trim();

const main = () => {
  const version = readVersion();
  let head;
  try {
    head = git('rev-parse HEAD');
  } catch (e) {
    if (!fs.existsSync(notesFile)) {
      fs.writeFileSync(notesFile, `v${version}\n\n- 维护性更新\n`, 'utf8');
    }
    console.warn('[gen-release-notes] git 不可用，保留现有说明:', e.message);
    return;
  }

  const isAncestor = (ref) => {
    try {
      git(`merge-base --is-ancestor ${ref} HEAD`);
      return true;
    } catch {
      return false;
    }
  };

  let anchor = null;
  // 1) 最近的可达版本 tag。
  try {
    const tags = git('tag --list "v*" --sort=-version:refname').split('\n').map((s) => s.trim()).filter(Boolean);
    for (const t of tags) {
      if (isAncestor(t)) {
        anchor = { ref: t, kind: 'tag' };
        break;
      }
    }
  } catch {
    /* 无 tag 或 git 不支持 --sort */
  }
  // 2) 文件标记兜底。
  if (!anchor) {
    let lastCommit = null;
    try {
      lastCommit = fs.readFileSync(markerFile, 'utf8').trim() || null;
    } catch {
      lastCommit = null;
    }
    if (lastCommit && isAncestor(lastCommit)) anchor = { ref: lastCommit, kind: 'marker' };
  }

  let subjects = [];
  if (anchor) {
    console.log(`[gen-release-notes] 发版锚点 = ${anchor.kind} ${anchor.ref}`);
    try {
      subjects = git(`log ${anchor.ref}..HEAD --no-merges --pretty=%s`).split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      subjects = [];
    }
  } else {
    console.warn(
      `[gen-release-notes] 警告：未找到版本 tag / 有效发版标记，无法定位上次发版点；` +
        `回退到最近 ${NO_ANCHOR_LOG_COUNT} 条提交，请核对本次说明，或下次用 --no-auto-notes 手写。`,
    );
    try {
      subjects = git(`log -${NO_ANCHOR_LOG_COUNT} --no-merges --pretty=%s`).split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      subjects = [];
    }
  }

  // 面向用户的提交（feat/fix/perf），去前缀；没有就退而用全部提交主题。
  const userFacing = subjects
    .filter((s) => /^(feat|fix|perf)\s*[:：]/i.test(s))
    .map((s) => s.replace(/^(feat|fix|perf)\s*[:：]\s*/i, '').trim())
    .filter(Boolean);
  const seen = new Set();
  const items = (userFacing.length ? userFacing : subjects).filter((s) => {
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });

  let date = '';
  try {
    date = git('log -1 --pretty=%ad --date=format:%Y-%m-%d');
  } catch {
    date = '';
  }

  const bullets = items.length ? items.map((s) => `- ${s}`).join('\n') : '- 维护性更新';
  const content = `v${version}${date ? `  (${date})` : ''}\n\n${bullets}\n`;
  fs.writeFileSync(notesFile, content, 'utf8');

  try {
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(markerFile, head + '\n', 'utf8');
  } catch (e) {
    console.warn('[gen-release-notes] 写发版标记失败:', e.message);
  }

  console.log(`[gen-release-notes] v${version}: 写入 ${items.length} 条更新说明`);
};

try {
  main();
} catch (e) {
  console.warn('[gen-release-notes] 生成异常，跳过（不影响打包）:', e && e.message);
}
process.exit(0);

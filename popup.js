'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────
const PAGE_SIZE = 10;
const MAX_PAGES = 5;
const REQ_DELAY_MS = 600;
const DEFAULT_CAT = '__uncategorized__';

// ── 搜索接口节流：经验证 600ms 安全，更快会触发 200013 ──
let _searchQueueTail = Promise.resolve();
const SEARCH_MIN_GAP_MS = 600;
let _rateLimitCount = 0;                // 本轮触发限流次数

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatDate(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function timeAgo(ts) {
  const diff = Date.now() / 1000 - ts;
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  return `${Math.floor(diff / 86400)}天前`;
}

function showToast(msg, duration = 2200) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), duration);
}

function showCooldownHint(seconds) {
  const el = document.getElementById('progress-text');
  if (!el) return;
  let remaining = seconds;
  el.textContent = `限流冷却中… 还需 ${remaining}s`;
  const timer = setInterval(() => {
    remaining--;
    if (remaining <= 0) { clearInterval(timer); return; }
    el.textContent = `限流冷却中… 还需 ${remaining}s`;
  }, 1000);
}

function noteSearchRateLimit() {
  _rateLimitCount++;
}

// ── 日志系统 ──
let _logStartTime = 0;
let _logStartClock = '';
const _logLines = [];
const LOG_MAX_LINES = 2000;

function _addLogLine(event, details) {
  const t = _logStartTime ? ((Date.now() - _logStartTime) / 1000).toFixed(1) : '----';
  const evt = String(event || '').padEnd(7);
  const line = `${t.padStart(6)}s  ${evt}  ${details || ''}`;
  _logLines.push(line);
  if (_logLines.length > LOG_MAX_LINES) _logLines.splice(0, _logLines.length - LOG_MAX_LINES);
  const el = document.getElementById('log-area');
  if (el) { el.value = _logLines.join('\n'); el.scrollTop = el.scrollHeight; }
}

function logRunStart(accountCount) {
  _logStartTime = Date.now();
  const d = new Date(_logStartTime);
  _logStartClock = `${d.getHours().toString().padStart(2, '0')}${d.getMinutes().toString().padStart(2, '0')}${d.getSeconds().toString().padStart(2, '0')}`;
  _logLines.length = 0;
  _addLogLine('RUN', `acc=${accountCount}  gap=${SEARCH_MIN_GAP_MS}ms`);
}

function logStart(acc) { _addLogLine('START', acc); }
function logOk(acc) { _addLogLine('OK', acc); }
function logFail(acc, ret, reason) { _addLogLine('FAIL', `${acc}  ret=${ret}  ${reason || ''}`); }
function logCoolStart(sec) { _addLogLine('COOL', `${sec}s`); }
function logCoolEnd() { _addLogLine('COOL', 'end'); }
function logRetry(acc) { _addLogLine('RETRY', acc); }

function logDone(accountCount, rlCount) {
  const dur = _logStartTime ? ((Date.now() - _logStartTime) / 1000).toFixed(1) : '?';
  _addLogLine('DONE', `acc=${accountCount}  RL=${rlCount}  gap=${SEARCH_MIN_GAP_MS}ms  duration=${dur}s`);
}

function copyLog() {
  const text = _logLines.join('\n');
  if (!text) { showToast('日志为空'); return; }
  navigator.clipboard.writeText(text).then(() => showToast('日志已复制')).catch(() => showToast('复制失败'));
}

function downloadLog() {
  const text = _logLines.join('\n');
  if (!text) { showToast('日志为空'); return; }
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `monitor-log-${_logStartClock || 'unknown'}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('日志已下载');
}

function clearLog() {
  _logLines.length = 0;
  _logStartTime = 0;
  const el = document.getElementById('log-area');
  if (el) el.value = '';
}

function blobDownload(filename, content) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function safeName(s) { return s.replace(/[\\/:*?"<>|]/g, '').slice(0, 60); }

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
// categories: [{ id, name }]  — id 是时间戳字符串
// accounts:   [{ name, catId }]
// results:    [{ account, articles, error }]
// selectedSet: Set of "account|idx" keys
// activeNav: 'all' | accountName
let state = {
  categories: [],
  accounts: [],
  selectedDays: 1,
  cookieString: '',
  token: '',
  results: [],
  selectedSet: new Set(),
  activeNav: 'all',
};

// ─────────────────────────────────────────────────────────────────────────────
// 持久化
// ─────────────────────────────────────────────────────────────────────────────
function saveStorage() {
  chrome.storage.local.set({
    categories: state.categories,
    accounts: state.accounts,
    token: state.token,
  });
}

async function loadStorage() {
  return new Promise(resolve =>
    chrome.storage.local.get(['categories', 'accounts', 'token'], resolve)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Cookie & Token 初始化
// ─────────────────────────────────────────────────────────────────────────────
async function initCredentials() {
  // 1. 先尝试从当前标签页 URL 参数中提取 token
  let urlToken = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes('mp.weixin.qq.com')) {
      const u = new URL(tab.url);
      urlToken = u.searchParams.get('token') || '';
    }
  } catch (e) { /* 部分页面权限受限，忽略 */ }

  // 2. 读取 cookies
  const cookies = await new Promise(resolve =>
    chrome.cookies.getAll({ domain: 'mp.weixin.qq.com' }, resolve)
  );
  state.cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  // 3. 确定 token：URL 参数优先 > cookie
  let tokenVal = urlToken;
  if (!tokenVal) {
    tokenVal = (cookies.find(c => c.name === 'token') || {}).value || '';
  }
  if (!tokenVal) {
    const wx = await new Promise(resolve => chrome.cookies.getAll({ domain: 'weixin.qq.com' }, resolve));
    tokenVal = (wx.find(c => c.name === 'token') || {}).value || '';
  }
  if (tokenVal) {
    state.token = tokenVal;
    document.getElementById('token').value = tokenVal;
  }

  const dot = document.getElementById('cookie-dot');
  const text = document.getElementById('cookie-text');
  if (state.cookieString && state.cookieString.length > 20) {
    dot.className = 'dot ok'; text.textContent = `Cookie 已就绪`;
  } else {
    dot.className = 'dot err'; text.textContent = '未登录，请先访问 mp.weixin.qq.com';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar 渲染
// ─────────────────────────────────────────────────────────────────────────────
function renderSidebar() {
  // 全部计数
  const totalArticles = state.results.reduce((s, r) => s + (r.articles ? r.articles.length : 0), 0);
  document.getElementById('nav-all-count').textContent = totalArticles;

  const navAll = document.getElementById('nav-all');
  navAll.className = 'sidebar-all' + (state.activeNav === 'all' ? ' active' : '');

  const catListEl = document.getElementById('cat-list');
  catListEl.innerHTML = '';

  // 按分类分组
  const catMap = {}; // catId -> accounts[]
  for (const acc of state.accounts) {
    const cid = acc.catId || DEFAULT_CAT;
    if (!catMap[cid]) catMap[cid] = [];
    catMap[cid].push(acc);
  }

  // 先渲染已命名分类，再渲染未分类
  const orderedCats = [...state.categories];
  // 如果有未分类账号，末尾加虚拟分类
  if (catMap[DEFAULT_CAT] && catMap[DEFAULT_CAT].length > 0) {
    orderedCats.push({ id: DEFAULT_CAT, name: '未分类' });
  }

  for (const cat of orderedCats) {
    const accs = catMap[cat.id] || [];
    const catArticleCount = accs.reduce((s, a) => {
      const r = state.results.find(x => x.account === a.name);
      return s + (r && r.articles ? r.articles.length : 0);
    }, 0);

    const block = document.createElement('div');
    block.className = 'cat-block' + (cat.id === DEFAULT_CAT ? ' uncategorized' : '');
    block.dataset.catId = cat.id;

    // 分类头
    const header = document.createElement('div');
    header.className = 'cat-header';
    header.innerHTML = `
      <span class="cat-arrow">▾</span>
      <span class="cat-name">${cat.name}</span>
      <span class="cat-total">${catArticleCount > 0 ? catArticleCount + '篇' : ''}</span>
      ${cat.id !== DEFAULT_CAT ? '<button class="cat-menu-btn" title="更多操作">•••</button>' : ''}
    `;

    // 折叠/展开
    header.addEventListener('click', e => {
      if (e.target.closest('.cat-menu-btn')) return;
      header.classList.toggle('collapsed');
      accList.style.display = header.classList.contains('collapsed') ? 'none' : '';
    });

    // 右键菜单
    const menuBtn = header.querySelector('.cat-menu-btn');
    if (menuBtn) {
      menuBtn.addEventListener('click', e => {
        e.stopPropagation();
        showCtxMenu(e, cat.id);
      });
    }

    // 公众号列表
    const accList = document.createElement('div');
    accList.className = 'acc-list';

    for (const acc of accs) {
      const r = state.results.find(x => x.account === acc.name);
      const cnt = r && r.articles ? r.articles.length : 0;
      const hasArts = cnt > 0;
      const item = document.createElement('div');
      item.className = 'acc-item' + (hasArts ? ' has-articles' : '') + (state.activeNav === acc.name ? ' active' : '');
      item.dataset.acc = acc.name;
      item.innerHTML = `
        <span class="acc-dot"></span>
        <span class="acc-name" title="${acc.name}">${acc.name}</span>
        <span class="acc-count">${hasArts ? cnt + '篇' : (r ? '0' : '—')}</span>
      `;
      item.addEventListener('click', () => setActiveNav(acc.name));
      item.addEventListener('contextmenu', e => {
        e.preventDefault();
        showAccCtxMenu(e, acc.name);
      });
      accList.appendChild(item);
    }

    if (accs.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:4px 10px 6px 20px;font-size:11px;color:#c7c7cc;';
      empty.textContent = '暂无公众号';
      accList.appendChild(empty);
    }

    block.appendChild(header);
    block.appendChild(accList);
    catListEl.appendChild(block);
  }

  // 如果没有任何分类也没有未分类，显示引导
  if (orderedCats.length === 0) {
    catListEl.innerHTML = '<div style="padding:12px 10px;font-size:11px;color:#c7c7cc;text-align:center;">点击 ＋ 新建分类<br>然后在「管理公众号」中添加</div>';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 导航切换
// ─────────────────────────────────────────────────────────────────────────────
function setActiveNav(nav) {
  state.activeNav = nav;
  state.selectedSet.clear();
  renderSidebar();
  renderArticlePanel();
}

// ─────────────────────────────────────────────────────────────────────────────
// 右侧文章面板渲染
// ─────────────────────────────────────────────────────────────────────────────
function renderArticlePanel() {
  const panel = document.getElementById('articles-panel');
  const titleEl = document.getElementById('right-title');
  const metaEl = document.getElementById('right-meta');
  panel.innerHTML = '';

  const daysLabel = state.selectedDays === 1 ? '最近24小时' : `最近${state.selectedDays}天`;

  if (state.results.length === 0) {
    titleEl.textContent = state.activeNav === 'all' ? '全部文章' : state.activeNav;
    metaEl.textContent = '';
    panel.innerHTML = '<div class="art-empty"><div>尚未获取文章</div><div class="hint">点击「▶ 开始监测」</div></div>';
    updateActionBar();
    return;
  }

  // 决定要渲染哪些结果
  let targets;
  if (state.activeNav === 'all') {
    targets = state.results;
    titleEl.textContent = '全部文章';
  } else {
    targets = state.results.filter(r => r.account === state.activeNav);
    titleEl.textContent = state.activeNav;
  }

  const totalCount = targets.reduce((s, r) => s + (r.articles ? r.articles.length : 0), 0);
  metaEl.textContent = `${daysLabel} · ${totalCount} 篇`;

  if (totalCount === 0 && !targets.some(r => r.error)) {
    panel.innerHTML = `<div class="art-empty"><div>所选范围内暂无新文章</div><div class="hint">${daysLabel}</div></div>`;
    updateActionBar();
    return;
  }

  const showAccTag = state.activeNav === 'all'; // 全部模式下显示来源标签

  let globalIdx = 0;
  for (const { account, articles, error } of targets) {
    if (error) {
      const errEl = document.createElement('div');
      errEl.className = 'err-item';
      errEl.textContent = `⚠️ ${account}：${error}`;
      panel.appendChild(errEl);
      continue;
    }
    if (!articles || articles.length === 0) continue;

    // 全部模式下显示账号分组标题
    if (showAccTag) {
      const groupTitle = document.createElement('div');
      groupTitle.className = 'acc-group-title';
      groupTitle.textContent = account;
      panel.appendChild(groupTitle);
    }

    articles.forEach((a, i) => {
      const key = `${account}|${i}`;
      const checked = state.selectedSet.has(key);
      globalIdx++;

      const item = document.createElement('div');
      item.className = 'article-item';
      item.innerHTML = `
        <div class="col-check">
          <input type="checkbox" data-key="${key}" data-acc="${account}" data-idx="${i}" ${checked ? 'checked' : ''}>
        </div>
        <span class="art-idx">${globalIdx}</span>
        <div class="art-body">
          <a class="art-title" href="#" data-url="${a.link}" title="${a.title}">${a.title}</a>
          <span class="art-meta">${a.date}</span>
        </div>
        <div class="art-actions">
          <button class="art-btn-dl"
            data-acc="${encodeURIComponent(account)}"
            data-idx="${i}">💾 下载</button>
        </div>
      `;

      item.querySelector('input[type="checkbox"]').addEventListener('change', cb => {
        const acc = cb.target.dataset.acc;
        const idx = parseInt(cb.target.dataset.idx);
        const k = `${acc}|${idx}`;
        if (cb.target.checked) state.selectedSet.add(k);
        else state.selectedSet.delete(k);
        updateActionBar();
      });

      item.querySelector('.art-btn-dl').addEventListener('click', e => {
        const acc = decodeURIComponent(e.currentTarget.dataset.acc);
        const idx = parseInt(e.currentTarget.dataset.idx);
        const r = state.results.find(x => x.account === acc);
        if (r) downloadArticle(r.articles[idx], acc, e.currentTarget);
      });

      // 链接点击：用 chrome.tabs.create 新开标签页，弹窗不关闭
      item.querySelector('.art-title').addEventListener('click', e => {
        e.preventDefault();
        const url = e.currentTarget.dataset.url;
        if (url && url !== '#') chrome.tabs.create({ url });
      });

      panel.appendChild(item);
    });
  }

  if (panel.children.length === 0) {
    panel.innerHTML = '<div class="art-empty"><div>暂无文章</div></div>';
  }

  updateActionBar();
}

// ─────────────────────────────────────────────────────────────────────────────
// 操作栏
// ─────────────────────────────────────────────────────────────────────────────
function updateActionBar() {
  const count = state.selectedSet.size;
  document.getElementById('sel-count').textContent = count;
  document.getElementById('dl-selected-btn').disabled = count === 0;

  const hasResults = state.results.some(r => r.articles && r.articles.length > 0);
  document.getElementById('action-bar').style.display = hasResults ? 'flex' : 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// 勾选逻辑
// ─────────────────────────────────────────────────────────────────────────────
function toggleSelectAll() {
  // 全选当前面板中所有可见文章
  let targets;
  if (state.activeNav === 'all') {
    targets = state.results;
  } else {
    targets = state.results.filter(r => r.account === state.activeNav);
  }
  const allKeys = [];
  for (const { account, articles } of targets) {
    if (!articles) continue;
    articles.forEach((_, i) => allKeys.push(`${account}|${i}`));
  }
  const allSelected = allKeys.every(k => state.selectedSet.has(k));
  if (allSelected) {
    allKeys.forEach(k => state.selectedSet.delete(k));
  } else {
    allKeys.forEach(k => state.selectedSet.add(k));
  }
  // 同步 checkbox
  allKeys.forEach(key => {
    const cb = document.querySelector(`input[data-key="${key}"]`);
    if (cb) cb.checked = state.selectedSet.has(key);
  });
  updateActionBar();
}

function clearSelection() {
  state.selectedSet.clear();
  document.querySelectorAll('input[data-key]').forEach(el => { el.checked = false; });
  updateActionBar();
}

function getSelectedArticles() {
  const result = [];
  for (const key of state.selectedSet) {
    const [account, idxStr] = key.split('|');
    const idx = parseInt(idxStr);
    const group = state.results.find(r => r.account === account);
    if (group && group.articles[idx]) {
      result.push({ article: group.articles[idx], account });
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 下载（Content Script 方式：打开页面 → 提取正文 → 保存 MD → 关闭标签页）
// ─────────────────────────────────────────────────────────────────────────────

// 生成链接版 MD（降级方案）
function buildMD(article, account) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  return `# ${article.title}\n\n---\n\n> **来源**：${account}\n\n> **链接**：${article.link}\n\n> **发布时间**：${article.date || '未知'}\n\n> **保存时间**：${now}\n\n`;
}

// 等待 content script 返回文章内容
function fetchArticleContent(tabId, requestId, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error('提取超时'));
    }, timeout);

    function listener(msg, sender) {
      if (msg.type === 'ARTICLE_CONTENT' && msg.requestId === requestId) {
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        if (msg.ok) resolve(msg.content);
        else reject(new Error(msg.error || '提取失败'));
      }
    }
    chrome.runtime.onMessage.addListener(listener);
  });
}

// 单篇下载
async function downloadArticle(article, account, btn) {
  btn.disabled = true;
  btn.textContent = '⏳';

  let tab = null;
  try {
    // 1. 创建新标签页打开文章（后台打开，不聚焦）
    tab = await chrome.tabs.create({ url: article.link, active: false });

    // 2. 生成唯一请求 ID
    const requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    // 3. 先监听返回消息
    const contentPromise = fetchArticleContent(tab.id, requestId, 25000);

    // 4. 等待 content script 注入完成后再发送提取指令
    //    content_scripts run_at document_idle，通常需要 2-4 秒
    await sleep(2500);
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_ARTICLE', requestId });
    } catch (e) {
      // content script 可能还没准备好，多等一会重试
      await sleep(3000);
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_ARTICLE', requestId });
      } catch (e2) {
        // 如果还是失败，尝试用 scripting API 手动注入
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
          });
          await sleep(1000);
          await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_ARTICLE', requestId });
        } catch (e3) {
          // 注入也失败了
        }
      }
    }

    // 5. 等待 content script 返回正文
    const md = await contentPromise;

    // 6. 保存 MD 文件
    blobDownload(`${safeName(account)}_${safeName(article.title)}.md`, md);
    btn.textContent = '✅';
    showToast(`已保存正文：${article.title.slice(0, 30)}`);

  } catch (e) {
    // 降级：保存链接版
    blobDownload(`${safeName(account)}_${safeName(article.title)}.md`, buildMD(article, account));
    btn.textContent = '✅链接';
    showToast(`正文提取失败，已保存链接：${e.message}`);
  }

  // 关闭打开的标签页
  if (tab && tab.id) {
    try { await chrome.tabs.remove(tab.id); } catch (e) { /* 忽略 */ }
  }

  setTimeout(() => { btn.textContent = '💾 下载'; btn.disabled = false; }, 2500);
}

// 批量下载
async function downloadSelected() {
  const selected = getSelectedArticles();
  if (selected.length === 0) return;
  const dlBtn = document.getElementById('dl-selected-btn');
  dlBtn.disabled = true;

  let ok = 0, fallback = 0;

  for (let i = 0; i < selected.length; i++) {
    const { article, account } = selected[i];
    dlBtn.textContent = `⏳ ${i + 1}/${selected.length}`;

    let tab = null;
    try {
      // 打开标签页
      tab = await chrome.tabs.create({ url: article.link, active: false });
      const requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

      const contentPromise = fetchArticleContent(tab.id, requestId, 25000);

      await sleep(2500);
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_ARTICLE', requestId });
      } catch (e) {
        await sleep(3000);
        try {
          await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_ARTICLE', requestId });
        } catch (e2) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content.js']
            });
            await sleep(1000);
            await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_ARTICLE', requestId });
          } catch (e3) { /* 忽略 */ }
        }
      }

      const md = await contentPromise;
      blobDownload(`${safeName(account)}_${safeName(article.title)}.md`, md);
      ok++;

    } catch (e) {
      // 降级：保存链接版
      blobDownload(`${safeName(account)}_${safeName(article.title)}.md`, buildMD(article, account));
      fallback++;
    }

    // 关闭标签页
    if (tab && tab.id) {
      try { await chrome.tabs.remove(tab.id); } catch (e) { /* 忽略 */ }
    }

    // 间隔一下避免太频繁
    if (i < selected.length - 1) await sleep(500);
  }

  dlBtn.disabled = false;
  dlBtn.textContent = '💾 批量下载';
  if (fallback > 0) {
    showToast(`完成！${ok} 篇正文，${fallback} 篇链接（提取失败降级）`);
  } else {
    showToast(`完成！成功下载 ${ok} 篇正文`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 导出报告
// ─────────────────────────────────────────────────────────────────────────────
function exportMarkdown() {
  const daysLabel = state.selectedDays === 1 ? '最近24小时' : `最近${state.selectedDays}天`;
  const now = new Date();
  const dateStr = formatDate(Math.floor(now.getTime() / 1000));
  let total = 0;
  state.results.forEach(r => { total += r.articles ? r.articles.length : 0; });

  let md = `# 公众号文章监测报告\n\n> 生成时间：${dateStr}　|　时间范围：${daysLabel}　|　共 **${total}** 篇\n\n---\n\n`;
  for (const { account, articles, error } of state.results) {
    md += `## ${account}\n\n`;
    if (error) {
      md += `> ⚠️ 获取失败：${error}\n\n`;
    } else if (!articles || articles.length === 0) {
      md += `> ${daysLabel}内暂无新文章\n\n`;
    } else {
      articles.forEach((a, i) => {
        md += `### ${i + 1}. [${a.title}](${a.link})\n\n- **时间**：${a.date}（${a.timeAgo}）\n`;
        if (a.digest) md += `- **摘要**：${a.digest}\n`;
        md += '\n';
      });
    }
    md += `---\n\n`;
  }
  blobDownload(`公众号监测报告_${dateStr.replace(/[: ]/g, '-')}.md`, md);
  showToast('已导出 Markdown 报告');
}

// ─────────────────────────────────────────────────────────────────────────────
// API 请求
// ─────────────────────────────────────────────────────────────────────────────
function buildHeaders() {
  return {
    'Cookie': state.cookieString,
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': 'https://mp.weixin.qq.com/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'X-Requested-With': 'XMLHttpRequest',
  };
}

async function searchFakeid(accountName) {
  // 全局队列保证 search 请求间隔 ≥ SEARCH_MIN_GAP_MS
  const myReq = _searchQueueTail.then(async () => {
    await sleep(SEARCH_MIN_GAP_MS);
    return searchWithRetry(accountName);
  });
  _searchQueueTail = myReq.catch(() => {});
  return myReq;
}

async function searchWithRetry(accountName) {
  logStart(accountName);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await trySearchOnce(accountName);
      logOk(accountName);
      return result;
    } catch (err) {
      const isRateLimit = /搜索频率限制/.test(err.message);
      if (!isRateLimit) {
        logFail(accountName, '?', err.message);
        throw err;
      }
      const m = err.message.match(/ret=(\d+)/);
      const ret = m ? m[1] : '?';
      logFail(accountName, ret, 'rate limit');
      noteSearchRateLimit();
      if (attempt === 2) throw err;
      logCoolStart(60);
      showCooldownHint(60);
      await sleep(60 * 1000);
      logCoolEnd();
      logRetry(accountName);
    }
  }
}

async function trySearchOnce(accountName) {
  const token = document.getElementById('token').value.trim() || state.token;
  const url = `https://mp.weixin.qq.com/cgi-bin/searchbiz?action=search_biz&begin=0&count=5&query=${encodeURIComponent(accountName)}&token=${token}&lang=zh_CN&f=json&ajax=1`;
  const resp = await fetch(url, { headers: buildHeaders() });
  const data = await resp.json();

  if (!data.base_resp) {
    throw new Error(`搜索接口无响应: ${accountName}`);
  }

  if (data.base_resp.ret !== 0) {
    const ret = data.base_resp.ret;
    const msg = data.base_resp.err_msg || data.base_resp.errmsg || '';
    if (ret === 200003 || ret === 200013 || /freq|limit|频繁/i.test(msg)) {
      throw new Error(`搜索频率限制 (ret=${ret}): ${accountName}`);
    }
    if (ret === 200001 || /token|invalid/i.test(msg)) {
      throw new Error(`Token 无效 (ret=${ret}): ${accountName}`);
    }
    throw new Error(`搜索失败 ret=${ret}${msg ? ' ' + msg : ''}: ${accountName}`);
  }

  if (data.list && data.list.length > 0) {
    const exact = data.list.find(b => b.nickname === accountName);
    return exact ? exact.fakeid : data.list[0].fakeid;
  }

  throw new Error(`未找到公众号: ${accountName}`);
}

async function fetchArticlesPage(fakeid, page) {
  const token = document.getElementById('token').value.trim() || state.token;
  const begin = (page - 1) * PAGE_SIZE;
  const url = `https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list&search_field=null&begin=${begin}&count=${PAGE_SIZE}&query=&fakeid=${encodeURIComponent(fakeid)}&type=101_1&free_publish_type=1&sub_action=list_ex&token=${token}&lang=zh_CN&f=json&ajax=1`;
  const resp = await fetch(url, { headers: buildHeaders() });
  const data = await resp.json();

  if (!data.base_resp) {
    throw new Error('文章接口无响应');
  }
  if (data.base_resp.ret !== 0) {
    const ret = data.base_resp.ret;
    const msg = data.base_resp.err_msg || data.base_resp.errmsg || '';
    if (ret === 200003 || /freq|limit|频繁/i.test(msg)) {
      throw new Error(`文章频率限制 (ret=${ret})`);
    }
    throw new Error(`文章拉取失败 ret=${ret}${msg ? ' ' + msg : ''}`);
  }
  if (!data.publish_page) {
    throw new Error('文章接口返回数据为空');
  }
  return JSON.parse(data.publish_page);
}

async function fetchArticlesPageWithRetry(fakeid, page, accountName) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetchArticlesPage(fakeid, page);
    } catch (err) {
      const isRateLimit = /文章频率限制/.test(err.message);
      if (!isRateLimit || attempt === 2) throw err;
      const m = err.message.match(/ret=(\d+)/);
      const ret = m ? m[1] : '?';
      _addLogLine('ART-RL', `${accountName}  page=${page}  ret=${ret}  → 30s 冷却后重试 (第 ${attempt + 1}/2 次)`);
      await sleep(30 * 1000);
      _addLogLine('ART', `${accountName}  page=${page}  重试中…`);
    }
  }
}

async function monitorAccount(accountName, cutoffTs) {
  const fakeid = await searchFakeid(accountName);
  const articles = [];
  let page = 1, exhausted = false;
  while (page <= MAX_PAGES && !exhausted) {
    let publishPage;
    try {
      publishPage = await fetchArticlesPageWithRetry(fakeid, page, accountName);
    } catch (err) {
      const m = err.message.match(/ret=(\d+)/);
      const ret = m ? m[1] : '?';
      const isRL = /文章频率限制/.test(err.message);
      _addLogLine(isRL ? 'ART-RL' : 'ART-FAIL', `${accountName}  page=${page}  ret=${ret}  ${err.message}`);
      throw err;
    }
    const list = publishPage.publish_list || [];
    if (list.length === 0) break;
    for (const item of list) {
      try {
        const info = JSON.parse(item.publish_info);
        for (const msg of (info.appmsgex || [])) {
          const ts = msg.create_time || msg.update_time || 0;
          if (ts < cutoffTs) { exhausted = true; break; }
          articles.push({
            title: msg.title || '无标题',
            link: msg.link || '#',
            digest: msg.digest || '',
            create_time: ts,
            date: formatDate(ts),
            timeAgo: timeAgo(ts),
          });
        }
        if (exhausted) break;
      } catch (e) { /* skip */ }
    }
    page++;
    if (!exhausted && page <= MAX_PAGES) await sleep(200);
  }
  _addLogLine('ART', `${accountName}  n=${articles.length}  pages=${page - 1}`);
  return articles;
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程：开始监测
// ─────────────────────────────────────────────────────────────────────────────
async function runMonitor() {
  const token = document.getElementById('token').value.trim();
  if (!token) { showToast('请先填写 Token'); return; }
  if (state.accounts.length === 0) { showToast('请先在「管理公众号」中添加公众号'); return; }

  state.token = token;
  saveStorage();

  const cookies = await new Promise(resolve => chrome.cookies.getAll({ domain: 'mp.weixin.qq.com' }, resolve));
  state.cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  const cutoffTs = Math.floor((Date.now() - state.selectedDays * 86400 * 1000) / 1000);
  state.selectedSet.clear();
  state.results = [];
  _rateLimitCount = 0;
  logRunStart(state.accounts.length);

  const runBtn = document.getElementById('run-btn');
  const progressWrap = document.getElementById('progress-wrap');
  const progressBar = document.getElementById('progress-bar');
  const progressText = document.getElementById('progress-text');
  runBtn.disabled = true;
  progressWrap.style.display = 'block';

  const CONCURRENCY = 3;
  let completed = 0;
  const results = [];

  async function processOne(acc) {
    try {
      const articles = await monitorAccount(acc.name, cutoffTs);
      return { account: acc.name, articles, error: null };
    } catch (err) {
      return { account: acc.name, articles: [], error: err.message };
    }
  }

  const tasks = state.accounts.map(acc => () => processOne(acc));
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      const r = await tasks[i]();
      results[i] = r;
      completed++;
      progressBar.style.width = `${Math.round(completed / state.accounts.length * 100)}%`;
      progressText.textContent = `[${completed}/${state.accounts.length}] 已完成 · 间隔 ${SEARCH_MIN_GAP_MS}ms · 限流 ${_rateLimitCount} 次`;
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, () => worker()));
  state.results = results.filter(Boolean);

  progressBar.style.width = '100%';
  progressText.textContent = `完成！共检查 ${state.accounts.length} 个公众号 · 触发限流 ${_rateLimitCount} 次`;
  logDone(state.accounts.length, _rateLimitCount);
  setTimeout(() => { progressWrap.style.display = 'none'; }, 1500);
  runBtn.disabled = false;

  renderSidebar();
  renderArticlePanel();
}

// ─────────────────────────────────────────────────────────────────────────────
// 分类管理
// ─────────────────────────────────────────────────────────────────────────────
let _catModalMode = 'create'; // 'create' | 'rename'
let _ctxCatId = null;

function openCatModal(mode, catId) {
  _catModalMode = mode;
  _ctxCatId = catId || null;
  const modal = document.getElementById('modal-cat');
  const title = document.getElementById('modal-cat-title');
  const input = document.getElementById('modal-cat-name');
  if (mode === 'rename') {
    const cat = state.categories.find(c => c.id === catId);
    title.textContent = '重命名分类';
    input.value = cat ? cat.name : '';
  } else {
    title.textContent = '新建分类';
    input.value = '';
  }
  modal.classList.add('open');
  setTimeout(() => input.focus(), 50);
}

function closeCatModal() {
  document.getElementById('modal-cat').classList.remove('open');
}

function confirmCatModal() {
  const name = document.getElementById('modal-cat-name').value.trim();
  if (!name) { showToast('请输入分类名称'); return; }
  if (_catModalMode === 'create') {
    const id = 'cat_' + Date.now();
    state.categories.push({ id, name });
    showToast(`分类「${name}」已创建`);
  } else {
    const cat = state.categories.find(c => c.id === _ctxCatId);
    if (cat) { cat.name = name; showToast('重命名成功'); }
  }
  saveStorage();
  closeCatModal();
  renderSidebar();
  refreshAccountModal();
}

// ─────────────────────────────────────────────────────────────────────────────
// 右键菜单（分类）
// ─────────────────────────────────────────────────────────────────────────────
let _ctxMenuCatId = null;

function showCtxMenu(e, catId) {
  _ctxMenuCatId = catId;
  hideAccCtxMenu(); // 关闭另一个菜单
  const menu = document.getElementById('ctx-menu');
  menu.classList.add('open');
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
}

function hideCtxMenu() {
  document.getElementById('ctx-menu').classList.remove('open');
}

// ─────────────────────────────────────────────────────────────────────────────
// 右键菜单（公众号）
// ─────────────────────────────────────────────────────────────────────────────
let _ctxAccName = null;

function showAccCtxMenu(e, accName) {
  _ctxAccName = accName;
  hideCtxMenu(); // 关闭另一个菜单
  const menu = document.getElementById('ctx-acc-menu');
  menu.classList.add('open');
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
}

function hideAccCtxMenu() {
  document.getElementById('ctx-acc-menu').classList.remove('open');
}

// ─────────────────────────────────────────────────────────────────────────────
// 管理公众号 Modal
// ─────────────────────────────────────────────────────────────────────────────
function openAccountModal() {
  document.getElementById('modal-accounts').classList.add('open');
  refreshAccountModal();
}

function closeAccountModal() {
  document.getElementById('modal-accounts').classList.remove('open');
}

function refreshAccountModal() {
  // 只刷新分类下拉
  const sel = document.getElementById('new-acc-cat');
  sel.innerHTML = state.categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('') +
    `<option value="${DEFAULT_CAT}">未分类</option>`;
}

function addAccountFromModal() {
  const raw = document.getElementById('new-acc-name').value;
  const names = raw.split('\n').map(s => s.trim()).filter(Boolean);
  if (!names.length) { showToast('请输入公众号名称'); return; }

  const catId = document.getElementById('new-acc-cat').value || DEFAULT_CAT;
  const existing = new Set(state.accounts.map(a => a.name));
  let added = 0;

  for (const name of names) {
    if (existing.has(name)) continue;
    state.accounts.push({ name, catId });
    existing.add(name);
    added++;
  }

  if (added === 0) { showToast('所有公众号已存在'); return; }

  saveStorage();
  renderSidebar();
  document.getElementById('new-acc-name').value = '';
  refreshAccountModal();
  showToast(`成功添加 ${added} 个公众号`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 初始化
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // 加载存储
  const saved = await loadStorage();
  if (saved.categories && Array.isArray(saved.categories)) state.categories = saved.categories;
  if (saved.accounts && Array.isArray(saved.accounts)) state.accounts = saved.accounts;
  if (saved.token) { state.token = saved.token; document.getElementById('token').value = saved.token; }

  await initCredentials();

  renderSidebar();
  renderArticlePanel();

  // ── 时间范围 ──
  document.getElementById('time-seg').addEventListener('click', e => {
    const btn = e.target.closest('button[data-days]');
    if (!btn) return;
    document.querySelectorAll('#time-seg button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.selectedDays = parseInt(btn.dataset.days);
  });

  // ── 开始监测 ──
  document.getElementById('run-btn').addEventListener('click', runMonitor);

  // ── 导出 MD ──
  document.getElementById('export-md-btn').addEventListener('click', exportMarkdown);

  // ── Token 变更 ──
  document.getElementById('token').addEventListener('change', e => {
    state.token = e.target.value.trim();
    saveStorage();
  });

  // ── 全部导航 ──
  document.getElementById('nav-all').addEventListener('click', () => setActiveNav('all'));

  // ── 新建分类 ──
  document.getElementById('add-cat-btn').addEventListener('click', () => openCatModal('create'));

  // ── 分类 Modal ──
  document.getElementById('modal-cat-cancel').addEventListener('click', closeCatModal);
  document.getElementById('modal-cat-ok').addEventListener('click', confirmCatModal);
  document.getElementById('modal-cat-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmCatModal();
    if (e.key === 'Escape') closeCatModal();
  });

  // ── 管理公众号 ──
  document.getElementById('manage-accounts-btn').addEventListener('click', openAccountModal);
  document.getElementById('modal-accounts-close').addEventListener('click', closeAccountModal);
  document.getElementById('add-acc-confirm').addEventListener('click', addAccountFromModal);
  document.getElementById('new-acc-name').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addAccountFromModal();
  });

  // ── 日志面板 ──
  document.getElementById('log-toggle-btn').addEventListener('click', () => {
    document.getElementById('log-panel').classList.toggle('open');
  });
  document.getElementById('log-close-btn').addEventListener('click', () => {
    document.getElementById('log-panel').classList.remove('open');
  });
  document.getElementById('log-copy-btn').addEventListener('click', copyLog);
  document.getElementById('log-download-btn').addEventListener('click', downloadLog);
  document.getElementById('log-clear-btn').addEventListener('click', clearLog);

  // ── 右键菜单 ──
  document.getElementById('ctx-rename').addEventListener('click', () => {
    hideCtxMenu();
    openCatModal('rename', _ctxMenuCatId);
  });
  document.getElementById('ctx-add-acc').addEventListener('click', () => {
    hideCtxMenu();
    openAccountModal();
    // 预选该分类
    setTimeout(() => {
      const sel = document.getElementById('new-acc-cat');
      if (sel) sel.value = _ctxMenuCatId;
    }, 50);
  });
  document.getElementById('ctx-delete').addEventListener('click', () => {
    hideCtxMenu();
    const cat = state.categories.find(c => c.id === _ctxMenuCatId);
    if (!cat) return;
    const accCount = state.accounts.filter(a => a.catId === _ctxMenuCatId).length;
    // 打开确认弹窗
    document.getElementById('modal-del-cat-title').textContent = `删除分类「${cat.name}」`;
    document.getElementById('modal-del-cat-desc').textContent =
      accCount > 0
        ? `该分类下有 ${accCount} 个公众号。删除分类后，这些公众号默认移至「未分类」，也可勾选下方选项将其一并删除。`
        : `该分类下暂无公众号。确认删除？`;
    document.getElementById('del-cat-with-accs').checked = false;
    document.getElementById('del-cat-with-accs').style.display = accCount > 0 ? '' : 'none';
    document.getElementById('del-cat-with-accs').parentElement.style.display = accCount > 0 ? '' : 'none';
    document.getElementById('modal-del-cat').classList.add('open');
  });

  // 确认删除分类
  document.getElementById('modal-del-cat-cancel').addEventListener('click', () => {
    document.getElementById('modal-del-cat').classList.remove('open');
  });
  document.getElementById('modal-del-cat-ok').addEventListener('click', () => {
    const cat = state.categories.find(c => c.id === _ctxMenuCatId);
    if (!cat) { document.getElementById('modal-del-cat').classList.remove('open'); return; }
    const withAccs = document.getElementById('del-cat-with-accs').checked;
    if (withAccs) {
      // 同时删除该分类下所有公众号及其监测结果
      const names = state.accounts.filter(a => a.catId === _ctxMenuCatId).map(a => a.name);
      state.accounts = state.accounts.filter(a => a.catId !== _ctxMenuCatId);
      state.results = state.results.filter(r => !names.includes(r.account));
      showToast(`分类「${cat.name}」及其 ${names.length} 个公众号已删除`);
    } else {
      // 仅删除分类，公众号移至未分类
      state.accounts.forEach(a => { if (a.catId === _ctxMenuCatId) a.catId = DEFAULT_CAT; });
      showToast(`分类「${cat.name}」已删除，公众号已移至未分类`);
    }
    state.categories = state.categories.filter(c => c.id !== _ctxMenuCatId);
    saveStorage();
    renderSidebar();
    renderArticlePanel();
    document.getElementById('modal-del-cat').classList.remove('open');
  });
  // 点击外部关闭右键菜单和所有 modal
  document.addEventListener('click', e => {
    if (!e.target.closest('#ctx-menu') && !e.target.closest('.cat-menu-btn')) hideCtxMenu();
    if (!e.target.closest('#ctx-acc-menu')) hideAccCtxMenu();
    if (e.target === document.getElementById('modal-cat')) closeCatModal();
    if (e.target === document.getElementById('modal-accounts')) closeAccountModal();
    if (e.target === document.getElementById('modal-del-cat')) {
      document.getElementById('modal-del-cat').classList.remove('open');
    }
    if (e.target === document.getElementById('modal-clear-all')) {
      document.getElementById('modal-clear-all').classList.remove('open');
    }
    if (e.target === document.getElementById('modal-move-acc')) {
      document.getElementById('modal-move-acc').classList.remove('open');
    }
    if (e.target === document.getElementById('modal-del-acc')) {
      document.getElementById('modal-del-acc').classList.remove('open');
    }
    if (e.target === document.getElementById('modal-about')) {
      document.getElementById('modal-about').classList.remove('open');
    }
  });

  // ── 公众号右键：移动到分类 ──
  document.getElementById('ctx-acc-move').addEventListener('click', () => {
    hideAccCtxMenu();
    if (!_ctxAccName) return;
    const acc = state.accounts.find(a => a.name === _ctxAccName);
    if (!acc) return;
    document.getElementById('move-acc-name').textContent = `公众号：${_ctxAccName}`;
    const sel = document.getElementById('move-acc-cat-sel');
    sel.innerHTML = state.categories.map(c => `<option value="${c.id}" ${acc.catId === c.id ? 'selected' : ''}>${c.name}</option>`).join('') +
      `<option value="${DEFAULT_CAT}" ${(!acc.catId || acc.catId === DEFAULT_CAT) ? 'selected' : ''}>未分类</option>`;
    document.getElementById('modal-move-acc').classList.add('open');
  });
  document.getElementById('modal-move-acc-cancel').addEventListener('click', () => {
    document.getElementById('modal-move-acc').classList.remove('open');
  });
  document.getElementById('modal-move-acc-ok').addEventListener('click', () => {
    const acc = state.accounts.find(a => a.name === _ctxAccName);
    if (acc) {
      acc.catId = document.getElementById('move-acc-cat-sel').value;
      saveStorage();
      renderSidebar();
      showToast(`已将「${_ctxAccName}」移动到新分类`);
    }
    document.getElementById('modal-move-acc').classList.remove('open');
  });

  // ── 公众号右键：删除 ──
  document.getElementById('ctx-acc-delete').addEventListener('click', () => {
    hideAccCtxMenu();
    if (!_ctxAccName) return;
    document.getElementById('modal-del-acc-desc').textContent =
      `确认删除公众号「${_ctxAccName}」？该公众号的监测结果也将一并删除。`;
    document.getElementById('modal-del-acc').classList.add('open');
  });
  document.getElementById('modal-del-acc-cancel').addEventListener('click', () => {
    document.getElementById('modal-del-acc').classList.remove('open');
  });
  document.getElementById('modal-del-acc-ok').addEventListener('click', () => {
    state.accounts = state.accounts.filter(a => a.name !== _ctxAccName);
    state.results = state.results.filter(r => r.account !== _ctxAccName);
    state.selectedSet.clear();
    if (state.activeNav === _ctxAccName) state.activeNav = 'all';
    saveStorage();
    renderSidebar();
    renderArticlePanel();
    showToast(`已删除：${_ctxAccName}`);
    document.getElementById('modal-del-acc').classList.remove('open');
  });

  // ── 清除所有数据 ──
  document.getElementById('clear-all-data-btn').addEventListener('click', () => {
    document.getElementById('modal-clear-all').classList.add('open');
  });
  document.getElementById('modal-clear-all-cancel').addEventListener('click', () => {
    document.getElementById('modal-clear-all').classList.remove('open');
  });
  document.getElementById('modal-clear-all-ok').addEventListener('click', () => {
    // 清空所有状态
    state.categories = [];
    state.accounts = [];
    state.token = '';
    state.results = [];
    state.selectedSet.clear();
    state.activeNav = 'all';
    // 清空 storage
    chrome.storage.local.clear(() => {
      document.getElementById('token').value = '';
      document.getElementById('modal-clear-all').classList.remove('open');
      closeAccountModal();
      renderSidebar();
      renderArticlePanel();
      showToast('所有数据已清除');
    });
  });

  // ── 批量下载 ──
  document.getElementById('dl-selected-btn').addEventListener('click', downloadSelected);
  document.getElementById('select-all-btn').addEventListener('click', toggleSelectAll);
  document.getElementById('clear-sel-btn').addEventListener('click', clearSelection);

  // ── 关于 ──
  document.getElementById('about-btn').addEventListener('click', () => {
    document.getElementById('modal-about').classList.add('open');
  });
  document.getElementById('modal-about-close').addEventListener('click', () => {
    document.getElementById('modal-about').classList.remove('open');
  });
});

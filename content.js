'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// 公众号文章正文提取 + HTML→Markdown 转换
// 注入到 mp.weixin.qq.com/s* 页面，提取文章正文后通过消息发回 popup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 主入口：监听来自 popup 的消息
 * 消息格式：{ type: 'EXTRACT_ARTICLE', requestId: string }
 * 返回格式：{ type: 'ARTICLE_CONTENT', requestId: string, ok: boolean, content?: string, error?: string }
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'EXTRACT_ARTICLE') return;

  // 异步处理
  (async () => {
    try {
      // 等待正文容器加载（最多 8 秒）
      const container = await waitForContent(8000);
      if (!container) {
        chrome.runtime.sendMessage({ type: 'ARTICLE_CONTENT', requestId: msg.requestId, ok: false, error: '未找到正文容器' });
        return;
      }

      const title = extractTitle();
      const author = extractAuthor();
      const date = extractDate();
      const mdBody = domToMarkdown(container);

      const md = `# ${title}\n\n` +
        `---\n\n` +
        `> **作者**：${author}\n\n` +
        `> **发布时间**：${date}\n\n` +
        `---\n\n` +
        mdBody;

      chrome.runtime.sendMessage({ type: 'ARTICLE_CONTENT', requestId: msg.requestId, ok: true, content: md });
    } catch (e) {
      chrome.runtime.sendMessage({ type: 'ARTICLE_CONTENT', requestId: msg.requestId, ok: false, error: e.message });
    }
  })();

  // 同步回复确认收到消息
  sendResponse({ received: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// 等待正文容器加载
// ─────────────────────────────────────────────────────────────────────────────
function waitForContent(timeout) {
  return new Promise(resolve => {
    const el = document.querySelector('#js_content');
    if (el && el.innerHTML.trim().length > 50) {
      resolve(el);
      return;
    }
    const observer = new MutationObserver(() => {
      const el = document.querySelector('#js_content');
      if (el && el.innerHTML.trim().length > 50) {
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      resolve(document.querySelector('#js_content'));
    }, timeout);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 提取标题、作者、日期
// ─────────────────────────────────────────────────────────────────────────────
function extractTitle() {
  return (document.querySelector('#activity-name') || document.querySelector('.rich_media_title'))?.textContent?.trim() || document.title || '无标题';
}

function extractAuthor() {
  return (document.querySelector('#js_name') || document.querySelector('.rich_media_meta_nickname') || document.querySelector('.profile_nickname'))?.textContent?.trim() || '未知';
}

function extractDate() {
  return (document.querySelector('#publish_time') || document.querySelector('.rich_media_meta_primary_category'))?.textContent?.trim() || '未知';
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM → Markdown 递归转换
// ─────────────────────────────────────────────────────────────────────────────
function domToMarkdown(root) {
  const lines = [];
  walkNode(root, lines, 0);
  // 清理多余空行
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function walkNode(node, lines, depth) {
  if (depth > 30) return; // 防止无限递归
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent.replace(/\s+/g, ' ').trim();
    if (text) lines.push(text);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const tag = node.tagName.toLowerCase();

  // 跳过隐藏元素、script、style
  if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'svg') return;
  const style = window.getComputedStyle(node);
  if (style && style.display === 'none') return;

  // 处理特定标签
  switch (tag) {
    case 'h1': lines.push(''); lines.push('# ' + getText(node)); lines.push(''); return;
    case 'h2': lines.push(''); lines.push('## ' + getText(node)); lines.push(''); return;
    case 'h3': lines.push(''); lines.push('### ' + getText(node)); lines.push(''); return;
    case 'h4': lines.push(''); lines.push('#### ' + getText(node)); lines.push(''); return;
    case 'h5': lines.push(''); lines.push('##### ' + getText(node)); lines.push(''); return;
    case 'h6': lines.push(''); lines.push('###### ' + getText(node)); lines.push(''); return;

    case 'p':
    case 'section': {
      const content = walkChildren(node, lines, depth);
      // walkChildren 已追加内容
      lines.push(''); // 段落后空行
      return;
    }

    case 'br':
      lines.push('');
      return;

    case 'blockquote': {
      lines.push('');
      const subLines = [];
      node.childNodes.forEach(child => walkNode(child, subLines, depth + 1));
      subLines.forEach(l => lines.push('> ' + l));
      lines.push('');
      return;
    }

    case 'strong':
    case 'b':
      lines.push('**' + getText(node) + '**');
      return;

    case 'em':
    case 'i':
      lines.push('*' + getText(node) + '*');
      return;

    case 'del':
    case 's':
      lines.push('~~' + getText(node) + '~~');
      return;

    case 'a': {
      const href = node.getAttribute('href') || '';
      const text = getText(node);
      if (href && href !== '#' && !href.startsWith('javascript')) {
        lines.push(`[${text}](${href})`);
      } else {
        lines.push(text);
      }
      return;
    }

    case 'img': {
      const src = node.getAttribute('data-src') || node.getAttribute('src') || '';
      const alt = node.getAttribute('alt') || '';
      if (src) lines.push(`![${alt}](${src})`);
      lines.push('');
      return;
    }

    case 'ul': {
      lines.push('');
      node.childNodes.forEach(child => {
        if (child.nodeType === Node.ELEMENT_NODE && child.tagName.toLowerCase() === 'li') {
          lines.push('- ' + getText(child).replace(/\n/g, ' '));
        } else {
          walkNode(child, lines, depth + 1);
        }
      });
      lines.push('');
      return;
    }

    case 'ol': {
      lines.push('');
      let idx = 1;
      node.childNodes.forEach(child => {
        if (child.nodeType === Node.ELEMENT_NODE && child.tagName.toLowerCase() === 'li') {
          lines.push(`${idx++}. ${getText(child).replace(/\n/g, ' ')}`);
        } else {
          walkNode(child, lines, depth + 1);
        }
      });
      lines.push('');
      return;
    }

    case 'pre':
    case 'code': {
      const text = node.textContent;
      if (tag === 'pre' || (node.parentElement && node.parentElement.tagName.toLowerCase() === 'pre')) {
        lines.push('```\n' + text + '\n```');
      } else {
        lines.push('`' + text + '`');
      }
      lines.push('');
      return;
    }

    case 'table': {
      const rows = [];
      node.querySelectorAll('tr').forEach(tr => {
        const cells = [];
        tr.querySelectorAll('th, td').forEach(cell => cells.push(getText(cell).replace(/\n/g, ' ')));
        rows.push(cells);
      });
      if (rows.length > 0) {
        lines.push('');
        lines.push('| ' + rows[0].join(' | ') + ' |');
        lines.push('| ' + rows[0].map(() => '---').join(' | ') + ' |');
        for (let i = 1; i < rows.length; i++) {
          lines.push('| ' + rows[i].join(' | ') + ' |');
        }
        lines.push('');
      }
      return;
    }

    default:
      walkChildren(node, lines, depth);
      return;
  }
}

function walkChildren(node, lines, depth) {
  node.childNodes.forEach(child => walkNode(child, lines, depth + 1));
}

function getText(node) {
  return node.textContent.replace(/\s+/g, ' ').trim();
}

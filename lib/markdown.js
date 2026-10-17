// Tiny Markdown converter (no dependencies).
// Supports: ## / ### headings, paragraphs, - and 1. lists, **bold**, *italic*, [links](url), > blockquotes.

export function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function inline(text = '') {
  let s = escapeHtml(text);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const external = /^https?:\/\//.test(url);
    return `<a href="${url}"${external ? ' rel="noopener" target="_blank"' : ''}>${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return s;
}

export function slugify(s = '') {
  return String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function markdown(src = '') {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // { type: 'ul'|'ol', items: [] }
  let quote = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote><p>${inline(quote.join(' '))}</p></blockquote>`);
    quote = [];
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushAll(); continue; }
    if ((m = line.match(/^(#{2,4})\s+(.*)$/))) {
      flushAll();
      const level = m[1].length;
      out.push(`<h${level} id="${slugify(m[2])}">${inline(m[2])}</h${level}>`);
      continue;
    }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      flushPara(); flushQuote();
      if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; }
      list.items.push(m[1]);
      continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara(); flushQuote();
      if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; }
      list.items.push(m[1]);
      continue;
    }
    if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara(); flushList();
      quote.push(m[1]);
      continue;
    }
    flushList(); flushQuote();
    para.push(line.trim());
  }
  flushAll();
  return out.join('\n');
}

// Front matter is a JSON object between the first two lines that are exactly '---'.
export function parseFrontMatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error('Missing front matter');
  return { data: JSON.parse(m[1]), body: m[2] };
}

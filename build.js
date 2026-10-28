// Static site builder for the affiliate blog. No dependencies — runs on Node 18+.
// Usage: node build.js   → outputs the finished site to ./dist
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { markdown, parseFrontMatter, escapeHtml as esc, inline, slugify } from './lib/markdown.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8'));
const products = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/products.json'), 'utf8'));
const productById = Object.fromEntries(products.map((p) => [p.id, p]));
const printablesFile = path.join(ROOT, 'data/printables.json');
const printables = fs.existsSync(printablesFile) ? JSON.parse(fs.readFileSync(printablesFile, 'utf8')) : [];
// Brand coupon boxes (data/promos.json). Codes and spend thresholds come from the brand; a promo stops rendering on builds after its "expires" date.
const promosFile = path.join(ROOT, 'data/promos.json');
const promos = fs.existsSync(promosFile) ? JSON.parse(fs.readFileSync(promosFile, 'utf8')) : {};
const TODAY = new Date().toISOString().slice(0, 10);
function promoBox(id) {
  const pr = promos[id];
  if (!pr || (pr.expires && TODAY > pr.expires)) return '';
  const rows = pr.codes.map((c) => `<li><code>${esc(c.code)}</code><span>${c.url ? `<a href="${esc(c.url)}" rel="sponsored nofollow noopener" target="_blank">${esc(c.offer)}</a>` : esc(c.offer)}</span></li>`).join('');
  return `<aside class="promo-box" aria-label="${esc(pr.title)}"><p class="eyebrow">Brand codes</p><h2>${esc(pr.title)}</h2><ul>${rows}</ul><p class="promo-terms">${esc(pr.terms)} ${esc(pr.endText || '')}</p><p class="promo-cta"><a class="btn btn-small" href="${esc(pr.url)}" rel="sponsored nofollow noopener" target="_blank">${esc(pr.cta)}</a></p><p class="promo-note">Codes from ${esc(pr.merchant)}; we earn a commission if you buy through these links.</p></aside>`;
}
const pillarBySlug = Object.fromEntries(config.pillars.map((p) => [p.slug, p]));
const SITE = config.siteUrl.replace(/\/$/, '');
const YEAR = new Date().getFullYear();
const errors = [];
const warnings = [];

// ---------- helpers ----------
function write(rel, content) {
  const file = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyDir(s, d); }
    else fs.copyFileSync(s, d);
  }
}
function fmtDate(iso) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}
function affiliateUrl(p) {
  let url = p.url;
  if (config.amazonTag && /amazon\./.test(url) && !/[?&]tag=/.test(url)) {
    url += (url.includes('?') ? '&' : '?') + 'tag=' + encodeURIComponent(config.amazonTag);
  }
  return url;
}
function buyButton(p, cls = 'btn') {
  const label = p.merchant === 'Amazon' ? 'Check current price on Amazon' : `See it at ${esc(p.merchant)}`;
  return `<a class="${cls}" href="${esc(affiliateUrl(p))}" rel="sponsored nofollow noopener" target="_blank">${label}</a>`;
}

// Fake-experience / pricing / medical phrases that must never appear in a post (see HANDOFF rules).
const BANNED = [
  /\bI (?:have )?tested\b/i, /\bwe (?:have )?tested\b/i, /\bmy (?:dog|cat|pup|puppy|kitten)\b/i,
  /\bour (?:dog|cat)\b/i, /\$\s?\d/, /\bcures?\b/i, /\btreats? (?:anxiety|allergies|arthritis)\b/i,
  /\bvet[- ]approved\b/i, /\bhands[- ]on\b/i,
];

const popularHtml = (config.popular || []).length ? `<nav class="popular" aria-label="Popular gift searches"><strong>Popular gift searches:</strong> ${config.popular.map((x) => `<a href="${x.url}">${esc(x.label)}</a>`).join(' · ')}</nav>` : '';

// Holiday gift checklist sign-up (Oct 25, 2026). Sign-ups go to the Fur & Nest form handler (Cloudflare Pages + KV), form-name picks-<siteKey>-checklist.
const FORM_ACTION = 'https://furandnest.pages.dev/api/form';
const checklistForm = (cta) => `<form class="cl-form" action="${FORM_ACTION}" method="post"><input type="hidden" name="form-name" value="picks-${config.siteKey}-checklist"><input type="text" name="company" tabindex="-1" autocomplete="off" class="cl-hp" aria-hidden="true"><label class="cl-sr" for="cl-email">Email address</label><input id="cl-email" type="email" name="email" required placeholder="Your email address"><button type="submit">${cta}</button></form><p class="cl-small">Free PDF. Occasional gift-guide emails, no spam. Unsubscribe any time. See our <a href="/privacy/">privacy policy</a>.</p>`;
const checklistBox = `<section class="cl-box"><p class="eyebrow">Free download</p><h2>The 2026 Holiday Gift Checklist</h2><p>A printable list to plan every person, budget and order date, plus our best gift ideas. Enter your email and it's yours.</p>${checklistForm('Send me the checklist')}</section>`;
// ---------- load posts ----------
const postDir = path.join(ROOT, 'content/posts');
const posts = fs.readdirSync(postDir).filter((f) => f.endsWith('.md')).map((file) => {
  const { data, body } = parseFrontMatter(fs.readFileSync(path.join(postDir, file), 'utf8'));
  const slug = data.slug || file.replace(/\.md$/, '');
  if (data.draft) return null;
  if (!pillarBySlug[data.pillar]) errors.push(`${file}: unknown pillar "${data.pillar}"`);
  for (const item of data.items || []) {
    if (!productById[item.product]) warnings.push(`${file}: product "${item.product}" is not in data/products.json (item skipped)`);
  }
  if (data.promo && !promos[data.promo]) warnings.push(`${file}: promo "${data.promo}" is not in data/promos.json (skipped)`);
  for (const id of data.quickPicks || []) {
    if (!productById[id]) warnings.push(`${file}: quick pick "${id}" is not in data/products.json (skipped)`);
  }
  const allText = body + JSON.stringify(data);
  for (const re of BANNED) if (re.test(allText)) errors.push(`${file}: contains banned phrase matching ${re}`);
  const [intro, after = ''] = body.split(/^<!--\s*list\s*-->\s*$/m);
  return { ...data, slug, intro, after, file };
}).filter(Boolean).sort((a, b) => (a.date < b.date ? 1 : -1));

// Products not re-verified in 90 days
const now = Date.now();
for (const p of products) {
  const last = p.lastVerified ? Date.parse(p.lastVerified) : null;
  if (!last || now - last > 90 * 864e5) warnings.push(`product "${p.id}" needs (re)verification`);
}


// Hero images: use a PNG from public/images/posts if one exists (made by scripts/make-images.mjs),
// otherwise draw a lightweight SVG hero at build time so every post always has an image.
const THEMES = {
  storage: ['#efe4d6', '#b5562f', '#2a2622', '#e2cdb6'], decor: ['#e4ece5', '#5d7a66', '#22302a', '#c9d9cc'],
  'small-spaces': ['#f3e6df', '#9c4a3a', '#2d2220', '#e6cbbd'], cleaning: ['#e7eef2', '#3f6b80', '#1f2c33', '#cadbe4'],
  seasonal: ['#f5e7d3', '#a8452b', '#2e231c', '#ebd0ad'], diy: ['#ece8dc', '#6c6a3c', '#26251a', '#d9d3bb'],
};
function wrap(text, max) {
  const lines = []; let cur = '';
  for (const w of text.split(/\s+/)) {
    if ((cur + ' ' + w).trim().length > max && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}
const paw = (x, y, s, c, r = 0) => `<g transform="translate(${x} ${y}) rotate(${r}) scale(${s})" fill="none" stroke="${c}" stroke-width="2"><path d="M-20 -8 L-10 -20 H10 L20 -8 L0 20 Z M-20 -8 H20 M-10 -20 L-4 -8 L0 20 L4 -8 L10 -20"/></g>`;
function heroSvg(post) {
  const [bg, accent, ink, soft] = (config.theme || THEMES[post.pillar] || THEMES.storage);
  const lines = wrap(post.title, 22).slice(0, 5);
  const size = lines.length > 4 ? 46 : 54;
  const startY = 315 - ((lines.length - 1) * size * 1.12) / 2 + 10;
  const label = (pillarBySlug[post.pillar]?.name || '').toUpperCase();
  const font = `'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
<rect width="1200" height="630" fill="${bg}"/>
<path d="M730 630V270a200 200 0 0 1 400 0v360z" fill="${soft}"/>
<path d="M790 630V290a140 140 0 0 1 280 0v340z" fill="${accent}"/>
${paw(930, 420, 3.2, bg, -12)}${paw(1120, 590, 1.3, accent, 18)}${paw(680, 585, 0.9, soft, -20)}
<text x="80" y="${startY - size - 6}" font-family="system-ui,Segoe UI,Arial,sans-serif" font-size="20" font-weight="700" letter-spacing="3" fill="${accent}">${esc(label)}</text>
${lines.map((l, i) => `<text x="80" y="${startY + i * size * 1.12}" font-family="${font}" font-size="${size}" font-weight="700" fill="${ink}">${esc(l)}</text>`).join('')}
<text x="80" y="${startY + (lines.length - 1) * size * 1.12 + 56}" font-family="system-ui,Segoe UI,Arial,sans-serif" font-size="20" fill="${ink}" opacity=".7">${esc(config.siteName)}</text>
</svg>`;
}
function heroUrl(post) {
  return fs.existsSync(path.join(ROOT, 'public/images/posts', `${post.slug}-hero.png`))
    ? `/images/posts/${post.slug}-hero.png` : `/images/posts/${post.slug}-hero.svg`;
}

// ---------- layout ----------
function layout({ title, description, urlPath, body, ogImage, type = 'website', extraHead = '', published }) {
  const fullTitle = (title === config.siteName || title === config.homeTitle) ? title : `${title} | ${config.siteName}`;
  const canonical = SITE + urlPath;
  const img = ogImage ? SITE + ogImage : SITE + (fs.existsSync(path.join(ROOT, 'public/images/og-default.png')) ? '/images/og-default.png' : '/favicon.svg');
  const nav = config.pillars.map((p) => `<a href="/category/${p.slug}/">${esc(p.short)}</a>`).join('') + (printables.length ? '<a class="nav-shop" href="/printables/">Printables</a>' : '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${extraHead.includes('name="robots"') ? '' : '<meta name="robots" content="max-image-preview:large">\n'}<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${config.headExtra||""}
<link rel="alternate" type="application/rss+xml" title="${esc(config.siteName)}" href="/rss.xml">
<link rel="stylesheet" href="/styles.css">
<meta property="og:site_name" content="${esc(config.siteName)}">
<meta property="og:type" content="${type}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${img}">
<meta name="twitter:card" content="summary_large_image">
${published ? `<meta property="article:published_time" content="${published}">` : ''}
${config.pinterestDomainVerify ? `<meta name="p:domain_verify" content="${esc(config.pinterestDomainVerify)}">` : ''}
<meta name="fo-verify" content="414343d2-b027-436d-b647-22b4aefeb45e" />
${extraHead}
${config.analyticsSnippet || ''}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="logo" href="/"><span class="logo-mark" aria-hidden="true"></span>${esc(config.siteName)}</a>
    <nav class="nav" aria-label="Categories">${nav}</nav>
  </div>
</header>
<main id="main">
${body}
</main>

<footer class="site-footer">
  <div class="wrap">
    <p class="footer-disclosure">${esc(config.siteName)} is reader-supported. Some links on this site are affiliate links, which means we may earn a small commission if you buy through them, at no extra cost to you. As an Amazon Associate we earn from qualifying purchases. <a href="/affiliate-disclosure/">Read our full disclosure</a>.</p>
    <nav class="footer-links" aria-label="Site">
      <a href="/about/">About</a><a href="/affiliate-disclosure/">Affiliate Disclosure</a><a href="/privacy/">Privacy Policy</a><a href="/contact/">Contact</a><a href="/rss.xml">RSS</a>
    </nav>
    ${popularHtml}
    ${config.sister?`<p class="sister">Shopping for someone else? <a href="${config.sister.url}">${esc(config.sister.name)} →</a></p>`:''}<p class="copyright">© ${YEAR} ${esc(config.siteName)}</p>
  </div>
</footer>
<script>var SITEKEY=${JSON.stringify(config.siteKey||'')};(function(){try{var d=new Date().toISOString().slice(0,10),u=0,s=0;try{if(localStorage['v_'+SITEKEY]!==d){localStorage['v_'+SITEKEY]=d;u=1}}catch(e){}try{if(!sessionStorage['s_'+SITEKEY]){sessionStorage['s_'+SITEKEY]=1;s=1}}catch(e){}var r='';try{r=document.referrer?new URL(document.referrer).hostname:''}catch(e){}if(r===location.hostname)r='';var b=function(q){try{navigator.sendBeacon?navigator.sendBeacon(q):fetch(q,{method:'POST',keepalive:true})}catch(e){}};b('https://thefurandnest.com/api/t?e=pv&p='+encodeURIComponent(SITEKEY+location.pathname)+'&r='+encodeURIComponent(r)+'&u='+u+'&s='+s);document.addEventListener('click',function(ev){var a=ev.target.closest&&ev.target.closest('a[href]');if(!a||!/amazon\.|amzn\.to|etsy\.com|chewy\.com/.test(a.href))return;b('https://thefurandnest.com/api/t?e=click&p='+encodeURIComponent(SITEKEY+location.pathname)+'&to='+encodeURIComponent(a.href.split('?')[0]))},true)}catch(e){}})();</script>
</body>
</html>`;
}

function card(post) {
  const pillar = pillarBySlug[post.pillar];
  return `<article class="card">
  <a class="card-link" href="/${post.slug}/">
    <img src="${heroUrl(post)}" alt="" width="1200" height="630" loading="lazy">
    <div class="card-body">
      <span class="eyebrow">${esc(pillar?.name || '')}</span>
      <h3>${esc(post.title)}</h3>
      <p>${esc(post.description)}</p>
    </div>
  </a>
</article>`;
}


function printableCard(pr) {
  return `<article class="card"><a class="card-link" href="${esc(pr.url)}" rel="noopener" target="_blank">
    <img src="${pr.image}" alt="${esc(pr.name)} printable preview" width="900" height="675" loading="lazy">
    <div class="card-body"><span class="eyebrow">Printable · Etsy</span><h3>${esc(pr.name)}</h3><p>${esc(pr.blurb)}</p><span class="shop-link">See it on Etsy →</span></div></a></article>`;
}

const disclosureTop = `<p class="disclosure-note"><strong>Heads up:</strong> this post contains affiliate links. If you buy through them we may earn a commission, at no extra cost to you. <a href="/affiliate-disclosure/">Learn more</a>.</p>`;

// ---------- pages ----------
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
copyDir(path.join(ROOT, 'public'), DIST);

// Post pages
for (const post of posts) {
  if (heroUrl(post).endsWith('.svg')) write(`images/posts/${post.slug}-hero.svg`, heroSvg(post));
  const pillar = pillarBySlug[post.pillar];
  const quick = (post.quickPicks || []).map((id) => productById[id]).filter(Boolean);
  const items = (post.items || []).filter((it) => productById[it.product]);
  const related = [
    ...posts.filter((p) => p.slug !== post.slug && p.pillar === post.pillar),
    ...posts.filter((p) => p.slug !== post.slug && p.pillar !== post.pillar),
  ].slice(0, 3);

  const quickBox = quick.length ? `<aside class="quick-picks" aria-label="Quick picks">
  <h2>Quick picks</h2>
  <ol>${quick.map((p) => `<li><div><strong>${esc(p.name)}</strong><span>${esc(p.description)}</span></div>${buyButton(p, 'btn btn-small')}</li>`).join('')}</ol>
</aside>` : '';

  const list = items.length ? `<section class="pick-list">
  <h2 id="${slugify(post.listHeading || 'the-picks')}">${esc(post.listHeading || 'The picks')}</h2>
  ${items.map((it, i) => {
    const p = productById[it.product];
    return `<div class="pick" id="pick-${i + 1}">
    <h3><span class="num">${i + 1}</span>${inline(it.title)}</h3>
    ${markdown(it.text)}
    <div class="pick-product"><div><span class="eyebrow">The pick</span><strong>${esc(p.name)}</strong></div>${buyButton(p)}</div>
  </div>`;
  }).join('\n')}
</section>` : '';

  const faq = (post.faq || []).length ? `<section class="faq">
  <h2 id="faq">Frequently asked questions</h2>
  ${post.faq.map((f) => `<details><summary>${esc(f.q)}</summary>${markdown(f.a)}</details>`).join('')}
</section>` : '';

  const relatedHtml = related.length ? `<section class="related"><h2>Keep reading</h2><div class="grid grid-3">${related.map(card).join('')}</div></section>` : '';

  const jsonLd = [{
    '@context': 'https://schema.org', '@type': 'Article', headline: post.title, description: post.description,
    datePublished: `${post.date}T12:00:00+00:00`, dateModified: `${post.updated || post.date}T12:00:00+00:00`, image: `${SITE}${heroUrl(post)}`,
    author: { '@type': 'Person', name: 'Amir Dabiri', url: `${SITE}/about/` }, publisher: { '@type': 'Organization', name: config.siteName },
    mainEntityOfPage: `${SITE}/${post.slug}/`,
  }];
  jsonLd.push({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [ { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` }, { '@type': 'ListItem', position: 2, name: pillar.name, item: `${SITE}/category/${pillar.slug}/` }, { '@type': 'ListItem', position: 3, name: post.title, item: `${SITE}/${post.slug}/` } ] });
  if (items.length) jsonLd.push({ '@context': 'https://schema.org', '@type': 'ItemList', name: post.listHeading || post.title, itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: productById[it.product].name, url: `${SITE}/${post.slug}/#pick-${i + 1}` })) });
  if ((post.faq || []).length) jsonLd.push({
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: post.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  });

  const body = `<article class="post wrap-narrow">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> / <a href="/category/${pillar.slug}/">${esc(pillar.name)}</a></nav>
  <h1>${esc(post.title)}</h1>
  <p class="post-meta">${post.updated ? `Updated ${fmtDate(post.updated)}` : fmtDate(post.date)} · ${esc(pillar.name)} · By <a href="/about/">Amir Dabiri</a></p>
  ${disclosureTop}
  <img class="hero" src="${heroUrl(post)}" alt="${esc(post.heroAlt || post.title)}" width="1200" height="630">
  <div class="prose">${markdown(post.intro)}</div>
  ${post.promo ? promoBox(post.promo) : ''}
  ${quickBox}
  ${list}
  <div class="prose">${markdown(post.after)}</div>
  ${faq}
  ${checklistBox}
  <p class="disclosure-note bottom">We don't accept payment for placement. Prices and availability change often, so check the retailer for current details. As an Amazon Associate we earn from qualifying purchases.</p>
</article>
<div class="wrap">${relatedHtml}</div>`;

  write(`${post.slug}/index.html`, layout({
    title: post.title, description: post.description, urlPath: `/${post.slug}/`, body, type: 'article',
    ogImage: heroUrl(post), published: post.date,
    extraHead: `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>`,
  }));
}

// Home
{
  const pillarsHtml = config.pillars.map((p) => {
    const n = posts.filter((x) => x.pillar === p.slug).length;
    return `<a class="pillar pillar-${p.slug}" href="/category/${p.slug}/"><strong>${esc(p.name)}</strong><span>${esc(p.blurb)}</span><em>${n ? n + (n === 1 ? ' guide' : ' guides') : 'New edit coming soon'}</em></a>`;
  }).join('');
  const body = `<section class="hero-band"><div class="wrap">
  <p class="eyebrow">${esc(config.homeEyebrow||"")}</p>
  <h1>${config.homeH1||esc(config.siteName)}</h1>
  <p class="lede">${esc(config.tagline)}. ${esc(config.homeLedeTail||'')}</p>
</div></section>
<div class="wrap">
  ${(config.popular || []).length ? `<section><h2 class="section-title">${esc(config.popularTitle || 'Most searched gift guides')}</h2><div class="popular-grid">${config.popular.map((x) => `<a class="popular-chip" href="${x.url}">${esc(x.label)}</a>`).join('')}</div></section>` : ''}
  ${checklistBox}
  <section><h2 class="section-title">Latest guides</h2><div class="grid grid-3">${posts.slice(0, 9).map(card).join('')}</div></section>
  ${printables.length ? `<section><h2 class="section-title">Our printables</h2><p class="lede" style="margin-bottom:18px">Planners, checklists and cards we designed for pet-loving homes. Instant download from our Etsy shop.</p><div class="grid grid-3">${printables.slice(0, 3).map(printableCard).join('')}</div><p style="margin-top:16px"><a href="/printables/">See all printables →</a></p></section>` : ''}
  <section><h2 class="section-title">Browse by topic</h2><div class="pillars">${pillarsHtml}</div></section>
</div>`;
  write('index.html', layout({ title: config.homeTitle || config.siteName, description: config.tagline, urlPath: '/', body }));
}

// Category pages
for (const p of config.pillars) {
  const list = posts.filter((x) => x.pillar === p.slug);
  const body = `<section class="hero-band small"><div class="wrap">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a></nav>
  <h1>${esc(p.name)}</h1><p class="lede">${esc(p.blurb)}</p>
</div></section>
<div class="wrap">${list.length ? `<div class="grid grid-3">${list.map(card).join('')}</div>` : `<p class="empty">New guides for this topic are on the way. In the meantime, <a href="/">see the latest posts</a>.</p>`}</div>`;
  write(`category/${p.slug}/index.html`, layout({ title: p.name, description: p.blurb, urlPath: `/category/${p.slug}/`, body }));
}

// Printables page (our own products on Etsy)
if (printables.length) {
  const body = `<section class="hero-band small"><div class="wrap">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a></nav>
  <h1>Fur &amp; Nest Printables</h1><p class="lede">Simple, good-looking printables for life with dogs and cats. Every file is an instant download in US Letter and A4, sold through our Etsy shop.</p>
</div></section>
<div class="wrap" style="padding-bottom:56px"><div class="grid grid-3">${printables.map(printableCard).join('')}</div>
<p class="note-small">These are our own products, sold on Etsy. Purchases are handled by Etsy.</p></div>`;
  write('printables/index.html', layout({ title: 'Printables', description: 'Pet care planners, checklists and cards for dog and cat owners. Instant download.', urlPath: '/printables/', body }));
}

// Static pages (content/pages/*.md, front matter: title, description, slug)
const pageDir = path.join(ROOT, 'content/pages');
const pages = fs.readdirSync(pageDir).filter((f) => f.endsWith('.md')).map((file) => {
  const raw = fs.readFileSync(path.join(pageDir, file), 'utf8')
    .replaceAll('{{siteName}}', config.siteName).replaceAll('{{contactEmail}}', config.contactEmail).replaceAll('{{year}}', String(YEAR));
  const { data, body: filled } = parseFrontMatter(raw);
  let html = markdown(filled);
  if (data.slug === 'contact') {

  }
  write(`${data.slug}/index.html`, layout({ title: data.title, description: data.description, urlPath: `/${data.slug}/`,
    body: `<article class="page wrap-narrow"><h1>${esc(data.title)}</h1><div class="prose">${html}</div></article>` }));
  return data;
});
write('holiday-gift-checklist/index.html', layout({ title: 'Free 2026 Holiday Gift Checklist (Printable PDF)', description: `A free printable 2026 holiday gift checklist from ${config.siteName}: plan every person, budget and order date, with our best gift ideas.`, urlPath: '/holiday-gift-checklist/',
  body: `<article class="page wrap-narrow"><p class="eyebrow">Free download</p><h1>Free 2026 Holiday Gift Checklist</h1><div class="prose"><p>Christmas shopping is easier with a plan. Our free printable checklist helps you:</p><ul><li>list everyone you're buying for, with a budget for each</li><li>note gift ideas, where to buy and when you ordered</li><li>tick off wrapped, shipped and given</li><li>see our most popular gift guides at a glance</li></ul><p>Enter your email below and we'll take you straight to the download.</p></div>${checklistForm('Get the free checklist')}</article>` }));
write('holiday-gift-checklist/thanks/index.html', layout({ title: 'Your Holiday Gift Checklist', description: 'Download your free 2026 holiday gift checklist.', urlPath: '/holiday-gift-checklist/thanks/',
  extraHead: '<meta name="robots" content="noindex">',
  body: `<article class="page wrap-narrow"><h1>You're in! Here's your checklist</h1><div class="prose"><p><a class="btn" href="/holiday-gift-checklist-2026.pdf" download>Download the 2026 Holiday Gift Checklist (PDF)</a></p><p>Need ideas to fill it in? Start with ${(config.popular || []).slice(0, 3).map((x) => `<a href="${x.url}">${esc(x.label.toLowerCase())}</a>`).join(', ')}.</p></div></article>` }));
write('newsletter/thanks/index.html', layout({ title: "You're in!", description: 'Subscribed', urlPath: '/newsletter/thanks/',
  body: `<article class="page wrap-narrow"><h1>You're in!</h1><p>Thank you.</p></article>` }));
write('contact/thanks/index.html', layout({ title: 'Thanks!', description: 'Message sent', urlPath: '/contact/thanks/',
  body: `<article class="page wrap-narrow"><h1>Thanks for reaching out</h1><p>We read every message and will reply as soon as we can. <a href="/">Back to home</a>.</p></article>` }));
write('404.html', layout({ title: 'Page not found', description: 'Page not found', urlPath: '/404.html',
  body: `<article class="page wrap-narrow"><h1>That page wandered off</h1><p>Try the <a href="/">home page</a> or browse a topic from the menu above.</p></article>` }));

// Sitemap, RSS, robots
const urls = ['/', ...(printables.length ? ['/printables/'] : []), ...config.pillars.map((p) => `/category/${p.slug}/`), ...posts.map((p) => `/${p.slug}/`), ...pages.map((p) => `/${p.slug}/`), '/holiday-gift-checklist/'];
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => { const po = posts.find((p) => `/${p.slug}/` === u); const lm = po ? (po.updated || po.date) : (u === '/' && posts[0] ? (posts[0].updated || posts[0].date) : ''); return `  <url><loc>${SITE}${u}</loc>${lm ? `<lastmod>${lm}</lastmod>` : ''}</url>`; }).join('\n')}
</urlset>`);
write('rss.xml', `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${esc(config.siteName)}</title><link>${SITE}/</link><description>${esc(config.tagline)}</description>
${posts.slice(0, 30).map((p) => `<item><title>${esc(p.title)}</title><link>${SITE}/${p.slug}/</link><guid>${SITE}/${p.slug}/</guid><pubDate>${new Date(p.date + 'T12:00:00Z').toUTCString()}</pubDate><description>${esc(p.description)}</description></item>`).join('\n')}
</channel></rss>`);
write('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);

// ---------- report ----------
console.log(`Built ${posts.length} posts, ${config.pillars.length} categories, ${pages.length} pages → dist/`);
if (warnings.length) console.log(`Note: ${warnings.length} product(s) need verification`);
if (errors.length) {
  console.error('\nBUILD ERRORS:\n- ' + errors.join('\n- '));
  process.exit(1);
}

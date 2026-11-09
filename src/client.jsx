// 小红书运营工作台 · DSH Desktop 客户端
// 由 Muse 里的同名工作台忠实移植：绑定账号、生成图文笔记、笔记库与发布、监测账号数据。
// 全部服务端调用走 api(action, args)，一律 POST JSON 到 /api/xiaohongshu-ops/<action>。
// 服务端动作名全小写（48 个 Muse 动作 + getstate 聚合端点），见文件末尾注释；
// 客户端 loadAll / reloadNotes 只调 getstate 一次取齐全部状态（服务端已归一化字段名）。
import React from 'react';

const h = React.createElement;
const { useState, useEffect, useRef, useCallback } = React;

const API_PREFIX = 'api/xiaohongshu-ops/';
const LOGIN_URL = 'https://www.xiaohongshu.com/login';
const RED = '#ff2442';

async function api(action, args) {
  const response = await fetch(
    new URL(API_PREFIX + action, document.baseURI).pathname,
    {
      // 服务端全部动作只注册了 POST，GET 会 404；无参调用也以空对象 POST。
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {}),
    },
  );
  let data;
  try {
    data = await response.json();
  } catch (e) {
    throw new Error('本地服务暂未就绪，请稍后重试。');
  }
  if (!response.ok) throw new Error(data.error || data.message || '本地请求失败');
  return data;
}

const num = (v) => (v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString('zh-CN'));
const metric = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('zh-CN'));
const fmtTime = (v) => {
  if (!v) return '—';
  try { return new Date(v).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return String(v); }
};
const fileNameOf = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
const accountHomeUrl = (a) => 'https://www.xiaohongshu.com/user/profile/' + (a && (a.xiaohongshuId || a.id));

const CSS = `
.xhs{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#262626;background:#f7f5f2;min-height:100vh;display:flex;font-size:14px;line-height:1.6}
.xhs *{box-sizing:border-box}
.xhs button{cursor:pointer}
.xhs button:disabled{cursor:not-allowed;opacity:.55}
.xhs-sidebar{width:248px;flex:0 0 248px;background:#fff;border-right:1px solid #ece7e2;display:flex;flex-direction:column;padding:16px 12px;gap:12px}
.xhs-brand{font-size:18px;font-weight:700;padding:2px 8px}
.xhs-brand b{color:${RED}}
.xhs-account-card{display:flex;gap:10px;align-items:center;background:#fff5f6;border:1px solid #ffe0e4;border-radius:12px;padding:10px}
.xhs-avatar{width:44px;height:44px;border-radius:50%;background:${RED};color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;flex:0 0 44px;overflow:hidden}
.xhs-avatar img{width:100%;height:100%;object-fit:cover}
.xhs-account-name{font-weight:700;font-size:14px}
.xhs-account-id{font-size:12px;color:#888}
.xhs-nav{display:flex;flex-direction:column;gap:4px}
.xhs-nav button{text-align:left;border:0;background:transparent;padding:10px 12px;border-radius:8px;font-size:14px;color:#333}
.xhs-nav button.active{background:#ffe9ec;color:${RED};font-weight:700}
.xhs-nav button:hover{background:#f7f5f2}
.xhs-refresh{margin-top:auto}
.xhs-refresh-btn{width:100%;border:0;border-radius:10px;background:${RED};color:#fff;font-size:15px;font-weight:700;padding:12px 10px}
.xhs-refresh-btn:disabled{background:#ff8a9a}
.xhs-refresh-result{font-size:12px;color:#666;margin-top:8px;white-space:pre-wrap}
.xhs-spin{display:inline-block;width:14px;height:14px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;animation:xhs-rot .8s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes xhs-rot{to{transform:rotate(360deg)}}
.xhs-main{flex:1;min-width:0;padding:20px 24px 40px;overflow:auto}
.xhs-page h2{margin:0 0 4px;font-size:20px}
.xhs-sub{color:#888;font-size:13px;margin:0 0 16px}
.xhs-card{background:#fff;border:1px solid #ece7e2;border-radius:14px;padding:16px 18px;margin-bottom:16px}
.xhs-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.xhs-stat{background:#fbf9f8;border-radius:10px;padding:12px}
.xhs-stat .v{font-size:22px;font-weight:800}
.xhs-stat .k{font-size:12px;color:#888}
.xhs-btn{border:1px solid #ddd;background:#fff;border-radius:8px;padding:8px 14px;font-size:14px}
.xhs-btn.primary{border-color:${RED};background:${RED};color:#fff;font-weight:700}
.xhs-btn.danger{border-color:#f3c1c7;color:${RED}}
.xhs-btn.ghost{border-color:transparent;background:transparent;color:${RED}}
.xhs-input,.xhs-textarea,.xhs-select{width:100%;border:1px solid #ddd;border-radius:8px;padding:9px 10px;font-size:14px;background:#fff}
.xhs-textarea{min-height:90px;resize:vertical}
.xhs-field{margin-bottom:14px}
.xhs-field label{display:block;font-weight:700;margin-bottom:6px}
.xhs-field label i{color:${RED};font-style:normal}
.xhs-hint{font-size:12px;color:#888;margin-top:6px}
.xhs-error{background:#fff0f1;border:1px solid #ffc9cf;color:#c81e3a;border-radius:10px;padding:10px 12px;margin-bottom:14px}
.xhs-ok{background:#eefaf0;border:1px solid #bfe8c8;color:#1d7a35;border-radius:10px;padding:10px 12px;margin-bottom:14px}
.xhs-note-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}
.xhs-note-card{background:#fff;border:1px solid #ece7e2;border-radius:14px;overflow:hidden}
.xhs-note-card.clickable{cursor:pointer}
.xhs-note-card.clickable:hover{box-shadow:0 4px 16px rgba(0,0,0,.08)}
.xhs-note-card.published{cursor:default}
.xhs-cover{width:100%;aspect-ratio:3/4;object-fit:cover;display:block;background:#eee}
.xhs-cover-ph{width:100%;aspect-ratio:3/4;background:#f0ecea;display:flex;align-items:center;justify-content:center;color:#aaa;font-size:13px}
.xhs-note-body{padding:12px}
.xhs-note-title{font-weight:700;font-size:14px;margin-bottom:6px}
.xhs-note-meta{font-size:12px;color:#888}
.xhs-metrics{display:flex;gap:12px;font-size:12px;color:#555;margin-top:8px;flex-wrap:wrap}
.xhs-metrics b{color:#262626}
.xhs-badge{display:inline-block;font-size:11px;border-radius:20px;padding:2px 8px;background:#f0ecea;color:#666;margin-left:6px}
.xhs-badge.published{background:#eefaf0;color:#1d7a35}
.xhs-badge.draft{background:#fff3e0;color:#a05a00}
.xhs-link{color:${RED};word-break:break-all;font-size:12px}
.xhs-link-row{font-size:12px;color:#888;margin-top:8px}
.xhs-progress{height:10px;background:#f0ecea;border-radius:20px;overflow:hidden}
.xhs-progress i{display:block;height:100%;background:${RED};border-radius:20px;transition:width .3s}
.xhs-stage{display:flex;gap:8px;align-items:center;padding:6px 0;font-size:13px;color:#888}
.xhs-stage.done{color:#262626}
.xhs-stage.now{color:${RED};font-weight:700}
.xhs-stage .dot{width:18px;height:18px;border-radius:50%;border:2px solid #ddd;display:inline-flex;align-items:center;justify-content:center;font-size:11px;flex:0 0 18px}
.xhs-stage.done .dot{border-color:${RED};background:${RED};color:#fff}
.xhs-stage.now .dot{border-color:${RED};color:${RED}}
.xhs-gen-wrap{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;align-items:start}
.xhs-phone{width:320px;margin:0 auto;background:#fff;border:1px solid #ddd;border-radius:28px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,.08)}
.xhs-phone-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #f0ecea}
.xhs-phone-head .xhs-avatar{width:32px;height:32px;font-size:13px;flex-basis:32px}
.xhs-phone-img{width:100%;aspect-ratio:3/4;object-fit:cover;display:block;background:#f2eeeb}
.xhs-phone-body{padding:12px 14px}
.xhs-phone-title{font-weight:700;font-size:15px;margin-bottom:6px}
.xhs-phone-tags{color:#3a6ea5;font-size:13px;margin-top:10px;word-break:break-all}
.xhs-editor{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:16px;align-items:start}
.xhs-img-row{display:flex;gap:8px;align-items:center;border:1px solid #eee;border-radius:8px;padding:6px;margin-bottom:8px}
.xhs-img-row img{width:56px;height:56px;object-fit:cover;border-radius:6px;background:#eee}
.xhs-img-row .grow{flex:1;min-width:0}
.xhs-img-row input{width:100%;border:1px solid #eee;border-radius:6px;padding:6px;font-size:12px}
.xhs-mini{font-size:12px;padding:4px 8px}
.xhs-table{width:100%;border-collapse:collapse;font-size:13px}
.xhs-table th,.xhs-table td{border-bottom:1px solid #f0ecea;padding:6px 8px;text-align:left}
.xhs-tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.xhs-tabs button{border:1px solid #ddd;background:#fff;border-radius:20px;padding:6px 14px;font-size:13px}
.xhs-tabs button.active{border-color:${RED};color:${RED};font-weight:700;background:#fff5f6}
.xhs-login-panels{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.xhs-login-box{background:#fbf9f8;border-radius:10px;padding:12px}
.xhs-login-box .k{font-size:12px;color:#888}
.xhs-login-box .v{font-size:15px;font-weight:700;margin-top:4px}
@media (max-width:900px){.xhs{flex-direction:column}.xhs-sidebar{width:100%;flex:none}.xhs-gen-wrap,.xhs-editor{grid-template-columns:1fr}.xhs-login-panels{grid-template-columns:1fr}}
`;

function Avatar({ account, size }) {
  const name = (account && (account.nickname || account.name)) || '我';
  const url = account && (account.avatarUrl || account.avatar);
  const style = size ? { width: size, height: size, flexBasis: size, fontSize: Math.round(size / 2.5) } : undefined;
  if (url) {
    return h('span', { className: 'xhs-avatar', style },
      h('img', { src: url, alt: name, referrerPolicy: 'no-referrer', onError: (e) => { e.currentTarget.style.display = 'none'; } }));
  }
  return h('span', { className: 'xhs-avatar', style }, name.slice(0, 1));
}

function AccountCard({ account }) {
  if (!account) {
    return h('div', { className: 'xhs-account-card' },
      h('span', { className: 'xhs-avatar' }, '?'),
      h('div', null,
        h('div', { className: 'xhs-account-name' }, '未绑定账号'),
        h('div', { className: 'xhs-account-id' }, '请在设置页扫码绑定')));
  }
  return h('div', { className: 'xhs-account-card' },
    h(Avatar, { account }),
    h('div', { style: { minWidth: 0 } },
      h('div', { className: 'xhs-account-name' }, account.nickname || account.name || '—'),
      h('div', { className: 'xhs-account-id' }, '小红书号：' + (account.xiaohongshuId || account.redId || '—'))));
}

function Stat({ k, v }) {
  return h('div', { className: 'xhs-stat' },
    h('div', { className: 'v' }, v),
    h('div', { className: 'k' }, k));
}

function NoteMetrics({ note }) {
  return h('div', { className: 'xhs-metrics' },
    h('span', null, '点赞 ', h('b', null, metric(note.likes))),
    h('span', null, '收藏 ', h('b', null, metric(note.collects))),
    h('span', null, '分享 ', h('b', null, metric(note.shares))),
    h('span', null, '评论 ', h('b', null, metric(note.comments))));
}

function NoteCard({ note, onOpenDraft, onRefreshLink }) {
  const published = note.status === 'published';
  const cover = note.coverUrl || (note.images && note.images[0] && (note.images[0].url || note.images[0]));
  const inner = [
    cover
      ? h('img', { className: 'xhs-cover', src: typeof cover === 'string' ? cover : cover.url, alt: '', referrerPolicy: 'no-referrer' })
      : h('div', { className: 'xhs-cover-ph' }, '暂无封面'),
    h('div', { className: 'xhs-note-body', key: 'body' },
      h('div', { className: 'xhs-note-title' }, note.title || '（无标题）',
        h('span', { className: 'xhs-badge ' + (published ? 'published' : 'draft') }, published ? '已发布' : '草稿')),
      h('div', { className: 'xhs-note-meta' },
        (note.publishedAt ? '发布于 ' + fmtTime(note.publishedAt) : note.fetchedAt ? '抓取于 ' + fmtTime(note.fetchedAt) : '') +
        (note.accountNickname ? ' · ' + note.accountNickname : '')),
      h(NoteMetrics, { note }),
      published && note.url ? h('div', { className: 'xhs-link-row' },
        h('a', { className: 'xhs-link', href: note.url, target: '_blank', rel: 'noreferrer', onClick: (e) => e.stopPropagation() }, '在小红书打开原笔记'),
        h('div', null, '原笔记链接里的令牌（xsec_token）会过期，过期后打不开会报 300017 / 300031，这不是笔记被删。'),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' } },
          h('a', { className: 'xhs-btn xhs-mini', href: note.accountId ? accountHomeUrl({ xiaohongshuId: note.accountXhsId || note.accountId }) : '#', target: '_blank', rel: 'noreferrer', onClick: (e) => e.stopPropagation() }, '去账号主页点这篇'),
          h('button', { type: 'button', className: 'xhs-btn xhs-mini', onClick: (e) => { e.stopPropagation(); onRefreshLink && onRefreshLink(note); } }, '重新获取新链接'))) : null,
      !published ? h('div', { className: 'xhs-note-meta', style: { marginTop: 8 } }, '点击进入编辑器') : null,
      published ? h('div', { className: 'xhs-note-meta', style: { marginTop: 8 } }, '已发布笔记仅展示，点击不会打开任何页面') : null),
  ];
  if (published) {
    // 已发布笔记：只做展示，点开不打开任何页面（用户明确要求）。
    return h('article', { className: 'xhs-note-card published', title: '已发布笔记仅展示，不在工作台内打开' }, inner);
  }
  return h('article', { className: 'xhs-note-card clickable', onClick: () => onOpenDraft && onOpenDraft(note), title: '点击进入编辑器' }, inner);
}

function OverviewPage({ state, onOpenDraft, onRefreshLink }) {
  const accounts = state.accounts || [];
  const main = accounts[0] || null;
  const notes = state.notes || [];
  const published = notes.filter((n) => n.status === 'published');
  const drafts = notes.filter((n) => n.status !== 'published');
  const totalLikes = notes.reduce((s, n) => s + (Number(n.likes) || 0), 0);
  const totalCollects = notes.reduce((s, n) => s + (Number(n.collects) || 0), 0);
  return h('div', { className: 'xhs-page' },
    h('h2', null, '总览'),
    h('p', { className: 'xhs-sub' }, '主账号、笔记概况与最新笔记一览'),
    h('div', { className: 'xhs-card' },
      h('h3', { style: { margin: '0 0 12px' } }, '主账号'),
      main ? h('div', null,
        h('div', { style: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 } },
          h(Avatar, { account: main, size: 56 }),
          h('div', null,
            h('div', { style: { fontSize: 17, fontWeight: 800 } }, main.nickname || main.name || '—'),
            h('div', { className: 'xhs-account-id' }, '小红书号：' + (main.xiaohongshuId || main.redId || '—')))),
        h('div', { className: 'xhs-grid' },
          h(Stat, { k: '关注', v: num(main.following) }),
          h(Stat, { k: '粉丝', v: num(main.followers) }),
          h(Stat, { k: '获赞与收藏', v: num(main.likesAndCollects != null ? main.likesAndCollects : main.likes) }),
          h(Stat, { k: '已抓取笔记', v: num(notes.length) })))
        : h('p', null, '尚未绑定主账号，请在设置页扫码绑定。')),
    h('div', { className: 'xhs-card' },
      h('h3', { style: { margin: '0 0 12px' } }, '笔记统计'),
      h('div', { className: 'xhs-grid' },
        h(Stat, { k: '已抓取笔记数', v: num(notes.length) }),
        h(Stat, { k: '草稿', v: num(drafts.length) }),
        h(Stat, { k: '已发布', v: num(published.length) }),
        h(Stat, { k: '笔记总点赞', v: num(totalLikes) }),
        h(Stat, { k: '笔记总收藏', v: num(totalCollects) }))),
    h('div', { className: 'xhs-card' },
      h('h3', { style: { margin: '0 0 12px' } }, '最新笔记'),
      notes.length === 0
        ? h('p', null, '还没有笔记。绑定账号后点「刷新全部数据」拉取，或在生成页写一篇新笔记。')
        : h('div', { className: 'xhs-note-grid' },
          notes.slice(0, 8).map((n) => h(NoteCard, { key: n.id || n.url || n.title, note: n, onOpenDraft, onRefreshLink })))),
  );
}

const GEN_STAGES = ['分析主题', '结合参考图构思', '撰写正文', '整理标签与配图说明', '保存草稿'];

// 把用户选的图片文件用 canvas 压缩到最大 1600px、转 JPEG base64。
function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const max = 1600;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const hh = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = hh;
        canvas.getContext('2d').drawImage(img, 0, 0, w, hh);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}

function GeneratePage({ state, onGenerated }) {
  const accounts = state.accounts || [];
  const [topic, setTopic] = useState('');
  const [keywords, setKeywords] = useState('');
  const [style, setStyle] = useState('种草测评');
  const [accountId, setAccountId] = useState(accounts[0] ? accounts[0].id : '');
  const [pathText, setPathText] = useState('');
  const [refImages, setRefImages] = useState([]); // {kind:'file'|'path', fileName, assetId?, dataUrl?, path?}
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState(0);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null); // {title, body, tags}
  const fileRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  const addPaths = () => {
    const lines = pathText.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return;
    setRefImages((prev) => prev.concat(lines.map((p) => ({ kind: 'path', fileName: fileNameOf(p), path: p }))));
    setPathText('');
  };

  const onPickFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    for (const file of files.slice(0, 9 - refImages.length)) {
      try {
        const dataUrl = await compressImageFile(file);
        const base64 = dataUrl.includes(',') ? dataUrl.split(',').slice(1).join(',') : dataUrl;
        const res = await api('importasset', {
          name: file.name,
          mimeType: file.type || 'image/jpeg',
          dataBase64: base64,
        });
        setRefImages((prev) => prev.concat([{ kind: 'file', fileName: file.name, assetId: (res.asset && res.asset.id) || null, dataUrl }]));
      } catch (err) {
        setError('图片「' + file.name + '」处理失败：' + (err && err.message ? err.message : String(err)));
      }
    }
  };

  const submit = async () => {
    if (!topic.trim()) { setError('请先填写主题。'); return; }
    if (busy) return;
    setError(''); setBusy(true); setProgress(0); setStage(0); setPreview(null);
    // 进度按耗时估算、渐近到 92%，等真实生成结果回来才到 100%。
    timerRef.current = setInterval(() => {
      setProgress((p) => {
        const next = p + (92 - p) * 0.03 + 0.15;
        return next >= 92 ? 92 : next;
      });
    }, 200);
    try {
      const res = await api('generatenote', {
        topic: topic.trim(),
        keywords: keywords.trim(),
        style,
        accountId: accountId ? Number(accountId) : (accounts[0] ? accounts[0].id : null),
        images: refImages.map((r) => ({ assetId: r.assetId != null ? r.assetId : null, path: r.path || r.fileName || '' })),
      });
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      setProgress(100); setStage(GEN_STAGES.length);
      const note = res.note || res;
      setPreview({ title: note.title, body: note.body, tags: note.tags });
      const id = note && (note.id || note.noteId);
      setTimeout(() => { setBusy(false); if (id && onGenerated) onGenerated(id); }, 600);
    } catch (err) {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      setBusy(false); setProgress(0); setStage(0);
      setError('生成失败：' + (err && err.message ? err.message : String(err)));
    }
  };

  useEffect(() => {
    setStage(progress < 18 ? 0 : progress < 38 ? 1 : progress < 62 ? 2 : progress < 85 ? 3 : 4);
  }, [progress]);

  const account = accounts.find((a) => String(a.id) === String(accountId)) || accounts[0];
  const firstFile = refImages.find((r) => r.dataUrl);
  return h('div', { className: 'xhs-page' },
    h('h2', null, '生成笔记'),
    h('p', { className: 'xhs-sub' }, '填主题、选参考图，生成一篇可编辑的图文笔记草稿'),
    error ? h('div', { className: 'xhs-error' }, error) : null,
    h('div', { className: 'xhs-gen-wrap' },
      h('div', null,
        h('div', { className: 'xhs-card' },
          h('div', { className: 'xhs-field' },
            h('label', null, '主题 ', h('i', null, '*')),
            h('input', { className: 'xhs-input', value: topic, disabled: busy, onChange: (e) => setTopic(e.target.value), placeholder: '例如：深圳秋假去哪玩' })),
          h('div', { className: 'xhs-field' },
            h('label', null, '关键词'),
            h('input', { className: 'xhs-input', value: keywords, disabled: busy, onChange: (e) => setKeywords(e.target.value), placeholder: '用逗号分隔，例如：秋日、探店、深圳' })),
          h('div', { className: 'xhs-field' },
            h('label', null, '风格'),
            h('select', { className: 'xhs-select', value: style, disabled: busy, onChange: (e) => setStyle(e.target.value) },
              ['种草测评', '探店分享', '干货教程', '日常记录', '好物推荐'].map((s) => h('option', { key: s, value: s }, s)))),
          h('div', { className: 'xhs-field' },
            h('label', null, '发布账号'),
            h('select', { className: 'xhs-select', value: accountId, disabled: busy, onChange: (e) => setAccountId(e.target.value) },
              accounts.length === 0
                ? h('option', { value: '' }, '尚未绑定账号')
                : accounts.map((a) => h('option', { key: a.id, value: a.id }, (a.nickname || a.name || '') + '（' + (a.xiaohongshuId || a.redId || a.id) + '）')))),
          h('div', { className: 'xhs-field' },
            h('label', null, '参考附图'),
            h('textarea', { className: 'xhs-textarea', value: pathText, disabled: busy, onChange: (e) => setPathText(e.target.value), placeholder: '图片文件路径，每行一个，例如：D:\\图片\\秋日街景.jpg' }),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
              h('button', { type: 'button', className: 'xhs-btn', disabled: busy, onClick: addPaths }, '添加路径'),
              h('button', { type: 'button', className: 'xhs-btn', disabled: busy, onClick: () => fileRef.current && fileRef.current.click() }, '从设备选择图片文件'),
              h('input', { ref: fileRef, type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' }, onChange: onPickFiles })),
            h('div', { className: 'xhs-hint' }, '手填路径只取文件名作参考，图片本身不被读取、也不挂到草稿上；从设备选择的图片会压缩到最大 1600px 转 JPEG 后真正附到草稿上。两种来源可混排，最多 9 张。'),
            refImages.length > 0 ? h('div', { style: { marginTop: 10 } }, refImages.map((r, i) =>
              h('div', { key: i, className: 'xhs-img-row' },
                r.dataUrl ? h('img', { src: r.dataUrl, alt: '' }) : h('span', { style: { width: 56, height: 56, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f0ecea', borderRadius: 6, fontSize: 11, color: '#888' } }, '路径'),
                h('span', { className: 'grow', style: { fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.fileName + (r.kind === 'path' ? '（仅文件名参考）' : '')),
                h('button', { type: 'button', className: 'xhs-btn xhs-mini', disabled: busy, onClick: () => setRefImages((prev) => prev.filter((_, j) => j !== i)) }, '移除')))) : null),
          h('button', { type: 'button', className: 'xhs-btn primary', disabled: busy || !topic.trim(), onClick: submit, style: { width: '100%', padding: 12, fontSize: 15 } },
            busy ? '生成中…' : '生成笔记')),
        busy || progress > 0 ? h('div', { className: 'xhs-card' },
          h('h3', { style: { margin: '0 0 8px' } }, '生成进度'),
          h('div', { className: 'xhs-progress' }, h('i', { style: { width: Math.round(progress) + '%' } })),
          h('div', { style: { fontSize: 13, color: '#888', margin: '6px 0 10px' } }, Math.round(progress) + '%'),
          GEN_STAGES.map((s, i) =>
            h('div', { key: s, className: 'xhs-stage ' + (i < stage ? 'done' : i === stage && busy ? 'now' : '') },
              h('span', { className: 'dot' }, i < stage ? '✓' : i + 1),
              h('span', null, s)))) : null),
      h('div', null,
        h('div', { className: 'xhs-card' },
          h('h3', { style: { margin: '0 0 12px' } }, '小红书样式手机预览'),
          h('div', { className: 'xhs-phone' },
            h('div', { className: 'xhs-phone-head' },
              h(Avatar, { account, size: 32 }),
              h('div', null,
                h('div', { style: { fontWeight: 700, fontSize: 13 } }, (account && (account.nickname || account.name)) || '未绑定账号'),
                h('div', { style: { fontSize: 11, color: '#999' } }, '刚刚 · 广东'))),
            firstFile
              ? h('img', { className: 'xhs-phone-img', src: firstFile.dataUrl, alt: '' })
              : h('div', { className: 'xhs-phone-img', style: { display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#aaa', fontSize: 13 } }, '暂无配图'),
            h('div', { className: 'xhs-phone-body' },
              h('div', { className: 'xhs-phone-title' }, (preview && preview.title) || topic.trim() || '标题将显示在这里'),
              h('div', { style: { fontSize: 13, whiteSpace: 'pre-wrap' } },
                (preview && preview.body) || '正文将显示在这里。生成完成后会自动打开编辑器，你可以继续改标题、正文、标签和配图。'),
              h('div', { className: 'xhs-phone-tags' },
                (preview && preview.tags ? preview.tags : []).map((t) => '#' + t).join(' ') || (keywords.trim() ? keywords.split(/[,，、\s]+/).filter(Boolean).map((t) => '#' + t).join(' ') : ''))))))));
}

function EditorPage({ note, onBack, onSaved }) {
  const [title, setTitle] = useState(note.title || '');
  const [body, setBody] = useState(note.body || '');
  const [tagsText, setTagsText] = useState((note.tags || []).join(' '));
  const [images, setImages] = useState((note.images || []).map((im, i) => ({
    assetId: typeof im === 'object' && im ? (im.assetId ?? null) : null,
    url: typeof im === 'string' ? im : (im.url || im.dataUrl || ''),
    note: (note.imageNotes && (note.imageNotes[i] || note.imageNotes[typeof im === 'string' ? im : im.url])) || (note.imageCaptions && note.imageCaptions[i]) || '',
  })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  const save = async (silent) => {
    setError(''); setOk('');
    try {
      const res = await api('updatenote', {
        id: note.id, accountId: note.accountId != null ? note.accountId : null, title, body,
        tags: tagsText.split(/[,，、\s]+/).map((t) => t.replace(/^#/, '')).filter(Boolean),
        imageIds: images.map((im) => im.assetId).filter((x) => x != null),
        imageCaptions: images.map((im) => im.note || ''),
      });
      if (!silent) setOk('已保存草稿。');
      if (onSaved) onSaved(res.note || res);
      return true;
    } catch (err) {
      setError('保存失败：' + (err && err.message ? err.message : String(err)));
      return false;
    }
  };

  const publish = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await save(true);
      await api('publishnote', { id: note.id });
      // 发布成功后直接回列表（不在编辑器停留）。
      onBack();
    } catch (err) {
      setError('发布失败：' + (err && err.message ? err.message : String(err)));
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!window.confirm('确定删除这篇草稿吗？')) return;
    try { await api('deletenote', { id: note.id }); onBack(); }
    catch (err) { setError('删除失败：' + (err && err.message ? err.message : String(err))); }
  };

  const moveImage = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= images.length) return;
    setImages((prev) => {
      const next = prev.slice();
      const t = next[i]; next[i] = next[j]; next[j] = t;
      return next;
    });
  };

  return h('div', { className: 'xhs-page' },
    h('button', { type: 'button', className: 'xhs-btn', onClick: onBack, style: { marginBottom: 12 } }, '← 返回笔记库'),
    h('h2', null, '编辑草稿'),
    h('p', { className: 'xhs-sub' }, (note.accountNickname ? note.accountNickname + ' · ' : '') + '草稿可编辑；已发布笔记不在工作台内打开'),
    error ? h('div', { className: 'xhs-error' }, error) : null,
    ok ? h('div', { className: 'xhs-ok' }, ok) : null,
    h('div', { className: 'xhs-editor' },
      h('div', { className: 'xhs-card' },
        h('div', { className: 'xhs-field' },
          h('label', null, '标题'),
          h('input', { className: 'xhs-input', value: title, onChange: (e) => setTitle(e.target.value), maxLength: 100 })),
        h('div', { className: 'xhs-field' },
          h('label', null, '正文'),
          h('textarea', { className: 'xhs-textarea', style: { minHeight: 260 }, value: body, onChange: (e) => setBody(e.target.value) })),
        h('div', { className: 'xhs-field' },
          h('label', null, '标签'),
          h('input', { className: 'xhs-input', value: tagsText, onChange: (e) => setTagsText(e.target.value), placeholder: '用空格或逗号分隔，不带 # 号' }),
          h('div', { className: 'xhs-hint' }, '显示时会自动加上 # 号。')),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('button', { type: 'button', className: 'xhs-btn', disabled: busy, onClick: () => save(false) }, '保存草稿'),
          h('button', { type: 'button', className: 'xhs-btn primary', disabled: busy, onClick: publish }, busy ? '发布中…' : '发布到小红书'),
          h('button', { type: 'button', className: 'xhs-btn danger', disabled: busy, onClick: remove }, '删除草稿'))),
      h('div', { className: 'xhs-card' },
        h('h3', { style: { margin: '0 0 12px' } }, '配图及配图说明（共 ' + images.length + ' 张）'),
        images.length === 0
          ? h('p', { className: 'xhs-hint' }, '这篇草稿还没有配图。发布至少需要 1 张图，请在生成页选图，或先保存后重新生成。')
          : images.map((im, i) =>
            h('div', { key: i, className: 'xhs-img-row' },
              im.url ? h('img', { src: im.url, alt: '' }) : h('span', { style: { width: 56, height: 56, background: '#f0ecea', borderRadius: 6 } }),
              h('div', { className: 'grow' },
                h('input', { value: im.note, placeholder: '第 ' + (i + 1) + ' 张图的配图说明', onChange: (e) => setImages((prev) => prev.map((x, j) => (j === i ? { ...x, note: e.target.value } : x))) })),
              h('button', { type: 'button', className: 'xhs-btn xhs-mini', disabled: i === 0, onClick: () => moveImage(i, -1), title: '上移' }, '↑'),
              h('button', { type: 'button', className: 'xhs-btn xhs-mini', disabled: i === images.length - 1, onClick: () => moveImage(i, 1), title: '下移' }, '↓'),
              h('button', { type: 'button', className: 'xhs-btn xhs-mini', onClick: () => setImages((prev) => prev.filter((_, j) => j !== i)) }, '删'))),
        h('div', { className: 'xhs-hint' }, '上下箭头调整图片顺序，顺序会随草稿一起保存。'))),
  );
}

function NotesPage({ state, editingNote, onOpenDraft, onCloseEditor, onSaved, onRefreshLink, onReload }) {
  const notes = state.notes || [];
  const fetching = state.fetchStatus === 'fetching' || state.fetching === true;
  const [filter, setFilter] = useState('all');

  // 列表自动刷新：获取中每 4 秒，平时每 15 秒。
  useEffect(() => {
    const ms = fetching ? 4000 : 15000;
    const t = setInterval(() => { if (onReload) onReload(true); }, ms);
    return () => clearInterval(t);
  }, [fetching, onReload]);

  if (editingNote) {
    return h(EditorPage, { note: editingNote, onBack: onCloseEditor, onSaved });
  }
  const shown = filter === 'all' ? notes : filter === 'draft' ? notes.filter((n) => n.status !== 'published') : notes.filter((n) => n.status === 'published');
  return h('div', { className: 'xhs-page' },
    h('h2', null, '笔记库'),
    h('p', { className: 'xhs-sub' },
      '共 ' + notes.length + ' 篇' + (fetching ? ' · 正在获取中，每 4 秒自动刷新' : ' · 每 15 秒自动刷新') +
      (state.fetchStatus ? ' · 获取状态：' + state.fetchStatus : '')),
    h('div', { className: 'xhs-tabs' },
      [['all', '全部'], ['draft', '草稿'], ['published', '已发布']].map(([k, label]) =>
        h('button', { key: k, type: 'button', className: filter === k ? 'active' : '', onClick: () => setFilter(k) }, label))),
    shown.length === 0
      ? h('div', { className: 'xhs-card' }, h('p', null, filter === 'all' ? '还没有笔记。' : filter === 'draft' ? '没有草稿。' : '没有已发布笔记。'))
      : h('div', { className: 'xhs-note-grid' },
        shown.map((n) => h(NoteCard, { key: n.id || n.url || n.title, note: n, onOpenDraft, onRefreshLink }))),
  );
}

function DataPage({ state, onReload }) {
  const monitored = state.monitoredAccounts || [];
  const bound = (state.accounts || [])[0] || null;
  const gate = state.loginGate || {};
  const loggedIn = bound && (gate.status === 'verified' || gate.verified === true || bound.loginStatus === 'verified');
  const [selectedId, setSelectedId] = useState(monitored[0] ? monitored[0].id : '');
  const [profileUrl, setProfileUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  useEffect(() => {
    if (!selectedId && monitored[0]) setSelectedId(monitored[0].id);
    if (selectedId && !monitored.find((m) => String(m.id) === String(selectedId)) && monitored[0]) setSelectedId(monitored[0].id);
  }, [monitored, selectedId]);

  const selected = monitored.find((m) => String(m.id) === String(selectedId)) || monitored[0] || null;

  const add = async () => {
    const url = profileUrl.trim();
    if (!url) { setError('请先粘贴小红书账号主页链接。'); return; }
    if (!/xiaohongshu\.com\/user\/profile\//.test(url)) { setError('链接格式不对，应为小红书账号主页链接，例如 https://www.xiaohongshu.com/user/profile/xxx'); return; }
    setBusy(true); setError(''); setOk('');
    try {
      const res = await api('addmonitoredaccount', { homepage: url });
      setOk(res.message || '已添加监测账号，正在拉取该账号的笔记数据…');
      setProfileUrl('');
      if (onReload) await onReload();
      const added = res.monitoredAccount;
      if (added && added.id) setSelectedId(added.id);
    } catch (err) { setError('添加失败：' + (err && err.message ? err.message : String(err))); }
    finally { setBusy(false); }
  };

  const refreshOne = async (m) => {
    setBusy(true); setError('');
    try {
      const res = await api('startfetchmonitoredaccount', { monitoredAccountId: m.id });
      if (res && res.started === false) throw new Error(res.message || '未能开始重新获取。');
      setOk(res.message || ('已开始重新获取「' + (m.nickname || m.xiaohongshuId || m.id) + '」的数据。'));
      if (onReload) await onReload();
    }
    catch (err) { setError('重新获取失败：' + (err && err.message ? err.message : String(err))); }
    finally { setBusy(false); }
  };

  const remove = async (m) => {
    if (!window.confirm('确定删除监测账号「' + (m.nickname || m.xiaohongshuId || m.id) + '」吗？它的笔记与快照会一并删除。')) return;
    try { await api('deletemonitoredaccount', { id: m.id }); if (onReload) await onReload(); }
    catch (err) { setError('删除失败：' + (err && err.message ? err.message : String(err))); }
  };

  return h('div', { className: 'xhs-page' },
    h('h2', null, '数据监测'),
    h('p', { className: 'xhs-sub' }, '监测账号与绑定账号是两个彻底分开的体系：这里只展示你填主页链接添加的其他账号，切换监测账号不会改动绑定账号'),
    error ? h('div', { className: 'xhs-error' }, error) : null,
    ok ? h('div', { className: 'xhs-ok' }, ok) : null,
    !loggedIn ? h('div', { className: 'xhs-card' },
      h('h3', { style: { margin: '0 0 8px' } }, '需要先登录绑定账号'),
      h('p', null, '监测账号的数据要借已登录的绑定账号拉取，但现在没有已登录的绑定账号。请先到设置页扫码登录绑定账号，再回来添加监测账号。'),
      h('p', { className: 'xhs-hint' }, '当前登录态：' + (gate.status || bound && bound.loginStatus || '未知')))
      : null,
    h('div', { className: 'xhs-card' },
      h('h3', { style: { margin: '0 0 8px' } }, '添加监测账号'),
      h('div', { style: { display: 'flex', gap: 8 } },
        h('input', { className: 'xhs-input', value: profileUrl, disabled: !loggedIn || busy, onChange: (e) => setProfileUrl(e.target.value), placeholder: '粘贴小红书账号主页链接，例如 https://www.xiaohongshu.com/user/profile/xxx' }),
        h('button', { type: 'button', className: 'xhs-btn primary', disabled: !loggedIn || busy, onClick: add }, busy ? '添加中…' : '添加')),
      h('div', { className: 'xhs-hint' }, '可添加多个监测账号；每个账号的笔记与快照分开存储、分别展示。')),
    monitored.length === 0
      ? h('div', { className: 'xhs-card' }, h('p', null, '还没有监测账号。粘贴一个小红书账号主页链接添加即可。'))
      : h('div', null,
        h('div', { className: 'xhs-tabs' }, monitored.map((m) =>
          h('button', { key: m.id, type: 'button', className: String(selectedId) === String(m.id) ? 'active' : '', onClick: () => setSelectedId(m.id) },
            (m.nickname || m.xiaohongshuId || m.id) + '（' + ((m.notes || []).length) + '篇）'))),
        selected ? h('div', { className: 'xhs-card' },
          h('div', { style: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' } },
            h(Avatar, { account: selected, size: 48 }),
            h('div', { style: { flex: 1, minWidth: 180 } },
              h('div', { style: { fontSize: 16, fontWeight: 800 } }, selected.nickname || '昵称尚未获取'),
              h('div', { className: 'xhs-account-id' }, '小红书号：' + (selected.xiaohongshuId || selected.redId || '—') + ' · 主页：' + (selected.profileUrl || ''))),
            h('button', { type: 'button', className: 'xhs-btn', disabled: busy, onClick: () => refreshOne(selected) }, '重新获取'),
            h('button', { type: 'button', className: 'xhs-btn danger', disabled: busy, onClick: () => remove(selected) }, '删除')),
          h('div', { className: 'xhs-grid', style: { marginTop: 12 } },
            h(Stat, { k: '关注', v: num(selected.following) }),
            h(Stat, { k: '粉丝', v: num(selected.followers) }),
            h(Stat, { k: '获赞与收藏', v: num(selected.likesAndCollects != null ? selected.likesAndCollects : selected.likes) }),
            h(Stat, { k: '已抓取笔记', v: num((selected.notes || []).length) })),
          h('h3', { style: { margin: '16px 0 12px' } }, '笔记与指标'),
          (selected.notes || []).length === 0
            ? h('p', null, '该账号还没有抓取到笔记，点「重新获取」试试。')
            : (selected.notes || []).map((n) =>
              h('div', { key: n.id || n.url || n.title, className: 'xhs-card', style: { marginBottom: 10 } },
                h('div', { style: { fontWeight: 700 } }, n.title || '（无标题）'),
                h('div', { className: 'xhs-note-meta' }, n.publishedAt ? '发布于 ' + fmtTime(n.publishedAt) : n.fetchedAt ? '抓取于 ' + fmtTime(n.fetchedAt) : ''),
                h(NoteMetrics, { note: n }),
                n.url ? h('div', { className: 'xhs-link-row' },
                  h('a', { className: 'xhs-link', href: n.url, target: '_blank', rel: 'noreferrer' }, '在小红书打开原笔记')) : null,
                (n.snapshots || []).length > 0 ? h('div', { style: { marginTop: 10 } },
                  h('div', { style: { fontWeight: 700, fontSize: 13, marginBottom: 6 } }, '历史快照'),
                  h('table', { className: 'xhs-table' },
                    h('thead', null, h('tr', null, h('th', null, '时间'), h('th', null, '点赞'), h('th', null, '收藏'), h('th', null, '分享'), h('th', null, '评论'))),
                    h('tbody', null, n.snapshots.slice(-8).map((s, i) =>
                      h('tr', { key: i },
                        h('td', null, fmtTime(s.at || s.fetchedAt)),
                        h('td', null, metric(s.likes)), h('td', null, metric(s.collects)),
                        h('td', null, metric(s.shares)), h('td', null, metric(s.comments)))))))
                  : h('div', { className: 'xhs-hint', style: { marginTop: 8 } }, '暂无历史快照，多次获取后会在这里形成趋势记录。'))))
          : null),
  );
}

function SettingsPage({ state, onReload }) {
  const accounts = state.accounts || [];
  const gate = state.loginGate || {};
  const handshake = state.handshake || {};
  const [showBind, setShowBind] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [folder, setFolder] = useState(state.dataFolder || state.dataFolderPath || '');
  const failed = gate.status === 'expired' || gate.status === 'failed' || gate.status === 'unknown';

  const readAccount = async () => {
    setBusy(true); setError(''); setOk('');
    try {
      let res;
      if (accounts.length > 0) {
        res = await api('startfetchloggedininfo', { accountId: accounts[0].id });
      } else {
        res = await api('startbindloggedinaccount', {});
      }
      if (res && res.started === false) {
        // 未开始：服务端已说明原因（门禁未通过 / 浏览器扩展未配对），不谎称已读取。
        setError(res.message || '未能开始读取登录账号信息。');
        if (res.loginUrl) window.open(res.loginUrl, '_blank');
      } else {
        setOk(res.message || '已开始读取登录账号信息。');
      }
      setShowBind(false);
      if (onReload) await onReload();
    } catch (err) { setError('读取账号信息失败：' + (err && err.message ? err.message : String(err)) + '。请确认已在浏览器里完成扫码登录，再点一次。'); }
    finally { setBusy(false); }
  };

  const retryLogin = async () => {
    setBusy(true); setError(''); setOk('');
    try {
      const res = await api('requestqrlogin', {});
      const url = res.url || res.loginUrl;
      if (url) window.open(url, '_blank');
      setOk(res.message || '已唤起浏览器扫码登录，请在浏览器里扫码，完成后点「已完成扫码，读取账号信息」。');
      if (onReload) await onReload();
    } catch (err) { setError('唤起登录失败：' + (err && err.message ? err.message : String(err))); }
    finally { setBusy(false); }
  };

  const saveFolder = async () => {
    setBusy(true); setError(''); setOk('');
    try {
      await api('updatesettings', { dataDirLabel: folder.trim() });
      setOk('数据文件夹路径已保存。只记录路径，不读取、不展示里面的图片。');
      if (onReload) await onReload();
    } catch (err) { setError('保存失败：' + (err && err.message ? err.message : String(err))); }
    finally { setBusy(false); }
  };

  return h('div', { className: 'xhs-page' },
    h('h2', null, '设置'),
    h('p', { className: 'xhs-sub' }, '绑定账号、登录态与数据文件夹'),
    error ? h('div', { className: 'xhs-error' }, error) : null,
    ok ? h('div', { className: 'xhs-ok' }, ok) : null,
    h('div', { className: 'xhs-card' },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' } },
        h('h3', { style: { margin: 0 } }, '小红书账号 ' + accounts.length + ' 个'),
        !showBind ? h('button', { type: 'button', className: 'xhs-btn primary', onClick: () => setShowBind(true) }, '+ 绑定新账号') : null),
      h('div', { style: { marginTop: 12, display: 'grid', gap: 10 } },
        accounts.length === 0
          ? h('p', { className: 'xhs-hint' }, '尚未绑定账号。')
          : accounts.map((a) => h(AccountCard, { key: a.id || a.xiaohongshuId, account: a }))),
      showBind ? h('div', { style: { marginTop: 14, borderTop: '1px solid #f0ecea', paddingTop: 14 } },
        h('h4', { style: { margin: '0 0 8px' } }, '绑定新账号（扫码登录）'),
        h('p', null, '点下面的链接打开小红书登录页，用手机小红书扫码登录；登录成功后回到这里点「已完成扫码，读取账号信息」。当前版本自动读取需要配对浏览器扩展（见 README），未配对时会明确提示原因；不用手动输入账号信息，也不碰你的密码。'),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('a', { className: 'xhs-btn primary', href: LOGIN_URL, target: '_blank', rel: 'noreferrer' }, '打开小红书登录页扫码'),
          h('button', { type: 'button', className: 'xhs-btn', disabled: busy, onClick: readAccount }, busy ? '读取中…' : '已完成扫码，读取账号信息'),
          h('button', { type: 'button', className: 'xhs-btn ghost', onClick: () => setShowBind(false) }, '取消'))) : null),
    h('div', { className: 'xhs-card' },
      h('h3', { style: { margin: '0 0 12px' } }, '登录态'),
      h('div', { className: 'xhs-login-panels' },
        h('div', { className: 'xhs-login-box' },
          h('div', { className: 'k' }, '工作台记录的登录态'),
          h('div', { className: 'v' }, gate.status === 'verified' ? '已登录' : gate.status === 'expired' ? '已过期' : gate.status === 'failed' ? '获取失败' : '未知'),
          h('div', { className: 'k', style: { marginTop: 6 } }, '账号：' + (((state.accounts || [])[0] && ((state.accounts[0].nickname || '') + ' / ' + ((state.accounts[0].xiaohongshuId || '')))) || '—')),
          h('div', { className: 'k' }, '校验时间：' + fmtTime(gate.verifiedAt || gate.at || (state.accounts[0] && state.accounts[0].loginVerifiedAt)))),
        h('div', { className: 'xhs-login-box' },
          h('div', { className: 'k' }, '最近一次握手'),
          h('div', { className: 'v' }, handshake.status === 'verified' || handshake.ok ? '成功' : handshake.status === 'failed' ? '失败' : '未知'),
          h('div', { className: 'k', style: { marginTop: 6 } }, '时间：' + fmtTime(handshake.at || handshake.time)),
          h('div', { className: 'k' }, handshake.message || handshake.detail || '')))),
    failed ? h('div', { className: 'xhs-card' },
      h('h3', { style: { margin: '0 0 8px' } }, '登录失败'),
      h('p', null, '登录态获取失败或已过期，笔记拉取与监测都会停住。点下面按钮重新唤起浏览器扫码登录并重试一次。'),
      h('button', { type: 'button', className: 'xhs-btn primary', disabled: busy, onClick: retryLogin }, busy ? '唤起中…' : '唤起浏览器扫码登录并重试')) : null,
    h('div', { className: 'xhs-card' },
      h('h3', { style: { margin: '0 0 12px' } }, '数据文件夹'),
      h('div', { className: 'xhs-field' },
        h('label', null, '数据文件夹路径'),
        h('input', { className: 'xhs-input', value: folder, onChange: (e) => setFolder(e.target.value), placeholder: '例如：D:\\小红书工作台数据' }),
        h('div', { className: 'xhs-hint' }, '只记录路径，不读取、不展示里面的图片。生成笔记时需要参考图，请在生成页从设备选择或填写图片路径。')),
      h('button', { type: 'button', className: 'xhs-btn primary', disabled: busy, onClick: saveFolder }, '保存')),
  );
}

const TABS = [
  ['overview', '总览'],
  ['generate', '生成'],
  ['notes', '笔记库'],
  ['data', '数据'],
  ['settings', '设置'],
];

function BusinessPanel() {
  const [tab, setTab] = useState('overview');
  const [state, setState] = useState({ accounts: [], notes: [], monitoredAccounts: [], loginGate: {}, handshake: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState('');

  const loadAll = useCallback(async (silent) => {
    if (!silent) setLoading(true);
    try {
      const data = await api('getstate');
      setState((prev) => ({
        accounts: data.accounts || prev.accounts || [],
        notes: data.notes || prev.notes || [],
        monitoredAccounts: data.monitoredAccounts || data.monitored || prev.monitoredAccounts || [],
        loginGate: data.loginGate || data.gate || prev.loginGate || {},
        handshake: data.handshake || prev.handshake || {},
        dataFolder: data.dataFolder || data.dataFolderPath || prev.dataFolder || '',
        fetchStatus: data.fetchStatus || prev.fetchStatus,
        infoFetchStatus: data.infoFetchStatus || prev.infoFetchStatus,
      }));
      setError('');
    } catch (err) {
      if (!silent) setError('加载失败：' + (err && err.message ? err.message : String(err)));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const reloadNotes = useCallback(async (silent) => {
    try {
      // 只调 getstate（聚合端点），保持只有一条归一化路径。
      const data = await api('getstate');
      const notes = data.notes || data || [];
      if (Array.isArray(notes)) setState((prev) => ({ ...prev, notes }));
    } catch (e) { /* 自动刷新失败时静默，下一次再试 */ }
  }, []);

  useEffect(() => { loadAll(false); }, [loadAll]);

  const refreshAll = async () => {
    const gate = state.loginGate || {};
    const hasAccount = (state.accounts || []).length > 0;
    const verified = gate.status === 'verified' || gate.verified === true;
    if (!hasAccount || !verified) {
      setRefreshResult('未登录：请先扫码登录绑定账号。');
      setTab('settings');
      return;
    }
    setRefreshing(true); setRefreshResult('');
    try {
      const res = await api('refreshalldata', {});
      await loadAll(true);
      const summary = res.message ||
        ('绑定账号资料与笔记、' + (state.monitoredAccounts || []).length + ' 个监测账号的数据已刷新。');
      setRefreshResult(summary + '\n完成时间：' + fmtTime(new Date().toISOString()));
    } catch (err) {
      setRefreshResult('刷新失败：' + (err && err.message ? err.message : String(err)) + '。请到设置页点「唤起浏览器扫码登录并重试」。');
    } finally { setRefreshing(false); }
  };

  const editingNote = editingNoteId ? (state.notes || []).find((n) => String(n.id) === String(editingNoteId)) : null;
  const openDraft = (note) => { setEditingNoteId(note.id); setTab('notes'); };
  const refreshLink = async (note) => {
    try {
      const accountId = note.accountId || (state.accounts[0] && state.accounts[0].id);
      if (accountId == null) throw new Error('没有可用的绑定账号。');
      const res = await api('startfetchaccountnotes', { accountId });
      if (res && res.started === false) throw new Error(res.message || '未能开始重新获取。');
      await reloadNotes(true);
    }
    catch (err) { setError('重新获取链接失败：' + (err && err.message ? err.message : String(err))); }
  };

  const main = (state.accounts || [])[0] || null;
  return h('div', { className: 'xhs' },
    h('style', null, CSS),
    h('aside', { className: 'xhs-sidebar' },
      h('div', { className: 'xhs-brand' }, h('b', null, '◈'), ' 小红书运营工作台'),
      h(AccountCard, { account: main }),
      h('nav', { className: 'xhs-nav' }, TABS.map(([k, label]) =>
        h('button', { key: k, type: 'button', className: tab === k ? 'active' : '', onClick: () => { setTab(k); if (k !== 'notes') setEditingNoteId(null); } }, label))),
      h('div', { className: 'xhs-refresh' },
        h('button', { type: 'button', className: 'xhs-refresh-btn', disabled: refreshing, onClick: refreshAll },
          refreshing ? h('span', null, h('span', { className: 'xhs-spin' }), '正在刷新…') : '刷新全部数据'),
        refreshResult ? h('div', { className: 'xhs-refresh-result' }, refreshResult) : null,
        !main ? h('div', { className: 'xhs-refresh-result' }, '尚未绑定账号，点「刷新全部数据」会先提示扫码登录。') : null)),
    h('main', { className: 'xhs-main' },
      loading ? h('p', null, '加载中…')
        : h('div', null,
          error ? h('div', { className: 'xhs-error' }, error) : null,
          tab === 'overview' ? h(OverviewPage, { state, onOpenDraft: openDraft, onRefreshLink: refreshLink })
          : tab === 'generate' ? h(GeneratePage, { state, onGenerated: (id) => { setEditingNoteId(id); setTab('notes'); loadAll(true); } })
          : tab === 'notes' ? h(NotesPage, { state, editingNote, onOpenDraft: openDraft, onCloseEditor: () => { setEditingNoteId(null); loadAll(true); }, onSaved: () => loadAll(true), onRefreshLink: refreshLink, onReload: reloadNotes })
          : tab === 'data' ? h(DataPage, { state, onReload: () => loadAll(true) })
          : h(SettingsPage, { state, onReload: () => loadAll(true) }))),
  );
}

function apply(ctx) {
  ctx.effect(() => ctx.desktopWorkbenches.register({
    title: '小红书运营工作台',
    description: '绑定小红书账号、生成图文笔记、管理笔记库与发布、监测账号数据',
    icon: '◈',
    customFrame: true,
  }, BusinessPanel));
}

const inject = ['desktopWorkbenches'];
export { apply, inject };

// 服务端动作（POST /api/xiaohongshu-ops/<action>，全小写）：
//   getstate -> {accounts, notes, monitoredAccounts, loginGate, handshake, dataFolder, fetchStatus, infoFetchStatus}
//     账号补 xiaohongshuId/profileUrl/following/followers/likesAndCollects；
//     笔记补 url/coverUrl/images/imageNotes/指标/accountNickname/accountXhsId；
//     监测账号附带 notes（含 snapshots）；loginGate 补 status（'verified'）/verified/verifiedAt；
//     handshake 补 status（'verified'/'failed'/'unknown'）/at/message/ok/browserState。
//   generatenote {topic, keywords, style, accountId, images:[{assetId, path}]} -> {ok, note}
//   updatenote {id, accountId, title, body, tags, imageIds, imageCaptions} / publishnote {id} / deletenote {id}
//   importasset {name, mimeType, dataBase64} -> {ok, asset}
//   addmonitoredaccount {homepage} -> {ok, exists, monitoredAccount, message}
//   startfetchmonitoredaccount {monitoredAccountId} / deletemonitoredaccount {id}
//   startfetchloggedininfo {accountId} / startbindloggedinaccount {} / requestqrlogin {} -> {ok, url, loginUrl, message}
//   updatesettings {dataDirLabel} / refreshalldata {} -> {ok, needsLogin, started, accountsCount, monitoredCount, message}
//   startfetchaccountnotes {accountId}
//   其余 48 个 Muse 动作（listaccounts / listnotes / getlogingate / getsettings 等）原样保留。
//   start* 只派发不拉取：无浏览器扩展配对时返回 {ok:true, started:false, message} 说明原因，客户端不得谎称已完成。
// 注意：package.json 里 dsh.client.inject 写 ["dsh-desktop-workbenches"]，
// 本文件 export 的 inject 是 ['desktopWorkbenches']，两者是不同层面的东西——
// beianbai 跨平台账号看板就是这么写的，不是名字不一致，无需改。

// 小红书运营工作台 · DSH Desktop 客户端 v0.2.0
// 由 Muse 里的同名工作台忠实移植：双层边栏（发布日历 / 笔记制作 / 竞对监控 /
// 热点资讯 / 留资管理 / 账号管理）、统一登录门禁、共用会话请求清单。
// 全部服务端调用走 api(action, args)，一律 POST JSON 到 /api/xiaohongshu-ops/<action>。
// 服务端动作名全小写（见清单 PORTING-PLAN-0.2.0.md §1），getstate 为聚合端点；
// 新动作（热点/留资/竞对通知/生图/共用会话/onboarding）用 apiSafe 容错调用——
// 服务端尚未注册时返回空态、绝不谎称数据。
// 样式：theme.css 三层令牌内联进本文件的 CSS 字符串（DSH 构建只打包本文件，
// 不另走 CSS 文件），组件只引用语义层 / 组件层令牌。
import React from 'react';

const h = React.createElement;
const { useState, useEffect, useRef, useCallback } = React;

const API_PREFIX = 'api/xiaohongshu-ops/';
const LOGIN_URL = 'https://www.xiaohongshu.com/login';
const XHS_HOME = 'https://www.xiaohongshu.com';

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

// 容错调用：新动作尚未注册（404）或暂不可用时返回 null，调用方用空态兜底。
async function apiSafe(action, args) {
  try { return await api(action, args); } catch (e) { return null; }
}

const num = (v) => (v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString('zh-CN'));
const metric = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('zh-CN'));
const fmtCount = (n) => {
  const v = Number(n);
  if (Number.isNaN(v)) return '—';
  if (v >= 10000) {
    const w = v / 10000;
    return (w >= 100 ? String(Math.round(w)) : String(Math.round(w * 10) / 10)) + '万';
  }
  return String(v);
};
const fmtTime = (v) => {
  if (!v) return '—';
  try {
    const d = new Date(v);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  } catch (e) { return String(v); }
};
const fmtDate = (v) => {
  if (!v) return '';
  try {
    const d = new Date(v);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  } catch (e) { return String(v); }
};
const fmtDateTime = fmtTime;
const fileNameOf = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
const accountHomeUrl = (a) => 'https://www.xiaohongshu.com/user/profile/' + (a && (a.xhsId || a.xiaohongshuId || a.id));
// 配图可能是字符串 URL，也可能是 {sourceUrl, blobKey} / {url} 对象。
const imgUrl = (x) => {
  if (!x) return '';
  if (typeof x === 'string') return x;
  return x.url || x.sourceUrl || x.contentUrl || '';
};
const imgUrls = (list) => (Array.isArray(list) ? list.map(imgUrl).filter(Boolean) : []);
const assetUrl = (a) => (a && (a.url || a.contentUrl)) || '';
// 旧行里可能残留的任务运行时原码 / 旧版扫码文案，展示前一律翻译成中性说法，绝不怪用户。
const humanizeFailureText = (text) => {
  if (!text) return text;
  return String(text)
    .replaceAll('expected_return_action_missing', '读取任务结束了，但没有把结果回写到工作台（不是登录掉线）')
    .replaceAll('等待扫码登录超时，用户未完成扫码登录', '等待扫码登录超时，本次没有完成扫码登录');
};
const localDateKey = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
// 把详情页读到的相对发布时间标签按读取日换算成绝对日期（与 Muse 侧同口径）；
// 换算不出来的返回 null——日期未知，绝不猜一天放进日历。
function parsePublishedLabel(label, fetchedAtIso) {
  const s = String(label || '').trim();
  if (!s) return null;
  const anchor = new Date(fetchedAtIso);
  if (Number.isNaN(anchor.getTime())) return null;
  const daysAgo = (n) => {
    const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    d.setDate(d.getDate() - n);
    return localDateKey(d);
  };
  let m = s.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (m) return m[1] + '-' + String(Number(m[2])).padStart(2, '0') + '-' + String(Number(m[3])).padStart(2, '0');
  m = s.match(/(\d+)\s*天前/);
  if (m) return daysAgo(Number(m[1]));
  if (s.includes('前天')) return daysAgo(2);
  if (s.includes('昨天')) return daysAgo(1);
  if (/刚刚|分钟前|小时前|今天/.test(s)) return daysAgo(0);
  m = s.match(/(\d{1,2})[-/月](\d{1,2})/);
  if (m) {
    const cand = new Date(anchor.getFullYear(), Number(m[1]) - 1, Number(m[2]));
    if (cand.getTime() > anchor.getTime()) cand.setFullYear(anchor.getFullYear() - 1);
    return localDateKey(cand);
  }
  return null;
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
}
function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
// 把用户选的图片文件用 canvas 压缩到最大 1600px、转 JPEG base64（与 Muse 侧同口径）。
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

const CSS = `
:root{
color-scheme:light dark;
--color-brand-50:#fff0f2;--color-brand-100:#ffdfe5;--color-brand-200:#ffc2cc;--color-brand-300:#ff96a8;--color-brand-400:#ff5c76;--color-brand-500:#ff2442;--color-brand-600:#e8102e;--color-brand-700:#c40d27;--color-brand-800:#9c0f22;--color-brand-900:#7a0c1e;
--color-gray-50:#faf9f7;--color-gray-100:#f3f1ee;--color-gray-150:#eceae6;--color-gray-200:#e3e0db;--color-gray-300:#cfccc6;--color-gray-400:#a8a49d;--color-gray-500:#86817a;--color-gray-600:#66625c;--color-gray-700:#4c4842;--color-gray-800:#35322e;--color-gray-850:#292623;--color-gray-900:#201d1a;--color-gray-950:#171412;
--color-green-100:#d9f5e3;--color-green-300:#6fce9c;--color-green-500:#22a35c;--color-green-600:#178a4c;--color-green-700:#12703e;
--color-amber-100:#fdeec9;--color-amber-300:#f5c65c;--color-amber-500:#d9930d;--color-amber-600:#b97a08;--color-amber-700:#966206;
--color-red-100:#fde3e1;--color-red-300:#f49a94;--color-red-500:#e5484d;--color-red-600:#d13438;--color-red-700:#b02a2e;
--color-sky-100:#ddeefc;--color-sky-300:#7cc0f5;--color-sky-500:#2f8fdd;--color-sky-600:#1f76bd;--color-sky-700:#1a619c;
--color-linkblue-100:#e4ebfa;--color-linkblue-300:#9db9e8;--color-linkblue-600:#3d5a99;--color-linkblue-700:#324a80;
--color-white:#ffffff;--color-black:#000000;
--font-family-sans:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Source Han Sans SC","Noto Sans SC","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
--font-family-mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
--font-size-xs:12px;--font-size-sm:14px;--font-size-base:16px;--font-size-lg:18px;--font-size-xl:20px;--font-size-2xl:24px;--font-size-3xl:30px;--font-size-4xl:36px;
--line-height-tight:1.3;--line-height-snug:1.45;--line-height-normal:1.6;--line-height-relaxed:1.75;
--font-weight-regular:400;--font-weight-medium:500;--font-weight-semibold:600;--font-weight-bold:700;
--letter-spacing-tight:-0.02em;--letter-spacing-normal:0;--letter-spacing-wide:0.04em;
--space-0:0;--space-1:0.25rem;--space-2:0.5rem;--space-3:0.75rem;--space-4:1rem;--space-5:1.25rem;--space-6:1.5rem;--space-8:2rem;--space-10:2.5rem;--space-12:3rem;--space-16:4rem;
--radius-none:0;--radius-sm:6px;--radius-md:10px;--radius-lg:14px;--radius-xl:16px;--radius-2xl:20px;--radius-3xl:24px;--radius-full:999px;
--shadow-xs:0 1px 2px rgb(32 29 26 / 0.05);--shadow-sm:0 1px 2px rgb(32 29 26 / 0.05),0 1px 6px rgb(32 29 26 / 0.04);--shadow-md:0 2px 4px rgb(32 29 26 / 0.05),0 6px 16px rgb(32 29 26 / 0.07);--shadow-lg:0 4px 8px rgb(32 29 26 / 0.05),0 12px 32px rgb(32 29 26 / 0.1);--shadow-xl:0 8px 16px rgb(32 29 26 / 0.06),0 24px 48px rgb(32 29 26 / 0.12);--shadow-nav:0 -6px 20px rgb(32 29 26 / 0.05);
--duration-instant:75ms;--duration-fast:150ms;--duration-normal:200ms;--duration-slow:300ms;
--ease-standard:cubic-bezier(0.2,0,0,1);--ease-out:cubic-bezier(0,0,0.2,1);--ease-in-out:ease-in-out;
--z-base:0;--z-sticky:30;--z-nav:40;--z-popup:60;--z-dialog:70;--z-toast:80;
--color-background:var(--color-gray-50);--color-surface:var(--color-white);--color-surface-alt:var(--color-gray-100);--color-surface-alt-hover:var(--color-gray-150);
--color-foreground:var(--color-gray-900);--color-foreground-secondary:var(--color-gray-700);--color-foreground-muted:var(--color-gray-500);--color-foreground-faint:var(--color-gray-400);
--color-on-primary:var(--color-white);--color-on-dark:var(--color-gray-50);
--color-primary:var(--color-brand-500);--color-primary-hover:var(--color-brand-600);--color-primary-active:var(--color-brand-700);--color-primary-soft:var(--color-brand-50);--color-primary-soft-hover:var(--color-brand-100);--color-primary-border:var(--color-brand-200);
--color-secondary:var(--color-gray-100);--color-secondary-hover:var(--color-gray-150);--color-secondary-foreground:var(--color-gray-900);
--color-muted:var(--color-gray-100);--color-muted-foreground:var(--color-gray-500);
--color-destructive:var(--color-red-600);--color-destructive-hover:var(--color-red-700);--color-destructive-soft:var(--color-red-100);
--color-danger:var(--color-red-600);--color-danger-soft:var(--color-red-100);
--color-success:var(--color-green-600);--color-success-hover:var(--color-green-700);--color-success-soft:var(--color-green-100);
--color-warning:var(--color-amber-700);--color-warning-soft:var(--color-amber-100);
--color-info:var(--color-sky-600);--color-info-soft:var(--color-sky-100);
--color-link:var(--color-linkblue-600);--color-link-hover:var(--color-linkblue-700);--color-link-soft:var(--color-linkblue-100);
--color-border:var(--color-gray-200);--color-border-strong:var(--color-gray-300);--color-input-border:var(--color-gray-300);
--color-ring:var(--color-brand-500);--color-ring-soft:rgb(255 36 66 / 0.16);
--color-overlay:rgb(23 20 18 / 0.5);--color-scrim:rgb(23 20 18 / 0.55);--color-scrim-soft:rgb(23 20 18 / 0.42);
--spacing-page-x:var(--space-4);--spacing-page-x-wide:var(--space-8);--spacing-page-top:var(--space-8);
--spacing-section:var(--space-10);--spacing-block:var(--space-6);--spacing-card:var(--space-5);--spacing-stack:var(--space-3);--spacing-inline:var(--space-2);
--font-display:var(--font-size-3xl);--font-heading:var(--font-size-xl);--font-subheading:var(--font-size-lg);--font-body:var(--font-size-base);--font-body-sm:var(--font-size-sm);--font-caption:var(--font-size-xs);--font-metric:var(--font-size-3xl);
--opacity-disabled:0.5;--ring-width:2px;--ring-offset:2px;
--button-primary-background:var(--color-primary);--button-primary-background-hover:var(--color-primary-hover);--button-primary-background-active:var(--color-primary-active);--button-primary-foreground:var(--color-on-primary);--button-primary-shadow:var(--shadow-xs);
--button-secondary-background:var(--color-surface);--button-secondary-background-hover:var(--color-secondary);--button-secondary-background-active:var(--color-surface-alt-hover);--button-secondary-foreground:var(--color-foreground);--button-secondary-border:var(--color-border-strong);
--button-ghost-foreground:var(--color-foreground-muted);--button-ghost-background-hover:var(--color-secondary);
--button-destructive-background:var(--color-destructive);--button-destructive-background-hover:var(--color-destructive-hover);--button-destructive-foreground:var(--color-white);
--button-padding-x:var(--space-4);--button-padding-y:var(--space-2);--button-padding-x-sm:var(--space-3);--button-padding-y-sm:var(--space-1);--button-padding-x-lg:var(--space-6);--button-padding-y-lg:var(--space-3);
--button-radius:var(--radius-full);--button-font-size:var(--font-size-sm);--button-font-weight:var(--font-weight-semibold);
--input-background:var(--color-surface);--input-background-disabled:var(--color-surface-alt);--input-foreground:var(--color-foreground);--input-placeholder:var(--color-foreground-faint);
--input-border:var(--color-input-border);--input-border-hover:var(--color-gray-400);--input-border-focus:var(--color-primary);--input-ring-focus:var(--color-ring-soft);--input-border-error:var(--color-destructive);
--input-padding-x:var(--space-4);--input-padding-y:var(--space-3);--input-radius:var(--radius-md);--input-font-size:var(--font-size-base);
--card-background:var(--color-surface);--card-foreground:var(--color-foreground);--card-border:var(--color-border);--card-padding:var(--spacing-card);--card-padding-lg:var(--space-6);--card-radius:var(--radius-2xl);--card-shadow:var(--shadow-sm);--card-shadow-hover:var(--shadow-md);
--badge-background:var(--color-primary);--badge-foreground:var(--color-on-primary);--badge-secondary-background:var(--color-secondary);--badge-secondary-foreground:var(--color-foreground-muted);
--badge-soft-background:var(--color-primary-soft);--badge-soft-foreground:var(--color-primary);
--badge-success-background:var(--color-success-soft);--badge-success-foreground:var(--color-success);
--badge-warning-background:var(--color-warning-soft);--badge-warning-foreground:var(--color-warning);
--badge-info-background:var(--color-info-soft);--badge-info-foreground:var(--color-info);
--badge-padding-x:var(--space-2);--badge-padding-y:var(--space-1);--badge-radius:var(--radius-full);--badge-font-size:var(--font-size-xs);
--dialog-overlay:var(--color-overlay);--dialog-background:var(--color-surface);--dialog-foreground:var(--color-foreground);--dialog-border:var(--color-border);--dialog-padding:var(--space-5);--dialog-radius:var(--radius-2xl);--dialog-shadow:var(--shadow-lg);
--table-header-background:var(--color-surface-alt);--table-header-foreground:var(--color-foreground-muted);--table-row-background:var(--color-surface);--table-row-background-hover:var(--color-surface-alt);--table-row-foreground:var(--color-foreground);--table-border:var(--color-border);--table-cell-padding-x:var(--space-4);--table-cell-padding-y:var(--space-3);
--nav-item-background-active:var(--color-primary-soft);--nav-item-foreground-active:var(--color-primary);--nav-item-background-hover:var(--color-secondary);--nav-item-foreground:var(--color-foreground-muted);--nav-item-radius:var(--radius-lg);
--bg:var(--color-background);--surface:var(--color-surface);--surface-alt:var(--color-surface-alt);--surface-alt-hover:var(--color-surface-alt-hover);
--text:var(--color-foreground);--dim:var(--color-foreground-muted);--border:var(--color-border);
--accent:var(--color-primary);--accent-hover:var(--color-primary-hover);--accent-active:var(--color-primary-active);--accent-soft:var(--color-primary-soft);--on-accent:var(--color-on-primary);
--link:var(--color-link);--link-soft:var(--color-link-soft);
--success:var(--color-success);--success-soft:var(--color-success-soft);--warning:var(--color-warning);--warning-soft:var(--color-warning-soft);
--info:var(--color-info);--info-soft:var(--color-info-soft);--danger:var(--color-danger);--danger-soft:var(--color-danger-soft);
--overlay:var(--color-overlay);--scrim:var(--color-scrim);--scrim-soft:var(--color-scrim-soft);
--ring:var(--color-ring);--ring-soft:var(--color-ring-soft);--radius:var(--radius-lg);
--btn-primary-bg:var(--button-primary-background);--btn-primary-bg-hover:var(--button-primary-background-hover);--btn-primary-bg-active:var(--button-primary-background-active);--btn-primary-fg:var(--button-primary-foreground);
--btn-secondary-bg:var(--button-secondary-background);--btn-secondary-bg-hover:var(--button-secondary-background-hover);--btn-secondary-border:var(--button-secondary-border);--btn-radius:var(--button-radius);
--input-bg:var(--input-background);--input-ring:var(--input-ring-focus);--input-radius:var(--input-radius);
--card-bg:var(--card-background);--card-border:var(--card-border);--card-radius:var(--card-radius);
--pop-shadow:var(--dialog-shadow);--chip-radius:var(--badge-radius);
--nav-item-bg-active:var(--nav-item-background-active);--nav-item-fg-active:var(--nav-item-foreground-active);--nav-item-bg-hover:var(--nav-item-background-hover);
--space-surface:var(--color-surface);--space-surface-alt:var(--color-surface);--space-muted:var(--color-foreground-muted);--space-border:var(--color-border);--space-accent:var(--color-primary);
}
@media (prefers-color-scheme: dark){
:root{
--color-background:var(--color-gray-950);--color-surface:var(--color-gray-900);--color-surface-alt:var(--color-gray-850);--color-surface-alt-hover:var(--color-gray-800);
--color-foreground:#f3efe9;--color-foreground-secondary:#cfc9c1;--color-foreground-muted:#a39c93;--color-foreground-faint:#7d766d;
--color-primary:var(--color-brand-400);--color-primary-hover:var(--color-brand-300);--color-primary-active:var(--color-brand-500);
--color-primary-soft:#3d1a22;--color-primary-soft-hover:#4c212c;--color-primary-border:#6e2a38;--color-on-primary:var(--color-white);
--color-secondary:var(--color-gray-850);--color-secondary-hover:var(--color-gray-800);--color-secondary-foreground:#f3efe9;
--color-muted:var(--color-gray-850);--color-muted-foreground:#a39c93;
--color-destructive:var(--color-red-300);--color-destructive-hover:var(--color-red-100);--color-destructive-soft:rgb(120 30 32 / 0.4);
--color-danger:var(--color-red-300);--color-danger-soft:rgb(120 30 32 / 0.4);
--color-success:var(--color-green-300);--color-success-soft:rgb(14 68 40 / 0.45);
--color-warning:var(--color-amber-300);--color-warning-soft:rgb(110 74 8 / 0.4);
--color-info:var(--color-sky-300);--color-info-soft:rgb(16 66 105 / 0.45);
--color-link:var(--color-linkblue-300);--color-link-hover:var(--color-linkblue-100);--color-link-soft:#26334f;
--color-border:#37322d;--color-border-strong:#4c463f;--color-input-border:#4c463f;
--color-ring:var(--color-brand-400);--color-ring-soft:rgb(255 92 118 / 0.28);
--card-shadow:0 1px 2px rgb(0 0 0 / 0.35),0 2px 10px rgb(0 0 0 / 0.3);
--dialog-shadow:0 4px 8px rgb(0 0 0 / 0.4),0 16px 40px rgb(0 0 0 / 0.5);
--shadow-nav:0 -6px 20px rgb(0 0 0 / 0.4);
}
}
`;

const CSS2 = `
.xhs{font-family:var(--font-family-sans);font-size:var(--font-body);line-height:var(--line-height-normal);color:var(--color-foreground);background:var(--color-background);min-height:100vh;-webkit-font-smoothing:antialiased}
.xhs *{box-sizing:border-box}
.xhs h1,.xhs h2,.xhs h3,.xhs h4{letter-spacing:var(--letter-spacing-tight);line-height:var(--line-height-tight)}
.xhs h2{margin:0;font-size:var(--font-display);font-weight:700}
.xhs h3{margin:0;font-size:var(--font-heading);font-weight:600}
.xhs button{transition-property:background-color,border-color,color,box-shadow,opacity;transition-duration:var(--duration-fast);transition-timing-function:var(--ease-standard);cursor:pointer;font-family:inherit}
.xhs button:disabled{cursor:not-allowed;opacity:var(--opacity-disabled)}
.xhs a{transition-property:color,background-color,opacity;transition-duration:var(--duration-fast);transition-timing-function:var(--ease-standard)}
.xhs :focus-visible{outline:var(--ring-width) solid var(--color-ring);outline-offset:var(--ring-offset)}
.xhs input:focus-visible,.xhs textarea:focus-visible,.xhs select:focus-visible{outline:none;box-shadow:0 0 0 3px var(--input-ring-focus)}
.xhs ::selection{background:var(--color-primary-soft)}
@media (prefers-reduced-motion: reduce){.xhs *,.xhs *::before,.xhs *::after{animation-duration:0.01ms!important;animation-iteration-count:1!important;transition-duration:0.01ms!important;scroll-behavior:auto!important}}
/* ---- 布局：桌面左侧边栏 240px + 主内容 85% 居中；手机底部双行导航、主内容满宽 ---- */
.xhs-layout{display:flex;min-height:100vh}
.xhs-nav{position:fixed;left:0;right:0;bottom:0;z-index:var(--z-nav);background:var(--color-surface);border-top:1px solid var(--color-border);padding-bottom:env(safe-area-inset-bottom);box-shadow:var(--shadow-nav)}
.xhs-nav-desktop{display:none}
.xhs-nav-mobile{display:block}
.xhs-main{flex:1;min-width:0;width:100%;padding:24px 16px 170px}
.xhs-main-inner{margin:0 auto;width:100%;min-width:0}
@media (min-width:768px){
.xhs-nav{position:sticky;top:0;flex:0 0 240px;width:240px;height:100vh;flex-shrink:0;border-top:0;border-right:1px solid var(--color-border);box-shadow:none;display:flex;flex-direction:column;padding-bottom:0}
.xhs-nav-desktop{display:flex;flex-direction:column;gap:4px;padding:0 12px;overflow-y:auto}
.xhs-nav-mobile{display:none}
.xhs-main{padding:32px 32px 48px}
.xhs-main-inner{width:85%}
}
.xhs-nav-eyebrow{padding:24px 20px 8px;font-size:12px;font-weight:500;letter-spacing:var(--letter-spacing-wide);color:var(--color-foreground-muted)}
.xhs-nav-group-label{display:flex;width:100%;align-items:center;padding:6px 12px;font-size:12px;font-weight:600;letter-spacing:var(--letter-spacing-wide);color:var(--color-foreground-muted);background:transparent;border:0;text-align:left}
.xhs-nav-group-label .chev{margin-left:auto;transition:transform var(--duration-normal)}
.xhs-nav-group-label .chev.closed{transform:rotate(-90deg)}
.xhs-nav-item{display:flex;width:100%;align-items:center;gap:10px;border:0;border-radius:var(--nav-item-radius);padding:10px 12px;font-size:14px;font-weight:500;color:var(--nav-item-foreground);background:transparent;text-align:left}
.xhs-nav-item:hover{background:var(--nav-item-background-hover)}
.xhs-nav-item.active{background:var(--nav-item-background-active);color:var(--nav-item-foreground-active);font-weight:600}
.xhs-nav-item .count{margin-left:auto;border-radius:var(--radius-full);background:var(--color-surface-alt);padding:2px 8px;font-size:12px;color:var(--color-foreground-muted)}
.xhs-nav-bottom{margin-top:auto;padding:8px 16px 16px}
.xhs-nav-account{display:flex;align-items:center;gap:8px;padding:4px 4px 12px;min-width:0}
.xhs-nav-account .nm{font-size:14px;font-weight:500;color:var(--color-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xhs-nav-account .st{font-size:12px;color:var(--color-foreground-muted)}
.xhs-nav-login-warn{padding:4px 4px 12px}
.xhs-nav-login-warn .t{font-size:14px;font-weight:600;color:var(--color-danger)}
.xhs-nav-login-warn .d{margin-top:2px;font-size:12px;line-height:1.6;color:var(--color-foreground-muted)}
.xhs-refresh-btn{display:flex;width:100%;align-items:center;justify-content:center;gap:8px;border:0;border-radius:var(--radius-lg);background:var(--button-primary-background);color:var(--button-primary-foreground);font-size:14px;font-weight:600;padding:10px 12px}
.xhs-refresh-btn:hover:not(:disabled){background:var(--button-primary-background-hover)}
.xhs-refresh-note{margin-top:8px;border-radius:var(--radius-lg);padding:8px 12px;font-size:12px;line-height:1.6;background:var(--color-surface-alt);color:var(--color-foreground-muted)}
.xhs-refresh-note.warn{background:var(--color-primary-soft);color:var(--color-foreground)}
.xhs-spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.5);border-top-color:#fff;border-radius:50%;animation:xhs-rot .8s linear infinite;vertical-align:-2px}
.xhs-spin.dark{border-color:#ddd;border-top-color:var(--color-primary)}
@keyframes xhs-rot{to{transform:rotate(360deg)}}
@keyframes fetchslide{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}
.xhs-pulse-dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--color-primary);animation:xhs-pulse 1.2s ease-in-out infinite}
@keyframes xhs-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.xhs-mnav-row{display:flex}
.xhs-mnav-row button{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;padding:8px 0 6px;border:0;background:transparent;font-size:12px;font-weight:500;color:var(--color-foreground-muted)}
.xhs-mnav-row button.active{color:var(--color-primary)}
.xhs-mnav-row2{border-top:1px solid var(--color-border)}
/* ---- 通用组件 ---- */
.xhs-sub{color:var(--color-foreground-muted);font-size:13px;margin:6px 0 0;line-height:1.6}
.xhs-card{background:var(--card-background);border:1px solid var(--card-border);border-radius:var(--card-radius);padding:var(--card-padding);margin-bottom:16px;box-shadow:var(--card-shadow)}
.xhs-card h3{margin:0 0 12px}
.xhs-page-title-row{display:flex;flex-wrap:wrap;align-items:center;gap:12px}
.xhs-page-title-row h2{font-size:var(--font-display)}
.xhs-section{margin-top:48px}
.xhs-section-gap{height:48px}
.xhs-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.xhs-stat{background:var(--color-surface-alt);border-radius:var(--radius-lg);padding:12px}
.xhs-stat .v{font-size:var(--font-metric);font-weight:800;line-height:1.2}
.xhs-stat .k{font-size:12px;color:var(--color-foreground-muted)}
.xhs-btn{border:1px solid var(--button-secondary-border);background:var(--button-secondary-background);color:var(--button-secondary-foreground);border-radius:var(--button-radius);padding:8px 16px;font-size:var(--button-font-size);font-weight:var(--button-font-weight)}
.xhs-btn:hover:not(:disabled){background:var(--button-secondary-background-hover)}
.xhs-btn.primary{border-color:transparent;background:var(--button-primary-background);color:var(--button-primary-foreground);box-shadow:var(--button-primary-shadow)}
.xhs-btn.primary:hover:not(:disabled){background:var(--button-primary-background-hover)}
.xhs-btn.danger{border-color:#f3c1c7;color:var(--color-danger);background:var(--color-surface)}
.xhs-btn.ghost{border-color:transparent;background:transparent;color:var(--color-primary)}
.xhs-btn.dark{border-color:transparent;background:var(--color-foreground);color:var(--color-background)}
.xhs-btn.mini{font-size:12px;padding:4px 10px}
.xhs-input,.xhs-textarea,.xhs-select{width:100%;border:1px solid var(--input-border);border-radius:var(--input-radius);padding:9px 14px;font-size:var(--input-font-size);background:var(--input-background);color:var(--input-foreground);font-family:inherit}
.xhs-input:hover,.xhs-textarea:hover,.xhs-select:hover{border-color:var(--input-border-hover)}
.xhs-textarea{min-height:90px;resize:vertical;line-height:1.6}
.xhs-field{margin-bottom:14px}
.xhs-field label{display:block;font-weight:600;margin-bottom:6px;font-size:14px}
.xhs-field label i{color:var(--color-primary);font-style:normal}
.xhs-hint{font-size:12px;color:var(--color-foreground-muted);margin-top:6px;line-height:1.6}
.xhs-error{background:var(--color-danger-soft);border:1px solid #ffc9cf;color:var(--color-danger);border-radius:var(--radius-lg);padding:10px 12px;margin-bottom:14px;font-size:14px}
.xhs-ok{background:var(--color-success-soft);border:1px solid #bfe8c8;color:var(--color-success);border-radius:var(--radius-lg);padding:10px 12px;margin-bottom:14px;font-size:14px}
.xhs-note-box{background:var(--color-surface-alt);border-radius:var(--radius-lg);padding:10px 12px;font-size:12px;line-height:1.6;color:var(--color-foreground-muted)}
.xhs-note-box.warn{background:var(--color-primary-soft);color:var(--color-foreground)}
.xhs-badge{display:inline-block;font-size:11px;border-radius:var(--badge-radius);padding:2px 8px;background:var(--color-surface-alt);color:var(--color-foreground-muted);font-weight:500}
.xhs-badge.published{background:var(--color-primary);color:#fff}
.xhs-badge.draft{background:var(--color-surface-alt);color:var(--color-foreground-muted)}
.xhs-badge.blue{background:var(--color-link-soft);color:var(--color-link)}
.xhs-link{color:var(--color-link);font-size:12px;word-break:break-all}
.xhs-link-row{font-size:12px;color:var(--color-foreground-muted);margin-top:8px;line-height:1.6}
.xhs-progress{height:10px;background:var(--color-surface-alt);border-radius:var(--radius-full);overflow:hidden}
.xhs-progress.thin{height:6px}
.xhs-progress i{display:block;height:100%;background:var(--color-primary);border-radius:var(--radius-full);transition:width .5s var(--ease-out)}
.xhs-progress i.slide{width:33%;animation:fetchslide 1.4s ease-in-out infinite}
.xhs-stage{display:flex;gap:8px;align-items:center;padding:6px 0;font-size:13px;color:var(--color-foreground-muted)}
.xhs-stage.done{color:var(--color-foreground)}
.xhs-stage.now{color:var(--color-primary);font-weight:600}
.xhs-stage .dot{width:20px;height:20px;border-radius:50%;border:1px solid var(--color-border);display:inline-flex;align-items:center;justify-content:center;font-size:11px;flex:0 0 20px}
.xhs-stage.done .dot{border-color:var(--color-primary);background:var(--color-primary);color:#fff}
.xhs-stage.now .dot{border-color:var(--color-primary);color:var(--color-primary);border-width:2px}
.xhs-avatar{width:44px;height:44px;border-radius:50%;background:var(--color-primary);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;flex:0 0 44px;overflow:hidden;flex-shrink:0}
.xhs-avatar img{width:100%;height:100%;object-fit:cover}
.xhs-tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.xhs-tabs button{border:1px solid var(--color-border);background:var(--color-surface);border-radius:var(--radius-full);padding:6px 14px;font-size:13px;color:var(--color-foreground)}
.xhs-tabs button.active{border-color:var(--color-primary);color:var(--color-primary);font-weight:700;background:var(--color-primary-soft)}
/* ---- 笔记卡片（徽标行：徽标 shrink-0 + nowrap，绝不内部换行、不被挤变形） ---- */
.xhs-note-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}
.xhs-note-card{background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-2xl);overflow:hidden;box-shadow:var(--card-shadow)}
.xhs-note-card.clickable{cursor:pointer}
.xhs-note-card.clickable:hover{box-shadow:var(--card-shadow-hover)}
.xhs-cover{width:100%;aspect-ratio:3/4;object-fit:cover;display:block;background:var(--color-surface-alt)}
.xhs-cover-ph{width:100%;aspect-ratio:3/4;background:var(--color-surface-alt);display:flex;align-items:center;justify-content:center;color:var(--color-foreground-faint);font-size:13px}
.xhs-note-body{padding:12px}
.xhs-note-title{font-weight:700;font-size:14px;margin-bottom:6px}
.xhs-note-meta{font-size:12px;color:var(--color-foreground-muted);line-height:1.6}
.xhs-metrics{display:flex;gap:12px;font-size:12px;color:var(--color-foreground-muted);margin-top:8px;flex-wrap:wrap}
.xhs-metrics b{color:var(--color-foreground)}
.xhs-badge-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.xhs-badge-row .xhs-badge{flex-shrink:0;white-space:nowrap}
.xhs-badge-row .acct{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--color-foreground-muted)}
.xhs-archive-card{display:flex;width:100%;min-width:0;gap:12px;overflow:hidden;border-radius:var(--radius-2xl);border:1px solid var(--color-border);background:var(--color-surface);padding:12px;box-shadow:var(--card-shadow)}
.xhs-archive-card img.thumb{width:80px;height:80px;flex-shrink:0;border-radius:var(--radius-lg);object-fit:cover}
.xhs-archive-card .thumb-ph{width:80px;height:80px;flex-shrink:0;border-radius:var(--radius-lg);background:var(--color-surface-alt);display:flex;align-items:center;justify-content:center;color:var(--color-foreground-faint)}
.xhs-archive-grid{display:grid;grid-template-columns:1fr;gap:16px;margin-top:20px}
@media (min-width:640px){.xhs-archive-grid{grid-template-columns:1fr 1fr}}
@media (min-width:1280px){.xhs-archive-grid{grid-template-columns:1fr 1fr 1fr}}
.xhs-divider{display:flex;align-items:center;gap:12px;padding-top:8px;font-size:14px;font-weight:600;color:var(--color-foreground)}
.xhs-divider:after{content:'';height:1px;flex:1;background:var(--color-border)}
.xhs-divider-wrap{grid-column:1/-1}
/* ---- 日历 ---- */
.xhs-cal-grid{display:grid;grid-template-columns:repeat(7,1fr)}
.xhs-cal-head{display:grid;grid-template-columns:repeat(7,1fr);border-bottom:1px solid var(--color-border);background:var(--color-surface-alt);text-align:center;font-size:12px;font-weight:500;color:var(--color-foreground-muted)}
.xhs-cal-head span{padding:8px 0}
.xhs-cal-cell{min-height:64px;border-bottom:1px solid var(--color-border);padding:6px}
.xhs-cal-cell:not(:nth-child(7n)){border-right:1px solid var(--color-border)}
.xhs-cal-cell.empty{background:var(--color-surface-alt);opacity:.4}
.xhs-cal-cell.today{background:var(--color-primary-soft)}
.xhs-cal-day{font-size:12px;font-weight:500;color:var(--color-foreground-muted)}
.xhs-cal-day.today{color:var(--color-primary)}
.xhs-cal-entry{margin-top:4px;display:block;border-radius:6px;background:var(--color-surface-alt);padding:2px 6px}
.xhs-cal-entry .t{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--color-foreground)}
.xhs-cal-entry .m{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:var(--color-foreground-muted)}
.xhs-cal-week{display:grid;grid-template-columns:1fr;gap:8px}
@media (min-width:768px){.xhs-cal-week{grid-template-columns:repeat(7,1fr)}}
/* ---- 手机预览框 ---- */
.xhs-gen-wrap{display:grid;grid-template-columns:minmax(0,1fr);gap:24px;align-items:start}
@media (min-width:1024px){.xhs-gen-wrap{grid-template-columns:minmax(0,1fr) 400px}}
.xhs-phone{width:100%;max-width:380px;margin:0 auto;background:var(--color-surface);border:1px solid var(--color-border);border-radius:28px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,0.14)}
.xhs-phone-head{display:flex;align-items:center;gap:8px;padding:12px 16px 10px}
.xhs-phone-img{width:100%;aspect-ratio:3/4;object-fit:cover;display:block;background:var(--color-surface-alt)}
.xhs-phone-img-ph{width:100%;aspect-ratio:3/4;background:var(--color-surface-alt);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--color-foreground-muted);font-size:13px}
.xhs-phone-body{padding:12px 16px}
.xhs-phone-title{font-weight:700;font-size:15px;margin-bottom:6px}
.xhs-phone-tags{color:var(--color-link);font-size:13px;margin-top:10px;word-break:break-all}
.xhs-phone-actions{display:flex;align-items:center;gap:20px;border-top:1px solid var(--color-border);padding-top:12px;margin-top:12px;color:var(--color-foreground-muted);font-size:12px}
.xhs-editor{display:grid;grid-template-columns:minmax(0,1fr);gap:24px;align-items:start}
@media (min-width:1024px){.xhs-editor{grid-template-columns:minmax(0,1fr) 400px}}
.xhs-img-row{display:flex;gap:8px;align-items:center;border:1px solid var(--color-border);border-radius:var(--radius-lg);padding:6px;margin-bottom:8px;background:var(--color-surface)}
.xhs-img-row img{width:56px;height:56px;object-fit:cover;border-radius:6px;background:var(--color-surface-alt)}
.xhs-img-row .grow{flex:1;min-width:0}
.xhs-img-row input{width:100%;border:1px solid var(--color-border);border-radius:6px;padding:6px;font-size:12px;background:var(--color-surface);color:var(--color-foreground)}
.xhs-mini{font-size:12px;padding:4px 8px}
.xhs-style-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.xhs-style-btn{border:1px solid var(--color-border);background:var(--color-surface);border-radius:var(--radius-lg);padding:10px 12px;text-align:left;color:var(--color-foreground)}
.xhs-style-btn.active{border-color:var(--color-primary);background:var(--color-primary-soft)}
.xhs-style-btn .v{display:block;font-size:16px;font-weight:500}
.xhs-style-btn .hint{display:block;margin-top:2px;font-size:12px;line-height:1.4;color:var(--color-foreground-muted)}
.xhs-backend-seg{display:inline-flex;overflow:hidden;border:1px solid var(--color-border);border-radius:var(--radius-full)}
.xhs-backend-seg button{border:0;padding:8px 16px;font-size:14px;font-weight:500;background:var(--color-surface);color:var(--color-foreground)}
.xhs-backend-seg button.active{background:var(--color-primary);color:#fff}
/* ---- 表格（竞对密集表：width 100%、列宽全百分比、窄屏渐进收列） ---- */
.xhs-table-wrap{width:100%;min-width:0;max-width:100%;overflow:hidden;border-radius:var(--radius-2xl);border:1px solid var(--color-border);background:var(--color-surface);box-shadow:var(--card-shadow);display:none}
@media (min-width:768px){.xhs-table-wrap{display:block}}
.xhs-table{width:100%;max-width:100%;table-layout:fixed;text-align:left;font-size:14px;border-collapse:collapse}
.xhs-table thead tr{border-bottom:1px solid var(--color-border-strong);background:var(--table-header-background);font-size:13px;font-weight:600;color:var(--color-foreground-secondary)}
.xhs-table th{padding:8px 12px;font-weight:600}
.xhs-table td{padding:6px 12px;border-bottom:1px solid var(--color-border);vertical-align:middle}
.xhs-table tbody tr:last-child td{border-bottom:0}
.xhs-table tbody tr:hover{background:var(--table-row-background-hover)}
.xhs-table .num{text-align:right;font-weight:500;color:var(--color-foreground);font-variant-numeric:tabular-nums}
.xhs-table .delta{font-size:10px;font-weight:400;line-height:1.2}
.xhs-table .trunc{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xhs-table .trunc-sm{font-size:11px;color:var(--color-foreground-muted)}
.xhs-col-lg,.xhs-cell-lg{display:none}
.xhs-col-xl,.xhs-cell-xl{display:none}
@media (min-width:1024px){col.xhs-col-lg{display:table-column}.xhs-cell-lg{display:table-cell}}
@media (min-width:1280px){col.xhs-col-xl{display:table-column}.xhs-cell-xl{display:table-cell}}
.xhs-mon-mobile{display:block}
@media (min-width:768px){.xhs-mon-mobile{display:none}}
.xhs-mon-row{border:1px solid var(--color-border);border-radius:var(--radius-lg);background:var(--color-surface);padding:12px;margin-bottom:8px}
.xhs-history-sub{width:100%;background:var(--color-surface-alt)}
.xhs-history-sub td{padding:12px 16px}
.xhs-sub-table{width:100%;border-collapse:collapse;font-size:13px}
.xhs-sub-table th,.xhs-sub-table td{border-bottom:1px solid var(--color-border);padding:6px 8px;text-align:left}
.xhs-sub-table .num{text-align:right;font-variant-numeric:tabular-nums}
/* ---- 通知弹窗 / 铃铛 ---- */
.xhs-popups{position:fixed;top:12px;right:12px;left:12px;z-index:var(--z-popup);display:flex;flex-direction:column;gap:8px}
@media (min-width:640px){.xhs-popups{left:auto;width:360px}}
.xhs-popup{border-radius:var(--radius-2xl);border:1px solid var(--color-border);background:var(--color-surface);padding:14px;box-shadow:var(--shadow-lg)}
.xhs-bell-panel{margin-top:4px;max-height:320px;overflow-y:auto;border-radius:var(--radius-lg);border:1px solid var(--color-border);background:var(--color-surface);padding:8px}
.xhs-notif-item{display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--color-border)}
.xhs-notif-item:last-child{border-bottom:0}
.xhs-chip{flex-shrink:0;border-radius:var(--radius-full);padding:2px 8px;font-size:12px;font-weight:500;height:fit-content;white-space:nowrap}
.xhs-chip.green{background:var(--color-success-soft);color:var(--color-success)}
.xhs-chip.red{background:var(--color-primary-soft);color:var(--color-primary)}
.xhs-chip.blue{background:var(--color-info-soft);color:var(--color-info)}
.xhs-chip.amber{background:var(--color-warning-soft);color:var(--color-warning)}
.xhs-chip.gray{background:var(--color-surface-alt);color:var(--color-foreground-muted)}
.xhs-chip.dark{background:var(--color-foreground);color:var(--color-background)}
.xhs-dialog-overlay{position:fixed;inset:0;z-index:var(--z-dialog);display:flex;align-items:flex-end;justify-content:center;background:var(--dialog-overlay);padding:0}
@media (min-width:640px){.xhs-dialog-overlay{align-items:center;padding:24px}}
.xhs-dialog{max-height:88vh;width:100%;max-width:560px;overflow-y:auto;border-radius:24px 24px 0 0;background:var(--dialog-background);padding:20px;box-shadow:var(--dialog-shadow)}
@media (min-width:640px){.xhs-dialog{border-radius:var(--dialog-radius)}}
.xhs-login-panels{display:grid;grid-template-columns:1fr;gap:12px}
@media (min-width:640px){.xhs-login-panels{grid-template-columns:1fr 1fr}}
.xhs-login-box{background:var(--color-surface-alt);border-radius:var(--radius-lg);padding:12px}
.xhs-login-box .k{font-size:12px;color:var(--color-foreground-muted)}
.xhs-login-box .v{font-size:15px;font-weight:700;margin-top:4px}
.xhs-banner{display:flex;align-items:center;gap:12px;border-radius:var(--radius-2xl);background:var(--color-foreground);color:var(--color-background);padding:16px 20px;margin-top:16px}
.xhs-banner .t{font-size:18px;font-weight:700}
.xhs-banner .s{font-size:14px;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xhs-mobile-bell{display:flex}
@media (min-width:768px){.xhs-mobile-bell{display:none}}
.xhs-asset-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
@media (min-width:640px){.xhs-asset-grid{grid-template-columns:repeat(6,1fr)}}
.xhs-asset-btn{position:relative;aspect-ratio:1/1;overflow:hidden;border-radius:var(--radius-lg);border:0;padding:0;background:var(--color-surface-alt)}
.xhs-asset-btn img{width:100%;height:100%;object-fit:cover}
.xhs-asset-btn .plus{position:absolute;right:4px;bottom:4px;display:flex;width:20px;height:20px;align-items:center;justify-content:center;border-radius:50%;background:var(--color-primary);color:#fff;font-size:12px;font-weight:700}
`;

const ICONS = {
  home: 'M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5',
  sparkles: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z',
  note: 'M6 2h9l5 5v15H6zM14 2v6h6M9 13h6M9 17h6',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
  image: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5zM3 16l5-5 4 4 3-3 6 6M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  user: 'M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5',
  heart: 'M12 20.5C7 16.5 3 13.3 3 9.3 3 6.4 5.2 4.5 7.7 4.5c1.7 0 3.4 1 4.3 2.4.9-1.4 2.6-2.4 4.3-2.4 2.5 0 4.7 1.9 4.7 4.8 0 4-4 7.2-9 11.2z',
  star: 'M12 3l2.7 5.8 6.3.7-4.7 4.3 1.3 6.2L12 17l-5.6 3 1.3-6.2L3 9.5l6.3-.7L12 3z',
  share: 'M12 3v13M7 8l5-5 5 5M5 13v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7',
  comment: 'M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z',
  refresh: 'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6',
  calendar: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6zM4 10h16M8 2v4M16 2v4',
  flame: 'M12 3c1 3.5-1.5 5-3 6.5C7.4 11 7 12.3 7 14a5 5 0 0 0 10 0c0-1.5-.5-2.7-1.2-3.9-.5 1-1.1 1.7-2 2.3C14 9.5 13.5 6 12 3z',
  bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M10.3 21a2 2 0 0 0 3.4 0',
  chevron: 'M6 9l6 6 6-6',
};

function Icon({ d, className, style }) {
  return h('svg', {
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
    strokeLinecap: 'round', strokeLinejoin: 'round',
    className: className || '', style: Object.assign({ width: 20, height: 20, flexShrink: 0 }, style || {}),
    'aria-hidden': true,
  }, h('path', { d }));
}

// 全站唯一的头像组件：真实头像优先，未读到或加载失败时昵称首字粉色圆圈占位，绝不编造图片。
function AccountAvatar({ nickname, avatarUrl, size }) {
  const [failed, setFailed] = useState(false);
  const style = size ? { width: size, height: size, flexBasis: size, fontSize: Math.round(size / 2.5) } : undefined;
  if (avatarUrl && !failed) {
    return h('span', { className: 'xhs-avatar', style },
      h('img', { src: avatarUrl, alt: (nickname || '') + ' 的头像', referrerPolicy: 'no-referrer', onError: () => setFailed(true) }));
  }
  return h('span', { className: 'xhs-avatar', style }, (nickname || '账').slice(0, 1));
}

function Delta({ now, prev }) {
  if (prev === undefined || prev === null) return null;
  const diff = now - prev;
  if (diff === 0) return h('span', { style: { color: 'var(--color-foreground-muted)' } }, '— 持平');
  return h('span', { style: { color: diff > 0 ? 'var(--color-success)' : 'var(--color-primary)' } },
    (diff > 0 ? '▲ ' : '▼ ') + fmtCount(Math.abs(diff)));
}

// 原笔记外链：存的 URL 原样打开（含 xsec_token，令牌不能去掉）；点开前先说明
// 令牌会过期、过期报 300017/300031 不是笔记被删，并给两个恢复入口。
function XhsNoteLink({ url, label, className, homepageUrl, onRefetch, refetchDisabled }) {
  const [confirming, setConfirming] = useState(false);
  const [refetchClicked, setRefetchClicked] = useState(false);
  return h('span', { style: { display: 'inline-block', maxWidth: '100%' } },
    h('button', { type: 'button', onClick: () => setConfirming((v) => !v), className: className || 'xhs-link', style: { background: 'none', border: 0, padding: 0, textAlign: 'left' } }, label),
    confirming ? h('span', { style: { display: 'block', marginTop: 6, maxWidth: 360, borderRadius: 12, background: 'var(--color-primary-soft)', padding: '10px 12px', fontSize: 12, lineHeight: 1.6, color: 'var(--color-foreground)' } },
      '这个链接带着获取那一刻小红书发的令牌（xsec_token），令牌会过期。过期后再打开会报「链接已失效 300017」或「当前笔记暂时无法浏览 300031」——不是笔记没了。令牌不能去掉（去掉令牌小红书直接打不开），打开时也要保持浏览器登录着小红书。',
      h('span', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 } },
        h('a', { href: url, target: '_blank', rel: 'noreferrer', onClick: () => setConfirming(false), className: 'xhs-btn mini primary', style: { textDecoration: 'none' } }, '打开原笔记'),
        homepageUrl ? h('a', { href: homepageUrl, target: '_blank', rel: 'noreferrer', className: 'xhs-btn mini', style: { textDecoration: 'none' } }, '去账号主页点这篇') : null,
        onRefetch ? h('button', { type: 'button', disabled: refetchDisabled || refetchClicked, className: 'xhs-btn mini', onClick: () => { onRefetch(); setRefetchClicked(true); } }, refetchClicked ? '已请求重新获取' : '重新获取新链接') : null,
        h('button', { type: 'button', className: 'xhs-btn mini', onClick: () => setConfirming(false) }, '先不打开')),
      refetchClicked ? h('span', { style: { display: 'block', marginTop: 6 } }, '已请求重新获取：工作台会用已登录态重新拉这个账号的笔记，拉完后这里的链接会自动换成新令牌的，稍等一会儿再打开。') : null) : null);
}

function NotePreview({ title, body, tags, imageUrls, captions, accountName, accountAvatarUrl, dateLine }) {
  const [page, setPage] = useState(0);
  const urls = imgUrls(imageUrls || []);
  const total = urls.length;
  const safePage = Math.min(page, Math.max(0, total - 1));
  const currentUrl = total > 0 ? urls[safePage] : undefined;
  const currentCaption = (captions && captions[safePage]) || '';
  return h('div', { className: 'xhs-phone' },
    h('div', { className: 'xhs-phone-head' },
      h(AccountAvatar, { nickname: accountName || '我', avatarUrl: accountAvatarUrl, size: 32 }),
      h('span', { style: { fontSize: 14, fontWeight: 500 } }, accountName || '我的账号'),
      h('span', { style: { marginLeft: 'auto', borderRadius: 999, border: '1px solid var(--color-primary)', padding: '2px 12px', fontSize: 12, fontWeight: 500, color: 'var(--color-primary)' } }, '关注')),
    total > 1 ? h('div', { style: { position: 'relative', aspectRatio: '3/4', width: '100%', background: 'var(--color-surface-alt)' } },
      currentUrl ? h('img', { src: currentUrl, alt: currentCaption || ('配图 ' + (safePage + 1)), style: { width: '100%', height: '100%', objectFit: 'cover' } })
        : h('div', { className: 'xhs-phone-img-ph' }, h(Icon, { d: ICONS.image, style: { width: 40, height: 40 } }), h('p', null, '还没有配图')),
      h('span', { style: { position: 'absolute', top: 12, right: 12, borderRadius: 999, background: 'var(--color-scrim)', padding: '2px 8px', fontSize: 12, color: '#fff' } }, (safePage + 1) + '/' + total),
      h('button', { type: 'button', onClick: () => setPage((p) => (p - 1 + total) % total), style: { position: 'absolute', top: '50%', left: 8, transform: 'translateY(-50%)', width: 32, height: 32, borderRadius: '50%', border: 0, background: 'var(--color-scrim-soft)', color: '#fff', fontSize: 18 } }, '‹'),
      h('button', { type: 'button', onClick: () => setPage((p) => (p + 1) % total), style: { position: 'absolute', top: '50%', right: 8, transform: 'translateY(-50%)', width: 32, height: 32, borderRadius: '50%', border: 0, background: 'var(--color-scrim-soft)', color: '#fff', fontSize: 18 } }, '›'),
      h('span', { style: { position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 6 } },
        urls.map((_, i) => h('span', { key: i, style: { height: 6, width: i === safePage ? 16 : 6, borderRadius: 999, background: i === safePage ? 'var(--color-primary)' : 'rgba(255,255,255,.7)' } }))),
      currentCaption ? h('span', { style: { position: 'absolute', bottom: 32, left: 12, maxWidth: '80%', borderRadius: 8, background: 'var(--color-scrim)', padding: '4px 8px', fontSize: 12, color: '#fff' } }, currentCaption) : null)
      : (currentUrl
        ? h('img', { className: 'xhs-phone-img', src: currentUrl, alt: currentCaption || '配图 1' })
        : h('div', { className: 'xhs-phone-img-ph' }, h(Icon, { d: ICONS.image, style: { width: 40, height: 40 } }), h('p', null, '还没有配图'))),
    h('div', { className: 'xhs-phone-body' },
      h('h3', { className: 'xhs-phone-title' }, title || '标题会显示在这里'),
      h('p', { style: { marginTop: 6, fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' } }, body || '正文会显示在这里。生成或手写一段内容，就能实时看到发出去的样子。'),
      (tags && tags.length > 0) ? h('p', { className: 'xhs-phone-tags' }, tags.map((t) => '#' + t).join(' ')) : null,
      dateLine ? h('p', { style: { marginTop: 8, fontSize: 12, color: 'var(--color-foreground-muted)' } }, dateLine) : null,
      h('div', { className: 'xhs-phone-actions' },
        h('span', { style: { display: 'flex', alignItems: 'center', gap: 4 } }, h(Icon, { d: ICONS.heart, style: { width: 16, height: 16 } }), '点赞'),
        h('span', { style: { display: 'flex', alignItems: 'center', gap: 4 } }, h(Icon, { d: ICONS.star, style: { width: 16, height: 16 } }), '收藏'),
        h('span', { style: { display: 'flex', alignItems: 'center', gap: 4 } }, h(Icon, { d: ICONS.comment, style: { width: 16, height: 16 } }), '评论'),
        h('span', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 } }, h(Icon, { d: ICONS.share, style: { width: 16, height: 16 } }), '分享'))));
}

function Stat({ k, v }) {
  return h('div', { className: 'xhs-stat' },
    h('div', { className: 'v' }, v),
    h('div', { className: 'k' }, k));
}

// 竞对 / 留资通知的可回看列表（两页共用同一渲染；弹窗与铃铛在壳里另做）。
function NotificationList({ items, unreadCount, onMarkRead, onMarkAllRead, emptyText, chipOf }) {
  return h('div', null,
    h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
      h('h3', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 16 } },
        h(Icon, { d: ICONS.bell, style: { width: 16, height: 16 } }), '通知',
        unreadCount > 0 ? h('span', { className: 'xhs-badge published', style: { fontSize: 12 } }, unreadCount + ' 条未读') : null),
      (items.length > 0 && unreadCount > 0) ? h('button', { type: 'button', className: 'xhs-btn mini', style: { marginLeft: 'auto' }, onClick: onMarkAllRead }, '全部标为已读') : null),
    items.length === 0
      ? h('p', { style: { marginTop: 8, fontSize: 14, color: 'var(--color-foreground-muted)' } }, emptyText)
      : h('ul', { style: { marginTop: 12, listStyle: 'none', padding: 0, margin: 0 } },
        items.slice(0, 20).map((n) => {
          const chip = chipOf(n);
          return h('li', { key: n.id, className: 'xhs-notif-item' },
            h('span', { className: 'xhs-chip ' + chip.cls }, chip.label),
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('p', { style: { margin: 0, fontSize: 14, fontWeight: n.isRead ? 400 : 500, color: n.isRead ? 'var(--color-foreground-muted)' : 'var(--color-foreground)' } }, n.title),
              h('p', { style: { margin: '2px 0 0', fontSize: 14, color: 'var(--color-foreground-muted)' } }, n.body),
              h('p', { style: { margin: '2px 0 0', fontSize: 12, color: 'var(--color-foreground-muted)' } },
                fmtTime(n.createdAt) +
                (n.likes !== null && n.likes !== undefined ? ' · 点赞 ' + n.likes : '') +
                (n.type === 'new_comment' && n.comments !== null && n.comments !== undefined ? ' · 评论共 ' + n.comments + ' 条' : '') +
                (!n.isRead ? ' · 未读' : ''))),
            !n.isRead ? h('button', { type: 'button', className: 'xhs-btn mini', style: { flexShrink: 0, alignSelf: 'flex-start' }, onClick: () => onMarkRead(n.id) }, '已读') : null);
        })),
    items.length > 20 ? h('p', { style: { marginTop: 8, fontSize: 12, color: 'var(--color-foreground-muted)' } }, '只显示最近 20 条，共 ' + items.length + ' 条。') : null);
}

const STYLE_OPTIONS = [
  { value: '种草', hint: '真实体验分享，像朋友推荐' },
  { value: '评测', hint: '有条理测评，优缺点分开讲' },
  { value: '探店', hint: '到店探访，环境和必点' },
];
const IMAGE_BACKENDS = [
  { value: 'muse', label: 'Muse' },
  { value: 'dsh', label: 'DSH' },
  { value: 'api', label: 'API' },
];
const GEN_STAGES = ['正在分析主题与关键词', '正在结合参考图片构思内容', '正在撰写标题和正文', '正在整理话题标签与配图说明', '正在保存草稿'];
function stageForElapsed(seconds) {
  if (seconds < 3) return 0;
  if (seconds < 7) return 1;
  if (seconds < 14) return 2;
  if (seconds < 24) return 3;
  return 4;
}
const SHARED_KIND_LABELS = {
  account_info: '确认登录 / 读取账号信息',
  account_notes: '拉取真实笔记',
  note_images: '补拉笔记配图',
  note_details: '补齐发布日期和数据',
  monitored_account: '获取监测账号数据',
  lead_dm: '检查私信',
  hotspot_xhs: '检索小红书热点',
  publish_note: '在小红书发布笔记',
};

// ---------- 发布日历 ----------
// 只算主账号；按 publishedAt（绝对日期）排进格子，publishedAt 为 null 的只进
// 下方「已发布归档」的「日期未知」一类、不进格子。未知指标显示「—」，
// 部分已知标注「（已知部分）」。
function CalendarView({ notes, fetchedNotes, accounts, gate, onReload }) {
  const primary = (accounts || []).find((a) => a.monitored) || (accounts || [])[0] || null;
  const fetchedByKey = useMemo(() => {
    const m = new Map();
    for (const f of fetchedNotes || []) {
      if (f.url) m.set(f.accountId + '|url|' + f.url, f);
      m.set(f.accountId + '|title|' + f.title, f);
    }
    return m;
  }, [fetchedNotes]);
  const entries = useMemo(() => (notes || [])
    .filter((n) => n.status === 'published' && (!primary || n.accountId === null || n.accountId === primary.id))
    .map((n) => {
      const f = n.source === 'fetched' && n.accountId
        ? (fetchedByKey.get(n.accountId + '|url|' + n.sourceUrl) || fetchedByKey.get(n.accountId + '|title|' + n.title))
        : undefined;
      return {
        note: n,
        date: n.publishedAt ? fmtDate(n.publishedAt) : (f ? (f.publishedAt ? fmtDate(f.publishedAt) : parsePublishedLabel(f.publishedLabel, f.fetchedAt)) : null),
        likes: f ? f.likes : (n.latestMetrics ? n.latestMetrics.likes : null),
        collects: f ? f.collects : (n.latestMetrics ? n.latestMetrics.collects : null),
        shares: f ? f.shares : (n.latestMetrics ? n.latestMetrics.shares : null),
        comments: f ? f.comments : (n.latestMetrics ? n.latestMetrics.comments : null),
      };
    }), [notes, fetchedByKey, primary]);
  const byDate = useMemo(() => {
    const m = new Map();
    for (const e of entries) {
      if (!e.date) continue;
      const list = m.get(e.date) || [];
      list.push(e); m.set(e.date, list);
    }
    return m;
  }, [entries]);
  const undatedCount = entries.filter((e) => !e.date).length;
  const totals = ['likes', 'collects', 'shares', 'comments'].reduce((acc, key) => {
    let sum = 0; let known = 0;
    for (const e of entries) {
      const v = e[key];
      if (v !== null && v !== undefined) { sum += v; known += 1; }
    }
    acc[key] = { sum, known };
    return acc;
  }, {});
  const totalText = (key) => {
    const t = totals[key];
    if (t.known === 0) return '—';
    return t.known < entries.length ? fmtCount(t.sum) + '（已知部分）' : fmtCount(t.sum);
  };
  const metricText = (v) => (v === null || v === undefined ? '—' : fmtCount(v));
  const entryLine = (e) => '赞 ' + metricText(e.likes) + ' · 藏 ' + metricText(e.collects) + ' · 分享 ' + metricText(e.shares) + ' · 评论 ' + metricText(e.comments);

  const [detailBusy, setDetailBusy] = useState(false);
  const [detailMsg, setDetailMsg] = useState('');
  const missingDetailCount = entries.filter((e) => e.note.source === 'fetched' && (e.date === null || e.collects === null || e.shares === null || e.comments === null)).length;
  const detailFetching = primary && primary.detailFetchStatus === 'fetching';
  const detailGateAllows = !!primary && !!gate && gate.canFetch && gate.accountId === primary.id;
  const startDetails = async () => {
    if (!primary) return;
    setDetailBusy(true); setDetailMsg('');
    try {
      const res = await api('startbackfillnotedetails', { accountId: primary.id });
      if (res && res.started === false) setDetailMsg(res.message || '未能开始补齐。');
      else setDetailMsg(res && res.message ? res.message : '已开始补齐，正在逐篇打开详情页读取…');
      if (onReload) await onReload();
    } catch (err) { setDetailMsg('补齐没能启动：' + (err && err.message ? err.message : String(err))); }
    finally { setDetailBusy(false); }
  };
  const detailProgressPct = primary && primary.detailFetchTotal > 0
    ? Math.min(100, Math.round((primary.detailFetchDone / primary.detailFetchTotal) * 100)) : null;

  const now = new Date();
  const todayKey = localDateKey(now);
  const [mode, setMode] = useState('month');
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth());
  const [weekAnchorKey, setWeekAnchorKey] = useState(todayKey);
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [rangeResult, setRangeResult] = useState(null);
  const [rangeError, setRangeError] = useState('');

  const monthCells = useMemo(() => {
    const first = new Date(viewYear, viewMonth, 1);
    const lead = first.getDay();
    const days = new Date(viewYear, viewMonth + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= days; d++) cells.push(localDateKey(new Date(viewYear, viewMonth, d)));
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [viewYear, viewMonth]);
  const shiftMonth = (dir) => {
    const d = new Date(viewYear, viewMonth + dir, 1);
    setViewYear(d.getFullYear()); setViewMonth(d.getMonth());
  };
  const weekDays = useMemo(() => {
    const parts = weekAnchorKey.split('-').map(Number);
    const anchor = new Date(parts[0] || 1970, (parts[1] || 1) - 1, parts[2] || 1);
    const sunday = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - anchor.getDay());
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + i);
      return { key: localDateKey(d), day: d };
    });
  }, [weekAnchorKey]);
  const shiftWeek = (dir) => {
    const parts = weekAnchorKey.split('-').map(Number);
    const d = new Date(parts[0] || 1970, (parts[1] || 1) - 1, (parts[2] || 1) + dir * 7);
    setWeekAnchorKey(localDateKey(d));
  };
  const runRangeQuery = () => {
    setRangeResult(null); setRangeError('');
    if (!rangeStart || !rangeEnd) { setRangeError('先选好开始和结束日期。'); return; }
    if (rangeStart > rangeEnd) { setRangeError('开始日期不能晚于结束日期。'); return; }
    setRangeResult(entries.filter((e) => e.date !== null && e.date >= rangeStart && e.date <= rangeEnd)
      .sort((a, b) => (a.date || '').localeCompare(b.date || '')));
  };
  const statCards = [
    ['已发布笔记', entries.length + ' 篇'],
    ['累计点赞', totalText('likes')],
    ['累计收藏', totalText('collects')],
    ['累计分享', totalText('shares')],
    ['累计评论', totalText('comments')],
  ];

  return h('div', null,
    h('div', { className: 'xhs-page-title-row' },
      h('h2', null, '发布日历'),
      primary ? h('span', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'var(--color-foreground-muted)' } },
        h(AccountAvatar, { nickname: primary.nickname, avatarUrl: primary.avatarUrl, size: 28 }),
        primary.nickname + ' · 主账号') : null),
    h('p', { className: 'xhs-sub' }, '按发布时间看主账号已发布的笔记。点赞、收藏、分享、评论是拉取时从笔记详情页读到的数，页面没显示的指标记为「—」，不按 0 算。'),
    primary && primary.fetchStatus === 'fetching' ? h('div', { className: 'xhs-card', style: { marginTop: 16 } },
      h('p', { style: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500, margin: 0 } },
        h('span', { className: 'xhs-pulse-dot' }), '正在拉取主账号笔记…'),
      h('p', { style: { margin: '4px 0 0', fontSize: 14, color: 'var(--color-foreground-muted)' } },
        primary.fetchMessage || '正在逐篇打开笔记详情页读发布时间和收藏/分享/评论数，逐篇读会比较慢，读完会自动排进日历。'),
      h('div', { className: 'xhs-progress thin', style: { marginTop: 8 } }, h('i', { className: 'slide' }))) : null,
    primary && (missingDetailCount > 0 || detailFetching || (primary.detailFetchStatus && primary.detailFetchStatus !== 'idle')) ? h('div', { className: 'xhs-card', style: { marginTop: 16 } },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 } },
        h('p', { style: { fontSize: 14, fontWeight: 500, margin: 0 } },
          detailFetching ? '正在补齐发布日期和详情数据…'
            : missingDetailCount > 0 ? '还有 ' + missingDetailCount + ' 篇已发布笔记缺发布日期或收藏/分享/评论数'
            : '发布日期和详情数据已补齐'),
        missingDetailCount > 0 ? h('button', { type: 'button', disabled: detailFetching || detailBusy || !detailGateAllows, className: 'xhs-btn primary mini', style: { marginLeft: 'auto' }, onClick: startDetails },
          detailFetching ? '正在补齐…' : '补齐发布日期和数据') : null),
      !detailGateAllows && missingDetailCount > 0 && !detailFetching
        ? h('p', { style: { margin: '6px 0 0', fontSize: 12, lineHeight: 1.6, color: 'var(--color-foreground-muted)' } }, '补读要借用主账号的登录态：统一登录门禁确认登录后这个按钮就能点。现在可以先去「账号管理」页确认登录态。') : null,
      detailMsg ? h('p', { style: { margin: '6px 0 0', fontSize: 13, color: 'var(--color-foreground-muted)' } }, detailMsg) : null,
      detailFetching ? h('div', { style: { marginTop: 8, fontSize: 14, color: 'var(--color-foreground-muted)' } },
        h('p', { style: { margin: 0 } }, primary.detailFetchMessage || '正在逐篇打开笔记详情页，读发布时间和收藏/分享/评论数，逐篇读会比较慢…'),
        primary.detailFetchTotal > 0 ? h('p', { style: { margin: '4px 0 0' } }, '已处理 ' + primary.detailFetchDone + ' / ' + primary.detailFetchTotal + ' 篇') : null,
        h('div', { className: 'xhs-progress thin', style: { marginTop: 8 } },
          detailProgressPct !== null ? h('i', { style: { width: Math.max(4, detailProgressPct) + '%' } }) : h('i', { className: 'slide' })))
        : primary.detailFetchStatus === 'failed' ? h('p', { style: { margin: '8px 0 0', fontSize: 14, color: 'var(--color-foreground-muted)' } },
          h('span', { style: { fontWeight: 500, color: 'var(--color-primary)' } }, '上次补读没完成。'),
          humanizeFailureText(primary.detailFetchMessage) || '点上方按钮再试一次。')
        : (primary.detailFetchStatus === 'done' && primary.detailFetchMessage) ? h('p', { style: { margin: '8px 0 0', fontSize: 14, color: 'var(--color-foreground-muted)' } }, humanizeFailureText(primary.detailFetchMessage)) : null) : null,
    h('div', { className: 'xhs-grid', style: { marginTop: 20, gridTemplateColumns: 'repeat(2,1fr)' } },
      statCards.map(([label, value]) => h('div', { key: label, className: 'xhs-card', style: { marginBottom: 0 } },
        h('p', { style: { margin: 0, fontSize: 12, fontWeight: 500, color: 'var(--color-foreground-muted)' } }, label),
        h('p', { style: { margin: '4px 0 0', fontSize: 30, fontWeight: 700, color: 'var(--color-foreground)' } }, value)))),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 20 } },
      h('div', { className: 'xhs-backend-seg', style: { borderRadius: 999 } },
        [['month', '月视图'], ['week', '周视图']].map(([key, label]) =>
          h('button', { key, type: 'button', onClick: () => setMode(key), className: mode === key ? 'active' : '', style: mode === key ? { background: 'var(--color-foreground)', color: 'var(--color-background)' } : {} }, label))),
      mode === 'month'
        ? h('span', { style: { marginLeft: 4, fontSize: 16, fontWeight: 600 } }, viewYear + ' 年 ' + (viewMonth + 1) + ' 月')
        : h('span', { style: { marginLeft: 4, fontSize: 16, fontWeight: 600 } },
          (weekDays[0] ? (weekDays[0].day.getMonth() + 1) + '月' + weekDays[0].day.getDate() + '日' : '') + ' – ' +
          (weekDays[6] ? (weekDays[6].day.getMonth() + 1) + '月' + weekDays[6].day.getDate() + '日' : '')),
      h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 8 } },
        mode === 'month'
          ? [h('button', { key: 'p', type: 'button', className: 'xhs-btn mini', onClick: () => shiftMonth(-1) }, '‹ 上月'),
             h('button', { key: 't', type: 'button', className: 'xhs-btn mini', onClick: () => { setViewYear(now.getFullYear()); setViewMonth(now.getMonth()); } }, '回到本月'),
             h('button', { key: 'n', type: 'button', className: 'xhs-btn mini', onClick: () => shiftMonth(1) }, '下月 ›')]
          : [h('button', { key: 'p', type: 'button', className: 'xhs-btn mini', onClick: () => shiftWeek(-1) }, '‹ 上周'),
             h('button', { key: 't', type: 'button', className: 'xhs-btn mini', onClick: () => setWeekAnchorKey(todayKey) }, '回到本周'),
             h('button', { key: 'n', type: 'button', className: 'xhs-btn mini', onClick: () => shiftWeek(1) }, '下周 ›')])),
    entries.length === 0
      ? h('div', { className: 'xhs-card', style: { marginTop: 16, textAlign: 'center', borderStyle: 'dashed', padding: 32 } },
        h('p', { style: { margin: 0 } }, '暂无已发布笔记。'),
        h('p', { style: { margin: '4px 0 0', fontSize: 14, color: 'var(--color-foreground-muted)' } }, '主账号还没有已发布的笔记记录：在「笔记制作」里发布草稿，或在「账号管理」里拉取主账号的真实笔记后，这里会按发布时间排进日历。'))
      : mode === 'month'
        ? h('div', { style: { marginTop: 16, overflow: 'hidden', borderRadius: 20, border: '1px solid var(--color-border)', background: 'var(--color-surface)', boxShadow: 'var(--card-shadow)' } },
          h('div', { className: 'xhs-cal-head' }, ['日', '一', '二', '三', '四', '五', '六'].map((w) => h('span', { key: w }, '周' + w))),
          h('div', { className: 'xhs-cal-grid' }, monthCells.map((key, i) => {
            if (key === null) return h('div', { key: 'empty-' + i, className: 'xhs-cal-cell empty' });
            const dayEntries = byDate.get(key) || [];
            const dayNum = Number(key.split('-')[2] || 0);
            return h('div', { key, className: 'xhs-cal-cell' + (key === todayKey ? ' today' : '') },
              h('span', { className: 'xhs-cal-day' + (key === todayKey ? ' today' : '') }, dayNum),
              dayEntries.slice(0, 2).map((e) => h('span', { key: e.note.id, className: 'xhs-cal-entry', title: e.note.title },
                h('span', { className: 't' }, e.note.title || '（无标题）'),
                h('span', { className: 'm' }, entryLine(e)))),
              dayEntries.length > 2 ? h('span', { style: { display: 'block', marginTop: 4, fontSize: 11, color: 'var(--color-foreground-muted)' } }, '共 ' + dayEntries.length + ' 篇') : null);
          })))
        : h('div', { className: 'xhs-cal-week', style: { marginTop: 16 } }, weekDays.map(({ key, day }) => {
          const dayEntries = byDate.get(key) || [];
          return h('div', { key, style: { borderRadius: 20, border: '1px solid var(--color-border)', padding: 12, background: key === todayKey ? 'var(--color-primary-soft)' : 'var(--color-surface)' } },
            h('p', { style: { margin: 0, fontSize: 14, fontWeight: 600, color: key === todayKey ? 'var(--color-primary)' : 'var(--color-foreground)' } },
              '周' + ['日', '一', '二', '三', '四', '五', '六'][day.getDay()] + ' · ' + (day.getMonth() + 1) + '月' + day.getDate() + '日'),
            dayEntries.length === 0
              ? h('p', { style: { margin: '8px 0 0', fontSize: 12, color: 'var(--color-foreground-muted)' } }, '暂无发布')
              : dayEntries.map((e) => h('div', { key: e.note.id, style: { marginTop: 8, borderTop: '1px solid var(--color-border)', paddingTop: 8 } },
                h('p', { style: { margin: 0, fontSize: 14, fontWeight: 500 } }, e.note.title || '（无标题）'),
                h('p', { style: { margin: '2px 0 0', fontSize: 12, color: 'var(--color-foreground-muted)' } }, entryLine(e)))));
        })),
    h('section', { className: 'xhs-card', style: { marginTop: 24 } },
      h('h3', { style: { fontSize: 16 } }, '按时间段查询'),
      h('form', {
        style: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8, marginTop: 12 },
        onSubmit: (e) => { e.preventDefault(); runRangeQuery(); },
      },
        h('label', { style: { fontSize: 14, color: 'var(--color-foreground-muted)' } }, '开始日期',
          h('input', { type: 'date', value: rangeStart, onChange: (e) => setRangeStart(e.target.value), className: 'xhs-input', style: { display: 'block', marginTop: 4, width: 'auto' } })),
        h('label', { style: { fontSize: 14, color: 'var(--color-foreground-muted)' } }, '结束日期',
          h('input', { type: 'date', value: rangeEnd, onChange: (e) => setRangeEnd(e.target.value), className: 'xhs-input', style: { display: 'block', marginTop: 4, width: 'auto' } })),
        h('button', { type: 'submit', className: 'xhs-btn primary' }, '查询这段时间')),
      rangeError ? h('p', { style: { margin: '8px 0 0', fontSize: 14, color: 'var(--color-primary)' } }, rangeError) : null,
      rangeResult !== null && (rangeResult.length === 0
        ? h('p', { style: { margin: '12px 0 0', fontSize: 14, color: 'var(--color-foreground-muted)' } }, '这段时间没有已发布的笔记。')
        : h('ul', { style: { margin: '12px 0 0', padding: 0, listStyle: 'none' } }, rangeResult.map((e) =>
          h('li', { key: e.note.id, style: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 12, borderRadius: 12, background: 'var(--color-surface-alt)', padding: '10px 12px', marginBottom: 8 } },
            h('span', { style: { fontSize: 14, fontWeight: 500 } }, e.date),
            h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14 } }, e.note.title || '（无标题）'),
            h('span', { style: { fontSize: 12, color: 'var(--color-foreground-muted)' } }, entryLine(e))))))),
    undatedCount > 0 ? h('p', { className: 'xhs-note-box', style: { marginTop: 16 } },
      '另有 ' + undatedCount + ' 篇已发布笔记的发布时间还没读到，没有放进日历格子，在下方「已发布归档」的「日期未知」一类里查看；点上方「补齐发布日期和数据」逐篇打开详情页补读后，读到的会自动归位进格子。') : null);
}

// ---------- 笔记库（草稿 / 已发布归档） ----------
// variant="drafts" 放在笔记制作页内（草稿可点开进编辑器）；
// variant="published" 放在发布日历页下（已发布只做展示，什么都不打开）。
function NotesView({ notes, assets, accounts, fetchedNotes, gate, onOpen, onNew, variant, onReload }) {
  const assetsById = useMemo(() => new Map((assets || []).map((a) => [a.id, a])), [assets]);
  const accountsById = useMemo(() => new Map((accounts || []).map((a) => [a.id, a])), [accounts]);
  const fetchedByKey = useMemo(() => {
    const m = new Map();
    for (const f of fetchedNotes || []) {
      if (f.url) m.set(f.accountId + '|url|' + f.url, f);
      m.set(f.accountId + '|title|' + f.title, f);
    }
    return m;
  }, [fetchedNotes]);
  const primaryAccount = (accounts || []).find((a) => a.monitored) || (accounts || [])[0];
  const shown = (notes || []).filter((n) => variant === 'drafts'
    ? n.status === 'draft'
    : n.status === 'published' && (!primaryAccount || n.accountId === null || n.accountId === primaryAccount.id));
  const noteDate = (n) => {
    if (n.publishedAt) return fmtDate(n.publishedAt);
    if (n.source !== 'fetched' || !n.accountId) return null;
    const f = fetchedByKey.get(n.accountId + '|url|' + n.sourceUrl) || fetchedByKey.get(n.accountId + '|title|' + n.title);
    if (!f) return null;
    return f.publishedAt ? fmtDate(f.publishedAt) : parsePublishedLabel(f.publishedLabel, f.fetchedAt);
  };
  const displayItems = (() => {
    if (variant !== 'published') return shown.map((note) => ({ kind: 'note', note }));
    const dated = shown.filter((n) => noteDate(n) !== null).sort((a, b) => (noteDate(b) || '').localeCompare(noteDate(a) || ''));
    const undated = shown.filter((n) => noteDate(n) === null);
    const items = [];
    if (dated.length > 0) {
      items.push({ kind: 'divider', key: 'dated', text: '已确认发布日期 · ' + dated.length + ' 篇' });
      for (const note of dated) items.push({ kind: 'note', note });
    }
    if (undated.length > 0) {
      items.push({ kind: 'divider', key: 'undated', text: '日期未知 · ' + undated.length + ' 篇 — 发布时间还没读到，不进日历格子；补读到后会自动归位' });
      for (const note of undated) items.push({ kind: 'note', note });
    }
    return items;
  })();

  const gateAllows = (accountId) => !!gate && gate.canFetch && gate.accountId === accountId;
  const imageTarget = (accounts || []).find((a) => gateAllows(a.id) && (fetchedNotes || []).some((f) => f.accountId === a.id))
    || (accounts || []).find((a) => (fetchedNotes || []).some((f) => f.accountId === a.id));
  const missingImageCount = imageTarget ? (fetchedNotes || []).filter((f) => f.accountId === imageTarget.id && (!f.images || f.images.length === 0)).length : 0;
  const imageFetching = imageTarget && imageTarget.imageFetchStatus === 'fetching';
  const [imgBusy, setImgBusy] = useState(false);
  const [imgMsg, setImgMsg] = useState('');
  const startImages = async () => {
    if (!imageTarget) return;
    setImgBusy(true); setImgMsg('');
    try {
      const res = await api('startbackfillnoteimages', { accountId: imageTarget.id });
      if (res && res.started === false) setImgMsg(res.message || '未能开始获取配图。');
      else setImgMsg(res && res.message ? res.message : '已开始获取配图，正在逐篇打开原笔记详情页…');
      if (onReload) await onReload();
    } catch (err) { setImgMsg('获取配图没能启动：' + (err && err.message ? err.message : String(err))); }
    finally { setImgBusy(false); }
  };
  const [refetchBusy, setRefetchBusy] = useState(false);
  const startRefetch = async (accountId) => {
    setRefetchBusy(true);
    try {
      await api('startfetchaccountnotes', { accountId });
      if (onReload) await onReload();
    } catch (e) { /* 失败时不弹错，卡片上的链接说明已写明恢复路径 */ }
    finally { setRefetchBusy(false); }
  };

  return h('div', null,
    h('div', { className: 'xhs-page-title-row' },
      h('h2', null, variant === 'drafts' ? '我的草稿' : '已发布归档'),
      h('span', { style: { fontSize: 14, color: 'var(--color-foreground-muted)' } }, '共 ' + shown.length + ' 篇'),
      variant === 'published' && imageTarget && (missingImageCount > 0 || imageFetching)
        ? h('button', { type: 'button', disabled: imageFetching || imgBusy || !gateAllows(imageTarget.id), className: 'xhs-btn mini', onClick: startImages },
          imageFetching ? '正在获取配图…' : '获取笔记配图（' + missingImageCount + ' 篇还没有）') : null,
      variant === 'drafts' ? h('button', { type: 'button', className: 'xhs-btn primary', style: { marginLeft: 'auto' }, onClick: onNew }, '+ 新建空白笔记') : null),
    variant === 'published' && imageTarget && imageTarget.imageFetchStatus && imageTarget.imageFetchStatus !== 'idle'
      ? h('div', { className: 'xhs-card', style: { marginTop: 12 } },
        imageFetching
          ? h('div', null,
            h('p', { style: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500, margin: 0 } }, h('span', { className: 'xhs-pulse-dot' }), '正在获取笔记配图…'),
            h('p', { style: { margin: '4px 0 0', fontSize: 14, color: 'var(--color-foreground-muted)' } }, imageTarget.imageFetchMessage || '正在逐篇打开原笔记的详情页读取配图，通常要几分钟，读到的图会自动出现在这里。'),
            h('div', { className: 'xhs-progress thin', style: { marginTop: 8 } }, h('i', { className: 'slide' })))
          : imageTarget.imageFetchStatus === 'failed'
            ? h('p', { style: { margin: 0, fontSize: 14, color: 'var(--color-foreground-muted)' } },
              h('span', { style: { fontWeight: 500, color: 'var(--color-primary)' } }, '配图获取没完成。'),
              imageTarget.imageFetchMessage || '点上方「获取笔记配图」再试一次。')
            : h('p', { style: { margin: 0, fontSize: 14, color: 'var(--color-foreground-muted)' } }, imageTarget.imageFetchMessage || ''))
      : null,
    imgMsg ? h('p', { style: { marginTop: 8, fontSize: 13, color: 'var(--color-foreground-muted)' } }, imgMsg) : null,
    shown.length === 0
      ? h('div', { className: 'xhs-card', style: { marginTop: 32, textAlign: 'center', borderStyle: 'dashed', padding: 32 } },
        h('p', { style: { margin: 0 } }, variant === 'drafts' ? '还没有草稿。' : '还没有已发布的笔记。'),
        h('p', { style: { margin: '4px 0 0', fontSize: 14, color: 'var(--color-foreground-muted)' } },
          variant === 'drafts' ? '在上方写下主题生成第一篇草稿，也可以先新建一篇空白笔记慢慢写。' : '在「笔记制作」里把草稿发布后，会归档到这里；从账号拉取回来的真实笔记也会同步到这里。'))
      : h('div', { className: 'xhs-archive-grid' }, displayItems.map((item) => {
        if (item.kind === 'divider') {
          return h('div', { key: item.key, className: 'xhs-divider-wrap' },
            h('div', { className: 'xhs-divider' }, h('span', null, item.text)));
        }
        const n = item.note;
        const firstId = n.imageIds && n.imageIds[0];
        const first = firstId !== undefined ? assetsById.get(firstId) : undefined;
        const account = n.accountId ? accountsById.get(n.accountId) : undefined;
        const fetched = n.source === 'fetched' && n.accountId
          ? (fetchedByKey.get(n.accountId + '|url|' + n.sourceUrl) || fetchedByKey.get(n.accountId + '|title|' + n.title))
          : undefined;
        const gallery = fetched && fetched.images && fetched.images.length > 0 ? imgUrls(fetched.images) : imgUrls(n.fetchedImages);
        const coverUrl = (first && assetUrl(first)) || gallery[0] || '';
        const mText = (v) => (v === null || v === undefined ? '—' : fmtCount(v));
        const date = noteDate(n);
        return h('div', { key: n.id, className: 'xhs-archive-card' },
          coverUrl
            ? h('img', { src: coverUrl, alt: n.title || '笔记配图', className: 'thumb', referrerPolicy: 'no-referrer' })
            : h('span', { className: 'thumb-ph' }, h(Icon, { d: ICONS.image, style: { width: 24, height: 24 } })),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('span', { className: 'xhs-badge-row' },
              h('span', { className: 'xhs-badge ' + (n.status === 'published' ? 'published' : 'draft') }, n.status === 'published' ? '已发布' : '草稿'),
              n.source === 'fetched' ? h('span', { className: 'xhs-badge blue' }, '真实笔记') : null,
              n.status === 'published' && !date ? h('span', { className: 'xhs-badge' }, '日期未知') : null,
              account ? h('span', { className: 'acct', title: account.nickname }, account.nickname) : null),
            n.status === 'published'
              ? h('span', { style: { display: 'block', marginTop: 6, width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left', fontSize: 14, fontWeight: 600 } }, n.title || '（无标题）')
              : h('button', { type: 'button', onClick: () => onOpen(n.id), style: { display: 'block', marginTop: 6, width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left', fontSize: 14, fontWeight: 600, background: 'none', border: 0, padding: 0, color: 'var(--color-foreground)' } }, n.title || '（无标题）'),
            h('span', { style: { display: 'block', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: 'var(--color-foreground-muted)' } }, n.body || '暂无正文'),
            n.source === 'fetched'
              ? h('span', { style: { display: 'block', marginTop: 4, fontSize: 12, color: 'var(--color-foreground-muted)' } },
                '赞 ' + mText(fetched ? fetched.likes : null) + ' · 藏 ' + mText(fetched ? fetched.collects : null) + ' · 分享 ' + mText(fetched ? fetched.shares : null) + ' · 评论 ' + mText(fetched ? fetched.comments : null) +
                (date ? ' · 发布日期：' + date : (fetched && fetched.publishedLabel ? ' · 发布：' + fetched.publishedLabel : '')))
              : h('span', { style: { display: 'block', marginTop: 4, fontSize: 12, color: 'var(--color-foreground-muted)' } },
                (n.imageIds ? n.imageIds.length : 0) + ' 张图 · 更新于 ' + fmtTime(n.updatedAt) +
                (n.latestMetrics ? ' · 赞 ' + fmtCount(n.latestMetrics.likes) + ' 藏 ' + fmtCount(n.latestMetrics.collects) : '')),
            gallery.length > 0 ? h('span', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 } },
              gallery.slice(0, 4).map((u, i) => h('img', { key: u + '-' + i, src: u, alt: (n.title || '笔记') + ' 配图 ' + (i + 1), style: { width: 36, height: 36, borderRadius: 6, objectFit: 'cover' }, referrerPolicy: 'no-referrer' })),
              h('span', { style: { fontSize: 12, color: 'var(--color-foreground-muted)' } }, '共 ' + gallery.length + ' 张配图')) : null,
            n.source === 'fetched' && gallery.length === 0 ? h('span', { style: { display: 'block', marginTop: 4, fontSize: 12, color: 'var(--color-foreground-muted)' } }, '配图还没读回来，点上方「获取笔记配图」就能补上。') : null,
            n.source === 'fetched' && n.sourceUrl ? h(XhsNoteLink, {
              url: n.sourceUrl, label: '在小红书打开原笔记 ↗', className: 'xhs-link',
              homepageUrl: account && account.homepage ? account.homepage : undefined,
              onRefetch: n.accountId !== null && n.accountId !== undefined ? () => startRefetch(n.accountId) : undefined,
              refetchDisabled: (account && account.fetchStatus === 'fetching') || refetchBusy,
            }) : null));
      })));
}

// ---------- 笔记制作 ----------
// 风格固定三档（种草/评测/探店，默认种草）；参考附图初始为空；
// 手填路径只取文件名作参考，选文件/选文件夹读进来的图与上传同管线、真正附到草稿；
// AI 生图三后端（Muse/DSH/API），默认后端取账号管理的 preferredBackend。
function GenerateView({ assets, accounts, defaultAccountId, onGenerated, prefill, onGoAccountSettings, onReload }) {
  const [topic, setTopic] = useState('');
  const [keywords, setKeywords] = useState('');
  const [style, setStyle] = useState('种草');
  const [accountId, setAccountId] = useState(defaultAccountId ? String(defaultAccountId) : '');
  const [refs, setRefs] = useState([]);
  const [pathInput, setPathInput] = useState('');
  const [picking, setPicking] = useState(false);
  const [pickNote, setPickNote] = useState('');
  const fileInputRef = useRef(null);
  const dirInputRef = useRef(null);
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [completed, setCompleted] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [imgPrompt, setImgPrompt] = useState('');
  const [imgBackend, setImgBackend] = useState('muse');
  const [imgNote, setImgNote] = useState('');
  const [imgNeedsKey, setImgNeedsKey] = useState(false);
  const [imgBusy, setImgBusy] = useState(false);
  const [imgGenSettings, setImgGenSettings] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => {
    let alive = true;
    apiSafe('getimagegensettings', {}).then((res) => { if (alive && res) setImgGenSettings(res); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (imgGenSettings && imgGenSettings.preferredBackend) setImgBackend(imgGenSettings.preferredBackend);
  }, [imgGenSettings]);
  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);
  useEffect(() => {
    if (!prefill) return;
    setTopic(prefill.topic);
    setKeywords(prefill.keywords);
  }, [prefill && prefill.nonce]);
  useEffect(() => {
    if (!generating) return;
    setElapsed(0);
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(t);
  }, [generating]);

  const progressPct = completed ? 100 : Math.min(92, Math.round(92 * (1 - Math.exp(-elapsed / 9))));
  const stage = completed ? GEN_STAGES.length : stageForElapsed(elapsed);
  const assetsById = useMemo(() => new Map((assets || []).map((a) => [a.id, a])), [assets]);

  const addPaths = () => {
    const lines = pathInput.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return;
    setRefs((prev) => {
      const next = prev.slice();
      for (const path of lines) {
        if (next.length >= 9) break;
        if (next.some((r) => r.kind === 'path' && r.path === path)) continue;
        next.push({ kind: 'path', path, name: fileNameOf(path) });
      }
      return next;
    });
    setPathInput('');
  };
  const removeRef = (index) => setRefs((prev) => prev.filter((_, i) => i !== index));

  const handlePickedFiles = async (files) => {
    if (!files || files.length === 0) return;
    const images = Array.from(files).filter((f) => f.type && f.type.startsWith('image/'));
    if (images.length === 0) { setPickNote('没有选到图片文件。'); return; }
    images.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    setPicking(true); setPickNote('');
    let done = 0; let failed = 0;
    for (const f of images) {
      if (refs.length + done >= 9) break;
      try {
        const dataUrl = await compressImageFile(f);
        const base64 = dataUrl.includes(',') ? dataUrl.split(',').slice(1).join(',') : dataUrl;
        const relPath = f.webkitRelativePath || f.name;
        const folderLabel = relPath.includes('/') ? (relPath.split('/')[0] || '') : '';
        const res = await api('importasset', { name: f.name, relativePath: relPath, folderLabel, mimeType: 'image/jpeg', dataBase64: base64 });
        const id = res && res.id !== undefined ? res.id : (res && res.asset && res.asset.id);
        setRefs((prev) => prev.length >= 9 || prev.some((r) => r.kind === 'asset' && r.id === id)
          ? prev : prev.concat([{ kind: 'asset', id, name: f.name, dataUrl }]));
        done += 1;
      } catch (e) { failed += 1; }
      setPickNote('正在添加 ' + (done + failed) + '/' + images.length + '…');
    }
    setPicking(false);
    setPickNote(failed > 0 ? '已添加 ' + done + ' 张，' + failed + ' 张添加失败。' : '');
    if (onReload) await onReload();
  };

  const genImage = async () => {
    if (!imgPrompt.trim() || imgBusy) return;
    setImgBusy(true); setImgNote(''); setImgNeedsKey(false);
    try {
      const res = await api('generateimage', { prompt: imgPrompt.trim(), backend: imgBackend });
      if (res && res.ok && res.assetId !== null && res.assetId !== undefined) {
        setImgNote(res.message || '图片已生成并加到参考附图里。');
        setRefs((prev) => prev.length >= 9 || prev.some((r) => r.kind === 'asset' && r.id === res.assetId)
          ? prev : prev.concat([{ kind: 'asset', id: res.assetId, name: 'AI 生成的配图' }]));
        if (onReload) await onReload();
      } else {
        setImgNeedsKey(res && res.reason === 'no_key');
        setImgNote((res && res.message) || '生图失败。');
      }
    } catch (err) {
      setImgNote('生图失败：' + (err && err.message ? err.message : String(err)));
    } finally { setImgBusy(false); }
  };

  const submit = async () => {
    if (!topic.trim() || generating) return;
    setError(''); setGenerating(true); setCompleted(false); setElapsed(0);
    try {
      const res = await api('generatenote', {
        topic: topic.trim(), keywords: keywords.trim(), style,
        accountId: accountId ? Number(accountId) : ((accounts || [])[0] ? (accounts || [])[0].id : null),
        images: refs.map((r) => r.kind === 'asset' ? { assetId: r.id, path: '' } : { assetId: null, path: r.path }),
      });
      if (res && res.ok === false) throw new Error(res.message || '生成失败');
      const note = (res && res.note) || res;
      setCompleted(true);
      const id = note && (note.id || note.noteId);
      setTimeout(() => { setGenerating(false); if (id && onGenerated) onGenerated(id); }, 700);
    } catch (err) {
      setGenerating(false);
      setError('生成失败：' + (err && err.message ? err.message : String(err)));
    }
  };

  const account = (accounts || []).find((a) => String(a.id) === String(accountId)) || (accounts || [])[0];
  const previewUrls = refs.map((r) => {
    if (r.kind === 'asset') {
      if (r.dataUrl) return r.dataUrl;
      const a = assetsById.get(r.id);
      return a ? assetUrl(a) : '';
    }
    return '';
  }).filter(Boolean);
  const apiKeySet = imgGenSettings ? !!imgGenSettings.apiKeySet : false;

  return h('div', { className: 'xhs-gen-wrap' },
    h('div', null,
      h('h2', null, '生成图文笔记'),
      h('p', { className: 'xhs-sub' }, '写下主题，一篇带标题、正文和话题的草稿就出来了；参考附图由你自己指定（选文件夹读取、直接上传、AI 生图或填文件路径），不加也能生成。'),
      h('div', { className: 'xhs-field', style: { marginTop: 24 } },
        h('label', null, '笔记主题 ', h('i', null, '*')),
        h('input', { className: 'xhs-input', value: topic, disabled: generating, onChange: (e) => setTopic(e.target.value), placeholder: '比如：秋冬通勤穿搭 / 新手化妆避坑 / 周末探店' })),
      h('div', { className: 'xhs-field' },
        h('label', null, '关键词 / 想强调的要点'),
        h('textarea', { className: 'xhs-textarea', rows: 3, value: keywords, disabled: generating, onChange: (e) => setKeywords(e.target.value), placeholder: '比如：显瘦、平价、适合小个子、步骤要详细……没有可留空' })),
      h('div', { className: 'xhs-field' },
        h('p', { style: { margin: '0 0 6px', fontSize: 14, fontWeight: 600 } }, '笔记风格'),
        h('div', { className: 'xhs-style-grid' }, STYLE_OPTIONS.map((s) =>
          h('button', { key: s.value, type: 'button', disabled: generating, onClick: () => setStyle(s.value), className: 'xhs-style-btn' + (style === s.value ? ' active' : '') },
            h('span', { className: 'v' }, s.value),
            h('span', { className: 'hint' }, s.hint))))),
      h('div', { className: 'xhs-field', style: { maxWidth: 360 } },
        h('label', null, '发布账号'),
        h('select', { className: 'xhs-select', value: accountId, disabled: generating, onChange: (e) => setAccountId(e.target.value) },
          h('option', { value: '' }, '暂不指定'),
          (accounts || []).map((a) => h('option', { key: a.id, value: a.id }, a.nickname)))),
      h('div', { style: { marginTop: 24 } },
        h('p', { style: { margin: 0, fontSize: 14, fontWeight: 600 } }, '参考附图 ',
          h('span', { style: { fontWeight: 400, color: 'var(--color-foreground-muted)' } }, '（可选，最多 9 张；添加顺序就是笔记里的图片顺序；已添加 ' + refs.length + ' 张）')),
        h('p', { style: { margin: '4px 0 0', fontSize: 14, lineHeight: 1.6, color: 'var(--color-foreground-muted)' } }, '这里不会预先摆出任何图片，参考图由你自己指定：选一个本地文件夹把里面的图片读进来，或者直接上传图片文件，也可以把图片文件的路径填进来。文件夹里的图和直接上传的图会真正附到草稿上，两种来源可以混排。'),
        h('label', { style: { display: 'block', marginTop: 12, fontSize: 14, fontWeight: 600 } }, '图片文件路径'),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 } },
          h('input', { className: 'xhs-input', style: { flex: 1, minWidth: 200 }, value: pathInput, disabled: generating || refs.length >= 9, onChange: (e) => setPathInput(e.target.value), placeholder: '比如：D:\\小红书素材\\穿搭1.jpg（可粘贴多行，一行一个路径）' }),
          h('button', { type: 'button', className: 'xhs-btn dark', disabled: generating || refs.length >= 9 || !pathInput.trim(), onClick: addPaths }, '添加参考图')),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginTop: 12 } },
          h('input', { ref: fileInputRef, type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' }, onChange: (e) => { handlePickedFiles(e.target.files); e.target.value = ''; } }),
          h('button', { type: 'button', className: 'xhs-btn', disabled: generating || picking || refs.length >= 9, onClick: () => fileInputRef.current && fileInputRef.current.click() },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } }, h(Icon, { d: ICONS.folder, style: { width: 16, height: 16 } }), picking ? '添加中…' : '从设备选择图片文件')),
          h('input', { ref: (el) => { dirInputRef.current = el; if (el) { el.setAttribute('webkitdirectory', ''); el.setAttribute('directory', ''); } }, type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' }, onChange: (e) => { handlePickedFiles(e.target.files); e.target.value = ''; } }),
          h('button', { type: 'button', className: 'xhs-btn', disabled: generating || picking || refs.length >= 9, onClick: () => dirInputRef.current && dirInputRef.current.click() },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } }, h(Icon, { d: ICONS.folder, style: { width: 16, height: 16 } }), '选择文件夹读取图片')),
          pickNote ? h('span', { style: { fontSize: 14, color: 'var(--color-foreground-muted)' } }, pickNote) : null),
        h('p', { className: 'xhs-hint' }, '浏览器读不到手填路径里的图片文件，所以只填路径时按文件名作参考；选文件夹读进来的图和直接上传的图会真正附到生成的草稿上。文件夹里图片超过剩余额度时，按文件名顺序取前面的。'),
        refs.length > 0 ? h('ul', { style: { margin: '12px 0 0', padding: 0, listStyle: 'none' } }, refs.map((r, i) => {
          const asset = r.kind === 'asset' ? assetsById.get(r.id) : undefined;
          const thumb = r.kind === 'asset' ? (r.dataUrl || (asset ? assetUrl(asset) : '')) : '';
          return h('li', { key: r.kind === 'asset' ? 'a-' + r.id : 'p-' + r.path, className: 'xhs-img-row' },
            h('span', { style: { display: 'flex', width: 24, height: 24, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: '50%', background: 'var(--color-primary)', color: '#fff', fontSize: 12, fontWeight: 700 } }, i + 1),
            thumb ? h('img', { src: thumb, alt: r.name }) : h('span', { style: { display: 'flex', width: 40, height: 40, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'var(--color-surface-alt)' } }, h(Icon, { d: ICONS.image, style: { width: 20, height: 20, color: 'var(--color-foreground-muted)' } })),
            h('span', { className: 'grow' },
              h('span', { style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, fontWeight: 500 } }, r.name),
              h('span', { style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: 'var(--color-foreground-muted)' } },
                r.kind === 'asset'
                  ? (asset && asset.folderLabel === 'AI 生图' ? 'AI 生成的图片，会附到草稿上'
                    : asset && asset.folderLabel ? '从文件夹「' + asset.folderLabel + '」读取，会附到草稿上' : '从设备选择的文件，会附到草稿上')
                  : r.path)),
            h('button', { type: 'button', className: 'xhs-btn mini', disabled: generating, onClick: () => removeRef(i) }, '移除'));
        })) : null),
      h('div', { className: 'xhs-card', style: { marginTop: 24 } },
        h('p', { style: { margin: 0, fontSize: 14, fontWeight: 600 } }, 'AI 生图'),
        h('p', { style: { margin: '4px 0 0', fontSize: 14, lineHeight: 1.6, color: 'var(--color-foreground-muted)' } }, '写一句画面描述生成一张配图，生成后会自动加到上面的参考附图里、跟着草稿一起保存。生图后端三选一：Muse 用当前平台生成；DSH 在 DSH 工作台里用；API 走 OpenAI 兼容接口，用的 Key 在「账号管理」里填。'),
        h('label', { style: { display: 'block', marginTop: 12, fontSize: 14, fontWeight: 600 } }, '画面描述'),
        h('input', { className: 'xhs-input', style: { marginTop: 6 }, value: imgPrompt, disabled: imgBusy, onChange: (e) => setImgPrompt(e.target.value), placeholder: '比如：秋日午后咖啡馆靠窗座位，桌上一杯拿铁和一本书，暖色调' }),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginTop: 12 } },
          h('div', { className: 'xhs-backend-seg' }, IMAGE_BACKENDS.map((b) =>
            h('button', { key: b.value, type: 'button', disabled: imgBusy, onClick: () => setImgBackend(b.value), className: imgBackend === b.value ? 'active' : '' }, b.label))),
          h('button', { type: 'button', className: 'xhs-btn dark', disabled: !imgPrompt.trim() || imgBusy || refs.length >= 9, onClick: genImage }, imgBusy ? '生成中…' : '生成图片'),
          refs.length >= 9 ? h('span', { style: { fontSize: 14, color: 'var(--color-foreground-muted)' } }, '参考附图已满 9 张，先移除一张再生成。') : null),
        imgBackend === 'api' && !apiKeySet ? h('p', { style: { margin: '8px 0 0', fontSize: 14, color: 'var(--color-foreground-muted)' } }, 'API 后端还没有填 Key：先去「账号管理」的「生图 API」里填接口地址和 Key，不然生成不了。') : null,
        imgNote ? h('p', { style: { margin: '8px 0 0', fontSize: 14, lineHeight: 1.6 } }, imgNote) : null,
        imgNeedsKey ? h('button', { type: 'button', className: 'xhs-btn primary', style: { marginTop: 8 }, onClick: onGoAccountSettings }, '去账号管理填写 API Key') : null),
      error ? h('p', { style: { marginTop: 16, fontSize: 14, color: 'var(--color-primary)' } }, error) : null,
      h('button', { type: 'button', className: 'xhs-btn primary', disabled: !topic.trim() || generating, onClick: submit, style: { marginTop: 24, width: '100%', padding: '12px 24px', fontSize: 16 } },
        h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'center' } },
          h(Icon, { d: ICONS.sparkles, style: { width: 20, height: 20 } }),
          completed ? '生成完成 ✓' : generating ? '正在生成草稿…' : '生成笔记草稿')),
      (generating || completed) ? h('div', { className: 'xhs-card', style: { marginTop: 16 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
          h('p', { style: { margin: 0, fontSize: 14, fontWeight: 500 } }, completed ? '草稿已生成，正在打开编辑器…' : GEN_STAGES[Math.min(stage, GEN_STAGES.length - 1)]),
          h('span', { style: { marginLeft: 'auto', fontSize: 14, color: 'var(--color-foreground-muted)' } }, progressPct + '% · 已用 ' + elapsed + ' 秒')),
        h('div', { className: 'xhs-progress', style: { marginTop: 10 } }, h('i', { style: { width: progressPct + '%' } })),
        h('ol', { style: { margin: '12px 0 0', padding: 0, listStyle: 'none' } }, GEN_STAGES.map((label, i) => {
          const doneStep = completed || i < stage;
          const activeStep = !completed && i === stage;
          return h('li', { key: label, className: 'xhs-stage ' + (doneStep ? 'done' : activeStep ? 'now' : '') },
            h('span', { className: 'dot' }, doneStep ? '✓' : activeStep ? '…' : i + 1),
            h('span', null, label),
            activeStep ? h('span', { style: { fontSize: 12, color: 'var(--color-foreground-muted)' } }, '进行中') : null);
        })),
        !completed ? h('p', { style: { margin: '10px 0 0', fontSize: 12, color: 'var(--color-foreground-muted)' } }, '生成一般要十几秒，写正文这步最花时间；进度条是按阶段估算的，草稿回来后会自动打开编辑器，期间别关页面。') : null) : null),
    h('div', { style: { position: 'sticky', top: 24, alignSelf: 'start' } },
      h('p', { style: { marginBottom: 12, fontSize: 14, fontWeight: 500, color: 'var(--color-foreground-muted)' } }, '发布预览 · 按发布后的笔记详情页展示，只是预览，不会发布'),
      h(NotePreview, {
        title: topic, body: '', tags: [],
        dateLine: (new Date().getMonth() + 1) + '-' + String(new Date().getDate()).padStart(2, '0') + ' · 发布预览',
        imageUrls: previewUrls, captions: previewUrls.map(() => ''),
        accountName: account ? account.nickname : '', accountAvatarUrl: account ? account.avatarUrl : null,
      })));
}

// ---------- 编辑器（只开草稿） ----------
function EditorView({ note, assets, accounts, gate, onBack, onReload }) {
  const [title, setTitle] = useState(note.title || '');
  const [body, setBody] = useState(note.body || '');
  const [tagsText, setTagsText] = useState((note.tags || []).join(' '));
  const [imageIds, setImageIds] = useState(note.imageIds || []);
  const [captions, setCaptions] = useState(note.imageCaptions || []);
  const [accountId, setAccountId] = useState(note.accountId ? String(note.accountId) : '');
  const [showPublish, setShowPublish] = useState(false);
  const [copied, setCopied] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sharedPublishNote, setSharedPublishNote] = useState('');

  const assetsById = useMemo(() => new Map((assets || []).map((a) => [a.id, a])), [assets]);
  const tags = tagsText.split(/[\s,，、]+/).map((t) => t.replace(/^#/, '')).filter(Boolean);
  const accountName = (accounts || []).find((a) => String(a.id) === accountId) ? (accounts || []).find((a) => String(a.id) === accountId).nickname : '';
  const imageUrls = imageIds.map((id) => { const a = assetsById.get(id); return a ? assetUrl(a) : ''; }).filter(Boolean);
  const previewUrls = imageUrls.length > 0 ? imageUrls : imgUrls(note.fetchedImages);
  const previewCaptions = imageUrls.length > 0 ? captions : imgUrls(note.fetchedImages).map(() => '');
  const publishText = title + '\n\n' + body + '\n\n' + tags.map((t) => '#' + t).join(' ');

  const save = async (silent) => {
    setError(''); setSavedMsg('');
    try {
      await api('updatenote', {
        id: note.id, accountId: accountId ? Number(accountId) : null, title: title.trim(), body,
        tags, imageIds, imageCaptions: captions,
      });
      if (!silent) setSavedMsg('已保存');
      if (onReload) await onReload();
      setTimeout(() => setSavedMsg(''), 2000);
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
      const ok = await save(true);
      if (!ok) return;
      await api('publishnote', { id: note.id });
      if (onReload) await onReload();
      onBack();
    } catch (err) { setError('发布失败：' + (err && err.message ? err.message : String(err))); }
    finally { setBusy(false); }
  };
  const requestSharedPublish = async () => {
    setSharedPublishNote('');
    try {
      const res = await api('requestviasharedsession', { kind: 'publish_note', noteId: note.id, accountId: note.accountId || null, monitoredAccountId: null });
      setSharedPublishNote((res && res.message) || '已登记到共用会话请求清单。');
      if (onReload) await onReload();
    } catch (err) { setSharedPublishNote('登记没有成功：' + (err && err.message ? err.message : String(err)) + '。可以稍后再试一次。'); }
  };
  const unpublish = async () => {
    try { await api('unpublishnote', { id: note.id }); setShowPublish(false); if (onReload) await onReload(); }
    catch (err) { setError('撤回失败：' + (err && err.message ? err.message : String(err))); }
  };
  const remove = async () => {
    try { await api('deletenote', { id: note.id }); if (onReload) await onReload(); onBack(); }
    catch (err) { setError('删除失败：' + (err && err.message ? err.message : String(err))); }
  };
  const moveImage = (index, dir) => {
    const target = index + dir;
    if (target < 0 || target >= imageIds.length) return;
    const nextIds = imageIds.slice(); const nextCaps = captions.slice();
    const idv = nextIds.splice(index, 1)[0]; const capv = nextCaps.splice(index, 1)[0];
    nextIds.splice(target, 0, idv); nextCaps.splice(target, 0, capv || '');
    setImageIds(nextIds); setCaptions(nextCaps);
  };
  const removeImage = (index) => {
    setImageIds((prev) => prev.filter((_, i) => i !== index));
    setCaptions((prev) => prev.filter((_, i) => i !== index));
  };
  const addImage = (id) => {
    if (imageIds.includes(id) || imageIds.length >= 18) return;
    setImageIds((prev) => prev.concat([id]));
    setCaptions((prev) => prev.concat(['']));
  };

  return h('div', null,
    h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 } },
      h('button', { type: 'button', className: 'xhs-btn', onClick: onBack }, '← 返回'),
      h('span', { style: { borderRadius: 999, padding: '4px 12px', fontSize: 12, fontWeight: 500, background: note.status === 'published' ? 'var(--color-primary)' : 'var(--color-surface-alt)', color: note.status === 'published' ? '#fff' : 'var(--color-foreground-muted)' } },
        note.status === 'published' ? '已发布 · ' + (note.publishedAt ? fmtDate(note.publishedAt) : '') : '草稿'),
      note.topic ? h('span', { style: { fontSize: 14, color: 'var(--color-foreground-muted)' } }, '主题：' + note.topic) : null,
      note.source === 'fetched' && note.sourceUrl
        ? h(XhsNoteLink, { url: note.sourceUrl, label: '真实笔记 · 在小红书打开 →', className: 'xhs-link', homepageUrl: ((accounts || []).find((a) => a.id === note.accountId) || {}).homepage || undefined })
        : note.source === 'fetched' ? h('span', { style: { fontSize: 14, color: 'var(--color-foreground-muted)' } }, '真实笔记（从账号主页获取）') : null,
      h('span', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 } },
        savedMsg ? h('span', { style: { fontSize: 14, color: 'var(--color-success)' } }, savedMsg) : null,
        h('button', { type: 'button', className: 'xhs-btn', disabled: busy, onClick: () => save(false) }, '保存'),
        h('button', { type: 'button', className: 'xhs-btn primary', onClick: () => setShowPublish(true) }, note.status === 'published' ? '发布包' : '发布'))),
    error ? h('div', { className: 'xhs-error', style: { marginTop: 12 } }, error) : null,
    h('div', { className: 'xhs-editor', style: { marginTop: 24 } },
      h('div', null,
        h('div', { className: 'xhs-field' },
          h('label', null, '标题（' + title.length + '/100）'),
          h('input', { className: 'xhs-input', value: title, onChange: (e) => setTitle(e.target.value), maxLength: 100 })),
        h('div', { className: 'xhs-field' },
          h('label', null, '正文（' + body.length + '/5000）'),
          h('textarea', { className: 'xhs-textarea', style: { minHeight: 260 }, value: body, onChange: (e) => setBody(e.target.value), maxLength: 5000 })),
        h('div', { className: 'xhs-field' },
          h('label', null, '话题标签（空格分隔，不用带 #）'),
          h('input', { className: 'xhs-input', value: tagsText, onChange: (e) => setTagsText(e.target.value), placeholder: '秋冬穿搭 通勤穿搭' })),
        h('div', { className: 'xhs-field' },
          h('label', null, '发布账号'),
          h('select', { className: 'xhs-select', style: { maxWidth: 320 }, value: accountId, onChange: (e) => setAccountId(e.target.value) },
            h('option', { value: '' }, '暂不指定'),
            (accounts || []).map((a) => h('option', { key: a.id, value: a.id }, a.nickname)))),
        note.source === 'fetched' ? h('div', { style: { marginTop: 24 } },
          h('p', { style: { margin: 0, fontSize: 14, fontWeight: 600 } }, '原笔记配图' + (note.fetchedImages && note.fetchedImages.length > 0 ? '（共 ' + imgUrls(note.fetchedImages).length + ' 张，从小红书原笔记读回）' : '')),
          imgUrls(note.fetchedImages).length > 0
            ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginTop: 8 } },
              imgUrls(note.fetchedImages).map((u, i) => h('img', { key: u + '-' + i, src: u, alt: (note.title || '笔记') + ' 配图 ' + (i + 1), style: { aspectRatio: '1/1', width: '100%', borderRadius: 12, objectFit: 'cover' }, referrerPolicy: 'no-referrer' })))
            : h('p', { style: { marginTop: 8, fontSize: 14, color: 'var(--color-foreground-muted)' } }, '这篇真实笔记的配图还没读回来。回「发布日历」页的已发布归档点「获取笔记配图」，工作台会逐篇打开原笔记把配图读回来显示在这里。')) : null,
        h('div', { style: { marginTop: 24 } },
          h('p', { style: { margin: 0, fontSize: 14, fontWeight: 600 } }, '配图（顺序即笔记图片顺序，可写配图说明）'),
          imageIds.length === 0 ? h('p', { style: { marginTop: 8, fontSize: 14, color: 'var(--color-foreground-muted)' } }, '这篇笔记还没有配图，从下方素材库添加。') : null,
          h('div', { style: { marginTop: 8 } }, imageIds.map((id, i) => {
            const asset = assetsById.get(id);
            return h('div', { key: id + '-' + i, className: 'xhs-img-row' },
              asset && assetUrl(asset) ? h('img', { src: assetUrl(asset), alt: asset.name }) : h('span', { style: { display: 'flex', width: 56, height: 56, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 6, background: 'var(--color-surface-alt)', fontSize: 12, color: 'var(--color-foreground-muted)' } }, '图已删'),
              h('div', { className: 'grow' },
                h('p', { style: { margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: 'var(--color-foreground-muted)' } }, '第 ' + (i + 1) + ' 张 · ' + (asset ? asset.name : '素材已删除')),
                h('input', { value: captions[i] || '', placeholder: '配图说明（可选）', onChange: (e) => setCaptions((prev) => prev.map((c, ci) => (ci === i ? e.target.value : c))) })),
              h('span', { style: { display: 'flex', flexShrink: 0, flexDirection: 'column', gap: 4 } },
                h('button', { type: 'button', className: 'xhs-btn mini', disabled: i === 0, onClick: () => moveImage(i, -1) }, '↑'),
                h('button', { type: 'button', className: 'xhs-btn mini', disabled: i === imageIds.length - 1, onClick: () => moveImage(i, 1) }, '↓')),
              h('button', { type: 'button', className: 'xhs-btn mini', onClick: () => removeImage(i) }, '移除'));
          })),
          (assets || []).some((a) => !imageIds.includes(a.id)) ? h('div', null,
            h('p', { style: { margin: '16px 0 0', fontSize: 14, fontWeight: 600 } }, '从素材库添加'),
            h('div', { className: 'xhs-asset-grid', style: { marginTop: 8 } }, (assets || []).filter((a) => !imageIds.includes(a.id)).map((a) =>
              h('button', { key: a.id, type: 'button', className: 'xhs-asset-btn', onClick: () => addImage(a.id) },
                assetUrl(a) ? h('img', { src: assetUrl(a), alt: a.name }) : h('span', { style: { display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--color-foreground-muted)' } }, a.name),
                h('span', { className: 'plus' }, '+'))))) : null),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 12, borderTop: '1px solid var(--color-border)', paddingTop: 16, marginTop: 32 } },
          confirmDelete
            ? h('span', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', { style: { fontSize: 14 } }, '连同数据记录一起删除？'),
              h('button', { type: 'button', className: 'xhs-btn primary', onClick: remove }, '确认删除'),
              h('button', { type: 'button', className: 'xhs-btn', onClick: () => setConfirmDelete(false) }, '取消'))
            : h('button', { type: 'button', className: 'xhs-btn', style: { color: 'var(--color-primary)' }, onClick: () => setConfirmDelete(true) }, '删除这篇笔记'),
          note.status === 'published' ? h('button', { type: 'button', className: 'xhs-btn', onClick: unpublish }, '撤回为草稿') : null)),
      h('div', { style: { position: 'sticky', top: 24, alignSelf: 'start' } },
        h('p', { style: { marginBottom: 12, fontSize: 14, fontWeight: 500, color: 'var(--color-foreground-muted)' } }, '发布预览 · 按发布后的笔记详情页展示，只是预览，不会发布'),
        h(NotePreview, {
          title, body, tags,
          dateLine: (new Date().getMonth() + 1) + '-' + String(new Date().getDate()).padStart(2, '0') + ' · 发布预览',
          imageUrls: previewUrls, captions: previewCaptions,
          accountName, accountAvatarUrl: ((accounts || []).find((a) => String(a.id) === accountId) || {}).avatarUrl || null,
        }))),
    showPublish ? h('div', { className: 'xhs-dialog-overlay' },
      h('div', { className: 'xhs-dialog' },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 12 } },
          h('h3', { style: { fontSize: 18 } }, note.status === 'published' ? '发布包' : '发布这篇笔记'),
          h('button', { type: 'button', className: 'xhs-btn mini', style: { marginLeft: 'auto' }, onClick: () => setShowPublish(false) }, '✕')),
        h('p', { style: { marginTop: 8, fontSize: 14, lineHeight: 1.6, color: 'var(--color-foreground-muted)' } },
          '原型版没有小红书官方发布接口：点发布后，这篇笔记会在工作台里标记为已发布，并生成发布包——复制全文、下载图片后，去小红书 App 粘贴发布即可；发布后回到工作台，这篇笔记会出现在「发布日历」里。'),
        note.status !== 'published'
          ? h('div', null,
            h('button', { type: 'button', className: 'xhs-btn primary', disabled: busy || !title.trim(), onClick: publish, style: { marginTop: 16, width: '100%', padding: '12px 24px', fontSize: 16 } }, busy ? '发布中…' : '确认发布'),
            gate && gate.isLoggedIn
              ? h('div', { style: { marginTop: 12, borderRadius: 12, background: 'var(--color-surface-alt)', padding: '12px 14px' } },
                h('p', { style: { margin: 0, fontSize: 14, lineHeight: 1.6 } }, '也可以让 Muse 在已登录的浏览器里直接发布到小红书（共用会话）：Muse 会在创作中心上传配图、填好标题正文和话题并提交；平台发布成功后，这篇笔记才会变成已发布。'),
                h('button', { type: 'button', className: 'xhs-btn', disabled: busy || !title.trim(), onClick: requestSharedPublish, style: { marginTop: 8, width: '100%', padding: '10px 24px' } }, '请 Muse 在共用会话里发布到小红书'),
                sharedPublishNote ? h('p', { style: { margin: '8px 0 0', fontSize: 12, lineHeight: 1.6, color: 'var(--color-foreground-muted)' } }, sharedPublishNote) : null)
              : h('p', { style: { marginTop: 12, fontSize: 12, lineHeight: 1.6, color: 'var(--color-foreground-muted)' } },
                '想让 Muse 直接在已登录的浏览器里发布到小红书，需要先登录（当前统一门禁：' + (gate && gate.verdict === 'logged_out' ? '未登录' : '无法确定') + '）——去「账号管理」扫码登录或在 Muse 聊天里登录共用会话后再回来。'))
          : h('div', { style: { marginTop: 16 } },
            h('div', { style: { borderRadius: 12, background: 'var(--color-primary-soft)', padding: '10px 14px', fontSize: 14 } }, '已在工作台标记为已发布（' + (note.publishedAt ? fmtTime(note.publishedAt) : '') + '）'),
            h('button', { type: 'button', className: 'xhs-btn primary', style: { marginTop: 12, width: '100%', padding: '12px 24px', fontSize: 16 }, onClick: async () => { setCopied(await copyText(publishText)); } },
              copied ? '已复制，去小红书粘贴吧' : '复制标题 + 正文 + 话题'),
            h('button', { type: 'button', className: 'xhs-btn', style: { marginTop: 8, width: '100%', padding: '12px 24px' }, onClick: () => downloadTextFile((title || '小红书笔记') + '.txt', publishText) }, '下载文案 .txt'),
            imageIds.length > 0 ? h('div', { style: { marginTop: 12 } },
              h('p', { style: { margin: 0, fontSize: 14, fontWeight: 600 } }, '按顺序下载配图'),
              h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 } }, imageIds.map((id, i) => {
                const asset = assetsById.get(id);
                if (!asset || !assetUrl(asset)) return null;
                return h('a', { key: id, href: assetUrl(asset), download: asset.name, className: 'xhs-btn mini', style: { textDecoration: 'none' } }, '第 ' + (i + 1) + ' 张 ↓');
              }))) : null))) : null);
}

// ---------- 竞对监控（A 方案：对比条 + 密集表格） ----------
// 顶部每账号一张对比卡（点卡切换管理区）；下面一张密集表汇全部监测账号的笔记，
// 一行一篇、10 列、按账号筛、按点赞排序、行末历史可展开。四个汇总大卡已去掉，
// 改成卡内按账号小计。监测笔记本身没存配图，封面为灰色占位（不画假图）。
function CompetitorView({ monitoredAccounts, gate, onQrLogin, notifications, unreadCount, onMarkNotificationRead, onMarkAllNotificationsRead, onReload }) {
  const [selectedId, setSelectedId] = useState(null);
  const selected = (monitoredAccounts || []).find((a) => a.id === selectedId) || (monitoredAccounts || [])[0] || null;
  const [historyId, setHistoryId] = useState(null);
  const [historySnaps, setHistorySnaps] = useState({});
  const [historyBusy, setHistoryBusy] = useState(false);
  const [homepageInput, setHomepageInput] = useState('');
  const [addError, setAddError] = useState('');
  const [addNotice, setAddNotice] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);
  const [fetchBusy, setFetchBusy] = useState(false);
  const [noteFilterAccountId, setNoteFilterAccountId] = useState('all');
  const [noteSort, setNoteSort] = useState('default');

  const hasLoginSession = !!(gate && gate.canFetch);
  const notesByAccount = new Map((monitoredAccounts || []).map((a) => [a.id, a.notes || []]));
  const accountNameById = new Map((monitoredAccounts || []).map((a) => [a.id, a.nickname || '（尚未获取到昵称）']));
  const metricText = (v) => (v === null || v === undefined ? '—' : fmtCount(v));
  const displayName = (a) => a.nickname || '（尚未获取到昵称）';
  const metricsOf = (n) => {
    if (n.latestMetrics) return { latest: n.latestMetrics, prev: n.previousMetrics || null, count: n.snapshotCount || 0 };
    const snaps = (n.snapshots || []).slice().sort((a, b) => String(a.at || a.capturedAt || a.recordedAt || '').localeCompare(String(b.at || b.capturedAt || b.recordedAt || '')));
    const latest = snaps[snaps.length - 1] || null;
    const prev = snaps.length > 1 ? snaps[snaps.length - 2] : null;
    return { latest, prev, count: snaps.length };
  };
  const notesTotalText = (list, key) => {
    let sum = 0; let known = 0;
    for (const n of list) {
      const v = n[key];
      if (v !== null && v !== undefined) { sum += v; known += 1; }
    }
    if (known === 0) return '—';
    return known < list.length ? fmtCount(sum) + '（已知部分）' : fmtCount(sum);
  };
  const latestNoteLabel = (list) => {
    const first = list[0];
    return first && first.publishedLabel ? first.publishedLabel : '—';
  };
  const tableNotes = (() => {
    const all = (monitoredAccounts || []).reduce((acc, a) => acc.concat(notesByAccount.get(a.id) || []), []);
    const filtered = noteFilterAccountId === 'all' ? all : all.filter((n) => n.monitoredAccountId === noteFilterAccountId);
    if (noteSort === 'default') return filtered;
    const dir = noteSort === 'likesDesc' ? -1 : 1;
    return filtered.slice().sort((x, y) => {
      if (x.likes === null && y.likes === null) return 0;
      if (x.likes === null) return 1;
      if (y.likes === null) return -1;
      return (x.likes - y.likes) * dir;
    });
  })();
  const totalNoteCount = (monitoredAccounts || []).reduce((s, a) => s + ((notesByAccount.get(a.id) || []).length), 0);

  const addMonitored = async () => {
    const url = homepageInput.trim();
    if (!url) { setAddError('请先粘贴小红书账号主页链接。'); return; }
    if (!/xiaohongshu\.com\/user\/profile\//.test(url)) { setAddError('链接格式不对，应为小红书账号主页链接，例如 https://www.xiaohongshu.com/user/profile/xxx'); return; }
    setAddBusy(true); setAddError(''); setAddNotice('');
    try {
      const res = await api('addmonitoredaccount', { homepage: url });
      if (res && res.ok === false) { setAddError(res.reason || res.message || '添加失败'); return; }
      setAddNotice((res && (res.reason || res.message)) || '已添加监测账号，正在拉取该账号的笔记数据…');
      setHomepageInput('');
      if (res && res.id !== null && res.id !== undefined) setSelectedId(res.id);
      if (onReload) await onReload();
    } catch (err) { setAddError('添加失败：' + (err && err.message ? err.message : String(err))); }
    finally { setAddBusy(false); }
  };
  const startFetch = async (id) => {
    setFetchBusy(true);
    try {
      const res = await api('startfetchmonitoredaccount', { monitoredAccountId: id });
      if (res && res.started === false) setAddError(res.message || '未能开始重新获取。');
      if (onReload) await onReload();
    } catch (err) { setAddError('重新获取失败：' + (err && err.message ? err.message : String(err))); }
    finally { setFetchBusy(false); }
  };
  const deleteMonitored = async (id) => {
    try { await api('deletemonitoredaccount', { id }); if (selectedId === id) setSelectedId(null); setDeleteConfirmId(null); if (onReload) await onReload(); }
    catch (err) { setAddError('删除失败：' + (err && err.message ? err.message : String(err))); }
  };
  const toggleHistory = async (n) => {
    if (historyId === n.id) { setHistoryId(null); return; }
    setHistoryId(n.id);
    if (!historySnaps[n.id]) {
      setHistoryBusy(true);
      try {
        const res = await apiSafe('listmonitoredsnapshots', { monitoredNoteId: n.id });
        setHistorySnaps((prev) => Object.assign({}, prev, { [n.id]: (res && res.snapshots) || n.snapshots || [] }));
      } finally { setHistoryBusy(false); }
    }
  };

  const historyCellContent = (n) => {
    if (historyBusy && !historySnaps[n.id]) return h('p', { style: { margin: 0, fontSize: 13, color: 'var(--color-foreground-muted)' } }, '加载历史…');
    const snaps = historySnaps[n.id] || n.snapshots || [];
    if (snaps.length === 0) return h('p', { style: { margin: 0, fontSize: 13, color: 'var(--color-foreground-muted)' } }, '暂无历史快照，多次获取后会在这里形成趋势记录。');
    return h('table', { className: 'xhs-sub-table' },
      h('thead', null, h('tr', null, h('th', null, '时间'), h('th', { className: 'num' }, '点赞'), h('th', { className: 'num' }, '收藏'), h('th', { className: 'num' }, '分享'), h('th', { className: 'num' }, '评论'))),
      h('tbody', null, snaps.slice(-8).map((s, i) =>
        h('tr', { key: i },
          h('td', null, fmtTime(s.capturedAt || s.at || s.recordedAt || s.fetchedAt)),
          h('td', { className: 'num' }, metric(s.likes)),
          h('td', { className: 'num' }, metric(s.collects)),
          h('td', { className: 'num' }, metric(s.shares)),
          h('td', { className: 'num' }, metric(s.comments))))));
  };

  const cellNum = (n, key) => {
    const m = metricsOf(n);
    return h('span', null,
      metricText(n[key]),
      n[key] !== null && n[key] !== undefined && m.prev ? h('span', { className: 'delta', style: { display: 'block' } }, h(Delta, { now: n[key], prev: m.prev[key] })) : null);
  };

  return h('div', { style: { minWidth: 0 } },
    h('div', { className: 'xhs-page-title-row' },
      h('h2', null, '竞对监控'),
      (monitoredAccounts || []).length > 0 && selected ? h('select', {
        className: 'xhs-select', style: { width: 'auto', maxWidth: '100%', borderRadius: 999, padding: '6px 12px', fontSize: 14 },
        value: String(selected.id),
        onChange: (e) => { setSelectedId(Number(e.target.value)); setHistoryId(null); },
      }, (monitoredAccounts || []).map((a) => h('option', { key: a.id, value: a.id }, a.nickname || a.homepage))) : null),
    h('p', { className: 'xhs-sub' }, '监测账号和绑定账号是两套独立记录：这里添加的是你想盯着看的其他账号，只存监测数据，不会改动你的绑定账号和它的笔记。每次获取只取最新 5 篇；有笔记上新、或已获取笔记点赞超过 5 时，会在工作台内弹窗提醒，并记到下面的通知列表里。'),
    (monitoredAccounts || []).length > 0 ? h('section', { style: { marginTop: 20 } },
      h('div', { style: { display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))' } },
        (monitoredAccounts || []).map((a) => {
          const list = notesByAccount.get(a.id) || [];
          const isCurrent = selected && selected.id === a.id;
          return h('button', {
            key: a.id, type: 'button', onClick: () => { setSelectedId(a.id); setHistoryId(null); },
            style: {
              borderRadius: 20, border: isCurrent ? '1px solid var(--color-primary)' : '1px solid var(--color-border)',
              background: 'var(--color-surface)', padding: 16, textAlign: 'left', boxShadow: 'var(--card-shadow)',
              outline: isCurrent ? '1px solid var(--color-primary)' : 'none', color: 'var(--color-foreground)',
            },
          },
            h('span', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h(AccountAvatar, { nickname: a.nickname || '监', avatarUrl: a.avatarUrl, size: 32 }),
              h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, fontWeight: 600 } }, displayName(a)),
              isCurrent ? h('span', { className: 'xhs-chip red' }, '管理中') : null,
              a.fetchStatus === 'fetching' ? h('span', { className: 'xhs-chip gray' }, '获取中…') : null),
            h('span', { style: { display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 10, fontSize: 12, color: 'var(--color-foreground-muted)' } },
              h('span', null, '粉丝 ' + (a.followersCount === null || a.followersCount === undefined ? '—' : fmtCount(a.followersCount))),
              h('span', null, '笔记 ' + list.length + ' 篇'),
              h('span', null, '最新笔记 ' + latestNoteLabel(list))),
            h('span', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, borderTop: '1px solid var(--color-border)', paddingTop: 10, marginTop: 8 } },
              [['总点赞', notesTotalText(list, 'likes')], ['总收藏', notesTotalText(list, 'collects')], ['总评论', notesTotalText(list, 'comments')]].map(([k, v]) =>
                h('span', { key: k },
                  h('span', { style: { display: 'block', fontSize: 12, color: 'var(--color-foreground-muted)' } }, k),
                  h('span', { style: { display: 'block', fontSize: 18, fontWeight: 700, lineHeight: 1.3, wordBreak: 'break-word' } }, v)))));
        }))) : null,
    h('section', { className: 'xhs-card', style: { marginTop: 16 } },
      h(NotificationList, {
        items: notifications || [], unreadCount: unreadCount || 0,
        onMarkRead: onMarkNotificationRead, onMarkAllRead: onMarkAllNotificationsRead,
        emptyText: '暂无通知。下次获取到新笔记、或有笔记点赞超过 5 时，这里会留下记录，工作台里也会弹窗提醒。',
        chipOf: (n) => n.type === 'new_note' ? { label: '笔记上新', cls: 'green' } : { label: '点赞超 5', cls: 'red' },
      })),
    h('form', {
      className: 'xhs-card', style: { marginTop: 16 },
      onSubmit: (e) => { e.preventDefault(); addMonitored(); },
    },
      h('label', { style: { fontSize: 14, fontWeight: 600 } }, '添加监测账号：粘贴对方的小红书主页链接'),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 } },
        h('input', { className: 'xhs-input', style: { flex: 1, minWidth: 200 }, value: homepageInput, onChange: (e) => setHomepageInput(e.target.value), placeholder: '如 https://www.xiaohongshu.com/user/profile/…' }),
        h('button', { type: 'submit', className: 'xhs-btn primary', disabled: addBusy || !homepageInput.trim() }, addBusy ? '添加中…' : '添加监测账号')),
      h('p', { className: 'xhs-hint' }, '添加后，工作台会用你已登录的浏览器（绑定账号的登录态）打开这个主页，读取它的昵称、头像、小红书号、关注 / 粉丝 / 获赞与收藏和最新 5 篇笔记，存到这个监测账号名下。已有监测账号的老笔记不会删，新规则只对之后每次获取的最新 5 篇生效。'),
      addError ? h('p', { style: { marginTop: 8, fontSize: 14, color: 'var(--color-primary)' } }, addError) : null,
      addNotice && !addError ? h('p', { style: { marginTop: 8, fontSize: 14, color: 'var(--color-foreground-muted)' } }, addNotice) : null),
    !hasLoginSession ? h('div', { className: 'xhs-note-box warn', style: { marginTop: 16, padding: 16, fontSize: 14 } },
      gate && gate.verdict === 'logged_out'
        ? h('div', null,
          h('p', { style: { margin: 0, fontWeight: 600 } }, '未登录，请扫码登录。'),
          h('p', { style: { margin: '4px 0 0' } }, '监测获取借用的是绑定账号的登录态：统一登录门禁的结论是未登录，所以暂时获取不了监测数据。点下面按钮打开小红书登录页扫码，登录成功后回到这里点「获取数据」即可。'),
          h('button', { type: 'button', className: 'xhs-btn primary', style: { marginTop: 8 }, onClick: onQrLogin }, '打开浏览器扫码登录'))
        : gate && gate.verdict === 'unknown'
          ? h('div', null,
            h('p', { style: { margin: 0, fontWeight: 600 } }, '登录态暂时无法确定。'),
            h('p', { style: { margin: '4px 0 0' } }, gate.message || ''),
            h('button', { type: 'button', className: 'xhs-btn primary', style: { marginTop: 8 }, onClick: onQrLogin }, '打开浏览器扫码登录'))
          : h('p', { style: { margin: 0 } }, '监测获取借用的是绑定账号的登录态：目前还没有已登录的绑定账号，暂时获取不了监测数据。先去「账号管理」页扫码登录，登录成功后回到这里点「获取数据」即可。')) : null,
    (monitoredAccounts || []).length === 0
      ? h('div', { className: 'xhs-card', style: { marginTop: 24, textAlign: 'center', borderStyle: 'dashed', padding: 32 } },
        h('p', { style: { margin: 0 } }, '还没有监测账号。'),
        h('p', { style: { margin: '4px 0 0', fontSize: 14, color: 'var(--color-foreground-muted)' } }, '把想监测的账号主页链接粘贴到上面，就能开始盯它的数据了。'))
      : selected ? h('section', { className: 'xhs-card', style: { marginTop: 20 } },
        h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
          h(AccountAvatar, { nickname: selected.nickname || '监', avatarUrl: selected.avatarUrl, size: 36 }),
          h('span', { style: { fontSize: 16, fontWeight: 600 } }, displayName(selected)),
          h('span', { className: 'xhs-chip red' }, '监测账号'),
          selected.xhsId ? h('span', { style: { fontSize: 14, color: 'var(--color-foreground-muted)' } }, '小红书号：' + selected.xhsId) : null),
        selected.homepage ? h('a', { href: selected.homepage, target: '_blank', rel: 'noreferrer', style: { display: 'block', marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, color: 'var(--color-link)' } }, selected.homepage) : null,
        (selected.followingCount !== null || selected.followersCount !== null || selected.likesCollectsCount !== null)
          ? h('p', { style: { display: 'flex', flexWrap: 'wrap', gap: 16, margin: '6px 0 0', fontSize: 14, color: 'var(--color-foreground-muted)' } },
            h('span', null, '关注 ' + (selected.followingCount === null ? '—' : fmtCount(selected.followingCount))),
            h('span', null, '粉丝 ' + (selected.followersCount === null ? '—' : fmtCount(selected.followersCount))),
            h('span', null, '获赞与收藏 ' + (selected.likesCollectsCount === null ? '—' : fmtCount(selected.likesCollectsCount)))) : null,
        h('div', { className: 'xhs-note-box', style: { marginTop: 12, fontSize: 14 } },
          selected.fetchStatus === 'fetching'
            ? h('div', null,
              h('p', { style: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500, margin: 0 } }, h('span', { className: 'xhs-pulse-dot' }), '正在获取监测数据…'),
              h('p', { style: { margin: '4px 0 0' } }, selected.fetchMessage || '正在打开这个监测账号的主页读取资料和笔记，通常要一两分钟。'),
              h('div', { className: 'xhs-progress thin', style: { marginTop: 8 } }, h('i', { className: 'slide' })))
            : selected.fetchStatus === 'done'
              ? h('p', { style: { margin: 0 } }, (selected.fetchMessage || '已获取 ' + (selected.fetchedCount || (selected.notes || []).length) + ' 篇笔记。') + (selected.fetchedAt ? ' · ' + fmtTime(selected.fetchedAt) : ''))
              : selected.fetchStatus === 'failed'
                ? h('p', { style: { margin: 0 } }, h('span', { style: { fontWeight: 500, color: 'var(--color-primary)' } }, '获取失败。'), humanizeFailureText(selected.fetchMessage) || '请点「重新获取」再试一次。')
                : h('p', { style: { margin: 0 } }, selected.fetchMessage || '尚未获取过这个监测账号的数据，点下方「获取数据」开始。')),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 } },
          h('button', { type: 'button', className: 'xhs-btn primary mini', disabled: selected.fetchStatus === 'fetching' || fetchBusy || !hasLoginSession, onClick: () => startFetch(selected.id) },
            selected.fetchStatus === 'fetching' ? '获取中…' : selected.fetchStatus === 'idle' ? '获取数据' : '重新获取数据'),
          !hasLoginSession && selected.fetchStatus !== 'fetching' ? h('span', { style: { alignSelf: 'center', fontSize: 12, color: 'var(--color-foreground-muted)' } }, '暂无已登录的绑定账号，先到「账号管理」页扫码登录。') : null,
          deleteConfirmId === selected.id
            ? h('span', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', { style: { fontSize: 14, color: 'var(--color-foreground-muted)' } }, '删除后这个监测账号和它的数据都会清掉，确认？'),
              h('button', { type: 'button', className: 'xhs-btn primary mini', onClick: () => deleteMonitored(selected.id) }, '确认删除'),
              h('button', { type: 'button', className: 'xhs-btn mini', onClick: () => setDeleteConfirmId(null) }, '取消'))
            : h('button', { type: 'button', className: 'xhs-btn mini', style: { color: 'var(--color-primary)' }, onClick: () => setDeleteConfirmId(selected.id) }, '删除监测账号'))) : null,
    (monitoredAccounts || []).length > 0 ? h('section', { style: { marginTop: 24, minWidth: 0 } },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
        h('h3', { style: { fontSize: 16 } }, '全部监测笔记',
          h('span', { style: { marginLeft: 8, fontSize: 14, fontWeight: 400, color: 'var(--color-foreground-muted)' } },
            noteFilterAccountId === 'all' ? '共 ' + totalNoteCount + ' 篇 · 全部监测账号合计' : '共 ' + tableNotes.length + ' 篇 · ' + (accountNameById.get(noteFilterAccountId) || ''))),
        h('div', { style: { marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
          h('select', { className: 'xhs-select', style: { width: 'auto', borderRadius: 999, padding: '6px 12px', fontSize: 14 }, value: noteFilterAccountId === 'all' ? 'all' : String(noteFilterAccountId), onChange: (e) => { setNoteFilterAccountId(e.target.value === 'all' ? 'all' : Number(e.target.value)); setHistoryId(null); } },
            h('option', { value: 'all' }, '全部账号'),
            (monitoredAccounts || []).map((a) => h('option', { key: a.id, value: a.id }, displayName(a)))),
          h('select', { className: 'xhs-select', style: { width: 'auto', borderRadius: 999, padding: '6px 12px', fontSize: 14 }, value: noteSort, onChange: (e) => setNoteSort(e.target.value) },
            h('option', { value: 'default' }, '默认排序'),
            h('option', { value: 'likesDesc' }, '点赞从高到低'),
            h('option', { value: 'likesAsc' }, '点赞从低到高')))),
      totalNoteCount === 0
        ? h('div', { className: 'xhs-card', style: { marginTop: 16, textAlign: 'center', borderStyle: 'dashed', padding: 32 } },
          h('p', { style: { margin: 0 } }, '还没有获取到任何监测账号的笔记。'),
          h('p', { style: { margin: '4px 0 0', fontSize: 14, color: 'var(--color-foreground-muted)' } }, '在上方对比卡里选中一个账号，点它管理区里的「获取数据」，读到的笔记会汇到这张表里。'))
        : tableNotes.length === 0
          ? h('p', { style: { marginTop: 16, fontSize: 14, color: 'var(--color-foreground-muted)' } }, '这个账号还没有获取到笔记，点它的管理区里的「获取数据」开始。')
          : h('div', null,
            h('div', { className: 'xhs-table-wrap', style: { marginTop: 12 } },
              h('table', { className: 'xhs-table' },
                h('colgroup', null,
                  h('col', { style: { width: '5%' } }),
                  h('col', null),
                  h('col', { style: { width: '12%' } }),
                  h('col', { style: { width: '7%' } }),
                  h('col', { className: 'xhs-col-lg', style: { width: '7%' } }),
                  h('col', { className: 'xhs-col-xl', style: { width: '6%' } }),
                  h('col', { style: { width: '7%' } }),
                  h('col', { className: 'xhs-col-lg', style: { width: '11%' } }),
                  h('col', { style: { width: '12%' } }),
                  h('col', { style: { width: '8%' } })),
                h('thead', null, h('tr', null,
                  h('th', { style: { paddingLeft: 16 } }, '封面'),
                  h('th', null, '标题'),
                  h('th', null, '所属账号'),
                  h('th', { className: 'num' }, '点赞'),
                  h('th', { className: 'num xhs-cell-lg' }, '收藏'),
                  h('th', { className: 'num xhs-cell-xl' }, '分享'),
                  h('th', { className: 'num' }, '评论'),
                  h('th', { className: 'num xhs-cell-lg' }, '发布时间'),
                  h('th', { className: 'num' }, '最近获取'),
                  h('th', { className: 'num', style: { paddingRight: 16 } }, '历史'))),
                h('tbody', null, tableNotes.map((n) => {
                  const cover = (n.images && n.images[0]) ? imgUrl(n.images[0]) : '';
                  const m = metricsOf(n);
                  const open = historyId === n.id;
                  const snaps = open ? (historySnaps[n.id] || n.snapshots || []) : [];
                  return [
                    h('tr', { key: n.id },
                      h('td', { style: { paddingLeft: 16 } },
                        cover ? h('img', { src: cover, alt: (n.title || '笔记') + ' 封面', style: { width: 32, height: 32, borderRadius: 6, objectFit: 'cover' }, referrerPolicy: 'no-referrer' })
                          : h('span', { style: { display: 'block', width: 32, height: 32, borderRadius: 6, border: '1px solid var(--color-border)', background: 'var(--color-surface-alt)' } })),
                      h('td', null,
                        h('span', { className: 'trunc', style: { fontWeight: 500, lineHeight: 1.3 } , title: n.title }, n.title || '（无标题）'),
                        n.excerpt ? h('span', { className: 'trunc trunc-sm' }, n.excerpt) : null),
                      h('td', null, h('span', { className: 'trunc', style: { fontSize: 13, color: 'var(--color-foreground-muted)' } }, accountNameById.get(n.monitoredAccountId) || '—')),
                      h('td', { className: 'num' }, cellNum(n, 'likes')),
                      h('td', { className: 'num xhs-cell-lg' }, cellNum(n, 'collects')),
                      h('td', { className: 'num xhs-cell-xl' }, cellNum(n, 'shares')),
                      h('td', { className: 'num' }, cellNum(n, 'comments')),
                      h('td', { className: 'num xhs-cell-lg', style: { fontWeight: 400 } }, h('span', { className: 'trunc' }, n.publishedLabel || '—')),
                      h('td', { className: 'num', style: { fontWeight: 400 } }, h('span', { className: 'trunc' }, n.fetchedAt ? fmtTime(n.fetchedAt) : '—')),
                      h('td', { className: 'num', style: { paddingRight: 16 } },
                        m.count > 0
                          ? h('button', { type: 'button', className: 'xhs-btn mini', onClick: () => toggleHistory(n) }, open ? '收起' : '历史 (' + m.count + ')')
                          : h('span', { style: { fontSize: 12, color: 'var(--color-foreground-muted)' } }, '—'))),
                    open ? h('tr', { key: n.id + '-hist' },
                      h('td', { colSpan: 10, className: 'xhs-history-sub' }, historyCellContent(n))) : null,
                  ];
                })))),
            h('div', { className: 'xhs-mon-mobile', style: { marginTop: 12 } }, tableNotes.map((n) => {
              const m = metricsOf(n);
              return h('div', { key: n.id, className: 'xhs-mon-row' },
                h('div', { style: { display: 'flex', gap: 10, alignItems: 'flex-start' } },
                  h('span', { style: { display: 'block', width: 32, height: 32, flexShrink: 0, borderRadius: 6, border: '1px solid var(--color-border)', background: 'var(--color-surface-alt)' } }),
                  h('div', { style: { flex: 1, minWidth: 0 } },
                    h('p', { style: { margin: 0, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, n.title || '（无标题）'),
                    h('p', { style: { margin: '2px 0 0', fontSize: 12, color: 'var(--color-foreground-muted)' } }, (accountNameById.get(n.monitoredAccountId) || '—') + ' · ' + (n.publishedLabel || '—'))),
                  h('span', { style: { fontSize: 12, color: 'var(--color-foreground-muted)', whiteSpace: 'nowrap' } }, '赞 ' + metricText(n.likes))),
                h('p', { style: { margin: '8px 0 0', fontSize: 12, color: 'var(--color-foreground-muted)' } },
                  '藏 ' + metricText(n.collects) + ' · 分享 ' + metricText(n.shares) + ' · 评论 ' + metricText(n.comments) + ' · 最近获取 ' + (n.fetchedAt ? fmtTime(n.fetchedAt) : '—')),
                m.count > 0 ? h('button', { type: 'button', className: 'xhs-btn mini', style: { marginTop: 8 }, onClick: () => toggleHistory(n) }, historyId === n.id ? '收起历史' : '历史 (' + m.count + ')') : null,
                historyId === n.id ? h('div', { style: { marginTop: 8 } }, historyCellContent(n)) : null);
            })))) : null);
}

// ---------- 热点资讯 ----------
function HotspotsView({ onMakeNote, gate, onQrLogin, onGoAccount, feed, onReload }) {
  const [formSeeded, setFormSeeded] = useState(false);
  const [keywordsText, setKeywordsText] = useState('');
  const [intervalHours, setIntervalHours] = useState(6);
  const [autoEnabled, setAutoEnabled] = useState(true);
  const [configNote, setConfigNote] = useState('');
  const [searchNote, setSearchNote] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (feed && !formSeeded) {
      setKeywordsText((feed.config.keywords || []).join('\n'));
      setIntervalHours(feed.config.intervalHours || 6);
      setAutoEnabled(feed.config.enabled !== false);
      setFormSeeded(true);
    }
  }, [feed, formSeeded]);

  const anyFetching = !!feed && (feed.xhs.status === 'fetching' || feed.x.status === 'fetching' || (feed.xLogin && feed.xLogin.status === 'checking'));
  const saveConfig = async () => {
    setBusy(true);
    try {
      const res = await api('updatehotspotconfig', {
        keywords: keywordsText.split(/[\n,，、]/).map((s) => s.trim()).filter((s) => s !== ''),
        intervalHours, enabled: autoEnabled,
      });
      const cfg = (res && res.config) || {};
      setKeywordsText((cfg.keywords || []).join('\n'));
      setConfigNote((cfg.keywords && cfg.keywords.length > 0)
        ? '已保存：' + cfg.keywords.length + ' 个关键词，小红书每 ' + cfg.intervalHours + ' 小时自动检索一次' + (cfg.enabled ? '' : '（自动检索已关闭，可手动点立即检索）') + '。'
        : '已保存：关键词为空，自动检索不会运行，填好关键词后才会开始检索。');
      if (onReload) await onReload();
    } catch (err) { setConfigNote('保存失败：' + (err && err.message ? err.message : String(err))); }
    finally { setBusy(false); }
  };
  const startSearch = async (source) => {
    setBusy(true);
    try {
      const res = await api('starthotspotsearch', { source });
      setSearchNote((res && res.message) || '已启动检索。');
      if (onReload) await onReload();
    } catch (err) { setSearchNote('检索没能启动：' + (err && err.message ? err.message : String(err))); }
    finally { setBusy(false); }
  };
  const startXLogin = async () => {
    try { const res = await api('startxlogin', {}); setSearchNote((res && res.message) || '已打开 X 登录页。'); if (onReload) await onReload(); }
    catch (err) { setSearchNote('X 登录页没能打开：' + (err && err.message ? err.message : String(err))); }
  };
  const checkXLogin = async () => {
    try { const res = await api('checkxloginstatus', {}); setSearchNote((res && res.message) || '已启动 X 登录态检查。'); if (onReload) await onReload(); }
    catch (err) { setSearchNote('X 登录态检查没能启动：' + (err && err.message ? err.message : String(err))); }
  };

  const statusChip = (s) => {
    if (!s) return h('span', { className: 'xhs-chip gray' }, '尚未检索');
    if (s.status === 'fetching') return h('span', { className: 'xhs-chip red' }, '检索中…');
    if (s.status === 'done') return h('span', { className: 'xhs-chip green' }, '已完成');
    if (s.status === 'failed') return h('span', { className: 'xhs-chip red' }, '未完成');
    return h('span', { className: 'xhs-chip gray' }, '尚未检索');
  };
  const items = (feed && feed.items) || [];
  const shownItems = sourceFilter === 'all' ? items : items.filter((i) => i.source === sourceFilter);
  const hasKeywords = feed && feed.config && (feed.config.keywords || []).length > 0;
  const xhsLoggedIn = !!(gate && gate.canFetch);
  const xLoggedOut = feed && feed.xLogin && feed.xLogin.status === 'logged_out';
  const xChecking = feed && feed.xLogin && feed.xLogin.status === 'checking';

  const sourceCard = (source, title, rule, s) => h('div', { className: 'xhs-card', style: { marginBottom: 0 } },
    h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
      h('h4', { style: { fontSize: 14, fontWeight: 600 } }, title),
      statusChip(s),
      h('button', { type: 'button', className: 'xhs-btn primary mini', style: { marginLeft: 'auto' }, disabled: !s || (s && s.status === 'fetching') || busy, onClick: () => startSearch(source) },
        s && s.status === 'fetching' ? '检索中…' : '立即检索')),
    h('p', { style: { margin: '6px 0 0', fontSize: 12, lineHeight: 1.6, color: 'var(--color-foreground-muted)' } }, rule),
    s && s.lastFetchedAt ? h('p', { style: { margin: '6px 0 0', fontSize: 12, color: 'var(--color-foreground-muted)' } }, '上次检索到结果：' + fmtTime(s.lastFetchedAt)) : null,
    s && s.nextDueAt ? h('p', { style: { margin: '2px 0 0', fontSize: 12, color: 'var(--color-foreground-muted)' } }, '下次自动检索：约 ' + fmtTime(s.nextDueAt)) : null,
    s && s.message ? h('p', { style: { margin: '6px 0 0', fontSize: 14, lineHeight: 1.6 } }, humanizeFailureText(s.message)) : null,
    source === 'xiaohongshu' && gate && !xhsLoggedIn ? h('div', { className: 'xhs-note-box warn', style: { marginTop: 12, padding: '10px 12px', fontSize: 14 } },
      h('p', { style: { margin: 0 } }, gate.verdict === 'logged_out' ? '小红书未登录，检索不了：' + (gate.message || '') : '小红书登录态暂时无法确定：' + (gate.message || '')),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 } },
        h('button', { type: 'button', className: 'xhs-btn primary mini', onClick: onQrLogin }, '打开浏览器扫码登录'),
        h('button', { type: 'button', className: 'xhs-btn mini', onClick: onGoAccount }, '去账号管理'))) : null,
    source === 'x' ? h('div', { style: { borderTop: '1px solid var(--color-border)', paddingTop: 12, marginTop: 12 } },
      xChecking
        ? h('p', { style: { margin: 0, fontSize: 14, lineHeight: 1.6 } }, 'X 登录页已经打开，正在等你在浏览器里完成登录（用你自己的邮箱和密码输在 X 的登录页里）。登录好后这里会自动更新，再点「立即检索」即可。')
        : xLoggedOut
          ? h('div', { className: 'xhs-note-box warn', style: { padding: '10px 12px', fontSize: 14 } },
            h('p', { style: { margin: 0 } }, 'X 还没有登录，所以读不到搜索结果——上面不会有任何 X 资讯，这不是没有热点，是还没登录。登录由你本人在 X 的页面上完成，密码只输进 X 的登录页，工作台不保存、也看不到。'),
            h('button', { type: 'button', className: 'xhs-btn primary mini', style: { marginTop: 8 }, onClick: startXLogin }, '打开 X 登录页'))
          : feed && feed.xLogin && feed.xLogin.status === 'logged_in'
            ? h('p', { style: { margin: 0, fontSize: 14, color: 'var(--color-foreground-muted)' } }, 'X 登录态：已登录' + (feed.xLogin.checkedAt ? '（最近确认 ' + fmtTime(feed.xLogin.checkedAt) + '）' : '') + '，可以正常检索。')
            : h('div', { style: { fontSize: 14, lineHeight: 1.6, color: 'var(--color-foreground-muted)' } },
              h('p', { style: { margin: 0 } }, 'X 登录态还没有确认过：点「立即检索」时工作台会先在浏览器里判断——没登录就会明确提示，不会假装有数据。你也可以先打开 X 登录页登录好再检索。'),
              h('button', { type: 'button', className: 'xhs-btn mini', style: { marginTop: 8 }, onClick: startXLogin }, '打开 X 登录页')),
      feed && feed.xLogin && feed.xLogin.message && feed.xLogin.status !== 'logged_out'
        ? h('p', { style: { margin: '6px 0 0', fontSize: 12, lineHeight: 1.6, color: 'var(--color-foreground-muted)' } }, humanizeFailureText(feed.xLogin.message)) : null,
      h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 10 } },
        h('button', { type: 'button', className: 'xhs-btn mini', disabled: busy || xChecking, onClick: checkXLogin }, xChecking ? '正在检查 X 登录态…' : '随机浏览检查 X 登录态'),
        feed && feed.xLogin && feed.xLogin.checkMethod ? h('span', { style: { fontSize: 12, color: 'var(--color-foreground-muted)' } },
          feed.xLogin.checkMethod === 'random_browse'
            ? '上次结论来自随机浏览检查' + ((feed.xLogin.browsedPages || []).length > 0 ? '（浏览了：' + (feed.xLogin.browsedPages || []).join('、') + '）' : '')
            : feed.xLogin.checkMethod === 'random_browse_inconclusive' ? '上次随机浏览没能给出结论，下一次 X 检索会再判断一次'
            : feed.xLogin.checkMethod === 'search' ? '上次结论来自 X 检索时的判断' : '上次结论来自打开 X 登录页时的判断') : null)) : null);

  return h('div', null,
    h('h2', null, '热点资讯'),
    h('p', { className: 'xhs-sub', style: { maxWidth: 640 } }, '按你定的关键词，定时去小红书和 X 上检索资讯，按「来源 · 标题 · 概括」列表展示，只保留近 7 天的内容，超过 7 天的会自动清理。检索由当前平台（Muse / DSH）的浏览器能力完成；看到想写的热点，点「做成笔记」就能跳去笔记制作，标题作主题、概括作关键词自动填好。'),
    h('section', { className: 'xhs-card', style: { marginTop: 20 } },
      h('h3', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 16 } }, h(Icon, { d: ICONS.flame, style: { width: 16, height: 16 } }), '检索设置'),
      h('label', { style: { display: 'block', marginTop: 12, fontSize: 14, fontWeight: 600 } }, '关键词（每行一个，或用逗号分隔，最多 20 个）'),
      h('textarea', { className: 'xhs-textarea', rows: 3, style: { marginTop: 6 }, value: keywordsText, onChange: (e) => setKeywordsText(e.target.value), placeholder: '例如：\n深圳周末去哪玩\n秋冬穿搭' }),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 16, marginTop: 12 } },
        h('div', null,
          h('label', { style: { display: 'block', fontSize: 14, fontWeight: 600 } }, '小红书自动检索间隔'),
          h('select', { className: 'xhs-select', style: { marginTop: 6, width: 'auto' }, value: intervalHours, onChange: (e) => setIntervalHours(Number(e.target.value)) },
            [1, 3, 6, 12, 24].map((hh) => h('option', { key: hh, value: hh }, '每 ' + hh + ' 小时')))),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 8, fontSize: 14 } },
          h('input', { type: 'checkbox', checked: autoEnabled, onChange: (e) => setAutoEnabled(e.target.checked), style: { width: 16, height: 16 } }), '开启自动检索'),
        h('button', { type: 'button', className: 'xhs-btn primary', disabled: busy || !feed, onClick: saveConfig }, busy ? '保存中…' : '保存设置')),
      h('p', { className: 'xhs-hint' }, 'X 的检索间隔按定好的规则固定为每 12 小时一次、每次最多 50 条，不跟随上面的间隔设置。关闭自动检索后仍可随时手动点「立即检索」。'),
      configNote ? h('p', { className: 'xhs-note-box', style: { marginTop: 8 } }, configNote) : null),
    h('div', { style: { display: 'grid', gap: 16, marginTop: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))' } },
      sourceCard('xiaohongshu', '小红书', '借用绑定账号的登录态在小红书站内按关键词搜索，间隔按上面的设置。', feed ? feed.xhs : null),
      sourceCard('x', 'X', '在已登录的浏览器里读 X 搜索页，每 12 小时一次、每次最多 50 条。', feed ? feed.x : null)),
    searchNote ? h('p', { className: 'xhs-note-box', style: { marginTop: 12 } }, searchNote) : null,
    h('section', { style: { marginTop: 24 } },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
        h('h3', { style: { fontSize: 16 } }, '资讯列表'),
        h('span', { style: { fontSize: 12, color: 'var(--color-foreground-muted)' } }, '近 7 天 · 共 ' + items.length + ' 条'),
        h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } },
          [['all', '全部'], ['xiaohongshu', '小红书'], ['x', 'X']].map(([key, label]) =>
            h('button', { key, type: 'button', className: 'xhs-btn mini' + (sourceFilter === key ? ' primary' : ''), onClick: () => setSourceFilter(key) }, label)))),
      !feed
        ? h('p', { style: { marginTop: 16, padding: '40px 0', textAlign: 'center', fontSize: 14, color: 'var(--color-foreground-muted)' } }, '正在加载热点资讯…')
        : shownItems.length === 0
          ? h('div', { className: 'xhs-card', style: { marginTop: 16, textAlign: 'center', borderStyle: 'dashed', padding: 32 } },
            h('p', { style: { margin: 0 } }, '暂无热点资讯。'),
            h('p', { style: { margin: '4px auto 0', maxWidth: 480, fontSize: 14, lineHeight: 1.6, color: 'var(--color-foreground-muted)' } },
              !hasKeywords ? '还没有设置关键词：先在上面的检索设置里填好关键词并保存，再点「立即检索」或等自动检索，读到的真实结果会出现在这里。'
                : items.length > 0 ? '当前筛选下没有资讯，换个来源筛选看看。'
                : xLoggedOut && !xhsLoggedIn ? '小红书和 X 都还没有登录：小红书先扫码登录、X 先点「打开 X 登录页」登录，登录后检索到的真实资讯会出现在这里；没登录时这里不会放任何示例资讯。'
                : xLoggedOut ? 'X 还没有登录，所以没有 X 资讯；小红书这边最近一次检索也没有读到结果。可以先登录 X、或调整关键词后再检索一次。'
                : !xhsLoggedIn ? '小红书还没有登录，暂时检索不了；X 这边最近一次检索也没有读到结果。先扫码登录小红书后再试。'
                : '最近一次检索没有读到结果，或者还没检索过：可以点上面的「立即检索」，读到的真实资讯会出现在这里。'))
          : h('ul', { style: { margin: '16px 0 0', padding: 0, listStyle: 'none' } }, shownItems.map((item) =>
            h('li', { key: item.id, className: 'xhs-card' },
              h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
                h('span', { className: 'xhs-chip ' + (item.source === 'x' ? 'dark' : 'red') }, item.source === 'x' ? 'X' : '小红书'),
                item.keyword ? h('span', { className: 'xhs-chip gray' }, '关键词：' + item.keyword) : null,
                h('span', { style: { fontSize: 12, color: 'var(--color-foreground-muted)' } }, fmtTime(item.fetchedAt) + ' 检索到'),
                h('button', { type: 'button', className: 'xhs-btn primary mini', style: { marginLeft: 'auto' }, onClick: () => onMakeNote({ title: item.title, summary: item.summary || '' }) }, '做成笔记')),
              item.url
                ? h('a', { href: item.url, target: '_blank', rel: 'noreferrer', style: { display: 'block', marginTop: 8, fontSize: 16, fontWeight: 600, lineHeight: 1.4, color: 'var(--color-foreground)', textDecoration: 'underline', textDecorationColor: 'var(--color-border)', textUnderlineOffset: 2 } }, item.title)
                : h('p', { style: { margin: '8px 0 0', fontSize: 16, fontWeight: 600, lineHeight: 1.4 } }, item.title),
              h('p', { style: { margin: '4px 0 0', fontSize: 14, lineHeight: 1.6, color: 'var(--color-foreground-muted)' } }, item.summary || '—'),
              h('p', { style: { margin: '6px 0 0', fontSize: 12, color: 'var(--color-foreground-muted)' } }, '作者：' + (item.author || '—')))))));
}

// ---------- 留资管理 ----------
// 只监控、不回复：页面上没有任何回复入口、不发送。私信只读消息页列表、不点开会话。
function LeadsView({ gate, onQrLogin, monitor, fetchedNotes, onMarkNotificationRead, onMarkAllNotificationsRead, onReload }) {
  const hasLoginSession = !!(gate && gate.canFetch);
  const dm = monitor && monitor.dm;
  const conversations = (monitor && monitor.conversations) || [];
  const notifications = (monitor && monitor.notifications) || [];
  const unreadCount = (monitor && monitor.unreadCount) || 0;
  const dmFetching = dm && dm.status === 'fetching';
  const [busy, setBusy] = useState(false);
  const [dmMsg, setDmMsg] = useState('');

  const startDmCheck = async () => {
    setBusy(true); setDmMsg('');
    try {
      const res = await api('startleaddmcheck', {});
      if (res && res.started === false) setDmMsg(res.message || '未能开始检查私信。');
      else setDmMsg((res && res.message) || '已开始检查私信。');
      if (onReload) await onReload();
    } catch (err) { setDmMsg('检查没能启动：' + (err && err.message ? err.message : String(err))); }
    finally { setBusy(false); }
  };

  const knownCommentNotes = (fetchedNotes || []).filter((n) => n.comments !== null && n.comments !== undefined);
  const commentTotalText = knownCommentNotes.length === 0 ? '—'
    : fmtCount(knownCommentNotes.reduce((s, n) => s + (n.comments || 0), 0)) + (knownCommentNotes.length < (fetchedNotes || []).length ? '（已知部分）' : '');
  const dmStatusChip = (status) => {
    if (status === 'fetching') return h('span', { className: 'xhs-chip gray' }, '检查中…');
    if (status === 'done') return h('span', { className: 'xhs-chip green' }, '已检查');
    if (status === 'failed') return h('span', { className: 'xhs-chip red' }, '检查失败');
    return h('span', { className: 'xhs-chip gray' }, '还没检查过');
  };

  return h('div', null,
    h('h2', null, '留资管理'),
    h('p', { className: 'xhs-sub', style: { maxWidth: 640 } }, '只监控主账号的私信和评论：检查到新私信、或已拉笔记有新评论时，会在工作台里弹窗提醒，并记到下面的提醒列表里。这里只做监控和提醒，不提供回复入口——要回复请到小红书 App 或网页的消息页处理。'),
    !hasLoginSession ? h('div', { className: 'xhs-note-box warn', style: { marginTop: 16, padding: 16, fontSize: 14 } },
      gate && gate.verdict === 'logged_out'
        ? h('div', null,
          h('p', { style: { margin: 0, fontWeight: 600 } }, '未登录，请扫码登录。'),
          h('p', { style: { margin: '4px 0 0' } }, '私信和评论都借用绑定账号的登录态读取：统一登录门禁的结论是未登录，所以暂时检查不了。点下面按钮打开小红书登录页扫码，登录成功后回来点「立即检查私信」即可。'),
          h('button', { type: 'button', className: 'xhs-btn primary', style: { marginTop: 8 }, onClick: onQrLogin }, '打开浏览器扫码登录'))
        : gate && gate.verdict === 'unknown'
          ? h('div', null,
            h('p', { style: { margin: 0, fontWeight: 600 } }, '登录态暂时无法确定。'),
            h('p', { style: { margin: '4px 0 0' } }, gate.message || ''),
            h('button', { type: 'button', className: 'xhs-btn primary', style: { marginTop: 8 }, onClick: onQrLogin }, '打开浏览器扫码登录'))
          : h('p', { style: { margin: 0 } }, '私信和评论都借用绑定账号的登录态读取：目前还没有已登录的绑定账号，暂时检查不了。先去「账号管理」页点「+ 绑定新账号」扫码登录，登录成功后回来点「立即检查私信」即可。')) : null,
    h('section', { className: 'xhs-card', style: { marginTop: 16 } },
      h(NotificationList, {
        items: notifications, unreadCount,
        onMarkRead: onMarkNotificationRead, onMarkAllRead: onMarkAllNotificationsRead,
        emptyText: '暂无提醒。检查到新私信、或已拉笔记评论数增加时，这里会留下记录，工作台里也会弹窗提醒。',
        chipOf: (n) => n.type === 'new_dm' ? { label: '新私信', cls: 'blue' } : { label: '新评论', cls: 'amber' },
      })),
    h('section', { className: 'xhs-card', style: { marginTop: 16 } },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
        h('h3', { style: { fontSize: 16 } }, '私信监控'),
        dm ? dmStatusChip(dm.status) : null,
        dm && dm.lastFetchedAt ? h('span', { style: { fontSize: 12, color: 'var(--color-foreground-muted)' } }, '最近一次读到：' + fmtTime(dm.lastFetchedAt)) : null),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 } },
        h('div', { className: 'xhs-stat' },
          h('p', { style: { margin: 0, fontSize: 12, color: 'var(--color-foreground-muted)' } }, '未读私信'),
          h('p', { style: { margin: '2px 0 0', fontSize: 30, fontWeight: 700 } }, (dm && dm.unreadTotal !== null && dm.unreadTotal !== undefined) ? fmtCount(dm.unreadTotal) : '—'),
          h('p', { style: { margin: '2px 0 0', fontSize: 12, color: 'var(--color-foreground-muted)' } }, dm && dm.lastFetchedAt ? '按最近一次检查读到的数字' : '还没检查过，读不到时显示 —')),
        h('div', { className: 'xhs-stat' },
          h('p', { style: { margin: 0, fontSize: 12, color: 'var(--color-foreground-muted)' } }, '私信会话'),
          h('p', { style: { margin: '2px 0 0', fontSize: 30, fontWeight: 700 } }, (dm && dm.conversationCount !== null && dm.conversationCount !== undefined) ? fmtCount(dm.conversationCount) : '—'),
          h('p', { style: { margin: '2px 0 0', fontSize: 12, color: 'var(--color-foreground-muted)' } }, '最近一次检查在列表里看到的会话数'))),
      h('div', { className: 'xhs-note-box', style: { marginTop: 12, fontSize: 14 } },
        dmFetching
          ? h('div', null,
            h('p', { style: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500, margin: 0 } }, h('span', { className: 'xhs-pulse-dot' }), '正在检查私信…'),
            h('p', { style: { margin: '4px 0 0' } }, (dm && dm.message) || '正在打开小红书消息页读取私信列表，通常要一两分钟。'))
          : dm && dm.status === 'failed'
            ? h('p', { style: { margin: 0 } }, h('span', { style: { fontWeight: 500, color: 'var(--color-primary)' } }, '检查失败。'), humanizeFailureText(dm.message || '') || '请点「立即检查私信」再试一次。')
            : dm && dm.status === 'done'
              ? h('p', { style: { margin: 0 } }, (dm.message || '已检查过私信。') + (dm.lastFetchedAt ? ' · ' + fmtTime(dm.lastFetchedAt) : ''))
              : h('p', { style: { margin: 0 } }, '还没有检查过私信。点下面「立即检查私信」，工作台会用已登录的浏览器打开小红书消息页，只读取私信列表（不会点开会话、不会回复）。第一次检查先作为基准，之后有新私信才会弹窗提醒。')),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 12 } },
        h('button', { type: 'button', className: 'xhs-btn primary', disabled: dmFetching || busy || !hasLoginSession, onClick: startDmCheck },
          dmFetching ? '检查中…' : (!dm || dm.status === 'idle') ? '立即检查私信' : '重新检查私信'),
        !hasLoginSession && !dmFetching ? h('span', { style: { fontSize: 12, color: 'var(--color-foreground-muted)' } }, '暂无已登录的绑定账号，先到「账号管理」页扫码登录。') : null),
      dmMsg ? h('p', { style: { marginTop: 8, fontSize: 13, color: 'var(--color-foreground-muted)' } }, dmMsg) : null,
      conversations.length > 0 ? h('ul', { style: { margin: '16px 0 0', padding: 0, listStyle: 'none' } }, conversations.map((c) =>
        h('li', { key: c.id, className: 'xhs-notif-item' },
          h('span', { style: { display: 'flex', width: 36, height: 36, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: '50%', background: 'var(--color-surface-alt)', fontSize: 14, fontWeight: 700 } }, (c.senderName || '私').slice(0, 1)),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('p', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, margin: 0, fontSize: 14, fontWeight: 500 } },
              c.senderName,
              c.unreadCount > 0 ? h('span', { className: 'xhs-chip red' }, c.unreadCount + ' 条未读') : null,
              c.timeLabel ? h('span', { style: { fontSize: 12, fontWeight: 400, color: 'var(--color-foreground-muted)' } }, c.timeLabel) : null),
            h('p', { style: { margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, color: 'var(--color-foreground-muted)' } }, c.preview || '—'))))) : null,
      dm && dm.status === 'done' && conversations.length === 0 ? h('p', { style: { marginTop: 12, fontSize: 14, color: 'var(--color-foreground-muted)' } }, '最近一次检查时，私信列表里没有会话。') : null),
    h('section', { className: 'xhs-card', style: { marginTop: 16 } },
      h('h3', { style: { fontSize: 16 } }, '评论监控'),
      h('p', { style: { marginTop: 6, fontSize: 14, lineHeight: 1.6, color: 'var(--color-foreground-muted)' } }, '评论提醒不用单独检查：每次重新拉取主账号笔记（左侧「刷新全部数据」、或发布日历里的拉取/补齐）时，工作台会把新读到的评论数和上次存的比一比，哪篇增加了就生成一条「新评论」提醒并弹窗。第一次拉取只建基准，不会把已有评论误报成新评论。'),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 } },
        h('div', { className: 'xhs-stat' },
          h('p', { style: { margin: 0, fontSize: 12, color: 'var(--color-foreground-muted)' } }, '已拉笔记评论合计'),
          h('p', { style: { margin: '2px 0 0', fontSize: 30, fontWeight: 700 } }, commentTotalText),
          h('p', { style: { margin: '2px 0 0', fontSize: 12, color: 'var(--color-foreground-muted)' } }, '来自 ' + (fetchedNotes || []).length + ' 篇已拉笔记，页面没显示评论数的篇目不计入')),
        h('div', { className: 'xhs-stat' },
          h('p', { style: { margin: 0, fontSize: 12, color: 'var(--color-foreground-muted)' } }, '评论数已知的笔记'),
          h('p', { style: { margin: '2px 0 0', fontSize: 30, fontWeight: 700 } }, (fetchedNotes || []).length === 0 ? '—' : knownCommentNotes.length + ' / ' + (fetchedNotes || []).length),
          h('p', { style: { margin: '2px 0 0', fontSize: 12, color: 'var(--color-foreground-muted)' } }, '只有评论数读到过的笔记才能比对出新评论'))),
      (fetchedNotes || []).length === 0 ? h('p', { style: { marginTop: 12, fontSize: 14, color: 'var(--color-foreground-muted)' } }, '还没有拉取过主账号的笔记，暂时没有可比对的评论数。先到「发布日历」或点「刷新全部数据」拉取一次笔记，之后再拉取时就能比对出新评论了。') : null));
}

function FetchedNotesList({ notes, homepageUrl, onRefetch, refetchDisabled }) {
  if (!notes || notes.length === 0) return null;
  return h('div', { style: { marginTop: 12, borderTop: '1px solid var(--color-border)', paddingTop: 12 } },
    h('p', { style: { margin: 0, fontSize: 14, fontWeight: 600 } }, '获取到的真实笔记（' + notes.length + ' 篇）'),
    h('ul', { style: { margin: '8px 0 0', padding: 0, listStyle: 'none' } }, notes.map((n) => {
      const imgs = imgUrls(n.images);
      return h('li', { key: n.id, style: { display: 'flex', gap: 12, borderRadius: 12, background: 'var(--color-surface-alt)', padding: '10px 12px', marginBottom: 8 } },
        imgs[0] ? h('img', { src: imgs[0], alt: n.title || '笔记配图', style: { width: 56, height: 56, flexShrink: 0, borderRadius: 8, objectFit: 'cover' }, referrerPolicy: 'no-referrer' }) : null,
        h('div', { style: { flex: 1, minWidth: 0 } },
          n.url
            ? h(XhsNoteLink, { url: n.url, label: n.title, className: 'xhs-link', homepageUrl, onRefetch, refetchDisabled })
            : h('span', { style: { fontSize: 14, fontWeight: 500 } }, n.title),
          n.excerpt ? h('p', { style: { margin: '2px 0 0', fontSize: 12, color: 'var(--color-foreground-muted)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, n.excerpt) : null,
          h('p', { style: { display: 'flex', flexWrap: 'wrap', gap: 12, margin: '4px 0 0', fontSize: 12, color: 'var(--color-foreground-muted)' } },
            h('span', null, '赞 ' + (n.likes === null || n.likes === undefined ? '—' : fmtCount(n.likes))),
            h('span', null, '藏 ' + (n.collects === null || n.collects === undefined ? '—' : fmtCount(n.collects))),
            h('span', null, '分享 ' + (n.shares === null || n.shares === undefined ? '—' : fmtCount(n.shares))),
            h('span', null, '评论 ' + (n.comments === null || n.comments === undefined ? '—' : fmtCount(n.comments))),
            n.publishedLabel ? h('span', null, '发布：' + n.publishedLabel) : null,
            imgs.length > 0 ? h('span', null, '配图 ' + imgs.length + ' 张') : null),
          imgs.length > 1 ? h('span', { style: { display: 'flex', gap: 6, marginTop: 6 } },
            imgs.slice(1, 5).map((u, i) => h('img', { key: u + '-' + i, src: u, alt: (n.title || '笔记') + ' 配图 ' + (i + 2), style: { width: 32, height: 32, borderRadius: 6, objectFit: 'cover' }, referrerPolicy: 'no-referrer' }))) : null));
    })),
    h('p', { style: { margin: '8px 0 0', fontSize: 12, color: 'var(--color-foreground-muted)' } }, '这些是绑定账号自己的笔记，已同步进「发布日历」的已发布归档（标记为已发布）；「竞对监控」页是监测其他账号的地方，两边数据分开存。'));
}

// ---------- 账号管理 ----------
function AccountView({ settings, accounts, fetchedNotes, notes, assets, gate, onQrLogin, qrFeedbackBox, go, onboarding, imageGenSettings, sharedRequests, sharedPendingCount, hotspotFeed, onReload }) {
  const [dirLabel, setDirLabel] = useState((settings && settings.dataDirLabel) || '');
  const [dirSaved, setDirSaved] = useState(false);
  const [unbindConfirmId, setUnbindConfirmId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [apiModel, setApiModel] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiSaved, setApiSaved] = useState(false);
  const [backendChoice, setBackendChoice] = useState('muse');
  const [apiTestNote, setApiTestNote] = useState('');
  const [apiTestOk, setApiTestOk] = useState(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [imgGenSeeded, setImgGenSeeded] = useState(false);
  const [firstUseMsg, setFirstUseMsg] = useState('');
  const [firstUseBusy, setFirstUseBusy] = useState(false);
  const [xBusy, setXBusy] = useState(false);

  useEffect(() => {
    if (imageGenSettings && !imgGenSeeded) {
      setApiBaseUrl(imageGenSettings.apiBaseUrl || '');
      setApiModel(imageGenSettings.apiModel || '');
      setBackendChoice(imageGenSettings.preferredBackend || 'muse');
      setImgGenSeeded(true);
    }
  }, [imageGenSettings, imgGenSeeded]);

  const apiKeySet = imageGenSettings ? !!imageGenSettings.apiKeySet : false;
  const xLogin = hotspotFeed && hotspotFeed.xLogin;
  const primaryAccount = (accounts || []).find((a) => a.monitored) || (accounts || [])[0] || null;
  const gateFor = (accountId) => !!(gate && gate.canFetch && gate.accountId === accountId);

  const saveSettings = async () => {
    setBusy(true);
    try { await api('updatesettings', { dataDirLabel: dirLabel.trim() }); setDirSaved(true); setTimeout(() => setDirSaved(false), 2000); if (onReload) await onReload(); }
    catch (e) { /* 保存失败时静默，按钮仍可再点 */ }
    finally { setBusy(false); }
  };
  const saveImageGen = async (opts) => {
    opts = opts || {};
    setBusy(true);
    try {
      await api('updateimagegensettings', {
        apiBaseUrl: apiBaseUrl.trim(), apiModel: apiModel.trim(), apiKey: apiKeyInput,
        clearApiKey: !!opts.clearApiKey, clearAll: !!opts.clearAll,
        preferredBackend: opts.backend || backendChoice,
      });
      setApiKeyInput(''); setApiSaved(true); setConfirmClearAll(false);
      setTimeout(() => setApiSaved(false), 2000);
      if (onReload) await onReload();
    } catch (e) { setApiTestNote('保存失败：' + (e && e.message ? e.message : String(e))); setApiTestOk(false); }
    finally { setBusy(false); }
  };
  const testImageApi = async () => {
    try {
      const res = await api('testimagegenapi', {});
      setApiTestOk(!!(res && res.ok));
      setApiTestNote((res && res.message) || (res && res.ok ? '连接正常。' : '连接失败。'));
    } catch (e) { setApiTestOk(false); setApiTestNote('测试没能完成：' + (e && e.message ? e.message : String(e))); }
  };
  const startFirstUse = async () => {
    setFirstUseBusy(true);
    try {
      const res = await api('startfirstuselogin', {});
      setFirstUseMsg((res && res.message) || '已唤起两个登录页。');
      if (onReload) await onReload();
    } catch (e) { setFirstUseMsg('唤起失败：' + (e && e.message ? e.message : String(e))); }
    finally { setFirstUseBusy(false); }
  };
  const startXLogin = async () => {
    setXBusy(true);
    try { await api('startxlogin', {}); if (onReload) await onReload(); }
    catch (e) { /* 失败时热点页会显示原因 */ }
    finally { setXBusy(false); }
  };
  const checkXLoginAcct = async () => {
    setXBusy(true);
    try { await api('checkxloginstatus', {}); if (onReload) await onReload(); }
    catch (e) { /* 同上 */ }
    finally { setXBusy(false); }
  };
  const startBind = async () => {
    setBusy(true);
    try {
      const res = await api('startbindloggedinaccount', {});
      if (res && res.loginUrl) window.open(res.loginUrl, '_blank', 'noopener,noreferrer');
      if (onReload) await onReload();
    } catch (e) { /* 失败时服务端消息经 getstate 回显 */ }
    finally { setBusy(false); }
  };
  const doAction = async (action, args) => {
    try { await api(action, args); if (onReload) await onReload(); } catch (e) { /* 失败时由轮询回显状态 */ }
  };
  const bindInProgress = (accounts || []).some((a) => a.infoFetchStatus === 'fetching' && a.xhsId === '');

  const steps = [
    { done: !!((settings && settings.dataDirLabel)), label: '指定数据文件夹', action: '去指定', run: () => { const el = document.getElementById('dir-label'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } },
    { done: (accounts || []).length > 0, label: '绑定小红书账号', action: '去绑定', run: () => { const el = document.getElementById('bound-accounts'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } },
    { done: (assets || []).length > 0, label: '添加图片素材（生成笔记时选文件夹、上传或生图）', action: '去添加', run: () => go('make') },
    { done: (notes || []).length > 0, label: '生成第一篇图文笔记', action: '去生成', run: () => go('make') },
  ];
  const allStepsDone = steps.every((s) => s.done);
  const gateVerdictLabel = !gate ? '读取中…' : gate.verdict === 'logged_in' ? '已登录' : gate.verdict === 'logged_out' ? '未登录' : '无法确定';

  return h('div', { style: { width: '100%' } },
    h('h2', null, '账号管理'),
    primaryAccount
      ? h('div', { className: 'xhs-banner' },
        h(AccountAvatar, { nickname: primaryAccount.nickname, avatarUrl: primaryAccount.avatarUrl, size: 48 }),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('p', { className: 't', style: { margin: 0 } }, primaryAccount.nickname),
          h('p', { className: 's', style: { margin: 0 } },
            (primaryAccount.xhsId ? '小红书号 ' + primaryAccount.xhsId + ' · ' : '') + '主账号' +
            (gate && gate.accountId === primaryAccount.id
              ? gate.verdict === 'logged_in' ? ' · 已登录' : gate.verdict === 'logged_out' ? ' · 未登录，请扫码登录' : gate.checkInFlight ? ' · 正在确认登录态…' : ' · 登录态暂时无法确定' : '') +
            ((settings && settings.dataDirLabel) ? ' · 数据文件夹：' + settings.dataDirLabel : ''))),
        h('button', { type: 'button', className: 'xhs-btn primary', style: { flexShrink: 0 }, onClick: () => go('make') }, '写新笔记'))
      : h('div', { className: 'xhs-banner' },
        h('div', null,
          h('p', { className: 't', style: { margin: 0 } }, '先花一分钟把工作台支起来'),
          h('p', { style: { margin: '4px 0 0', fontSize: 14, opacity: 0.7 } }, '指定文件夹、扫码绑定账号，然后就能在「笔记制作」里生成第一篇小红书图文笔记。'))),
    !allStepsDone ? h('section', { className: 'xhs-card', style: { marginTop: 20 } },
      h('h3', { style: { fontSize: 16 } }, '上手清单'),
      h('ul', { style: { margin: '8px 0 0', padding: 0, listStyle: 'none' } }, steps.map((s) =>
        h('li', { key: s.label, style: { display: 'flex', alignItems: 'center', gap: 12, fontSize: 14, padding: '4px 0' } },
          h('span', { style: { display: 'flex', width: 20, height: 20, alignItems: 'center', justifyContent: 'center', borderRadius: '50%', fontSize: 11, fontWeight: 700, background: s.done ? 'var(--color-primary)' : 'transparent', border: s.done ? 'none' : '1px solid var(--color-border)', color: s.done ? '#fff' : 'var(--color-foreground-muted)' } }, s.done ? '✓' : ''),
          h('span', { style: s.done ? { color: 'var(--color-foreground-muted)', textDecoration: 'line-through' } : {} }, s.label),
          !s.done ? h('button', { type: 'button', onClick: s.run, style: { marginLeft: 'auto', background: 'none', border: 0, color: 'var(--color-primary)', fontWeight: 500, fontSize: 14 } }, s.action + ' →') : null)))) : null,
    h('section', { className: 'xhs-card', style: { marginTop: 16 } },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
        h('span', { className: 'xhs-chip ' + (gate && gate.verdict === 'logged_in' ? 'green' : gate && gate.verdict === 'logged_out' ? 'red' : 'gray'), style: { fontSize: 12 } }, gateVerdictLabel),
        gate && gate.nickname ? h('span', { style: { fontSize: 14, fontWeight: 500 } }, gate.nickname) : null,
        h('span', { style: { fontSize: 12, color: 'var(--color-foreground-muted)' } }, '全工作台统一登录态 · 只认这一个结论 · 每 60 秒握手一次确认')),
      h('p', { style: { marginTop: 8, fontSize: 14, lineHeight: 1.6 } }, (gate && gate.message) || '正在读取统一登录状态…'),
      h('div', { style: { marginTop: 8, fontSize: 12, lineHeight: 1.6, color: 'var(--color-foreground-muted)' } },
        h('p', { style: { margin: '4px 0' } },
          '工作台记录的登录态：' +
          (gate && gate.recordedStatus === 'verified' ? '已成功读取过已登录账号信息'
            : gate && gate.recordedStatus === 'verifying' ? '正在读取中'
            : gate && gate.recordedStatus === 'failed' ? '上次读取未成功'
            : gate && gate.recordedStatus === 'none' ? '还没有绑定账号' : '尚未读取') +
          (gate && gate.lastConfirmedAt ? ' · 最近确认 ' + fmtTime(gate.lastConfirmedAt) : ' · 还没有确认过')),
        h('p', { style: { margin: '4px 0' } },
          '最近一次握手（工作台自己的浏览器会话）：' +
          (gate && gate.handshakeStatus === 'checking' ? '正在确认…'
            : gate && gate.handshakeStatus === 'valid' ? '确认仍登录着'
            : gate && gate.handshakeStatus === 'expired' ? '确认已未登录'
            : gate && gate.handshakeStatus === 'idle' ? '还没握手过，60 秒内会自动进行'
            : gate && gate.handshakeTimedOut ? '超时无回写，没能确定（不等于掉登录）' : '没能确定（不等于掉登录）') +
          (gate && gate.lastHandshakeAt ? ' · 尝试于 ' + fmtTime(gate.lastHandshakeAt) : '') +
          (gate && gate.handshakeMessage ? ' · ' + humanizeFailureText(gate.handshakeMessage) : '')),
        h('p', { style: { margin: '4px 0' } },
          '共用会话（Muse 聊天里你能看到的浏览器）：' +
          (gate && gate.sharedState === 'logged_in' ? '确认已登录' + (gate.sharedNickname ? '「' + gate.sharedNickname + '」' : '')
            : gate && gate.sharedState === 'logged_out' ? '确认未登录' : '还没有确认过') +
          (gate && gate.sharedAt ? ' · 确认于 ' + fmtTime(gate.sharedAt) : '') +
          (gate && gate.sharedMessage ? ' · ' + gate.sharedMessage : '')),
        gate && gate.verdict === 'logged_in' ? h('p', { style: { margin: '4px 0' } },
          '当前登录来源：' +
          (gate.loginSource === 'shared_browser'
            ? '共用会话——读取和发布走你能看到的那个已登录浏览器；工作台自己的任务浏览器未登录时，工作会登记到下方「共用会话请求清单」，不会再被它的掉线推翻。'
            : '工作台自己的浏览器会话。') +
          (gate.pendingSharedRequests > 0 ? ' 当前有 ' + gate.pendingSharedRequests + ' 项共用会话工作待处理。' : '')) : null),
      gate && gate.qrWaiting ? h('div', { className: 'xhs-note-box warn', style: { marginTop: 12, padding: '10px 12px', fontSize: 14 } },
        h('p', { style: { margin: 0, fontWeight: 500 } }, '已派发扫码登录，正在等你扫码。'),
        h('p', { style: { margin: '2px 0 0' } },
          '已派发浏览器打开小红书登录页' + (gate.qrLastOpenedAt ? '（' + fmtTime(gate.qrLastOpenedAt) + ' 派发）' : '') + '，请用小红书 App 扫一扫并在手机上确认登录；如果浏览器本来就是登录状态，会直接读取账号信息，不用扫码。派发只说明任务已经发出——要是浏览器没有弹出来，点下方「在浏览器打开小红书」在你自己的浏览器里打开登录页，扫完再点「我已扫码，重新读取账号信息」。' +
          (gate.qrWaitDeadlineAt ? '这次等待最晚到 ' + fmtTime(gate.qrWaitDeadlineAt) + '，超时后会如实显示原因，不会反复自动打开。' : ''))) : null,
      gate && gate.verdict === 'logged_out' ? h('button', { type: 'button', className: 'xhs-btn primary', style: { marginTop: 10 }, onClick: onQrLogin }, '打开浏览器扫码登录') : null,
      gate && gate.verdict === 'unknown' ? h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 10 } },
        h('button', { type: 'button', className: 'xhs-btn', onClick: onQrLogin }, '打开浏览器扫码登录'),
        h('span', { style: { fontSize: 12, color: 'var(--color-foreground-muted)' } }, '也可以等下一次每 60 秒握手自动确认。')) : null,
      qrFeedbackBox ? h('div', { style: { marginTop: 12 } }, qrFeedbackBox) : null),
    h('section', { className: 'xhs-card', style: { marginTop: 16 } },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
        h('h3', { style: { fontSize: 16 } }, '共用会话请求清单'),
        h('span', { className: 'xhs-chip gray' }, '待处理 ' + (sharedPendingCount || 0) + ' 项')),
      h('p', { style: { marginTop: 6, fontSize: 14, lineHeight: 1.6, color: 'var(--color-foreground-muted)' } }, '登录在 Muse 聊天里那个你能看到的浏览器上时（共用会话），拉取、检查和发布这些工作由 Muse 在那个已登录浏览器里完成再写回工作台——工作台和它共用同一个登录会话，不再各看各的。待处理的项会显示在这里；回到 Muse 聊天里说一声「按共用会话请求清单处理」，Muse 就会逐项做完，这里的状态会自动变成已完成。'),
      (!sharedRequests || sharedRequests.length === 0)
        ? h('p', { style: { marginTop: 12, fontSize: 14, color: 'var(--color-foreground-muted)' } }, '目前没有共用会话请求。')
        : h('ul', { style: { margin: '12px 0 0', padding: 0, listStyle: 'none' } }, sharedRequests.map((r) =>
          h('li', { key: r.id, style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--color-border)' } },
            h('span', { className: 'xhs-chip ' + (r.status === 'pending' ? 'red' : r.status === 'fulfilled' ? 'green' : 'gray') },
              r.status === 'pending' ? '待处理' : r.status === 'fulfilled' ? '已完成' : '已取消'),
            h('span', { style: { fontSize: 14, fontWeight: 500 } }, SHARED_KIND_LABELS[r.kind] || r.kind),
            r.noteId !== null && r.noteId !== undefined ? h('span', { style: { fontSize: 12, color: 'var(--color-foreground-muted)' } }, '笔记 #' + r.noteId) : null,
            r.monitoredAccountId !== null && r.monitoredAccountId !== undefined ? h('span', { style: { fontSize: 12, color: 'var(--color-foreground-muted)' } }, '监测账号 #' + r.monitoredAccountId) : null,
            h('span', { style: { fontSize: 12, color: 'var(--color-foreground-muted)' } }, '登记于 ' + fmtTime(r.createdAt)),
            r.status === 'fulfilled' && r.resultMessage ? h('span', { style: { width: '100%', fontSize: 12, lineHeight: 1.6, color: 'var(--color-foreground-muted)' } }, r.resultMessage) : null,
            r.status === 'pending' ? h('button', { type: 'button', onClick: () => doAction('cancelsharedsessionrequest', { id: r.id }), style: { marginLeft: 'auto', background: 'none', border: 0, fontSize: 12, fontWeight: 500, color: 'var(--color-foreground-muted)', textDecoration: 'underline' } }, '取消') : null)))),
    onboarding && onboarding.isFirstUse ? h('section', { className: 'xhs-card', style: { marginTop: 16, borderColor: 'var(--color-primary)', background: 'var(--color-primary-soft)' } },
      h('h3', { style: { fontSize: 16 } }, '首次使用工作台：先登录小红书和 X'),
      h('p', { style: { marginTop: 6, fontSize: 14, lineHeight: 1.6 } }, '工作台第一次打开时已自动为你唤起浏览器：小红书用 App 扫码登录（登录后账号信息会自动读回来成为主账号）；X 打开的是 X 自己的登录页，邮箱和密码由你自己输在 X 页面里，工作台不碰密码、不保存任何凭据。如果浏览器没有弹出来，点下面按钮再唤起一次。'),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 } },
        h('button', { type: 'button', className: 'xhs-btn primary', disabled: firstUseBusy, onClick: startFirstUse }, firstUseBusy ? '正在唤起两个登录…' : '唤起小红书扫码 + X 登录页'),
        h('button', { type: 'button', className: 'xhs-btn', disabled: xBusy, onClick: startXLogin }, '只打开 X 登录页')),
      firstUseMsg ? h('p', { style: { marginTop: 8, fontSize: 14, lineHeight: 1.6 } }, firstUseMsg) : null) : null,
    h('section', { style: { marginTop: 24 } },
      h('h3', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 16 } }, h(Icon, { d: ICONS.folder, style: { width: 20, height: 20, color: 'var(--color-primary)' } }), '数据文件夹'),
      h('p', { style: { marginTop: 4, fontSize: 14, lineHeight: 1.6, color: 'var(--color-foreground-muted)' } }, '在这里填一个你电脑或手机上的文件夹路径，作为工作目录备注：笔记、账号和数据记录都按这个目录名归档在工作台里；生成笔记时，参考附图也从这个目录里按文件路径逐张指定。这里只记录路径，不会读取或展示这个文件夹里的图片。'),
      h('label', { style: { display: 'block', marginTop: 12, fontSize: 14, fontWeight: 600 } }, '文件夹路径'),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 } },
        h('input', { id: 'dir-label', className: 'xhs-input', style: { flex: 1, minWidth: 200 }, value: dirLabel, onChange: (e) => setDirLabel(e.target.value), placeholder: '比如：D:\\小红书素材 或 素材/穿搭' }),
        h('button', { type: 'button', className: 'xhs-btn dark', disabled: busy, onClick: saveSettings }, dirSaved ? '已保存' : '保存目录'))),
    h('section', { style: { marginTop: 40 } },
      h('h3', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 16 } },
        h(Icon, { d: ICONS.image, style: { width: 20, height: 20, color: 'var(--color-primary)' } }), '生图后端与 API 管理',
        h('span', { style: { fontSize: 14, fontWeight: 400, color: apiKeySet ? 'var(--color-success)' : 'var(--color-foreground-muted)' } }, apiKeySet ? 'API Key 已保存' : 'API 还没有填 Key')),
      h('p', { style: { marginTop: 4, fontSize: 14, lineHeight: 1.6, color: 'var(--color-foreground-muted)' } }, '生图有三个后端，在「笔记制作」里逐张选、这里设默认：Muse 用当前平台的生图能力；DSH 在 DSH 工作台里用；API 走下面配的 OpenAI 兼容接口。Key 只保存在工作台服务端、生图和测试时由服务端带上，任何页面都不会回显已保存的 Key；选了 API 后端但这里没填 Key 时，生成页会明确提示来这里填，不会假装能生成。'),
      h('p', { style: { margin: '12px 0 0', fontSize: 14, fontWeight: 600 } }, '默认生图后端（笔记制作打开时的预选，逐张还能改）'),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 } },
        IMAGE_BACKENDS.map((b) =>
          h('button', { key: b.value, type: 'button', disabled: busy, onClick: () => { setBackendChoice(b.value); saveImageGen({ backend: b.value }); }, className: 'xhs-btn' + (backendChoice === b.value ? ' primary' : '') }, b.label)),
        h('span', { style: { alignSelf: 'center', fontSize: 12, color: 'var(--color-foreground-muted)' } },
          backendChoice === 'muse' ? 'Muse：当前平台可用，直接生成。'
            : backendChoice === 'dsh' ? 'DSH：在 DSH 工作台里用。'
            : apiKeySet ? 'API：Key 已保存，将走下面的接口生成。' : 'API：还没填 Key，填好保存后才能生成。')),
      h('label', { style: { display: 'block', marginTop: 16, fontSize: 14, fontWeight: 600 } }, '接口地址（Base URL）'),
      h('input', { className: 'xhs-input', style: { marginTop: 6 }, value: apiBaseUrl, onChange: (e) => setApiBaseUrl(e.target.value), placeholder: '比如：https://api.openai.com/v1（留空按 OpenAI 官方地址）' }),
      h('div', { style: { display: 'grid', gap: 12, marginTop: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' } },
        h('div', null,
          h('label', { style: { display: 'block', fontSize: 14, fontWeight: 600 } }, '生图模型'),
          h('input', { className: 'xhs-input', style: { marginTop: 6 }, value: apiModel, onChange: (e) => setApiModel(e.target.value), placeholder: '比如：gpt-image-1（留空按 gpt-image-1）' })),
        h('div', null,
          h('label', { style: { display: 'block', fontSize: 14, fontWeight: 600 } }, 'API Key' + (apiKeySet ? '（已保存，不回显）' : '')),
          h('input', { type: 'password', autoComplete: 'off', className: 'xhs-input', style: { marginTop: 6 }, value: apiKeyInput, onChange: (e) => setApiKeyInput(e.target.value), placeholder: apiKeySet ? '已保存，留空保存不会改动；要换 Key 直接粘贴新的' : '粘贴你的 API Key' }))),
      h('p', { style: { marginTop: 6, fontSize: 12, lineHeight: 1.6, color: 'var(--color-foreground-muted)' } },
        '实际生效：接口 ' + ((imageGenSettings && imageGenSettings.effectiveBaseUrl) || 'https://api.openai.com/v1') + ' · 模型 ' + ((imageGenSettings && imageGenSettings.effectiveModel) || 'gpt-image-1') + ' · Key ' +
        (apiKeySet ? '已保存' + ((imageGenSettings && imageGenSettings.apiKeyUpdatedAt) ? '（' + fmtTime(imageGenSettings.apiKeyUpdatedAt) + ' 更新）' : '') + '，页面不显示 Key 内容' : '未保存——选 API 后端生图时会提示先来这里填')),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 } },
        h('button', { type: 'button', className: 'xhs-btn dark', disabled: busy, onClick: () => saveImageGen({}) }, apiSaved ? '已保存' : '保存生图 API 设置'),
        h('button', { type: 'button', className: 'xhs-btn', disabled: busy || !apiKeySet, onClick: testImageApi }, '测试 API 连接'),
        apiKeySet ? h('button', { type: 'button', className: 'xhs-btn', style: { color: 'var(--color-primary)' }, disabled: busy, onClick: () => saveImageGen({ clearApiKey: true }) }, '清除已保存的 Key') : null,
        confirmClearAll
          ? h('span', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: { fontSize: 14, color: 'var(--color-foreground-muted)' } }, '清空接口地址、模型和 Key，恢复默认？'),
            h('button', { type: 'button', className: 'xhs-btn primary', disabled: busy, onClick: () => saveImageGen({ clearAll: true }) }, '确认清空全部'),
            h('button', { type: 'button', className: 'xhs-btn', onClick: () => setConfirmClearAll(false) }, '取消'))
          : (apiKeySet || apiBaseUrl || apiModel) ? h('button', { type: 'button', className: 'xhs-btn', style: { color: 'var(--color-primary)' }, disabled: busy, onClick: () => setConfirmClearAll(true) }, '清空全部配置') : null),
      !apiKeySet ? h('p', { style: { marginTop: 6, fontSize: 12, color: 'var(--color-foreground-muted)' } }, '「测试 API 连接」要先保存 Key 才能点。') : null,
      apiTestNote ? h('p', { style: { marginTop: 8, fontSize: 14, lineHeight: 1.6, color: apiTestOk ? 'var(--color-success)' : 'var(--color-primary)' } }, apiTestNote) : null),
    h('section', { style: { marginTop: 40 } },
      h('h3', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 16 } },
        h(Icon, { d: ICONS.user, style: { width: 20, height: 20, color: 'var(--color-primary)' } }), 'X 账号',
        h('span', { className: 'xhs-chip ' + (xLogin && xLogin.status === 'logged_in' ? 'green' : xLogin && xLogin.status === 'logged_out' ? 'red' : 'gray') },
          !xLogin ? '还没有确认过' : xLogin.status === 'logged_in' ? '已登录' : xLogin.status === 'logged_out' ? '未登录' : xLogin.status === 'checking' ? '正在确认…' : '还没有确认过')),
      h('p', { style: { marginTop: 4, fontSize: 14, lineHeight: 1.6, color: 'var(--color-foreground-muted)' } }, 'X 只用于热点资讯检索（固定 12 小时一次、每次最多 50 条）。登录由你本人在 X 的登录页完成：点「打开 X 登录页」后，在唤起的浏览器里用你自己的邮箱和密码登录——密码只输进 X 的页面，工作台不接收、不保存任何 X 凭据，这里只保存「是否登录」这个确认结果。'),
      xLogin && xLogin.checkedAt ? h('p', { style: { marginTop: 6, fontSize: 12, color: 'var(--color-foreground-muted)' } },
        '最近确认：' + fmtTime(xLogin.checkedAt) +
        (xLogin.checkMethod === 'random_browse' ? ' · 方式：随机浏览检查' + ((xLogin.browsedPages || []).length > 0 ? '（浏览了 ' + (xLogin.browsedPages || []).join('、') + '）' : '')
          : xLogin.checkMethod === 'random_browse_inconclusive' ? ' · 方式：随机浏览（没能给出结论，下一次 X 检索会再判断）'
          : xLogin.checkMethod === 'search' ? ' · 方式：X 检索时判断'
          : xLogin.checkMethod === 'login_flow' ? ' · 方式：打开登录页后判断' : '')) : null,
      xLogin && xLogin.message ? h('p', { style: { marginTop: 6, fontSize: 14, lineHeight: 1.6 } }, humanizeFailureText(xLogin.message)) : null,
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 } },
        h('button', { type: 'button', className: 'xhs-btn primary', disabled: xBusy || (xLogin && xLogin.status === 'checking'), onClick: startXLogin }, xLogin && xLogin.status === 'checking' ? 'X 登录处理中…' : '打开 X 登录页'),
        h('button', { type: 'button', className: 'xhs-btn', disabled: xBusy || (xLogin && xLogin.status === 'checking'), onClick: checkXLoginAcct }, '随机浏览检查 X 登录态')),
      h('p', { style: { marginTop: 6, fontSize: 12, lineHeight: 1.6, color: 'var(--color-foreground-muted)' } }, '随机浏览检查：在浏览器里像正常用户一样打开 X 首页、搜索页等几个页面，看是否还是登录状态；浏览后仍判断不了时，会如实记为「没能确定」，并以下一次 X 检索时的判断兜底，绝不猜测登录状态。')),
    h('section', { style: { marginTop: 40 }, id: 'bound-accounts' },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
        h('h3', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 16 } },
          h(Icon, { d: ICONS.user, style: { width: 20, height: 20, color: 'var(--color-primary)' } }), '小红书账号',
          h('span', { style: { fontSize: 14, fontWeight: 400, color: 'var(--color-foreground-muted)' } }, (accounts || []).length + ' 个')),
        h('button', { type: 'button', className: 'xhs-btn primary', style: { flexShrink: 0 }, disabled: busy || bindInProgress, onClick: startBind }, busy || bindInProgress ? '正在唤起浏览器扫码…' : '+ 绑定新账号')),
      h('p', { style: { marginTop: 8, fontSize: 14, lineHeight: 1.6, color: 'var(--color-foreground-muted)' } }, '绑定不用填任何账号信息：点「+ 绑定新账号」会唤起浏览器打开小红书登录页，你用小红书 App 扫码登录后，后台会自动读取登录账号的昵称、头像、小红书号、主页和关注 / 粉丝 / 获赞与收藏，生成绑定记录；之后获取的笔记也会按这个登录账号归属存储。这里只放你自己扫码登录的绑定账号；想监测别人的账号，去「竞对监控」页粘贴对方的主页链接添加监测账号，两边的数据分开存、互不影响。'),
      (accounts || []).length === 0 ? h('p', { style: { marginTop: 8, fontSize: 14, color: 'var(--color-foreground-muted)' } }, '还没有绑定账号，点右上角「+ 绑定新账号」扫码登录即可。') : null,
      h('div', { style: { marginTop: 12, display: 'grid', gap: 8 } }, (accounts || []).map((a) => {
        const ownFetched = (fetchedNotes || []).filter((n) => n.accountId === a.id);
        const missing = ownFetched.filter((n) => !n.images || n.images.length === 0).length;
        return h('div', { key: a.id, className: 'xhs-card', style: { marginBottom: 0 } },
          h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
            h(AccountAvatar, { nickname: a.nickname, avatarUrl: a.avatarUrl, size: 36 }),
            h('span', { style: { fontSize: 16, fontWeight: 600 } }, a.nickname),
            a.monitored ? h('span', { className: 'xhs-chip red' }, '主账号') : null,
            gateFor(a.id) ? h('span', { className: 'xhs-chip green' }, '已登录') : null,
            a.xhsId ? h('span', { style: { fontSize: 14, color: 'var(--color-foreground-muted)' } }, '小红书号：' + a.xhsId) : null),
          a.note ? h('p', { style: { margin: '6px 0 0', fontSize: 14, color: 'var(--color-foreground-muted)' } }, a.note) : null,
          a.homepage ? h('a', { href: a.homepage, target: '_blank', rel: 'noreferrer', style: { display: 'block', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, color: 'var(--color-link)' } }, a.homepage) : null,
          (a.followingCount !== null || a.followersCount !== null || a.likesCollectsCount !== null)
            ? h('p', { style: { display: 'flex', flexWrap: 'wrap', gap: 16, margin: '6px 0 0', fontSize: 14, color: 'var(--color-foreground-muted)' } },
              h('span', null, '关注 ' + (a.followingCount === null ? '—' : fmtCount(a.followingCount))),
              h('span', null, '粉丝 ' + (a.followersCount === null ? '—' : fmtCount(a.followersCount))),
              h('span', null, '获赞与收藏 ' + (a.likesCollectsCount === null ? '—' : fmtCount(a.likesCollectsCount)))) : null,
          gateFor(a.id) && !a.avatarUrl ? h('p', { style: { margin: '6px 0 0', fontSize: 12, color: 'var(--color-foreground-muted)' } }, '头像暂时还是昵称首字占位：上次获取账号信息时没有读到真实头像，下次点「重新获取已登录账号信息」时会一并读取。') : null,
          h('p', { style: { margin: '12px 0 0', fontSize: 12, fontWeight: 600, color: 'var(--color-foreground-muted)' } }, '账号信息读取（与下面的笔记拉取是两条独立的线，状态分开显示）'),
          h('div', { className: 'xhs-note-box', style: { marginTop: 6, fontSize: 14, background: a.infoFetchStatus === 'done' ? 'var(--color-success-soft)' : a.infoFetchStatus === 'failed' ? 'var(--color-primary-soft)' : 'var(--color-surface-alt)' } },
            a.infoFetchStatus === 'fetching'
              ? h('div', null,
                h('p', { style: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500, margin: 0 } }, h('span', { className: 'xhs-pulse-dot' }),
                  ((a.infoFetchMessage || a.loginMessage || '').includes('已自动唤起') ? '上次获取没完成，已自动打开登录页，正在等待扫码登录…' : '正在获取已登录账号信息…')),
                h('p', { style: { margin: '4px 0 0' } }, humanizeFailureText(a.infoFetchMessage || a.loginMessage) || '浏览器已打开小红书：已登录时会直接读取当前账号信息；未登录时会停在登录二维码页面，请用小红书 App 扫码并在手机上确认登录，登录后会自动读取账号信息。'),
                h('div', { className: 'xhs-progress thin', style: { marginTop: 8 } }, h('i', { className: 'slide' })))
              : a.infoFetchStatus === 'done'
                ? h('p', { style: { margin: 0 } }, h('span', { style: { fontWeight: 500, color: 'var(--color-success)' } }, '已获取已登录账号信息。'), (a.infoFetchMessage || a.loginMessage || '') + (a.loginVerifiedAt ? ' · 获取于 ' + fmtTime(a.loginVerifiedAt) : '') + (gateFor(a.id) ? ' 这个账号就是当前统一登录态的账号，登录态由统一门禁每 60 秒握手维持。' : ''))
                : a.infoFetchStatus === 'failed'
                  ? h('div', null,
                    h('p', { style: { margin: 0 } }, h('span', { style: { fontWeight: 500, color: 'var(--color-primary)' } }, '未能获取已登录账号信息。'), humanizeFailureText(a.infoFetchMessage || a.loginMessage) || '扫码登录未完成，或页面读取失败。'),
                    h('button', { type: 'button', className: 'xhs-btn primary mini', style: { marginTop: 8 }, onClick: () => doAction('startfetchloggedininfo', { accountId: a.id }) }, '唤起浏览器扫码登录并重试'))
                  : h('p', { style: { margin: 0 } }, '尚未获取已登录账号信息。点下方「获取已登录账号信息」会唤起浏览器：已经登录时直接读取当前账号的昵称、小红书号和主页并显示在这里；未登录时会先让你用小红书 App 扫码登录，登录后自动读取。获取成功后才会显示这个账号的登录状态，获取前也不会获取这个账号的笔记。')),
          h('p', { style: { margin: '12px 0 0', fontSize: 12, fontWeight: 600, color: 'var(--color-foreground-muted)' } }, '真实笔记拉取'),
          h('div', { className: 'xhs-note-box', style: { marginTop: 6, fontSize: 14, background: a.fetchStatus === 'failed' ? 'var(--color-primary-soft)' : 'var(--color-surface-alt)' } },
            a.fetchStatus === 'fetching'
              ? h('div', null,
                h('p', { style: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500, margin: 0 } }, h('span', { className: 'xhs-pulse-dot' }), '正在获取真实笔记…'),
                h('p', { style: { margin: '4px 0 0' } }, a.fetchMessage || '正在打开小红书网页版读取这个账号的笔记，通常要一两分钟。'),
                h('div', { className: 'xhs-progress thin', style: { marginTop: 8 } }, h('i', { className: 'slide' })))
              : a.fetchStatus === 'done'
                ? h('p', { style: { margin: 0 } }, (a.fetchMessage || '已获取 ' + (a.fetchedCount || ownFetched.length) + ' 篇真实笔记。') + (a.fetchedAt ? ' · ' + fmtTime(a.fetchedAt) : ''))
                : a.fetchStatus === 'failed'
                  ? h('p', { style: { margin: 0 } }, h('span', { style: { fontWeight: 500, color: 'var(--color-primary)' } }, '获取失败。'), humanizeFailureText(a.fetchMessage) || '请点「重新获取」再试一次。')
                  : gateFor(a.id)
                    ? h('p', { style: { margin: 0 } }, '统一登录态正常，点下方「获取真实笔记」开始获取这个账号的真实笔记。')
                    : h('p', { style: { margin: 0 } }, '统一登录态未确认这个账号已登录，不会获取笔记。先确认上方统一登录状态（失效时重新扫码登录），再获取真实笔记。')),
          h(FetchedNotesList, { notes: ownFetched, homepageUrl: a.homepage || undefined, onRefetch: () => doAction('startfetchaccountnotes', { accountId: a.id }), refetchDisabled: a.fetchStatus === 'fetching' }),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 } },
            h('button', { type: 'button', className: 'xhs-btn primary mini', disabled: a.fetchStatus === 'fetching' || !gateFor(a.id), onClick: () => doAction('startfetchaccountnotes', { accountId: a.id }) },
              a.fetchStatus === 'fetching' ? '获取中…' : a.fetchStatus === 'idle' ? '获取真实笔记' : '重新获取真实笔记'),
            !gateFor(a.id) && a.fetchStatus !== 'fetching' ? h('span', { style: { alignSelf: 'center', fontSize: 12, color: 'var(--color-foreground-muted)' } }, '统一登录态未确认这个账号已登录，不会获取笔记——先看上方统一登录状态，失效时重新扫码登录。') : null,
            ownFetched.length > 0 ? h('button', { type: 'button', className: 'xhs-btn mini', disabled: a.imageFetchStatus === 'fetching' || !gateFor(a.id) || missing === 0, onClick: () => doAction('startbackfillnoteimages', { accountId: a.id }) },
              a.imageFetchStatus === 'fetching' ? '正在获取配图…' : missing === 0 ? '配图已获取' : '获取配图（' + missing + ' 篇还没有）') : null,
            a.imageFetchStatus === 'failed' ? h('span', { style: { alignSelf: 'center', fontSize: 12, color: 'var(--color-primary)' } }, a.imageFetchMessage || '') : null,
            h('button', { type: 'button', className: 'xhs-btn mini', disabled: a.infoFetchStatus === 'fetching', onClick: () => doAction('startfetchloggedininfo', { accountId: a.id }) },
              a.infoFetchStatus === 'fetching' ? '正在获取已登录账号信息…' : a.infoFetchStatus === 'done' ? '重新获取已登录账号信息' : '获取已登录账号信息'),
            !a.monitored ? h('button', { type: 'button', className: 'xhs-btn mini', onClick: () => doAction('setmonitoredaccount', { id: a.id }) }, '设为主账号') : null,
            unbindConfirmId === a.id
              ? h('span', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('span', { style: { fontSize: 14, color: 'var(--color-foreground-muted)' } }, '解绑后笔记保留、只取消归属，确认？'),
                h('button', { type: 'button', className: 'xhs-btn primary mini', onClick: () => doAction('deleteaccount', { id: a.id }) }, '确认解绑'),
                h('button', { type: 'button', className: 'xhs-btn mini', onClick: () => setUnbindConfirmId(null) }, '取消'))
              : h('button', { type: 'button', className: 'xhs-btn mini', style: { color: 'var(--color-primary)' }, onClick: () => setUnbindConfirmId(a.id) }, '解绑')));
      }))));
}

// ---------- 壳：双层边栏 + 通知 + 刷新 + 门禁 ----------
const NAV_GROUPS = [
  { key: 'notesZone', label: '笔记专区', items: [
    { key: 'calendar', label: '发布日历', icon: ICONS.calendar },
    { key: 'make', label: '笔记制作', icon: ICONS.sparkles },
  ] },
  { key: 'dataZone', label: '数据专区', items: [
    { key: 'competitor', label: '竞对监控', icon: ICONS.chart },
    { key: 'hotspots', label: '热点资讯', icon: ICONS.flame },
    { key: 'leads', label: '留资管理', icon: ICONS.comment },
  ] },
];
const ACCOUNT_ITEM = { key: 'account', label: '账号管理', icon: ICONS.user };
function groupOfTab(t) {
  for (const g of NAV_GROUPS) if (g.items.some((i) => i.key === t)) return g.key;
  return null;
}

function BusinessPanel() {
  const [tab, setTab] = useState('calendar');
  const [state, setState] = useState({
    accounts: [], notes: [], fetchedNotes: [], monitoredAccounts: [], assets: [],
    loginGate: null, handshake: {}, dataFolder: '',
    hotspotFeed: null, leadMonitor: null,
    competitorNotifications: [], competitorUnread: 0,
    leadNotifications: [], leadUnread: 0,
    imageGenSettings: null, onboarding: null,
    sharedRequests: [], sharedPendingCount: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [makePrefill, setMakePrefill] = useState(null);
  const [openGroups, setOpenGroups] = useState({ notesZone: true, dataZone: true });
  const [mobileGroup, setMobileGroup] = useState('notesZone');
  const [notifPanelOpen, setNotifPanelOpen] = useState(false);
  const [popupHiddenIds, setPopupHiddenIds] = useState(new Set());
  const [qrFeedback, setQrFeedback] = useState(null);
  const [qrBusy, setQrBusy] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState(null);
  const [refreshNeedsLogin, setRefreshNeedsLogin] = useState(false);
  const [refreshDoneAt, setRefreshDoneAt] = useState(null);
  const firstUseFiredRef = useRef(false);
  const refreshCycleRef = useRef(false);
  const wasBusyRef = useRef(false);
  const refreshStartedRef = useRef({ infoFetches: 0, noteFetches: 0, monitoredFetches: 0 });

  const loadAll = useCallback(async (silent) => {
    if (!silent) setLoading(true);
    try {
      const data = await api('getstate');
      const extra = await Promise.all([
        apiSafe('listfetchednotes', { accountId: null }),
        apiSafe('listassets', {}),
        apiSafe('gethotspotfeed', {}),
        apiSafe('getleadmonitor', {}),
        apiSafe('listcompetitornotifications', { limit: 50 }),
        apiSafe('listleadnotifications', { limit: 50 }),
        apiSafe('getimagegensettings', {}),
        apiSafe('getonboardingstate', {}),
        apiSafe('listsharedsessionrequests', {}),
      ]);
      const fetchedRes = extra[0];
      const assetsRes = extra[1];
      const hotspotRes = extra[2];
      const leadRes = extra[3];
      const compRes = extra[4];
      const leadNotifRes = extra[5];
      const imgGenRes = extra[6];
      const onboardingRes = extra[7];
      const sharedRes = extra[8];
      const gateRaw = data.loginGate || {};
      const gate = Object.assign({}, gateRaw, {
        verdict: gateRaw.verdict || (gateRaw.state === 'valid' ? 'logged_in' : gateRaw.state === 'needs_scan' ? 'logged_out' : 'unknown'),
        isLoggedIn: gateRaw.isLoggedIn !== undefined ? gateRaw.isLoggedIn : !!gateRaw.verified,
        canFetch: gateRaw.canFetch !== undefined ? gateRaw.canFetch : !!gateRaw.verified,
      });
      const accounts = (data.accounts || []).map((a) => Object.assign({}, a, {
        nickname: a.nickname || a.name || '',
        xhsId: a.xhsId || a.xiaohongshuId || '',
        homepage: a.homepage || a.profileUrl || '',
        avatarUrl: a.avatarUrl || a.avatar || null,
        followingCount: a.followingCount !== undefined ? a.followingCount : (a.following !== undefined ? a.following : null),
        followersCount: a.followersCount !== undefined ? a.followersCount : (a.followers !== undefined ? a.followers : null),
        likesCollectsCount: a.likesCollectsCount !== undefined ? a.likesCollectsCount : (a.likesAndCollects !== undefined ? a.likesAndCollects : null),
        fetchedCount: a.fetchedCount !== undefined ? a.fetchedCount : 0,
        detailFetchStatus: a.detailFetchStatus || 'idle',
        detailFetchMessage: a.detailFetchMessage || '',
        detailFetchTotal: a.detailFetchTotal || 0,
        detailFetchDone: a.detailFetchDone || 0,
      }));
      const notes = (data.notes || []).map((n) => Object.assign({}, n, {
        fetchedImages: imgUrls(n.fetchedImages),
        images: (n.images || []).map((im) => (typeof im === 'string' ? { assetId: null, url: im } : { assetId: im.assetId !== undefined ? im.assetId : null, url: imgUrl(im) })),
        tags: n.tags || [],
        imageIds: n.imageIds || [],
        imageCaptions: n.imageCaptions || [],
      }));
      const fetchedNotes = ((fetchedRes && fetchedRes.notes) || []).map((f) => Object.assign({}, f, { images: imgUrls(f.images) }));
      const monitoredAccounts = (data.monitoredAccounts || []).map((m) => Object.assign({}, m, {
        nickname: m.nickname || m.name || '',
        xhsId: m.xhsId || m.xiaohongshuId || '',
        homepage: m.homepage || m.profileUrl || '',
        avatarUrl: m.avatarUrl || m.avatar || null,
        followingCount: m.followingCount !== undefined ? m.followingCount : (m.following !== undefined ? m.following : null),
        followersCount: m.followersCount !== undefined ? m.followersCount : (m.followers !== undefined ? m.followers : null),
        likesCollectsCount: m.likesCollectsCount !== undefined ? m.likesCollectsCount : (m.likesAndCollects !== undefined ? m.likesAndCollects : null),
        notes: (m.notes || []).map((n) => Object.assign({}, n, {
          images: imgUrls(n.images),
          snapshots: (n.snapshots || []).map((s) => Object.assign({}, s, { at: s.at || s.capturedAt || s.recordedAt || s.fetchedAt || null })),
          latestMetrics: n.latestMetrics || null,
          previousMetrics: n.previousMetrics || null,
          snapshotCount: n.snapshotCount !== undefined ? n.snapshotCount : ((n.snapshots || []).length),
        })),
      }));
      setState((prev) => ({
        accounts,
        notes,
        fetchedNotes,
        monitoredAccounts,
        assets: ((assetsRes && assetsRes.assets) || prev.assets || []).map((a) => Object.assign({}, a, { url: assetUrl(a) })),
        loginGate: gate,
        handshake: data.handshake || prev.handshake || {},
        dataFolder: data.dataFolder || data.dataFolderPath || prev.dataFolder || '',
        hotspotFeed: (hotspotRes && hotspotRes.feed) || (data.hotspotFeed || null),
        leadMonitor: (leadRes && leadRes.monitor) || (data.leadMonitor || null),
        competitorNotifications: (compRes && compRes.notifications) || (data.competitorNotifications || []),
        competitorUnread: (compRes && compRes.unreadCount !== undefined) ? compRes.unreadCount : (data.competitorUnread !== undefined ? data.competitorUnread : 0),
        leadNotifications: (leadNotifRes && leadNotifRes.notifications) || (data.leadNotifications || []),
        leadUnread: (leadNotifRes && leadNotifRes.unreadCount !== undefined) ? leadNotifRes.unreadCount : (data.leadUnread !== undefined ? data.leadUnread : 0),
        imageGenSettings: imgGenRes || data.imageGenSettings || prev.imageGenSettings || null,
        onboarding: (onboardingRes && onboardingRes.onboarding) || data.onboarding || prev.onboarding || null,
        sharedRequests: (sharedRes && sharedRes.requests) || (data.sharedRequests || []),
        sharedPendingCount: (sharedRes && sharedRes.pendingCount !== undefined) ? sharedRes.pendingCount : (data.sharedPendingCount !== undefined ? data.sharedPendingCount : 0),
      }));
      setError('');
    } catch (err) {
      if (!silent) setError('加载失败：' + (err && err.message ? err.message : String(err)));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const reload = useCallback((silent) => loadAll(silent !== false), [loadAll]);

  useEffect(() => { loadAll(false); }, [loadAll]);

  const accounts = state.accounts;
  const anyFetching = accounts.some((a) => a.fetchStatus === 'fetching' || a.infoFetchStatus === 'fetching' || a.imageFetchStatus === 'fetching' || a.detailFetchStatus === 'fetching')
    || (state.monitoredAccounts || []).some((a) => a.fetchStatus === 'fetching')
    || (state.leadMonitor && state.leadMonitor.dm && state.leadMonitor.dm.status === 'fetching')
    || (state.hotspotFeed && (state.hotspotFeed.xhs.status === 'fetching' || state.hotspotFeed.x.status === 'fetching'));

  // 轮询：有拉取在途时每 4 秒，平时每 15 秒；在途时顺带同步任务状态，
  // 没回写的任务会如实标失败、而不是一直转圈。
  useEffect(() => {
    const ms = anyFetching ? 4000 : 15000;
    const t = setInterval(() => {
      if (anyFetching) {
        apiSafe('syncfetchstatuses', {});
        apiSafe('syncloggedininfostatuses', {});
        apiSafe('syncmonitoredfetchstatuses', {});
        apiSafe('syncnoteimagefetchstatuses', {});
        apiSafe('syncnotedetailfetchstatuses', {});
        apiSafe('syncleaddmstatuses', {});
        apiSafe('synchotspotsearchstatuses', {});
      }
      loadAll(true);
    }, ms);
    return () => clearInterval(t);
  }, [anyFetching, loadAll]);

  // 首次使用：全新工作台只自动唤起一次小红书扫码 + X 登录页。
  useEffect(() => {
    if (firstUseFiredRef.current) return;
    if (state.onboarding && state.onboarding.isFirstUse) {
      firstUseFiredRef.current = true;
      apiSafe('startfirstuselogin', {}).then(() => loadAll(true));
    }
  }, [state.onboarding, loadAll]);

  const loginGate = state.loginGate;
  const combinedNotifications = [
    ...(state.competitorNotifications || []).map((n) => ({
      key: 'competitor:' + n.id, source: 'competitor', id: n.id,
      chip: n.type === 'new_note' ? '笔记上新' : '点赞超 5', chipCls: n.type === 'new_note' ? 'green' : 'red',
      title: n.title, body: n.body, createdAt: n.createdAt, isRead: n.isRead, target: 'competitor', targetLabel: '去竞对监控看',
    })),
    ...(state.leadNotifications || []).map((n) => ({
      key: 'lead:' + n.id, source: 'lead', id: n.id,
      chip: n.type === 'new_dm' ? '新私信' : '新评论', chipCls: n.type === 'new_dm' ? 'blue' : 'amber',
      title: n.title, body: n.body, createdAt: n.createdAt, isRead: n.isRead, target: 'leads', targetLabel: '去留资管理看',
    })),
  ].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || b.id - a.id);
  const totalUnreadCount = (state.competitorUnread || 0) + (state.leadUnread || 0);
  const unreadNotifications = combinedNotifications.filter((n) => !n.isRead);
  const popupNotifications = unreadNotifications.filter((n) => !popupHiddenIds.has(n.key)).slice(0, 3);
  const markAnyNotificationRead = async (n) => {
    await apiSafe(n.source === 'competitor' ? 'markcompetitornotificationread' : 'markleadnotificationread', { id: n.id });
    loadAll(true);
  };
  const markAllCombinedRead = async () => {
    if (state.competitorUnread > 0) await apiSafe('markallcompetitornotificationsread', {});
    if (state.leadUnread > 0) await apiSafe('markallleadnotificationsread', {});
    setNotifPanelOpen(false);
    loadAll(true);
  };

  // 扫码登录：用户主动点时立即在自己的浏览器里打开小红书登录页（同步弹开，
  // 不等服务端派发），同时服务端强制派发全新扫码任务；文案只说派发了什么，
  // 绝不谎称“已打开”。
  const requestQrLogin = async () => {
    try { window.open(LOGIN_URL, '_blank', 'noopener,noreferrer'); } catch (e) { /* 弹窗被拦也不吞掉服务端派发 */ }
    setQrBusy(true);
    try {
      const res = await api('requestqrlogin', {});
      const url = res && (res.url || res.loginUrl);
      if (url && url !== LOGIN_URL) window.open(url, '_blank', 'noopener,noreferrer');
      setQrFeedback({ started: res ? res.started !== false : false, message: (res && res.message) || '已唤起扫码登录。', at: new Date().toISOString() });
      loadAll(true);
    } catch (err) {
      setQrFeedback({ started: false, message: '这次点击没能联系上工作台服务：' + (err && err.message ? err.message : String(err)) + '。可以稍后再点一次。', at: new Date().toISOString() });
    } finally { setQrBusy(false); }
  };
  const requestConfirmScanned = async () => {
    setConfirmBusy(true);
    try {
      const res = await api('confirmqrscanned', {});
      setQrFeedback({ started: res ? res.started !== false : false, message: (res && res.message) || '已重新读取账号信息。', at: new Date().toISOString() });
      loadAll(true);
    } catch (err) {
      setQrFeedback({ started: false, message: '这次没能联系上工作台服务：' + (err && err.message ? err.message : String(err)) + '。可以稍后再点一次。', at: new Date().toISOString() });
    } finally { setConfirmBusy(false); }
  };
  const qrFeedbackBox = loginGate && loginGate.verdict !== 'logged_in' && (qrFeedback || loginGate.qrWaiting)
    ? h('div', { className: 'xhs-note-box', style: { fontSize: 12, padding: '10px 12px' } },
      qrFeedback ? h('p', { style: { margin: 0, color: qrFeedback.started ? 'var(--color-foreground)' : 'var(--color-primary)' } },
        (qrFeedback.started ? '✓ ' : '') + qrFeedback.message + '（' + fmtTime(qrFeedback.at) + '）') : null,
      loginGate.qrWaiting ? h('p', { style: { margin: '4px 0 0', color: 'var(--color-foreground-muted)' } },
        '扫码登录等待中' + (loginGate.qrWaitDeadlineAt ? '，这次等待最晚到 ' + fmtTime(loginGate.qrWaitDeadlineAt) : '') + '，超时后按钮会重新可用。') : null,
      h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginTop: 6 } },
        h('button', { type: 'button', disabled: confirmBusy, onClick: requestConfirmScanned, style: { background: 'none', border: 0, padding: 0, fontSize: 12, fontWeight: 600, color: 'var(--color-primary)', textDecoration: 'underline' } },
          confirmBusy ? '正在重新读取…' : '我已扫码，重新读取账号信息'),
        h('a', { href: LOGIN_URL, target: '_blank', rel: 'noreferrer', style: { fontSize: 12, fontWeight: 500, color: 'var(--color-foreground-muted)', textDecoration: 'underline' } }, '在浏览器打开小红书')))
    : null;

  const navigate = (t) => {
    setTab(t);
    setEditingNoteId(null);
    const g = groupOfTab(t);
    if (g) { setOpenGroups((prev) => Object.assign({}, prev, { [g]: true })); setMobileGroup(g); }
    else setMobileGroup(null);
  };
  const openNote = (id) => {
    const target = (state.notes || []).find((n) => n.id === id);
    if (!target || target.status === 'published') return;
    setEditingNoteId(id);
  };
  const createBlank = async () => {
    try {
      const primary = accounts.find((a) => a.monitored) || accounts[0] || null;
      const res = await api('createnote', { accountId: primary ? primary.id : null, title: '', body: '', tags: [], imageIds: [] });
      await loadAll(true);
      const id = res && (res.id || (res.note && res.note.id));
      if (id) setEditingNoteId(id);
    } catch (err) { setError('新建笔记失败：' + (err && err.message ? err.message : String(err))); }
  };

  const refreshAll = async () => {
    const gate = state.loginGate || {};
    const hasAccount = (state.accounts || []).length > 0;
    if (!hasAccount || !gate.isLoggedIn) {
      setRefreshNeedsLogin(true);
      setRefreshNote('未登录：请先扫码登录绑定账号。');
      navigate('account');
      return;
    }
    setRefreshing(true); setRefreshNote(null); setRefreshNeedsLogin(false); setRefreshDoneAt(null);
    refreshCycleRef.current = true;
    try {
      const res = await api('refreshalldata', {});
      refreshStartedRef.current = (res && res.started) || { infoFetches: 0, noteFetches: 0, monitoredFetches: 0 };
      setRefreshNeedsLogin(!!(res && res.needsLogin));
      setRefreshNote((res && res.message) || '已开始刷新全部数据。');
      await loadAll(true);
    } catch (err) {
      refreshCycleRef.current = false;
      setRefreshNote('刷新没能启动：' + (err && err.message ? err.message : String(err)) + '。请稍后再点一次。');
    } finally { setRefreshing(false); }
  };
  const anyBusy = anyFetching || refreshing;
  useEffect(() => {
    if (anyBusy) { wasBusyRef.current = true; return; }
    if (!wasBusyRef.current) return;
    wasBusyRef.current = false;
    if (!refreshCycleRef.current) return;
    refreshCycleRef.current = false;
    const verifiedNow = !!(state.loginGate && state.loginGate.isLoggedIn);
    if (!verifiedNow) {
      setRefreshNeedsLogin(true);
      setRefreshNote('刷新没有完成：目前没有已登录的绑定账号，拉不到新数据。刷新时已自动唤起浏览器打开小红书登录页，请用小红书 App 扫码登录；登录成功后再点一次「刷新全部数据」。');
      return;
    }
    const problems = [];
    for (const a of accounts) {
      if (a.infoFetchStatus === 'failed' && (a.infoFetchMessage || a.loginMessage)) problems.push('账号信息读取：' + humanizeFailureText(a.infoFetchMessage || a.loginMessage));
      if (a.fetchStatus === 'failed' && a.fetchMessage) problems.push('笔记拉取：' + humanizeFailureText(a.fetchMessage));
    }
    for (const m of state.monitoredAccounts || []) {
      if (m.fetchStatus === 'failed' && m.fetchMessage) problems.push(humanizeFailureText(m.fetchMessage));
    }
    const noteTotal = accounts.reduce((s, a) => s + (a.fetchedCount || 0), 0);
    const started = refreshStartedRef.current;
    const parts = ['绑定账号信息和登录状态已刷新'];
    if (noteTotal > 0) parts.push(started.noteFetches > 0 ? '笔记已重新拉取（当前共 ' + noteTotal + ' 篇）' : '笔记列表已重新加载（共 ' + noteTotal + ' 篇）');
    if ((state.monitoredAccounts || []).length > 0) {
      parts.push(started.monitoredFetches > 0 ? state.monitoredAccounts.length + ' 个监测账号的数据已重新获取' : state.monitoredAccounts.length + ' 个监测账号的数据已重新加载');
    }
    let summary = '刷新完成：' + parts.join('；') + '。';
    if (problems.length > 0) summary += '但有几项没成功：' + problems.join('；');
    setRefreshNeedsLogin(false);
    setRefreshNote(summary);
    setRefreshDoneAt(new Date().toISOString());
  }, [anyBusy, accounts, state.monitoredAccounts, state.loginGate]);

  const editingNote = editingNoteId !== null ? (state.notes || []).find((n) => String(n.id) === String(editingNoteId)) : null;
  useEffect(() => {
    if (editingNote && editingNote.status === 'published') setEditingNoteId(null);
  }, [editingNote && editingNote.id, editingNote && editingNote.status]);
  const main = accounts[0] || null;
  const monitored = accounts.find((a) => a.monitored) || accounts[0] || null;

  const navItem = (t, active) => h('button', {
    key: t.key, type: 'button', onClick: () => navigate(t.key),
    className: 'xhs-nav-item' + (active ? ' active' : ''),
  },
    h(Icon, { d: t.icon, style: { width: 20, height: 20 } }),
    t.label,
    t.key === 'make' && (state.notes || []).length > 0 ? h('span', { className: 'count' }, (state.notes || []).length) : null);

  return h('div', { className: 'xhs' },
    h('style', null, CSS + CSS2),
    popupNotifications.length > 0 ? h('div', { className: 'xhs-popups', 'aria-live': 'polite', 'aria-label': '工作台新通知' },
      popupNotifications.map((n) => h('div', { key: n.key, className: 'xhs-popup', role: 'alert' },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 8 } },
          h('span', { className: 'xhs-chip ' + n.chipCls }, n.chip),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('p', { style: { margin: 0, fontSize: 14, fontWeight: 600 } }, n.title),
            h('p', { style: { margin: '2px 0 0', fontSize: 14, lineHeight: 1.6, color: 'var(--color-foreground-muted)' } }, n.body),
            h('p', { style: { margin: '4px 0 0', fontSize: 12, color: 'var(--color-foreground-muted)' } }, fmtTime(n.createdAt)))),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 } },
          h('button', { type: 'button', className: 'xhs-btn primary mini', onClick: () => { markAnyNotificationRead(n); navigate(n.target); } }, n.targetLabel),
          h('button', { type: 'button', className: 'xhs-btn mini', onClick: () => markAnyNotificationRead(n) }, '知道了'),
          h('button', { type: 'button', onClick: () => setPopupHiddenIds((prev) => { const next = new Set(prev); next.add(n.key); return next; }), style: { background: 'none', border: 0, padding: '6px 8px', fontSize: 12, color: 'var(--color-foreground-muted)' } }, '稍后')))),
      unreadNotifications.length > 3 ? h('p', { className: 'xhs-note-box', style: { textAlign: 'center', margin: 0 } }, '还有 ' + (unreadNotifications.length - 3) + ' 条未读通知，点铃铛查看全部。') : null) : null,
    h('div', { className: 'xhs-layout' },
      h('nav', { className: 'xhs-nav', 'aria-label': '工作台导航' },
        h('div', { className: 'xhs-nav-desktop' },
          h('p', { className: 'xhs-nav-eyebrow' }, '运营工作台'),
          NAV_GROUPS.map((g) => h('div', { key: g.key, style: { marginTop: 8 } },
            h('button', { type: 'button', className: 'xhs-nav-group-label', onClick: () => setOpenGroups((prev) => Object.assign({}, prev, { [g.key]: !prev[g.key] })) },
              g.label,
              h('span', { className: 'chev' + (openGroups[g.key] ? '' : ' closed') }, h(Icon, { d: ICONS.chevron, style: { width: 16, height: 16 } }))),
            openGroups[g.key] ? g.items.map((t) => navItem(t, tab === t.key && editingNoteId === null)) : null)),
          h('div', { style: { marginTop: 8 } },
            navItem(ACCOUNT_ITEM, tab === 'account' && editingNoteId === null),
            h('button', { type: 'button', className: 'xhs-nav-item', onClick: () => setNotifPanelOpen((v) => !v) },
              h(Icon, { d: ICONS.bell, style: { width: 20, height: 20 } }), '通知',
              totalUnreadCount > 0 ? h('span', { className: 'count', style: { background: 'var(--color-primary)', color: '#fff', fontWeight: 600 } }, totalUnreadCount) : null),
            notifPanelOpen ? h('div', { className: 'xhs-bell-panel' },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px' } },
                h('span', { style: { fontSize: 12, fontWeight: 600 } }, '通知'),
                totalUnreadCount > 0 ? h('button', { type: 'button', onClick: markAllCombinedRead, style: { marginLeft: 'auto', background: 'none', border: 0, fontSize: 12, color: 'var(--color-primary)' } }, '全部已读') : null),
              combinedNotifications.length === 0
                ? h('p', { style: { padding: '8px 4px', fontSize: 12, lineHeight: 1.6, color: 'var(--color-foreground-muted)', margin: 0 } }, '暂无通知。竞对有笔记上新或点赞超 5、主账号有新私信或新评论时会出现在这里。')
                : h('ul', { style: { listStyle: 'none', margin: 0, padding: 0 } }, combinedNotifications.slice(0, 20).map((n) =>
                  h('li', { key: n.key, style: { padding: '8px 4px', borderTop: '1px solid var(--color-border)' } },
                    h('p', { style: { margin: 0, fontSize: 12, fontWeight: n.isRead ? 400 : 500, color: n.isRead ? 'var(--color-foreground-muted)' : 'var(--color-foreground)' } }, n.title),
                    h('p', { style: { margin: '2px 0 0', fontSize: 12, color: 'var(--color-foreground-muted)' } }, n.body),
                    h('p', { style: { margin: '2px 0 0', fontSize: 11, color: 'var(--color-foreground-muted)' } }, fmtTime(n.createdAt) + ' · ' + n.chip)))),
              h('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
                h('button', { type: 'button', onClick: () => { setNotifPanelOpen(false); navigate('competitor'); }, style: { flex: 1, borderRadius: 8, background: 'var(--color-surface-alt)', border: 0, padding: '6px 8px', fontSize: 12 } }, '去竞对监控'),
                h('button', { type: 'button', onClick: () => { setNotifPanelOpen(false); navigate('leads'); }, style: { flex: 1, borderRadius: 8, background: 'var(--color-surface-alt)', border: 0, padding: '6px 8px', fontSize: 12 } }, '去留资管理'))) : null,
          h('div', { className: 'xhs-nav-bottom' },
            monitored && loginGate && loginGate.isLoggedIn && loginGate.accountId === monitored.id
              ? h('div', { className: 'xhs-nav-account' },
                h(AccountAvatar, { nickname: monitored.nickname, avatarUrl: monitored.avatarUrl, size: 32 }),
                h('span', { style: { minWidth: 0 } },
                  h('span', { className: 'nm', style: { display: 'block' } }, monitored.nickname),
                  h('span', { className: 'st', style: { display: 'block' } }, '已登录' + (loginGate.loginSource === 'shared_browser' ? '（共用会话）' : '') + ' · 主账号' + (loginGate.handshakeStatus === 'checking' ? ' · 正在握手确认…' : ''))))
              : loginGate && loginGate.verdict === 'logged_out'
                ? h('div', { className: 'xhs-nav-login-warn' },
                  h('p', { className: 't', style: { margin: 0 } }, '未登录，请扫码登录'),
                  h('p', { className: 'd', style: { margin: '2px 0 0' } }, '统一门禁的结论是未登录。点下面按钮打开小红书登录页扫码，或在 Muse 聊天里让 Muse 在你能看到的浏览器里打开登录页扫码（共用会话）——两种登录成功后都会自动恢复。'),
                  h('button', { type: 'button', disabled: qrBusy, onClick: requestQrLogin, style: { marginTop: 6, background: 'none', border: 0, padding: 0, fontSize: 12, fontWeight: 600, color: 'var(--color-primary)', textDecoration: 'underline' } }, '打开浏览器扫码登录'))
                : loginGate && loginGate.verdict === 'unknown'
                  ? h('div', { className: 'xhs-nav-login-warn' },
                    h('p', { className: 'd', style: { margin: 0 } }, loginGate.checkInFlight ? '正在确认登录态…（每 60 秒与小红书握手一次）' : '登录态暂时无法确定（不等于掉登录，详见账号管理页的统一登录状态）。'),
                    h('button', { type: 'button', disabled: qrBusy, onClick: requestQrLogin, style: { marginTop: 6, background: 'none', border: 0, padding: 0, fontSize: 12, fontWeight: 600, color: 'var(--color-primary)', textDecoration: 'underline' } }, '打开浏览器扫码登录'))
                  : null,
            qrFeedbackBox ? h('div', { style: { padding: '0 4px 12px' } }, qrFeedbackBox) : null,
            h('button', { type: 'button', className: 'xhs-refresh-btn', disabled: refreshing || anyFetching, onClick: refreshAll },
              h('span', { className: refreshing || anyFetching ? 'xhs-spin' : '' }, refreshing || anyFetching ? '' : h(Icon, { d: ICONS.refresh, style: { width: 16, height: 16 } })),
              refreshing || anyFetching ? '正在刷新…' : '刷新全部数据'),
            refreshNote ? h('div', { className: 'xhs-refresh-note' + (refreshNeedsLogin ? ' warn' : '') },
              h('p', { style: { margin: 0 } }, (refreshing || anyFetching) ? '正在刷新全部数据…' : refreshNote),
              refreshNeedsLogin ? h('button', { type: 'button', onClick: () => navigate('account'), style: { marginTop: 6, background: 'none', border: 0, padding: 0, fontSize: 12, fontWeight: 600, color: 'var(--color-primary)', textDecoration: 'underline' } }, '去账号管理页扫码登录') : null,
              refreshDoneAt && !refreshing && !anyFetching ? h('p', { style: { margin: '4px 0 0' } }, '完成于 ' + fmtTime(refreshDoneAt)) : null) : null)),
        h('div', { className: 'xhs-nav-mobile' },
          h('div', { className: 'xhs-mnav-row' },
            NAV_GROUPS.map((g) => {
              const sel = mobileGroup === g.key;
              const contains = editingNoteId === null && g.items.some((i) => i.key === tab);
              return h('button', { key: g.key, type: 'button', className: sel || contains ? 'active' : '', onClick: () => setMobileGroup(sel ? null : g.key) },
                g.label,
                h(Icon, { d: ICONS.chevron, style: { width: 14, height: 14, transform: sel ? 'rotate(180deg)' : 'none' } }));
            }),
            h('button', { type: 'button', className: tab === 'account' && editingNoteId === null ? 'active' : '', onClick: () => navigate('account') },
              h(Icon, { d: ICONS.user, style: { width: 20, height: 20 } }), '账号管理'),
            h('button', { type: 'button', disabled: refreshing || anyFetching, onClick: refreshAll },
              h('span', { className: refreshing || anyFetching ? 'xhs-spin dark' : '' }, refreshing || anyFetching ? '' : h(Icon, { d: ICONS.refresh, style: { width: 20, height: 20 } })),
              refreshing || anyFetching ? '刷新中' : '刷新')),
          mobileGroup ? h('div', { className: 'xhs-mnav-row xhs-mnav-row2' },
            (NAV_GROUPS.find((g) => g.key === mobileGroup) || { items: [] }).items.map((t) =>
              h('button', { key: t.key, type: 'button', className: tab === t.key && editingNoteId === null ? 'active' : '', onClick: () => navigate(t.key) },
                h(Icon, { d: t.icon, style: { width: 20, height: 20 } }), t.label))) : null)),
      h('main', { className: 'xhs-main' },
        h('div', { className: 'xhs-main-inner' },
          h('div', { className: 'xhs-mobile-bell', style: { display: 'flex', justifyContent: 'flex-end', marginBottom: 12 } },
            h('button', { type: 'button', className: 'xhs-btn mini', onClick: () => navigate((state.leadUnread || 0) > 0 && (state.competitorUnread || 0) === 0 ? 'leads' : 'competitor'), style: { display: 'flex', alignItems: 'center', gap: 6 } },
              h(Icon, { d: ICONS.bell, style: { width: 16, height: 16 } }), '通知',
              totalUnreadCount > 0 ? h('span', { className: 'xhs-badge published' }, totalUnreadCount) : null)),
          refreshNote ? h('div', { className: 'xhs-refresh-note' + (refreshNeedsLogin ? ' warn' : ''), style: { marginBottom: 16 } },
            h('p', { style: { margin: 0 } }, (refreshing || anyFetching) ? '正在刷新全部数据…' : refreshNote),
            refreshNeedsLogin ? h('button', { type: 'button', onClick: () => navigate('account'), style: { marginTop: 4, background: 'none', border: 0, padding: 0, fontSize: 12, fontWeight: 600, color: 'var(--color-primary)', textDecoration: 'underline' } }, '去账号管理页扫码登录') : null) : null,
          loading
            ? h('p', { style: { padding: '64px 0', textAlign: 'center', fontSize: 14, color: 'var(--color-foreground-muted)' } }, '正在加载工作台…')
            : error
              ? h('div', { style: { padding: '64px 0', textAlign: 'center' } },
                h('p', { style: { margin: 0 } }, '加载失败'),
                h('p', { style: { margin: '4px 0 0', fontSize: 14, color: 'var(--color-foreground-muted)' } }, String(error)),
                h('button', { type: 'button', className: 'xhs-btn primary', style: { marginTop: 16 }, onClick: () => loadAll(false) }, '重试'))
              : editingNote && editingNote.status !== 'published'
                ? h(EditorView, { key: editingNote.id + '-' + editingNote.updatedAt, note: editingNote, assets: state.assets, accounts, gate: loginGate, onBack: () => { setEditingNoteId(null); loadAll(true); }, onReload: () => loadAll(true) })
                : editingNoteId !== null && !editingNote
                  ? h('div', { style: { padding: '64px 0', textAlign: 'center' } },
                    h('p', { style: { margin: 0 } }, '这篇笔记已经不存在了。'),
                    h('button', { type: 'button', className: 'xhs-btn primary', style: { marginTop: 16 }, onClick: () => setEditingNoteId(null) }, '返回'))
                  : tab === 'calendar'
                    ? h('div', null,
                      h(CalendarView, { notes: state.notes, fetchedNotes: state.fetchedNotes, accounts, gate: loginGate, onReload: () => loadAll(true) }),
                      h('div', { className: 'xhs-section-gap' }),
                      h(NotesView, { notes: state.notes, assets: state.assets, accounts, fetchedNotes: state.fetchedNotes, gate: loginGate, onOpen: openNote, onNew: createBlank, variant: 'published', onReload: () => loadAll(true) }))
                    : tab === 'make'
                      ? h('div', null,
                        h(GenerateView, { assets: state.assets, accounts, defaultAccountId: monitored ? monitored.id : null, onGenerated: openNote, prefill: makePrefill, onGoAccountSettings: () => navigate('account'), onReload: () => loadAll(true) }),
                        h('div', { className: 'xhs-section-gap' }),
                        h(NotesView, { notes: state.notes, assets: state.assets, accounts, fetchedNotes: state.fetchedNotes, gate: loginGate, onOpen: openNote, onNew: createBlank, variant: 'drafts', onReload: () => loadAll(true) }))
                      : tab === 'competitor'
                        ? h(CompetitorView, {
                          monitoredAccounts: state.monitoredAccounts, gate: loginGate, onQrLogin: requestQrLogin,
                          notifications: state.competitorNotifications, unreadCount: state.competitorUnread,
                          onMarkNotificationRead: async (id) => { await apiSafe('markcompetitornotificationread', { id }); loadAll(true); },
                          onMarkAllNotificationsRead: async () => { await apiSafe('markallcompetitornotificationsread', {}); loadAll(true); },
                          onReload: () => loadAll(true),
                        })
                        : tab === 'hotspots'
                          ? h(HotspotsView, {
                            onMakeNote: (item) => { setMakePrefill({ topic: item.title, keywords: item.summary, nonce: Date.now() }); navigate('make'); },
                            gate: loginGate, onQrLogin: requestQrLogin, onGoAccount: () => navigate('account'),
                            feed: state.hotspotFeed, onReload: () => loadAll(true),
                          })
                          : tab === 'leads'
                            ? h(LeadsView, {
                              gate: loginGate, onQrLogin: requestQrLogin, monitor: state.leadMonitor, fetchedNotes: state.fetchedNotes,
                              onMarkNotificationRead: async (id) => { await apiSafe('markleadnotificationread', { id }); loadAll(true); },
                              onMarkAllNotificationsRead: async () => { await apiSafe('markallleadnotificationsread', {}); loadAll(true); },
                              onReload: () => loadAll(true),
                            })
                            : h(AccountView, {
                              settings: { dataDirLabel: state.dataFolder }, accounts, fetchedNotes: state.fetchedNotes,
                              notes: state.notes, assets: state.assets, gate: loginGate, onQrLogin: requestQrLogin,
                              qrFeedbackBox, go: navigate, onboarding: state.onboarding,
                              imageGenSettings: state.imageGenSettings,
                              sharedRequests: state.sharedRequests, sharedPendingCount: state.sharedPendingCount,
                              hotspotFeed: state.hotspotFeed, onReload: () => loadAll(true),
                            }))))),
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

// 服务端动作（POST /api/xiaohongshu-ops/<action>，全小写；无参也 POST 空对象）：
//   getstate -> {accounts, notes, monitoredAccounts, loginGate, handshake, dataFolder, fetchStatus, infoFetchStatus}
//     账号补 xiaohongshuId/profileUrl/following/followers/likesAndCollects；
//     笔记补 url/coverUrl/images/imageNotes/指标/accountNickname/accountXhsId；
//     监测账号附带 notes（含 snapshots）；loginGate 补 status/verified/verifiedAt；
//     handshake 补 status/at/message/ok/browserState。
//     v0.2.0 扩展（服务端移植员按清单 §3.4.5 补齐；客户端用 apiSafe 容错读，
//     尚未注册时显示空态）：hotspotFeed / leadMonitor / competitorNotifications /
//     leadNotifications / imageGenSettings / onboarding / sharedRequests。
//   新动作（清单 §1，名字一字不差）：
//   startbackfillnotedetails {accountId} / save* 回写类 / getimagegensettings {} /
//   updateimagegensettings {apiBaseUrl, apiModel, apiKey, clearApiKey, clearAll, preferredBackend} /
//   testimagegenapi {} / generateimage {prompt, backend} /
//   listcompetitornotifications {limit} / markcompetitornotificationread {id} / markallcompetitornotificationsread {} /
//   getleadmonitor {} / startleaddmcheck {} / saveleaddmcheck {} / syncleaddmstatuses {} /
//   listleadnotifications {limit} / markleadnotificationread {id} / markallleadnotificationsread {} /
//   gethotspotfeed {} / updatehotspotconfig {keywords, intervalHours, enabled} /
//   starthotspotsearch {source} / savehotspotitems {} / startxlogin {} / savexloginresult {} /
//   checkxloginstatus {} / savexlogincheckresult {} / getonboardingstate {} / startfirstuselogin {} /
//   synchotspotsearchstatuses {} / runhotspotsearchtick {} /
//   confirmqrscanned {} / reportsharedsessionlogin {} / listsharedsessionrequests {} /
//   requestviasharedsession {kind, accountId, monitoredAccountId, noteId} / cancelsharedsessionrequest {id} /
//   listmonitoredsnapshots {monitoredNoteId} / listfetchednotes {accountId} / listassets {} /
//   generatenote {topic, keywords, style, accountId, images:[{assetId, path}]} -> {ok, note}
//   updatenote {id, accountId, title, body, tags, imageIds, imageCaptions} / publishnote {id} /
//   unpublishnote {id} / deletenote {id} / createnote {accountId, title, body, tags, imageIds} /
//   importasset {name, relativePath, folderLabel, mimeType, dataBase64} -> {id} /
//   addmonitoredaccount {homepage} / startfetchmonitoredaccount {monitoredAccountId} / deletemonitoredaccount {id} /
//   startfetchloggedininfo {accountId} / startbindloggedinaccount {} / requestqrlogin {} -> {ok, url, loginUrl, message} /
//   updatesettings {dataDirLabel} / refreshalldata {} -> {ok, needsLogin, started, message} /
//   startfetchaccountnotes {accountId} / startbackfillnoteimages {accountId} / setmonitoredaccount {id} / deleteaccount {id}
//   start* 只派发不拉取：无浏览器扩展配对时返回 {ok:true, started:false, message} 说明原因，客户端不得谎称已完成。
//   已发布笔记在工作台里不打开任何页面（卡片只做展示，原笔记走 XhsNoteLink 外链，
//   含 xsec_token 与过期说明 + 两个恢复入口）；草稿点开进编辑器。
// 注意：package.json 里 dsh.client.inject 写 ["dsh-desktop-workbenches"]，
// 本文件 export 的 inject 是 ['desktopWorkbenches']，两者是不同层面的东西——
// 跨平台账号看板参考实现就是这么写的，不是名字不一致，无需改。

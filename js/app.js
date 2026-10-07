/*
 * 楽天・Yahoo! DTF画像ツール ― 画面（単体ツール用）
 *
 * 業務ロジックは js/core.js（DTFCore）、画像処理は js/image.js（DTFImage）、
 * ブラウザ内の保存は js/storage.js（DTFStore）にある。このファイルは画面の操作と表示だけを担当する。
 * orimake に組み込むときは、このファイルを orimake の画面（注文・出荷）に置き換える。
 */
'use strict';
const C = window.DTFCore, IMG = window.DTFImage, { lsGet, lsSet, idb } = window.DTFStore;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gb = n => (n / 1024 ** 3).toFixed(1);
const download = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); };
async function readText(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); }
  catch (e) { return new TextDecoder('shift_jis').decode(buf); }
}

const LS = { legacy: 'rydtf.yahooLegacy.v1', chest: 'rydtf.chestPct', kids: 'rydtf.kidsPct' };
const pct = (k, d) => { const v = parseFloat(lsGet(k)); return v > 0 && v <= 100 ? v : d; };
const chestPct = () => pct(LS.chest, 35);
const kidsPct = () => pct(LS.kids, 70);
function setChestPct(v) { const n = parseFloat(v); if (n > 0 && n <= 100) { lsSet(LS.chest, n); rerun(); } }
function setKidsPct(v) { const n = parseFloat(v); if (n > 0 && n <= 100) { lsSet(LS.kids, n); rerun(); } }

/* ================= 状態 ================= */
const state = {
  master: null,   // DTFCore.buildMasterIndex の結果
  yahoo: null,    // （任意）Yahoo!商品データ
  // Yahoo!旧商品コード → 対応（ツール同梱 data/yahoo_legacy.js ＋ 画面で読み込んだ分）
  legacy: Object.assign({}, window.BUNDLED_LEGACY && window.BUNDLED_LEGACY.map, lsGet(LS.legacy)),
  images: new Map(), finder: C.makeImageFinder([]),
  custom: {},     // 画面で登録したSKU：'品番-カラー' → { image, sizes, at }
  files: [], lines: [], gifts: [], names: [], notices: [], pendingMaster: null
};
const findImage = name => state.finder.find(name);
const ctx = () => ({ master: state.master, legacy: state.legacy, yahooSub: state.yahoo && state.yahoo.sub, custom: state.custom, findImage, hasImages: state.images.size > 0 });

/* ================= 商品管理マスタ（Excel／CSV） ================= */
$('#fMaster').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  let rows;
  if (/\.xls[xm]?$/i.test(f.name)) {
    if (!window.XLSX) await new Promise((ok, ng) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'; s.onload = ok; s.onerror = ng; document.head.appendChild(s); });
    const wb = XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: 'array' });
    // SKU見出しを含むシートのうち、行数が最も多いものを使う
    let best = null;
    for (const n of wb.SheetNames) {
      const r = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '', raw: false }).map(x => x.map(String));
      if (C.findHeaderRow(r) >= 0 && (!best || r.length > best.length)) best = r;
    }
    rows = best || [];
  } else rows = C.parseCSV(await readText(f));
  const hi = C.findHeaderRow(rows);
  if (hi < 0) { alert('SKUの見出し行が見つかりませんでした。'); return; }
  const head = rows[hi]; const body = rows.slice(hi + 1);
  state.pendingMaster = { name: f.name, head, body };
  const opts = head.map((h, i) => `<option value="${i}">${esc(h || ('列' + (i + 1)))}</option>`).join('');
  $('#selSku').innerHTML = opts; $('#selImg').innerHTML = opts;
  const pick = res => { for (const re of res) { const i = head.findIndex(h => re.test(h)); if (i >= 0) return i; } return 0; };
  $('#selSku').value = pick([/^出品者sku$/i, /^sku$/i, /sku/i]);
  $('#selImg').value = pick([/dtf.*画像/i, /画像名|画像ファイル|ファイル名/i, /画像|image|png/i]);
  $('#chooserName').textContent = `${f.name}（${body.length.toLocaleString()}行）`;
  $('#chooserPreview').innerHTML = `<table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body.slice(0, 4).map(r => `<tr>${head.map((_, i) => `<td>${esc((r[i] || '').slice(0, 40))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  $('#chooser').style.display = 'block';
};
async function commitMaster() {
  const p = state.pendingMaster; if (!p) return;
  const text = C.masterTextFromRows(p.body, +$('#selSku').value, +$('#selImg').value);
  const m = { name: p.name, loadedAt: new Date().toLocaleString('ja-JP'), text };
  if (await idb.set('master', { name: m.name, loadedAt: m.loadedAt, text })) state.master = C.buildMasterIndex(m);
  $('#chooser').style.display = 'none'; state.pendingMaster = null;
  renderSetup(); rerun();
}
async function clearMaster() {
  if (!confirm('読み込んだマスタを削除しますか？' + (window.BUNDLED_MASTER ? '（ツール同梱のマスタに戻ります）' : ''))) return;
  await idb.del('master');
  state.master = window.BUNDLED_MASTER && window.BUNDLED_MASTER.text ? C.buildMasterIndex(Object.assign({}, window.BUNDLED_MASTER, { bundled: true })) : null;
  renderSetup(); rerun();
}

/* ================= Yahoo!旧コード対応表（CSV） ================= */
$('#fLegacy').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const map = C.parseLegacyCsv(C.parseCSV(await readText(f)));
  const n = Object.keys(map).length;
  if (!n) { alert('対応表の行が見つかりませんでした。「Yahoo旧コード対応表_候補.csv」を選んでください。'); return; }
  Object.assign(state.legacy, map); lsSet(LS.legacy, map);
  alert(`${n}件の対応を読み込みました。`); renderSetup(); rerun();
};

/* ================= DTF画像（ブラウザ内に取り込み） ================= */
function indexImages(entries) {
  state.images = new Map(entries.map(e => [e.name, e]));
  state.finder = C.makeImageFinder(entries);
}
// 画像をブラウザ内の保存領域に取り込む。同名は上書き、既存分は残す
async function importImages(files) {
  files = files.filter(f => /\.(png|jpe?g)$/i.test(f.name));
  if (!files.length) { alert('PNG / JPEG 画像が見つかりませんでした。'); return; }
  const total = files.reduce((a, f) => a + f.size, 0);
  try {
    const est = await navigator.storage.estimate();
    if (est.quota && est.quota - est.usage < total * 1.05) { alert(`ブラウザの保存容量が足りません（必要 約${gb(total)}GB／空き 約${gb(est.quota - est.usage)}GB）。`); return; }
  } catch (e) { /* 容量が分からないときはそのまま進める */ }
  try { if (navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* 任意 */ }
  const bar = $('#imgProg'); bar.classList.remove('hidden');
  let done = 0, batch = [], bytes = 0;
  try {
    for (const f of files) {
      batch.push([f.name.normalize('NFC'), f]); bytes += f.size;
      if (batch.length >= 25 || bytes > 150e6) {
        await idb.imgPutMany(batch); done += batch.length; batch = []; bytes = 0;
        bar.firstElementChild.style.width = (done / files.length * 100).toFixed(0) + '%'; $('#stImages').textContent = `取り込み中… ${done} / ${files.length}`;
      }
    }
    if (batch.length) { await idb.imgPutMany(batch); done += batch.length; }
  } catch (e) { alert(`取り込みが途中で止まりました（${done}枚まで保存済み）：${e.message}`); }
  const idx = new Map([...state.images.values()].map(e => [e.name, e.size]));
  for (const f of files.slice(0, done)) idx.set(f.name.normalize('NFC'), f.size);
  await idb.set('imgIndex', [...idx]);
  indexImages([...idx].map(([name, size]) => ({ name, size })));
  bar.classList.add('hidden'); bar.firstElementChild.style.width = '0';
  renderSetup(); rerun();
  if (done === files.length) alert(`${done.toLocaleString()}枚の画像をツールに取り込みました。次回からフォルダの選択は不要です。`);
}
$('#fImages').onchange = e => { const fs = [...e.target.files]; e.target.value = ''; importImages(fs); };
$('#fImageFiles').onchange = e => { const fs = [...e.target.files]; e.target.value = ''; importImages(fs); };
async function clearImages() {
  if (!confirm('ツールに取り込んだDTF画像をすべて削除しますか？（元に戻せません）')) return;
  await idb.imgClear(); await idb.del('imgIndex'); indexImages([]); renderSetup(); rerun();
}
// バックアップ：取り込んだ画像を指定フォルダへ書き出す（再取り込みで復元できる）
async function exportImagesZip() {
  if (!state.images.size) return alert('取り込まれた画像がありません。');
  if (!window.showDirectoryPicker) return alert('このブラウザはフォルダへの書き出しに対応していません（Chrome / Edge をお使いください）。');
  let dir; try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch (e) { return; }
  const bar = $('#imgProg'); bar.classList.remove('hidden'); let n = 0;
  try {
    for (const e of state.images.values()) {
      const b = await imageBlob(e); if (!b) continue;
      const w = await (await dir.getFileHandle(e.name, { create: true })).createWritable(); await w.write(b); await w.close();
      bar.firstElementChild.style.width = (++n / state.images.size * 100).toFixed(0) + '%';
    }
    alert(`${n.toLocaleString()}枚を書き出しました。`);
  } catch (err) { alert(`書き出しが途中で止まりました（${n}枚完了）：${err.message}`); }
  bar.classList.add('hidden'); bar.firstElementChild.style.width = '0';
}
async function imageBlob(e) { return e.file || await idb.imgGet(e.name).catch(() => null); }

/* ================= 注文CSV ================= */
const drop = $('#drop');
drop.onclick = () => $('#fOrders').click();
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); handleOrderFiles([...e.dataTransfer.files]); };
$('#fOrders').onchange = e => { handleOrderFiles([...e.target.files]); e.target.value = ''; };

const MALL_LABEL = { rakuten: '楽天', yahooOrder: 'Yahoo!注文情報', yahooItem: 'Yahoo!商品情報' };
async function handleOrderFiles(files) {
  for (const f of files) {
    const rows = C.parseCSV(await readText(f));
    if (!rows.length) continue;
    const kind = C.detectKind(rows[0]);
    if (!kind) { alert(`${f.name}：楽天・Yahoo!どちらの注文CSVか判別できませんでした。`); continue; }
    state.files = state.files.filter(x => x.name !== f.name);
    state.files.push({ name: f.name, kind, rows: C.toObjects(rows) });
  }
  rerun();
}
function resetOrders() { state.files = []; state.lines = []; $('#result').classList.add('hidden'); $('#dropWrap').classList.remove('hidden'); }

function rerun() {
  if (!state.files.length) { renderSetup(); return; }
  const r = C.processOrders(state.files, ctx());
  state.lines = r.lines; state.gifts = r.gifts; state.names = r.names; state.notices = r.notices;
  render();
  checkInk();
}

/* ---- インク色チェック：黒Tに黒インク／白Tに白インクの画像は、反対色の画像に差し替える ---- */
// 画像ファイル名の「黒／白」はTシャツの色（黒.png＝白インク、白.png＝黒インク）が基本だが、例外やマスタの誤りがあるため中身で判定する
const INK = new Map(); let inkLoaded = false, inkDirty = false, inkRun = 0;
async function inkOf(e) {
  if (!inkLoaded) { const c = await idb.get('inkCache'); if (c) for (const k in c) INK.set(k, c[k]); inkLoaded = true; }
  const key = e.name + '|' + (e.size || '');
  if (INK.has(key)) return INK.get(key);
  const b = await imageBlob(e); const v = b ? await IMG.inkLevel(b) : null;
  INK.set(key, v); inkDirty = true; return v;
}
async function checkInk() {
  const run = ++inkRun;
  const targets = state.lines.filter(l => (l.status === 'ok' || l.status === 'est') && l.file && ['black', 'white'].includes(C.shirtOf(l)));
  if (!targets.length) return;
  state.inkChecking = true; updateZipButton();
  for (const l of targets) {
    const shirt = C.shirtOf(l), v = await inkOf(l.file);
    if (run !== inkRun) return;
    if (!C.inkBad(shirt, v)) continue;
    const alt = C.swapColorName(l.file.name, shirt), ae = alt && findImage(alt);
    if (ae && !C.inkBad(shirt, await inkOf(ae))) { l.colorFixFrom = l.image; l.image = ae.name; l.file = ae; }
    else { l.status = 'colorng'; l.reason = `${shirt === 'black' ? '黒T' : '白T'}に${shirt === 'black' ? '黒' : '白'}インクの画像`; }
  }
  if (run !== inkRun) return;
  if (inkDirty) { idb.set('inkCache', Object.fromEntries(INK)); inkDirty = false; }
  state.inkChecking = false;
  C.computeOuts(state.lines); render();
}

/* ================= SKUの追加（設定から登録） ================= */
const saveCustom = () => idb.set('customSku', state.custom);
const COLOR_IMG = { black: '黒', white: '白' };
function fillStemList() {
  if ($('#stemList').dataset.n == state.images.size) return;
  const set = new Set(); for (const n of state.images.keys()) set.add(C.stemOf(n));
  $('#stemList').innerHTML = [...set].sort().map(s => `<option value="${esc(s)}">`).join('');
  $('#stemList').dataset.n = state.images.size;
}
// 入力内容から登録する行を作る
function regEntries() {
  let design = C.normSku($('#rDesign').value).replace(/-oya$/, ''); const stem = C.stemOf($('#rStem').value);
  const m = design.match(/^([a-z]+-\d+(?:-\d+)?)-([a-z]+)(?:-[0-9a-z]+)?$/);
  if (m) design = m[1];  // 色・サイズを付けて入力されても外す（ot-2000-black-m → ot-2000）
  const sizes = [...document.querySelectorAll('input[name=rSize]:checked')].map(x => x.value);
  const out = [];
  if ($('#rBlack').checked) out.push({ color: 'black', image: `${stem} 黒.png` });
  if ($('#rWhite').checked) out.push({ color: 'white', image: `${stem} 白.png` });
  if ($('#rOther').checked) {
    const code = $('#rOtherCode').value.trim().toLowerCase(), img = $('#rOtherImg').value.trim();
    if (code) out.push({ color: code, image: img ? (/\.png$/i.test(img) ? img : img + '.png') : `${stem}.png` });
  }
  return { design, stem, sizes, out };
}
function regPreview() {
  const { design, stem, sizes, out } = regEntries();
  $('#rOtherBox').style.display = $('#rOther').checked ? '' : 'none';
  if (($('#rBlack').checked || $('#rWhite').checked) && !stem) { $('#rPreview').innerHTML = '<span class="muted">画像名を入力してください（例：ポンコツ → 黒T＝ポンコツ 黒.png、白T＝ポンコツ 白.png）</span>'; return; }
  const mark = n => !state.images.size ? '' : findImage(n) ? ' <span class="s ok">✔</span>' : ' <span class="s ng">✖なし</span>';
  $('#rPreview').innerHTML = !design || !out.length || !sizes.length ? '<span class="muted">SKU・画像名・カラー・サイズを入力すると、使う画像がここに表示されます</span>'
    : out.map(o => `<div><b class="mono">${esc(design)}-${esc(o.color)}</b>：` + sizes.map(s =>
      s === 'normal' ? `S〜3XL＝${esc(o.image)}${mark(o.image)}`
        : s === 'large' ? `4XL以上＝${esc('[大]' + o.image)}${mark('[大]' + o.image)}`
          : findImage('[キッズ]' + o.image) ? `キッズ＝${esc('[キッズ]' + o.image)}${mark('[キッズ]' + o.image)}` : `キッズ＝${esc(o.image)}を${kidsPct()}%に縮小${mark(o.image)}`).join('　/　') + '</div>').join('');
}
async function submitRegister() {
  const { design, stem, sizes, out } = regEntries();
  if (!/^[a-z]+-[0-9a-z-]+$/.test(design)) return alert('SKUを入力してください（例：ot-2000）');
  if (!out.length) return alert('カラーを選んでください');
  if (!sizes.length) return alert('サイズを選んでください');
  if (($('#rBlack').checked || $('#rWhite').checked) && !stem) return alert('画像名を入力してください（例：ポンコツ）');
  const need = []; for (const o of out) { if (sizes.includes('normal') || sizes.includes('kids')) need.push(o.image); if (sizes.includes('large')) need.push('[大]' + o.image); }
  const missing = state.images.size ? need.filter(n => !findImage(n)) : [];
  if (missing.length && !confirm(`次の画像が取り込まれていません：\n${missing.join('\n')}\n\nこのまま登録しますか？（画像を後から追加すれば使えるようになります）`)) return;
  const at = new Date().toLocaleDateString('ja-JP');
  for (const o of out) state.custom[`${design}-${o.color}`] = { image: o.image, sizes, at };
  await saveCustom();
  $('#rMsg').textContent = `✔ ${out.map(o => design + '-' + o.color).join('、')} を登録しました`;
  renderRegList(); rerun();
}
// 画像なしの行の「登録」から：SKU・カラー・サイズを入れた状態で開く
function openRegister(key) {
  openSettings();
  const t = String(key || '').split('-'), sp = C.splitSku(key || '');
  const color = sp ? t[t.length - 2] : '', design = sp ? t.slice(0, -2).join('-') : key;
  $('#rDesign').value = design || ''; $('#rStem').value = '';
  $('#rBlack').checked = color === 'black'; $('#rWhite').checked = color === 'white';
  $('#rOther').checked = !!color && !COLOR_IMG[color]; $('#rOtherCode').value = COLOR_IMG[color] ? '' : color; $('#rOtherImg').value = '';
  const need = sp ? C.SIZE_CLASS[C.sizeClass(sp.size)] : 'normal';
  document.querySelectorAll('input[name=rSize]').forEach(x => x.checked = x.value === need || (x.value === 'normal' && need !== 'kids'));
  $('#rMsg').textContent = ''; fillStemList(); regPreview();
  $('#regRow').scrollIntoView({ block: 'start' }); $('#rStem').focus();
}
function renderRegList() {
  const all = Object.entries(state.custom).sort((a, b) => a[0].localeCompare(b[0]));
  $('#regCount').textContent = all.length;
  $('#regBody').innerHTML = all.map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td>${esc(v.image)}</td><td>${(v.sizes || ['normal', 'large', 'kids']).map(s => C.SIZE_LABEL[s]).join('・')}</td>
    <td><button class="small" onclick="deleteCustom('${esc(k)}')">削除</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">登録はまだありません</td></tr>';
}
async function deleteCustom(k) { if (!confirm(`${k} の登録を削除しますか？`)) return; delete state.custom[k]; await saveCustom(); renderRegList(); rerun(); }

/* ================= 描画 ================= */
function renderSetup() {
  const m = state.master, lg = Object.values(state.legacy).filter(Boolean).length;
  if (document.activeElement !== $('#chestPct')) $('#chestPct').value = chestPct();
  if (document.activeElement !== $('#kidsPct')) $('#kidsPct').value = kidsPct();
  $('#stMaster').innerHTML = m ? `<span class="st ok">✔ ${m.exact.size.toLocaleString()} SKU（画像名あり ${m.withImg.toLocaleString()}）</span><br><span class="muted">${m.bundled ? 'ツール同梱：' : ''}${esc(m.name)}（${esc(m.loadedAt)}）${m.conflicts.size ? `<br>⚠ 画像が2種類あるSKU：${m.conflicts.size}` : ''}</span>` : '<span class="st ng">未読込（Excelの商品管理マスタを読み込んでください）</span>';
  $('#stLegacy').innerHTML = lg ? `<span class="st ok">✔ ${lg} 件</span>` : '<span class="st ng">未読込（Yahoo旧コード対応表_候補.csv を読み込んでください）</span>';
  const bytes = [...state.images.values()].reduce((a, e) => a + (e.size || 0), 0);
  $('#stImages').innerHTML = state.images.size ? `<span class="st ok">✔ ${state.images.size.toLocaleString()} 枚（約${gb(bytes)}GB）</span> <span class="muted">このPCのブラウザ内に保存済み</span>` : '<span class="st ng">未取り込み（DTFイメージのフォルダを取り込んでください）</span>';
  // 初回セットアップの案内（足りないものだけ表示）
  const need = [!m && '商品管理マスタ', !state.images.size && 'DTF画像', !lg && 'Yahoo!旧コード対応表'].filter(Boolean);
  $('#setupHint').innerHTML = need.length ? `最初に <b>${need.join('・')}</b> の読み込みが必要です。<a onclick="openSettings()">設定</a>から読み込んでください（このPCのブラウザで1回だけ）。` : '';
  $('#setupHint').classList.toggle('hidden', !need.length || !state.ready);
}
function openSettings() {
  renderSetup(); renderRegList(); regPreview();
  if ($('#imgList2').childElementCount !== state.images.size) $('#imgList2').innerHTML = [...state.images.keys()].map(n => `<option value="${esc(n)}">`).join('');
  if (!$('#settings').open) $('#settings').showModal();
}
const STATUS = {
  ok: ['ok', '✔ 存在'], est: ['est', '✔ 存在（サイズ区分から推定）'], noimage: ['ng', '✖ 画像なし（ファイルなし）'], nofolder: ['warn', '− 画像未取り込み'],
  unregistered: ['ng', '✖ 画像なし（マスタ未登録）'], emptyimg: ['ng', '✖ 画像なし（マスタの画像名が空）'], conflict: ['ng', '✖ マスタ重複'],
  legacynone: ['ng', '✖ 画像なし'], unresolved: ['ng', '✖ 画像なし（対応未設定）'], colorng: ['ng', '✖ 色要確認（Tシャツと同じ色のインク）'],
  nomaster: ['warn', '− マスタ未読込'], noorder: ['warn', '− 注文情報CSV未読込'], custom: ['cus', '✎ 名入れ・オーダー'], plain: ['plain', '— 無地（印刷不要）']
};
function updateZipButton() {
  const zb = $('#btnZip'), n = state.zipCount || 0;
  zb.disabled = !n || state.inkChecking;
  zb.innerHTML = state.inkChecking ? '⏳ 画像のインク色を確認中…' : `⬇ DTF画像ZIPをダウンロード（${n}枚）`;
}
const optTags = opts => opts.map(o => `<span class="tag${C.HOT_OPT_RE.test(o.v) ? ' o' : ''}">${esc(o.k ? o.k + '：' : '')}${esc(o.v)}</span>`).join(' ');
function render() {
  renderSetup();
  $('#dropWrap').classList.add('hidden'); $('#result').classList.remove('hidden');
  const L = state.lines;
  const orders = new Set(L.map(l => l.mall + l.orderId));
  const printable = L.filter(l => !l.custom && l.status !== 'plain');
  const total = printable.reduce((a, l) => a + l.qty * l.positions.length, 0);
  const zipCount = L.reduce((a, l) => a + ((l.status === 'ok' || l.status === 'est') ? l.outs.length : 0), 0);
  const ng = L.filter(l => C.NG_STATUS.includes(l.status));
  const ngKeys = new Set(ng.map(l => l.mall + (l.key || l.mallSku)));
  $('#kOrders').innerHTML = `${orders.size}<small>件 / ${L.length}行</small>`;
  $('#kZip').innerHTML = `${zipCount}<small>/ 全${total}枚</small>`;
  $('#kWarn').innerHTML = `${ngKeys.size}<small>SKU</small>`;
  $('#kGift').innerHTML = `${state.gifts.length}<small>件</small>`;
  $('#kName').innerHTML = `${state.names.length}<small>件</small>`;
  $('#noticeCard').classList.toggle('hidden', !state.notices.length);
  $('#noticeCard').innerHTML = state.notices.map(n => `<div>⚠ ${n}</div>`).join('');
  $('#fileChips').innerHTML = state.files.map(f => `📄 ${esc(f.name)} <span class="mall ${f.kind === 'rakuten' ? 'r' : 'y'}">${MALL_LABEL[f.kind]}</span>`).join('　')
    + `　<span class="muted">・正常マッチ：${L.filter(l => l.status === 'ok' || l.status === 'est').length}行</span>`;
  state.zipCount = zipCount; updateZipButton();

  // ギフト
  $('#giftCard').classList.toggle('hidden', !state.gifts.length);
  $('#giftCount').textContent = state.gifts.length + '件';
  $('#giftBody').innerHTML = state.gifts.map(g => `<tr><td><span class="mall ${g.mk}">${g.mall}</span></td><td class="mono"><b>${esc(g.orderId)}</b></td><td>${esc(g.recipient)}</td>
    <td>${g.kinds.map(k => `<span class="tag o">${esc(k)}</span>`).join(' ')}</td><td style="white-space:pre-wrap">${esc(g.message || '-')}</td><td class="mono">${esc(g.time)}</td></tr>`).join('');

  // 名入れ
  $('#nameCard').classList.toggle('hidden', !state.names.length);
  $('#nameCount').textContent = state.names.length + '件';
  $('#nameBody').innerHTML = state.names.map(n => { const l = n.ln; return `<tr><td><span class="mall ${l.mk}">${l.mall}</span></td><td class="mono"><b>${esc(l.orderId)}</b></td>
    <td><span class="tag">${esc(n.kind)}</span></td><td><span class="mono">${esc(l.mallSku)}</span><div class="title" title="${esc(l.title)}">${esc(l.title)}</div></td>
    <td class="num">${l.qty}</td><td>${n.opts.length ? n.opts.map(o => `<div><span class="muted">${esc(o.k)}：</span><span class="${C.NAME_KEY_RE.test(o.k) ? 'nm' : ''}">${esc(o.v)}</span></div>`).join('') : `<span class="s warn">${esc(n.note)}</span>`}</td></tr>`; }).join('');

  // 画像なし
  const groups = new Map();
  for (const l of ng) {
    const gk = l.mall + ':' + (l.key || l.mallSku);
    if (!groups.has(gk)) groups.set(gk, { l, n: 0 }); groups.get(gk).n += l.qty;
  }
  const fixed = L.filter(l => l.colorFixFrom && (l.status === 'ok' || l.status === 'est'));
  $('#warnCard').classList.toggle('hidden', !groups.size && !fixed.length);
  const WHY = { unregistered: 'マスタ未登録', emptyimg: 'マスタの画像名が空', conflict: 'マスタ重複', noimage: '画像ファイルなし', legacynone: '画像なし', unresolved: '旧コード未設定', colorng: '色要確認' };
  $('#warnList').innerHTML =
    (groups.size ? `<div class="wlabel">画像なし（${groups.size}）</div><div style="overflow:auto"><table class="wtable"><thead><tr><th>モール</th><th>SKU</th><th>商品名</th><th>カラー</th><th>サイズ</th><th>数量</th><th>理由</th><th></th></tr></thead><tbody>${[...groups.values()].map(({ l, n }) =>
      `<tr><td><span class="mall ${l.mk}">${l.mall}</span></td><td class="mono"><b>${esc(l.mallSku)}</b></td>
        <td><div class="title" title="${esc(l.title)}">${esc(l.title)}</div>${(l.showOpts || []).length ? `<div>${optTags(l.showOpts)}</div>` : ''}</td><td>${esc(l.colorName || '-')}</td><td>${esc(l.sizeName || '-')}</td>
        <td class="num">${n}</td><td><span class="s ng" title="${esc(l.reason || l.image || '')}">${WHY[l.status] || '画像なし'}</span>${l.status === 'noimage' && l.image ? `<div class="muted">${esc(l.image)}</div>` : ''}${l.regKey && l.reason ? `<div class="muted">${esc(l.reason)}</div>` : ''}</td>
        <td>${l.key && C.splitSku(l.key) ? `<button class="small" onclick="openRegister('${esc(l.key)}')">登録</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '') +
    (fixed.length ? `<div class="wlabel" style="color:var(--blue)">色を自動で補正（${fixed.length}）</div><div class="wchips">${fixed.map(l =>
      `<span class="wchip fix">${esc(l.key || l.mallSku)} <small>${esc(l.colorFixFrom)} → ${esc(l.image)}</small></span>`).join('')}</div>` : '');

  renderLines();
}
function renderLines() {
  const L = state.lines;
  $('#lineCount').textContent = `${L.length} 行 / ${state.zipCount || 0} 枚`;
  $('#lineBody').innerHTML = L.map((l, i) => { const [cls, label] = STATUS[l.status] || ['', l.status]; return `<tr>
    <td class="muted">${i + 1}</td><td><span class="mall ${l.mk}">${l.mall}</span></td>
    <td class="mono"><b>${esc(l.mallSku)}</b></td>
    <td><div class="title" title="${esc(l.title)}">${esc(l.title)}</div><div>${l.colorName || l.sizeName ? `<span class="tag">${esc([l.colorName, l.sizeName].filter(Boolean).join(' / '))}</span>` : ''}${optTags(l.showOpts || [])}</div></td>
    <td class="num"><b>${l.qty}</b></td>
    <td>${esc(l.image || '-')}${l.colorFixFrom ? `<div class="s est">色を補正（マスタ：${esc(l.colorFixFrom)}）</div>` : ''}${l.kidsShrink ? `<div class="muted">キッズ用に${kidsPct()}%に縮小</div>` : ''}${l.regKey && (l.status === 'ok' || l.status === 'est') ? '<div class="muted">設定で登録したSKU</div>' : ''}</td>
    <td><span class="s ${cls}">${label}</span></td>
    <td>${l.status === 'ok' || l.status === 'est' ? l.outNames.map(n => `<span class="fname">${esc(n)}</span>`).join('<br>') : '-'}</td></tr>`; }).join('')
    || '<tr><td colspan="8" class="muted" style="text-align:center">該当する行はありません</td></tr>';
}

/* ================= ZIP ================= */
async function downloadZip() {
  const jobs = [];
  for (const l of state.lines) {
    if (!(l.status === 'ok' || l.status === 'est') || !l.file) continue;
    for (const o of l.outs) jobs.push({ o, e: l.file });
  }
  if (!jobs.length) return;
  const btn = $('#btnZip'); btn.disabled = true; $('#prog').classList.remove('hidden');
  const zip = new JSZip(), n = jobs.length;
  try {
    const blobs = new Map(), smalls = new Map();
    for (const { o, e } of jobs) {
      if (!blobs.has(e.name)) blobs.set(e.name, await imageBlob(e));
      const b = blobs.get(e.name);
      if (!b) throw new Error('画像を読み込めませんでした：' + e.name);
      // 胸プリント・キッズ（登録SKU）は縮小。両方なら掛け合わせ
      const scale = (o.chest ? chestPct() / 100 : 1) * (o.kids ? kidsPct() / 100 : 1);
      if (scale < 1) {
        const sk = e.name + '|' + scale;
        if (!smalls.has(sk)) smalls.set(sk, await IMG.shrinkPng(b, scale));
        zip.file(o.name, smalls.get(sk));
      } else zip.file(o.name, b);
    }
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, m => { $('#prog div').style.width = m.percent.toFixed(0) + '%'; });
    const d = new Date(), p = x => String(x).padStart(2, '0');
    download(blob, `DTF_楽天Yahoo_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}_${n}枚.zip`);
  } catch (e) { alert('ZIP作成に失敗しました: ' + e.message); }
  btn.disabled = false; $('#prog').classList.add('hidden'); $('#prog div').style.width = '0';
}

/* ================= 起動 ================= */
(async function init() {
  renderSetup();
  // マスタ：設定で読み込んだものがあれば優先、なければツール同梱（data/master.js があれば）
  const m = await idb.get('master');
  if (m && m.text) state.master = C.buildMasterIndex(m);
  else if (window.BUNDLED_MASTER && window.BUNDLED_MASTER.text) state.master = C.buildMasterIndex(Object.assign({}, window.BUNDLED_MASTER, { bundled: true }));
  const y = await idb.get('yahoo'); if (y && y.sub) state.yahoo = y;
  const idx = await idb.get('imgIndex'); if (Array.isArray(idx)) indexImages(idx.map(([name, size]) => ({ name, size })));
  const cu = await idb.get('customSku'); if (cu && typeof cu === 'object') state.custom = cu;
  state.ready = true;
  renderSetup();
})();

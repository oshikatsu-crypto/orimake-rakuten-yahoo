/*
 * 楽天・Yahoo! DTF画像ツール ― 業務ロジック（画面に依存しない部分）
 *
 * 注文CSVの読み込み → SKUの正規化 → DTF画像との紐づけ → 出力ファイル名の決定 までを担当する。
 * DOM・ブラウザ保存・画像処理には触れないので、orimake（Amazon版）へ組み込むときはこのファイルを
 * そのまま流用できる。外部データ（商品管理マスタ・取り込み済み画像など）は ctx として受け取る。
 *
 * ctx = {
 *   master,      // buildMasterIndex() の結果（SKU → DTF画像名）
 *   legacy,      // Yahoo!旧商品コード → 'ot-123' | 'img:画像名' | 'none'
 *   yahooSub,    // （任意）Yahoo!商品データの個別商品コード → [商品コード, カラー, サイズ]
 *   custom,      // 画面で登録したSKU：'品番-カラー' → { image, sizes:['normal','large','kids'] }
 *   findImage,   // (画像名) => 画像エントリ | null（表記ゆれを吸収して探す）
 *   hasImages,   // 画像が1枚以上取り込まれているか
 * }
 *
 * ブラウザでは window.DTFCore、Node.js（テスト）では require() で使える。
 */
(function (root) {
  'use strict';

  /* ================= ルール（定数） ================= */
  // 名入れ・オーダー品（固定のDTF画像がない商品）の品番プレフィックス
  const CUSTOM_PREFIX = { nt: '名入れ', pt: '写真プリント' };
  // 名入れ内容とみなす項目名
  const NAME_KEY_RE = /名入|名前|なまえ|文字|ネーム|イニシャル|刺繍|フォント|書体|inscription/i;
  // 商品名に含まれていたら名入れ商品とみなす（画像がないときは「名入れ・オーダー」扱い）
  const NAME_TITLE_RE = /名入れ|名前入れ|名入り/;
  // 「画像なし」とみなす状態
  const NO_IMG_STATUS = ['unregistered', 'emptyimg', 'noimage', 'unresolved', 'legacynone', 'conflict'];
  // 画面の「画像なし」一覧に出す状態
  const NG_STATUS = ['unregistered', 'emptyimg', 'conflict', 'unresolved', 'noimage', 'legacynone', 'colorng'];
  // 表示しない定型の選択肢
  const IGNORE_OPT_RE = /レビュー|クーポン/;
  // 作業上目立たせるオプション値
  const HOT_OPT_RE = /背面|両面|長袖|胸|ワンポイント/;

  const SIZE_ALIAS = { xxl: '2xl', xxxl: '3xl', xxxxl: '4xl', xxxxxl: '5xl' };
  const SIZE_RE = /^(xs|s|m|l|xl|[2-9]xl|[3-9]l|\d{2,3}|f|free)$/;
  const LARGE_RE = /^([4-9]xl|[4-9]l)$/;
  const KIDS_RE = /^\d{2,3}$/;
  const COLOR_JP = [
    [/ライトブルー/, 'lightblue'], [/ロイヤルブルー/, 'royalblue'], [/ブラック|黒/, 'black'], [/ホワイト|白/, 'white'], [/ネイビー|紺/, 'navy'],
    [/レッド|赤/, 'red'], [/ブルー|青/, 'blue'], [/グレー|灰/, 'gray'], [/ベージュ/, 'beige'], [/グリーン|緑/, 'green'],
    [/イエロー|黄/, 'yellow'], [/ピンク/, 'pink'], [/ブラウン|茶/, 'brown'], [/オートミール/, 'oatmeal'], [/パープル|紫/, 'purple'], [/オレンジ/, 'orange']
  ];
  // DTF画像名の「黒／白」はTシャツの色（黒.png＝黒T用＝白インク）
  const COLOR_NAME_JP = { black: '黒', white: '白', navy: 'ネイビー', red: '赤', blue: '青', gray: 'グレー', pink: 'ピンク' };
  const COLOR_KEY_RE = /カラー|^色$|ボディ色/;
  const SIZE_KEY_RE = /サイズ/;
  const STD_SUB_RE = /^([a-z]+-\d+(?:-\d+)?)(?:-oya)?-([a-z]+)-([0-9a-z]+)$/i;
  const STD_ITEM_RE = /^([a-z]+-\d+(?:-\d+)?)(?:-oya)?$/i;
  const POS_KEY_RE = /プリント面|印刷面|印刷箇所|プリント箇所|プリント位置|印刷位置/;
  const NO_IMAGE_RE = /^(画像無し|画像なし|なし|-)(\.png)?$/i;
  // サイズ区分：normal = S〜3XL / large = 4XL〜7XL（[大]画像）/ kids = 100〜150（[キッズ]画像、無ければ縮小）
  const SIZE_CLASS = { adult: 'normal', large: 'large', kids: 'kids' };
  const SIZE_LABEL = { normal: 'S〜3XL', large: '4XL〜7XL', kids: 'キッズ' };

  /* ================= 基本の変換 ================= */
  const sizeClass = s => LARGE_RE.test(s) ? 'large' : KIDS_RE.test(s) ? 'kids' : 'adult';
  function normSize(s) { s = String(s || '').trim().toLowerCase(); return SIZE_ALIAS[s] || s; }
  function normColor(s) {
    s = String(s || '').trim(); if (!s) return '';
    if (/^[a-z]+$/i.test(s)) return s.toLowerCase();
    for (const [re, c] of COLOR_JP) if (re.test(s)) return c;
    return s.toLowerCase();
  }
  // SKUを突合用に正規化（小文字化・XXL→2XL等）
  function normSku(s) {
    const t = String(s || '').trim().toLowerCase().replace(/\s+/g, '').split('-');
    if (t.length > 1) t[t.length - 1] = normSize(t[t.length - 1]);
    return t.join('-');
  }
  // "ot-123-black-3xl" → { base:"ot-123-black", size:"3xl" }
  function splitSku(key) {
    const t = String(key || '').split('-'); const last = t[t.length - 1];
    if (t.length >= 3 && SIZE_RE.test(last)) return { base: t.slice(0, -1).join('-'), size: last };
    return null;
  }
  function customKind(code) {
    const m = String(code || '').toLowerCase().match(/^([a-z]+)-/);
    return (m && CUSTOM_PREFIX[m[1]]) || null;
  }
  // 無地（印刷不要）：大きいサイズ無地Tシャツ（lt-）
  const isPlain = ln => /^lt-/i.test(ln.key || ln.mallSku || '') && /無地/.test(ln.title || '');
  // プリント位置オプション → 出力する位置の一覧（オプションなしは前面1枚）
  function printPositions(opts) {
    const o = (opts || []).find(x => POS_KEY_RE.test(x.k));
    if (!o) return [''];
    const v = o.v, out = [];
    if (/両面/.test(v)) out.push('前面', '背面');
    else { if (/前面/.test(v)) out.push('前面'); if (/背面/.test(v)) out.push('背面'); }
    if (/胸|ワンポイント/.test(v)) out.push('胸');
    return out.length ? out : [''];
  }
  function optColorSize(opts) {
    const c = opts.find(o => COLOR_KEY_RE.test(o.k)), s = opts.find(o => SIZE_KEY_RE.test(o.k));
    return { color: c ? normColor(c.v.split('/')[0]) : '', size: s ? normSize(s.v) : '' };
  }
  const ts14 = s => (String(s).match(/\d+/g) || []).join('').padEnd(14, '0').slice(0, 14);
  const safeName = s => String(s).replace(/[\\/:*?"<>|]/g, '_').trim();
  // 画像名から「[大]」などの接頭辞・末尾の「黒／白」・「.png」を除いた名前
  const stemOf = s => String(s || '').trim().replace(/(\.png)+$/i, '').replace(/^(\[[^\]]*\]\s*)+/, '').replace(/[\s　]*(黒|白)$/, '').trim();
  // ファイル名の表記ゆれ（全角/半角・空白・.png の重複・[大]の位置・: と _）を吸収した照合キー
  function imgKey(name) {
    let s = String(name).normalize('NFKC').toLowerCase().replace(/(\.png)+$/, '').replace(/:/g, '_');
    const tags = []; s = s.replace(/\[[^\]]*\]/g, t => { tags.push(t); return ''; });
    return tags.sort().join('') + s.replace(/\s+/g, '');
  }
  // 画像エントリ（{ name, ... }）の一覧から、表記ゆれを吸収して探す関数を作る
  function makeImageFinder(entries) {
    const byName = new Map(), byKey = new Map();
    for (const e of entries) { byName.set(e.name, e); const k = imgKey(e.name); if (!byKey.has(k)) byKey.set(k, e); }
    const find = name => {
      if (!name) return null; const n = String(name).normalize('NFC');
      return byName.get(n) || byName.get(n + '.png') || byKey.get(imgKey(n)) || null;
    };
    return { find, byName, size: byName.size };
  }

  /* ================= CSV ================= */
  function parseCSV(text) {
    const first = text.slice(0, text.indexOf('\n') + 1 || text.length);
    const d = (first.split('\t').length > first.split(',').length) ? '\t' : ',';
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true;
      else if (c === d) { row.push(f); f = ''; }
      else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
      else if (c !== '\r') f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter(r => r.some(x => x !== ''));
  }
  const toObjects = rows => { const h = rows[0].map(x => x.trim()); return rows.slice(1).map(r => Object.fromEntries(h.map((k, i) => [k, r[i] ?? '']))); };
  // 見出し行から、どのCSVかを判定する
  function detectKind(header) {
    const h = header || [];
    if (h.includes('注文番号') && (h.includes('SKU管理番号') || h.includes('商品番号'))) return 'rakuten';
    if (h.includes('OrderId') && h.includes('LineId') && h.includes('ItemId')) return 'yahooItem';
    if (h.includes('OrderId') && h.includes('OrderTime')) return 'yahooOrder';
    return null;
  }
  function parseKV(txt) {
    return String(txt || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => {
      const i = s.search(/[:：]/); return i < 0 ? { k: '', v: s } : { k: s.slice(0, i).trim(), v: s.slice(i + 1).trim() };
    });
  }
  // Yahoo!注文情報CSVの「L1=…&L2=…」形式を明細ごとに分ける
  function splitL(v) {
    const res = {}; if (!v) return res;
    const ms = [...String(v).matchAll(/(?:^|&)L(\d+)=/g)];
    if (!ms.length) { res['1'] = v; return res; }
    ms.forEach((m, i) => { res[m[1]] = String(v).slice(m.index + m[0].length, i + 1 < ms.length ? ms[i + 1].index : undefined); });
    return res;
  }

  /* ================= 商品管理マスタ ================= */
  // m.text = "出品者SKU\tDTF画像名\n..." → 照合用の索引を作る
  function buildMasterIndex(m) {
    m.exact = new Map(); m.byBase = new Map(); m.conflicts = new Map(); let withImg = 0;
    for (const ln of String(m.text || '').split('\n')) {
      const [sku, raw = ''] = ln.split('\t'); const k = normSku(sku); if (!k) continue;
      const img = NO_IMAGE_RE.test(raw) ? '' : raw;  // 「画像無し.png」などは画像なし扱い
      const prev = m.exact.get(k);
      if (prev) {
        if (img && prev.image && prev.image !== img) { const s = m.conflicts.get(k) || new Set([prev.image]); s.add(img); m.conflicts.set(k, s); }
        if (!img || prev.image) continue;
      }
      m.exact.set(k, { sku, image: img }); if (img) withImg++;
      const sp = splitSku(k);
      if (sp && img) { if (!m.byBase.has(sp.base)) m.byBase.set(sp.base, []); m.byBase.get(sp.base).push({ size: sp.size, sku, image: img }); }
    }
    m.withImg = withImg;
    return m;
  }
  // 表の行（見出し付き）から、マスタのテキスト形式を作る
  const masterTextFromRows = (body, skuCol, imgCol) =>
    body.map(r => [String(r[skuCol] || '').trim(), String(r[imgCol] || '').trim().replace(/[\t\n]/g, ' ')]).filter(x => x[0]).map(x => x.join('\t')).join('\n');
  const findHeaderRow = rows => rows.slice(0, 15).findIndex(r => r.some(c => String(c).trim().length <= 20 && /sku/i.test(c)));

  // Yahoo!旧コード対応表CSVの1行 → 対応の値（'ot-123' / 'img:画像名' / 'none' / null）
  function legacyValue(design, img) {
    design = String(design || '').trim(); img = String(img || '').trim();
    if (design) return /^[a-z]+-\d/i.test(design) ? design.toLowerCase() : (/^画像な[しい]$/.test(design) ? 'none' : 'img:' + design);
    if (/^画像な[しい]$/.test(img)) return 'none';
    if (img && !img.includes(' / ')) return 'img:' + img;
    return null;
  }
  function parseLegacyCsv(rows) {
    const h = rows[0] || [], out = {};
    const ci = h.findIndex(x => /共通品番/.test(x)), ii = h.findIndex(x => /画像デザイン/.test(x));
    for (const r of rows.slice(1)) {
      const c = (r[0] || '').trim().toLowerCase(); if (!c) continue;
      const v = legacyValue(r[ci >= 0 ? ci : 2], ii >= 0 ? r[ii] : ''); if (v !== null) out[c] = v;
    }
    return out;
  }

  /* ================= 楽天 ================= */
  function rakutenLines(rows) {
    const out = [], gifts = new Map();
    for (const r of rows) {
      const orderId = r['注文番号']; if (!orderId) continue;
      const mallSku = r['SKU管理番号'] || r['システム連携用SKU番号'] || r['商品番号'] || r['商品管理番号'];
      const recipient = [r['送付先姓'], r['送付先名']].filter(Boolean).join(' ');
      const opts = parseKV(r['項目・選択肢']).filter(o => !IGNORE_OPT_RE.test(o.k));
      const skuKV = parseKV(r['SKU情報']);
      const sku = skuKV.filter(o => !COLOR_KEY_RE.test(o.k) && !SIZE_KEY_RE.test(o.k));
      out.push({
        mall: '楽天', mk: 'r', orderId, orderTime: r['注文日時'], recipient,
        mallSku, itemCode: r['商品管理番号'], title: r['商品名'], qty: parseInt(r['個数'], 10) || 1,
        key: normSku(mallSku), via: 'SKU管理番号', opts, showOpts: [...sku, ...opts],
        colorName: (skuKV.find(o => COLOR_KEY_RE.test(o.k)) || {}).v || '', sizeName: (skuKV.find(o => SIZE_KEY_RE.test(o.k)) || {}).v || ''
      });
      const wraps = [1, 2].map(i => [r['ラッピングタイトル' + i], r['ラッピング名' + i]].filter(Boolean).join('：')).filter(Boolean);
      const kinds = [...wraps];
      if (r['のし']) kinds.push('のし：' + r['のし']);
      if (r['ギフト配送希望'] === '1') kinds.push('ギフト配送希望');
      if (r['ソーシャルギフト注文フラグ'] === '1') kinds.push('ソーシャルギフト');
      if (kinds.length && !gifts.has(orderId)) {
        const cm = String(r['コメント'] || '').replace(/\[配送日時指定:[^\]]*\]/g, '').trim();
        gifts.set(orderId, { mall: '楽天', mk: 'r', orderId, recipient, kinds, message: cm, time: r['注文日時'] });
      }
    }
    return { lines: out, gifts: [...gifts.values()] };
  }

  /* ================= Yahoo! ================= */
  // 個別商品コード＋（商品オプション or 商品データ）→ 共通SKU
  function yahooResolve(itemId, sub, opts, ctx) {
    const std = sub.match(STD_SUB_RE);
    if (std) return { key: normSku(`${std[1]}-${std[2]}-${std[3]}`), via: '個別商品コード' };
    const p = ctx.yahooSub && ctx.yahooSub[sub.toLowerCase()];
    const code = String(itemId || (p && p[0]) || '').toLowerCase();
    const mapped = (ctx.legacy || {})[code];
    if (mapped === 'none') return { key: null, noImage: true, legacyCode: code, reason: 'Yahoo!旧コード：対応する画像なし' };
    const imageStem = mapped && mapped.startsWith('img:') ? mapped.slice(4) : null;
    const design = imageStem ? null : (mapped || (code.match(STD_ITEM_RE) || [])[1]);
    const oc = opts ? optColorSize(opts) : { color: '', size: '' };
    const color = oc.color || (p && p[1]) || '', size = oc.size || (p && p[2]) || '';
    if (imageStem) {
      if (!color) return { key: null, reason: 'カラー不明（Yahoo!商品情報CSVを読み込んでください）' };
      return { key: null, imageStem, color, size, via: '旧コード対応表（画像名）' };
    }
    if (!design) return { key: null, legacyCode: code, reason: 'Yahoo!旧コード：対応が未設定' };
    if (!color || !size) return { key: null, reason: opts ? 'オプションにカラー／サイズがありません' : 'カラー／サイズ不明（Yahoo!商品情報CSVを読み込んでください）' };
    return { key: normSku(`${design}-${color}-${size}`), via: mapped ? '旧コード対応表' : (oc.color && oc.size ? '商品オプション' : 'Yahoo!商品データ') };
  }
  function yahooOrderInfo(r) {
    const kinds = [];
    if (r.GiftWrapType) kinds.push(r.GiftWrapType);
    else if (r.NeedGiftWrap === '1') kinds.push('ギフト包装');
    if (r.GiftWrapPaperType) kinds.push('包装紙：' + r.GiftWrapPaperType);
    if (r.GiftWrapName) kinds.push('のし名：' + r.GiftWrapName);
    if (r.SocialGiftType && r.SocialGiftType !== '0') kinds.push('ソーシャルギフト');
    const recipient = r.ShipName || [r.ShipLastName, r.ShipFirstName].filter(Boolean).join(' ');
    const gift = (kinds.length || r.GiftWrapMessage) ? {
      mall: 'Yahoo!', mk: 'y', orderId: r.OrderId, recipient, kinds: kinds.length ? kinds : ['ギフトメッセージ'],
      message: [r.GiftWrapMessage, r.BuyerComments && ('備考：' + r.BuyerComments)].filter(Boolean).join('\n'), time: r.OrderTime
    } : null;
    return { time: r.OrderTime, recipient, gift };
  }
  function yahooLine(orderId, info, itemId, sub, title, qty, opts, inscription, ctx) {
    const res = yahooResolve(itemId, sub || itemId, opts, ctx);
    const all = (opts || []).filter(o => !IGNORE_OPT_RE.test(o.k));
    return {
      mall: 'Yahoo!', mk: 'y', orderId, orderTime: info && info.time, recipient: info && info.recipient, noOrderInfo: !info,
      mallSku: sub || itemId, itemCode: itemId, title, qty,
      key: res.key, via: res.via, reason: res.reason, legacyCode: res.legacyCode,
      imageStem: res.imageStem, color: res.color, size: res.size, noImage: res.noImage,
      opts: [...all, ...inscription], showOpts: [...all.filter(o => !COLOR_KEY_RE.test(o.k) && !SIZE_KEY_RE.test(o.k)), ...inscription],
      colorName: (all.find(o => COLOR_KEY_RE.test(o.k)) || {}).v || '', sizeName: (all.find(o => SIZE_KEY_RE.test(o.k)) || {}).v || ''
    };
  }
  // orderRowsList / itemRowsList：各CSVの行（toObjects 済み）の配列の配列
  function yahooLines(orderRowsList, itemRowsList, ctx) {
    const info = new Map(), gifts = [];
    for (const rows of orderRowsList) for (const r of rows) { if (!r.OrderId) continue; const i = yahooOrderInfo(r); info.set(r.OrderId, i); if (i.gift) gifts.push(i.gift); }
    const out = [];
    if (itemRowsList.length) {
      // 商品情報CSV（1明細1行・オプション／名入れ付き）
      for (const rows of itemRowsList) for (const r of rows) {
        if (!r.OrderId) continue;
        const names = String(r.ItemOptionName || '').split(';'), vals = String(r.ItemOptionValue || '').split(';');
        const opts = names.map((k, i) => ({ k: k.trim(), v: (vals[i] || '').trim() })).filter(o => o.k || o.v);
        const inscription = r.InscriptionValue ? [{ k: '名入れ（' + (r.InscriptionName || '文字') + '）', v: r.InscriptionValue }] : [];
        out.push(yahooLine(r.OrderId, info.get(r.OrderId), r.ItemId, r.SubCode, r.Title, parseInt(r.Quantity, 10) || 1, opts, inscription, ctx));
      }
    } else {
      // 注文情報CSVのみ（L1=…&L2=… 形式。オプション・名入れは取れない）
      for (const rows of orderRowsList) for (const r of rows) {
        if (!r.OrderId) continue;
        const ids = splitL(r.ItemId), subs = splitL(r.SubCode), titles = splitL(r.Title), qtys = splitL(r.QuantityDetail || r.Quantity);
        for (const ln of Object.keys(ids)) out.push(yahooLine(r.OrderId, info.get(r.OrderId), ids[ln], subs[ln], titles[ln] || '', parseInt(qtys[ln], 10) || 1, null, [], ctx));
      }
    }
    return { lines: out, gifts };
  }

  /* ================= 画像との紐づけ ================= */
  // 旧コード対応表で画像名が指定されている場合：画像名＋注文カラー（黒/白）で探す
  function resolveStemImage(ln, ctx) {
    const cj = COLOR_NAME_JP[ln.color] || ln.color, stem = ln.imageStem;
    const pre = LARGE_RE.test(ln.size) ? '[大]' : KIDS_RE.test(ln.size) ? '[キッズ]' : '';
    const cands = [...(pre ? [`${pre}${stem} ${cj}`, `${pre}${stem}`] : []), `${stem} ${cj}`, stem];
    ln.image = `${pre}${stem} ${cj}.png`;
    if (!ctx.hasImages) { ln.status = 'nofolder'; return; }
    for (const c of cands) { const e = ctx.findImage(c); if (e) { ln.image = e.name; ln.file = e; ln.status = 'ok'; return; } }
    ln.status = 'noimage';
  }
  // 画面で登録したSKU（品番-カラー単位）。マスタより優先する
  function resolveCustom(line, ctx) {
    const c = ctx.custom || {}, key = line.key; if (!key) return false;
    const sp = splitSku(key); const hit = sp && c[sp.base]; if (!hit) return false;
    const need = SIZE_CLASS[sizeClass(sp.size)];
    line.regKey = sp.base; line.masterSku = 'ツール登録：' + sp.base;
    const sizes = hit.sizes || ['normal', 'large', 'kids'];
    if (!sizes.includes(need)) { line.status = 'unregistered'; line.reason = `${sp.base} は ${SIZE_LABEL[need]} が未登録`; return true; }
    const names = need === 'large' ? ['[大]' + hit.image] : need === 'kids' ? ['[キッズ]' + hit.image, hit.image] : [hit.image];
    line.image = names[need === 'kids' ? 1 : 0];
    if (!ctx.hasImages) { line.status = 'nofolder'; return true; }
    for (let i = 0; i < names.length; i++) {
      const e = ctx.findImage(names[i]);
      if (e) { line.image = e.name; line.file = e; line.status = 'ok'; line.kidsShrink = need === 'kids' && i === 1; return true; }
    }
    line.image = names[0]; line.status = 'noimage'; return true;
  }
  function resolveImage(line, ctx) {
    if (resolveCustom(line, ctx)) return;
    const m = ctx.master;
    if (!m) { line.status = 'nomaster'; return; }
    const conf = m.conflicts.get(line.key);
    if (conf) { line.status = 'conflict'; line.reason = 'マスタ重複：' + [...conf].join(' / '); return; }
    const hit = m.exact.get(line.key);
    if (hit && hit.image) { line.image = hit.image; line.masterSku = hit.sku; }
    else {
      // 同デザイン・同カラーで、同じサイズ区分（キッズ／通常／4XL以上）の画像から推定
      const sp = splitSku(line.key); const cands = sp && m.byBase.get(sp.base);
      const pick = cands && cands.find(c => sizeClass(c.size) === sizeClass(sp.size));
      if (!pick) { line.status = hit ? 'emptyimg' : 'unregistered'; return; }
      line.image = pick.image; line.masterSku = pick.sku; line.estimated = true;
    }
    if (!ctx.hasImages) { line.status = 'nofolder'; return; }
    line.file = ctx.findImage(line.image);
    line.status = line.file ? (line.estimated ? 'est' : 'ok') : 'noimage';
  }

  /* ================= 全体の処理 ================= */
  // files: [{ name, kind:'rakuten'|'yahooOrder'|'yahooItem', rows:[{...}] }]
  function processOrders(files, ctx) {
    let lines = [], gifts = [];
    const notices = [];
    for (const f of files.filter(f => f.kind === 'rakuten')) { const r = rakutenLines(f.rows); lines = lines.concat(r.lines); gifts = gifts.concat(r.gifts); }
    const yo = files.filter(f => f.kind === 'yahooOrder').map(f => f.rows), yi = files.filter(f => f.kind === 'yahooItem').map(f => f.rows);
    if (yo.length || yi.length) {
      const r = yahooLines(yo, yi, ctx); lines = lines.concat(r.lines); gifts = gifts.concat(r.gifts);
      if (!yi.length) notices.push('Yahoo!の<b>商品情報CSV</b>が読み込まれていません。商品オプション（袖・プリント面など）と名入れ文字が取得できないため、注文情報CSVと一緒に読み込んでください。');
      if (!yo.length) notices.push('Yahoo!の<b>注文情報CSV</b>が読み込まれていません。注文日時（ファイル名）とギフト情報が取得できないため、Yahoo!分はZIPに含めていません。');
    }
    const names = [];
    for (const ln of lines) {
      ln.custom = customKind(ln.key || ln.mallSku) || customKind(ln.itemCode);
      const nameTitle = NAME_TITLE_RE.test(ln.title || '');
      if (ln.custom) ln.status = 'custom';
      else if (isPlain(ln)) ln.status = 'plain';           // 無地（印刷不要）
      else if (ln.imageStem) resolveStemImage(ln, ctx);
      else if (ln.noImage) ln.status = 'legacynone';
      else if (!ln.key) ln.status = 'unresolved';
      else resolveImage(ln, ctx);
      // 商品名が「名入れ」で画像がないもの（kp-00001、kt-10001 など）は名入れ・オーダー扱い
      if (!ln.custom && nameTitle && NO_IMG_STATUS.includes(ln.status)) { ln.custom = '名入れ'; ln.status = 'custom'; }
      if (ln.noOrderInfo && (ln.status === 'ok' || ln.status === 'est')) ln.status = 'noorder';
      const nameOpts = ln.custom ? ln.opts : ln.opts.filter(o => NAME_KEY_RE.test(o.k));
      if (ln.custom || nameOpts.length || nameTitle) {
        names.push({
          ln, kind: ln.custom || '名入れ', opts: nameOpts,
          note: nameOpts.length ? '' : ln.custom === '写真プリント' ? '写真・指定内容は注文詳細で確認'
            : ln.custom ? (ln.mk === 'y' ? 'CSVに名入れ内容がありません（商品情報CSVを確認）' : '名入れ内容は注文詳細で確認')
            : 'デザイン画像のみZIPに含めています。名入れ内容は注文詳細で確認'
        });
      }
    }
    computeOuts(lines);
    return { lines, gifts, names, notices };
  }

  // 出力ファイル名（注文日時_元画像名[_位置]_連番）。両面は前面・背面の2枚、胸・キッズ（登録SKU）は縮小
  function computeOuts(lines) {
    const cnt = {};
    for (const ln of lines) {
      ln.positions = printPositions(ln.opts);
      ln.outs = [];
      if (!ln.image || !ln.orderTime) { ln.outNames = []; continue; }
      const ext = (ln.image.match(/\.[a-z0-9]+$/i) || ['.png'])[0];
      const stem = ((ln.file && ln.file.name) || ln.image).replace(/(\.[a-z0-9]+)+$/i, '');
      for (let i = 0; i < ln.qty; i++) {
        for (const pos of ln.positions) {
          const label = pos === '胸' ? '_胸' : (pos && (pos !== '前面' || ln.positions.length > 1)) ? '_' + pos : '';
          const base = `${ts14(ln.orderTime)}_${safeName(stem)}${label}`;
          cnt[base] = (cnt[base] || 0) + 1;
          const kids = !!ln.kidsShrink;
          ln.outs.push({ name: `${base}_${cnt[base]}${pos === '胸' || kids ? '.png' : ext}`, chest: pos === '胸', kids });
        }
      }
      ln.outNames = ln.outs.map(o => o.name);
    }
  }

  // 黒T・白Tのインク色チェック（明るさ v は 0〜255、画像の不透明部分の平均）
  const shirtOf = ln => ln.color || (ln.key ? ln.key.split('-').slice(-2, -1)[0] : '') || '';
  const inkBad = (shirt, v) => v != null && ((shirt === 'black' && v < 60) || (shirt === 'white' && v > 195));
  const swapColorName = (name, shirt) => { const want = shirt === 'black' ? '黒' : '白'; const s = name.replace(/(黒|白)(\s*(\.png)+)$/i, want + '$2'); return s !== name ? s : null; };

  const api = {
    // ルール
    CUSTOM_PREFIX, NAME_KEY_RE, NAME_TITLE_RE, NO_IMG_STATUS, NG_STATUS, IGNORE_OPT_RE, HOT_OPT_RE, COLOR_KEY_RE, SIZE_KEY_RE,
    STD_ITEM_RE, SIZE_CLASS, SIZE_LABEL, COLOR_NAME_JP,
    // 変換
    sizeClass, normSize, normColor, normSku, splitSku, customKind, isPlain, printPositions, optColorSize, ts14, safeName, stemOf, imgKey, makeImageFinder,
    // CSV
    parseCSV, toObjects, detectKind, parseKV, splitL,
    // マスタ・対応表
    buildMasterIndex, masterTextFromRows, findHeaderRow, legacyValue, parseLegacyCsv,
    // 注文
    rakutenLines, yahooResolve, yahooLines, resolveImage, resolveCustom, resolveStemImage, processOrders, computeOuts,
    // インク色
    shirtOf, inkBad, swapColorName
  };
  root.DTFCore = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

// 業務ロジック（js/core.js）のテスト。実行：node --test tests/
// 注文データ・マスタはすべて架空のもの（tests/fixtures）。実際の注文CSVや商品管理マスタは使わない。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../js/core.js');

const load = (name, kind) => {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8').replace(/^﻿/, '');
  const rows = C.parseCSV(text);
  return { name, kind: kind || C.detectKind(rows[0]), rows: C.toObjects(rows) };
};

// 架空の商品管理マスタ（出品者SKU \t DTF画像名）
const MASTER_TEXT = [
  'OT-122-Black-M\tポンコツ 黒.png',
  'OT-122-Black-L\tポンコツ 黒.png',
  'OT-122-Black-5XL\t[大] ポンコツ 黒.png',
  'OT-1400-Black-XL\tオキナワ 黒.png',
  'OT-040-Black-L\tジィジ 黒.png',
  'lt-00001-Black-8L\t画像無し.png',
  'ON-302-Black-M\tAAA 黒.png',
  'ON-302-Black-M\tBBB 黒.png',
].join('\n');
// 取り込み済みのDTF画像（[大]の位置が違う表記ゆれも含む）
const IMAGES = ['ポンコツ 黒.png', '[大]ポンコツ 黒.png', 'オキナワ 黒.png', 'ジィジ 黒.png', 'ホカニキルフク 白.png'];

const makeCtx = () => {
  const finder = C.makeImageFinder(IMAGES.map(name => ({ name })));
  return {
    master: C.buildMasterIndex({ text: MASTER_TEXT }),
    legacy: { '20220929hokani': 'img:ホカニキルフク' },
    custom: {}, findImage: finder.find, hasImages: true,
  };
};
const run = () => C.processOrders([load('rakuten.csv'), load('yahoo_order.csv'), load('yahoo_item.csv')], makeCtx());
const bySku = (lines, sku) => lines.find(l => l.mallSku === sku);

test('SKUの正規化', () => {
  assert.equal(C.normSku(' OT-122-Black-XXL '), 'ot-122-black-2xl');
  assert.equal(C.normSku('ot-1-white-xxxl'), 'ot-1-white-3xl');
  assert.deepEqual(C.splitSku('ot-122-black-3xl'), { base: 'ot-122-black', size: '3xl' });
  assert.equal(C.splitSku('fe-00001-black'), null);
  assert.equal(C.normColor('黒Tシャツ'), 'black');
  assert.equal(C.normColor('ホワイト'), 'white');
  assert.equal(C.sizeClass('5xl'), 'large');
  assert.equal(C.sizeClass('120'), 'kids');
  assert.equal(C.sizeClass('m'), 'adult');
});

test('CSVの読み込み（引用符・改行入りの項目）とファイル種別の判定', () => {
  const rows = C.parseCSV('"a","b"\n"1","x\ny"\n"2","say ""hi"""\n');
  assert.deepEqual(rows, [['a', 'b'], ['1', 'x\ny'], ['2', 'say "hi"']]);
  assert.equal(load('rakuten.csv').kind, 'rakuten');
  assert.equal(load('yahoo_order.csv').kind, 'yahooOrder');
  assert.equal(load('yahoo_item.csv').kind, 'yahooItem');
});

test('画像ファイル名の表記ゆれを吸収して探す', () => {
  const f = C.makeImageFinder(['ホカニキルフク 白.png', '[大]ポンコツ 黒.png', 'ホンジツノトナカイ_ヤスミ 黒.png'].map(name => ({ name })));
  assert.equal(f.find('ホカニキルフク白.png').name, 'ホカニキルフク 白.png');          // 空白なし
  assert.equal(f.find('ホカニキルフク　白.png.png').name, 'ホカニキルフク 白.png');    // 全角空白・.png重複
  assert.equal(f.find('ポンコツ [大] 黒.png').name, '[大]ポンコツ 黒.png');            // [大]の位置
  assert.equal(f.find('ホンジツノトナカイ:ヤスミ 黒.png').name, 'ホンジツノトナカイ_ヤスミ 黒.png'); // : と _
  assert.equal(f.find('ないもの 黒.png'), null);
});

test('商品管理マスタ：画像無し・重複の扱い', () => {
  const m = C.buildMasterIndex({ text: MASTER_TEXT });
  assert.equal(m.exact.get('lt-00001-black-8l').image, '');           // 「画像無し.png」は画像なし
  assert.ok(m.conflicts.has('on-302-black-m'));                       // 同じSKUに画像が2種類
});

test('楽天：SKU管理番号でマスタと照合し、ファイル名を決める', () => {
  const { lines } = run();
  const a = bySku(lines, 'ot-122-black-m');
  assert.equal(a.status, 'ok');
  assert.equal(a.image, 'ポンコツ 黒.png');
  assert.deepEqual(a.outNames, ['20260101100000_ポンコツ 黒_1.png']);
  const b = bySku(lines, 'ot-1400-black-xl');                         // 数量2 → 2枚、連番
  assert.deepEqual(b.outNames, ['20260101140000_オキナワ 黒_1.png', '20260101140000_オキナワ 黒_2.png']);
  const c = bySku(lines, 'ot-122-black-5xl');                         // 4XL以上は[大]画像（表記ゆれも吸収）
  assert.equal(c.status, 'ok');
  assert.equal(c.file.name, '[大]ポンコツ 黒.png');
});

test('無地・名入れ・写真プリントは ZIP に入れない', () => {
  const { lines, names } = run();
  assert.equal(bySku(lines, 'lt-00001-Black-8L').status, 'plain');
  const kp = bySku(lines, 'kp-00001-red-l-60');
  assert.equal(kp.status, 'custom'); assert.equal(kp.custom, '名入れ');  // 商品名に「名入れ」・画像なし
  const pt = bySku(lines, 'pt-00001-black-3XL');
  assert.equal(pt.status, 'custom'); assert.equal(pt.custom, '写真プリント');
  assert.ok(names.some(n => n.ln === kp) && names.some(n => n.ln === pt));
});

test('Yahoo!：両面は2枚、胸は縮小フラグ付き', () => {
  const { lines } = run();
  const both = lines.find(l => l.mall === 'Yahoo!' && l.mallSku === 'ot-122-Black-M');
  assert.deepEqual(both.outNames, ['20260102090000_ポンコツ 黒_前面_1.png', '20260102090000_ポンコツ 黒_背面_1.png']);
  const chest = bySku(lines, 'ot-040-Black-L');
  assert.deepEqual(chest.outs, [{ name: '20260102110000_ジィジ 黒_胸_1.png', chest: true, kids: false }]);
});

test('Yahoo!：旧コードは対応表の画像名＋注文カラーで探す（XXL→2XL）', () => {
  const { lines } = run();
  const l = bySku(lines, 'w20220929hokanoXXL');
  assert.equal(l.status, 'ok');
  assert.equal(l.image, 'ホカニキルフク 白.png');
  assert.equal(l.size, '2xl');
});

test('Yahoo!：名入れ文字は商品情報CSVの InscriptionValue から取る', () => {
  const { lines, names } = run();
  const nt = bySku(lines, 'nt-00001m');
  assert.equal(nt.status, 'custom');
  const n = names.find(x => x.ln === nt);
  assert.ok(n.opts.some(o => o.v === 'TARO' && C.NAME_KEY_RE.test(o.k)));
});

test('ギフトは実際にギフト指定がある注文だけ', () => {
  const { gifts } = run();
  assert.equal(gifts.length, 2);
  const r = gifts.find(g => g.mall === '楽天');
  assert.deepEqual(r.kinds, ['ラッピング：赤リボン']);
  assert.equal(r.message, '誕生日プレゼントです');
  assert.deepEqual(gifts.find(g => g.mall === 'Yahoo!').kinds, ['ラッピング']);
});

test('画面で登録したSKU：サイズ区分ごとの画像（[大]・キッズ縮小）', () => {
  const ctx = makeCtx();
  ctx.custom = { 'ot-9999-black': { image: 'ポンコツ 黒.png', sizes: ['normal', 'large', 'kids'] }, 'ot-9999-white': { image: 'ポンコツ 白.png', sizes: ['normal'] } };
  const mk = key => ({ key, mallSku: key, title: '', opts: [] });
  const m = mk('ot-9999-black-m'); C.resolveImage(m, ctx); assert.equal(m.status, 'ok'); assert.equal(m.image, 'ポンコツ 黒.png');
  const l = mk('ot-9999-black-5xl'); C.resolveImage(l, ctx); assert.equal(l.file.name, '[大]ポンコツ 黒.png');
  const k = mk('ot-9999-black-120'); C.resolveImage(k, ctx); assert.equal(k.kidsShrink, true);  // [キッズ]画像がないので縮小
  const w = mk('ot-9999-white-5xl'); C.resolveImage(w, ctx); assert.equal(w.status, 'unregistered'); // 4XL以上は未登録
});

test('黒T・白Tのインク色チェックと反対色の画像名', () => {
  assert.equal(C.inkBad('black', 10), true);    // 黒Tに黒インク
  assert.equal(C.inkBad('black', 250), false);
  assert.equal(C.inkBad('white', 250), true);   // 白Tに白インク
  assert.equal(C.swapColorName('ナカガワ 白.png', 'black'), 'ナカガワ 黒.png');
  assert.equal(C.swapColorName('ゲームチェンジャー.png', 'black'), null);
});

test('Yahoo!旧コード対応表CSVの値', () => {
  assert.equal(C.legacyValue('ot-123', ''), 'ot-123');
  assert.equal(C.legacyValue('', 'ホカニキルフク'), 'img:ホカニキルフク');
  assert.equal(C.legacyValue('', '画像なし'), 'none');
  assert.equal(C.legacyValue('', 'A / B'), null);  // 候補が複数のままのものは使わない
});

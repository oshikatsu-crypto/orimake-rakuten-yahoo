/*
 * 楽天・Yahoo! DTF画像ツール ― 画像処理（ブラウザ用）
 *
 * ・shrinkPng：胸プリント・キッズ用の縮小。DPI（pHYs）とカラープロファイルは元画像から引き継ぐ
 * ・inkLevel ：画像の不透明部分の平均の明るさ（0〜255）。黒T／白Tのインク色チェックに使う
 *
 * OffscreenCanvas / createImageBitmap を使うので、ブラウザ（またはWeb Worker）で動かす。
 * orimake に組み込むときも、このファイルはそのまま流用できる。
 */
(function (root) {
  'use strict';

  function pngChunks(b) {
    const out = []; let p = 8;
    while (p + 8 <= b.length) {
      const len = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
      const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      out.push({ type, bytes: b.subarray(p, p + 12 + len) }); p += 12 + len;
      if (type === 'IEND') break;
    }
    return out;
  }
  const META_CHUNKS = ['pHYs', 'iCCP', 'sRGB', 'gAMA', 'cHRM'];

  // ratio（0〜1）の大きさに縮小した PNG を返す
  async function shrinkPng(file, ratio) {
    const src = new Uint8Array(await file.arrayBuffer());
    let img = await createImageBitmap(file, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    let w = img.width, h = img.height;
    const tw = Math.max(1, Math.round(w * ratio)), th = Math.max(1, Math.round(h * ratio));
    const draw = (cw, ch) => { const c = new OffscreenCanvas(cw, ch); const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, cw, ch); img = c; w = cw; h = ch; };
    while (w / 2 >= tw) draw(Math.round(w / 2), Math.round(h / 2));  // 段階的に縮小して画質を保つ
    draw(tw, th);
    const out = new Uint8Array(await (await img.convertToBlob({ type: 'image/png' })).arrayBuffer());
    const isPng = src[1] === 0x50 && src[2] === 0x4E && src[3] === 0x47;
    const meta = isPng ? pngChunks(src).filter(c => META_CHUNKS.includes(c.type)).map(c => c.bytes) : [];
    const body = pngChunks(out).filter(c => !META_CHUNKS.includes(c.type)).map(c => c.bytes);
    const parts = [out.subarray(0, 8), body[0], ...meta, ...body.slice(1)];  // IHDR の直後にメタ情報を挿入
    return new Blob(parts, { type: 'image/png' });
  }

  // 画像の不透明部分の平均の明るさ（0〜255）。読めなければ null
  async function inkLevel(blob) {
    try {
      const bm = await createImageBitmap(blob);
      const w = 96, h = Math.max(1, Math.round(bm.height * w / bm.width));
      const c = new OffscreenCanvas(w, h), x = c.getContext('2d'); x.drawImage(bm, 0, 0, w, h); if (bm.close) bm.close();
      const d = x.getImageData(0, 0, w, h).data; let s = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 200) continue; s += (d[i] + d[i + 1] + d[i + 2]) / 3; n++; }
      return n ? Math.round(s / n) : null;
    } catch (e) { return null; }
  }

  root.DTFImage = { pngChunks, shrinkPng, inkLevel };
})(typeof window !== 'undefined' ? window : globalThis);

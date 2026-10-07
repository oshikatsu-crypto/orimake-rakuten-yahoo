/*
 * 楽天・Yahoo! DTF画像ツール ― ブラウザ内の保存（IndexedDB / localStorage）
 *
 * 単体ツールでは、商品管理マスタ・DTF画像・画面で登録したSKUをブラウザ内に保存する。
 * orimake に組み込むときは、このファイルを orimake の DB（SKU管理）と画像ストレージへの
 * 読み書きに置き換える（docs/INTEGRATION.md を参照）。
 *
 *   kv  ストア： master / imgIndex / customSku / inkCache / yahoo
 *   img ストア： DTF画像本体（ファイル名 → Blob）
 */
(function (root) {
  'use strict';

  const lsGet = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { alert('ブラウザへの保存に失敗しました: ' + e.message); return false; } };

  const idb = (() => {
    let p;
    const open = () => p || (p = new Promise((ok, ng) => {
      const r = indexedDB.open('rydtf', 2);
      r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv'); if (!d.objectStoreNames.contains('img')) d.createObjectStore('img'); };
      r.onsuccess = () => ok(r.result); r.onerror = () => ng(r.error);
    }));
    const run = async (store, mode, fn) => { const d = await open(); return new Promise((ok, ng) => { const t = d.transaction(store, mode); const q = fn(t.objectStore(store)); t.oncomplete = () => ok(q && q.result); t.onerror = () => ng(t.error); t.onabort = () => ng(t.error); }); };
    return {
      get: k => run('kv', 'readonly', s => s.get(k)).catch(() => null),
      set: (k, v) => run('kv', 'readwrite', s => s.put(v, k)).then(() => true).catch(e => { alert('ブラウザへの保存に失敗しました: ' + e.message); return false; }),
      del: k => run('kv', 'readwrite', s => s.delete(k)).catch(() => null),
      imgGet: k => run('img', 'readonly', s => s.get(k)),
      imgPutMany: pairs => run('img', 'readwrite', s => { for (const [k, v] of pairs) s.put(v, k); }),
      imgClear: () => run('img', 'readwrite', s => s.clear())
    };
  })();

  root.DTFStore = { lsGet, lsSet, idb };
})(typeof window !== 'undefined' ? window : globalThis);

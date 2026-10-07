# orimake への統合ガイド

このリポジトリの楽天・Yahoo!対応を、orimake（Amazon版の注文情報管理 `/orders`）に組み込むための説明です。
業務ロジックは画面・保存から切り離してあるので、`js/core.js` と `js/image.js` はほぼそのまま流用できます。

## 1. 構成と統合時の扱い

| ファイル | 役割 | 統合時の扱い |
|---|---|---|
| `js/core.js`（`DTFCore`） | CSVの読み込み、SKUの正規化、SKU→DTF画像の紐づけ、出力ファイル名の決定 | **そのまま流用**（DOM・保存に依存しない純粋な処理） |
| `js/image.js`（`DTFImage`） | 胸・キッズ用の縮小（DPI・カラープロファイルを保持）、インク色の判定 | **そのまま流用**（ブラウザ／Web Worker で動作） |
| `js/storage.js`（`DTFStore`） | IndexedDB / localStorage への保存 | orimake の DB（SKU管理）と画像ストレージに**置き換え** |
| `js/app.js` | 画面の操作と表示 | orimake の `/orders` 画面に**置き換え** |
| `tests/core.test.js` | `core.js` のテスト（架空データ） | 統合後も回帰テストとして使える |

各ファイルは「即時関数＋グローバル（`window.DTFCore` など）＋ CommonJS（`module.exports`）」の形です。
ES Modules / TypeScript にする場合は、末尾の `root.DTFCore = api; module.exports = api;` を `export` に置き換えるだけです。

## 2. 処理の流れ

```
注文CSV（楽天 / Yahoo!注文情報 / Yahoo!商品情報）
   │ parseCSV → detectKind → toObjects
   ▼
processOrders(files, ctx)
   │ ① 楽天：SKU管理番号 → 共通SKU（normSku）
   │ ② Yahoo!：個別商品コード／旧コード対応表＋商品オプション(カラー・サイズ) → 共通SKU
   │ ③ 共通SKU → DTF画像名（ctx.custom → ctx.master の順。サイズ区分で[大]・[キッズ]）
   │ ④ 名入れ・写真プリント・無地の判定、ギフト・名入れ一覧の作成
   │ ⑤ computeOuts：出力ファイル名（注文日時_画像名[_位置]_連番）
   ▼
{ lines, gifts, names, notices }
   │ （画面）インク色チェック：inkLevel → inkBad → swapColorName で差し替え
   │ （画面）ZIP：lines[].outs ごとに画像Blob、chest/kids は shrinkPng で縮小
   ▼
DTF画像ZIP
```

## 3. `processOrders(files, ctx)`

### 入力

```js
files = [{ name, kind: 'rakuten' | 'yahooOrder' | 'yahooItem', rows: [ { 列名: 値, ... } ] }]

ctx = {
  master,     // buildMasterIndex({ text }) の結果。text は「SKU\tDTF画像名」を改行でつないだもの
  legacy,     // Yahoo!旧商品コード（小文字）→ 'ot-123' | 'img:画像名' | 'none'
  yahooSub,   // （任意）Yahoo!商品データの個別商品コード → [商品コード, カラー, サイズ]
  custom,     // （任意）'品番-カラー' → { image, sizes: ['normal','large','kids'] }
  findImage,  // (画像名) => { name, ... } | null   表記ゆれの吸収は makeImageFinder を参照
  hasImages,  // boolean
}
```

orimake では、次のように作ります。

| ctx | orimake での作り方 |
|---|---|
| `master` | SKU管理（`/sku`）の「SKU → DTF画像名」から `text` を作り、`buildMasterIndex({ text })` に渡す。楽天・Yahoo!のSKUは Amazon と同じ形式（`ot-122-black-m`）なので、同じテーブルで引ける |
| `legacy` | Yahoo!旧コード対応表を orimake のテーブルに移し、`{ 旧コード: 値 }` の形で渡す（元データ：`Yahoo旧コード対応表_候補.csv`、222件） |
| `custom` | SKU管理に統合するなら不要（空オブジェクト） |
| `findImage` | 画像ストレージのファイル名一覧から `makeImageFinder(entries).find` を作る。エントリにはストレージのキーやURLを持たせてよい |

### 出力（`lines` の主な項目）

| 項目 | 内容 |
|---|---|
| `mall` / `orderId` / `orderTime` | モール、注文番号、注文日時 |
| `mallSku` / `key` | モールのSKU、共通SKU（正規化済み） |
| `title` / `colorName` / `sizeName` / `qty` | 商品名、カラー、サイズ、数量 |
| `opts` / `showOpts` | 商品オプション（プリント面・名入れなど） |
| `image` / `file` | DTF画像名、`findImage` が返したエントリ |
| `status` | 下の表を参照 |
| `outs` | `[{ name, chest, kids }]` ZIPに入れるファイル。`chest`・`kids` は縮小が必要 |

| status | 意味 | ZIP |
|---|---|---|
| `ok` / `est` | 画像あり（`est`：同じデザイン・カラー・サイズ区分の画像から推定） | 入れる |
| `custom` | 名入れ・写真プリント | 入れない（名入れ一覧へ） |
| `plain` | 無地（印刷不要） | 入れない |
| `unregistered` / `emptyimg` / `noimage` / `conflict` / `unresolved` / `legacynone` / `colorng` | 画像なし（理由別） | 入れない（画像なし一覧へ） |
| `nofolder` / `nomaster` / `noorder` | 画像未取り込み／マスタ未読込／Yahoo!注文情報CSVなし | 入れない |

## 4. 業務ルール（`core.js` の定数）

| ルール | 定数・関数 |
|---|---|
| 名入れ・写真プリントの品番（`nt-`・`pt-`） | `CUSTOM_PREFIX` |
| 商品名に「名入れ」→ 画像がなければ名入れ扱い | `NAME_TITLE_RE` |
| 無地（`lt-` かつ商品名に「無地」） | `isPlain` |
| サイズ表記の統一（XXL→2XL、XXXL→3XL） | `SIZE_ALIAS` / `normSku` |
| サイズ区分（キッズ 100〜150／通常／4XL以上） | `sizeClass` / `SIZE_CLASS` |
| プリント位置（両面→前面・背面の2枚、胸→縮小） | `printPositions` / `computeOuts` |
| 画像名の表記ゆれ（空白・.png重複・[大]の位置・: と _） | `imgKey` / `makeImageFinder` |
| マスタの「画像無し.png」は画像なし扱い、同一SKUに複数画像は「重複」 | `buildMasterIndex` |
| 黒T・白Tのインク色（画像名の黒／白＝Tシャツの色） | `shirtOf` / `inkBad` / `swapColorName`（`image.js` の `inkLevel` と組み合わせる） |
| ギフト判定（ラッピング・のし・ギフト包装・ソーシャルギフト） | `rakutenLines` / `yahooLines` |

## 5. 統合の手順（案）

1. `js/core.js`・`js/image.js`・`tests/` を orimake に追加する（必要なら ES Modules / TypeScript に変換）
2. `/orders` のアップロードで、Amazon の `.txt` に加えて楽天・Yahoo!の `.csv` を受け付け、`detectKind` で振り分ける
3. `ctx` を orimake の SKU管理・画像ストレージから作り、`processOrders` を呼ぶ
4. 画面は Amazon 版の構成（集計 → ギフト → 名入れ → 画像なし → ZIP一覧）に、楽天・Yahoo!の列（モール、カラー・サイズ、オプション）を足す
5. ZIP 生成は Amazon 版の処理に、`outs[].chest`・`outs[].kids` の縮小（`shrinkPng`）を足す
6. `node --test tests/` が通ることを確認する

## 6. 方針

- 注文データ（個人情報）は保存しない。ブラウザ（またはサーバーのメモリ）上で処理して破棄する
- 商品管理マスタ・DTF画像・Yahoo!旧コード対応表は公開リポジトリに含めない

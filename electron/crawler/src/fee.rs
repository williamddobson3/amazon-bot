//! 手数料・サイズ区分 計算エンジン (Rust 実装)
//!
//! クライアント機密のため、JS (profit.js / fee-calc.js) にあった手数料・
//! サイズ区分の計算ロジック (カテゴリ別料率表 / FBA 料金表 / サイズ判定 /
//! ブランド表 等) を Rust に移植し、コンパイル済みバイナリ (strip + LTO)
//! 内にのみ存在させる。JS 側には CSV 列マッピングや値抽出などのプラム
//! 配管のみを残す。
//!
//! 公開 API:
//!   computeFees(keepaItemJson, salesPrice, settingsJson, month) -> resultJson
//!     resultJson = {"sizeKubun":"標準4","fbaFee":420,"inventoryStorageFee":8,"amazonFee":221}
//!     (amazonFee は消費税10%込み = int(本体手数料 × 1.1))
//!
//! 入力 keepaItem (JSON) は CSV / Keepa API から JS 側で組んだもの:
//!   packageLength/Width/Height/Weight, itemLength/.../Weight (number|null),
//!   fbaPickAndPackFee, referralFeePercent, referralFeeBasedOnCurrentBuyBoxPrice,
//!   rootCategory(string), categories([string]), categoryTreeList([string]), brand(string)

use napi_derive::napi;
use serde::Deserialize;

#[derive(Deserialize, Default)]
#[serde(default)]
struct KeepaItem {
    #[serde(rename = "packageLength")] package_length: Option<f64>,
    #[serde(rename = "packageWidth")]  package_width:  Option<f64>,
    #[serde(rename = "packageHeight")] package_height: Option<f64>,
    #[serde(rename = "packageWeight")] package_weight: Option<f64>,
    #[serde(rename = "itemLength")] item_length: Option<f64>,
    #[serde(rename = "itemWidth")]  item_width:  Option<f64>,
    #[serde(rename = "itemHeight")] item_height: Option<f64>,
    #[serde(rename = "itemWeight")] item_weight: Option<f64>,
    #[serde(rename = "fbaPickAndPackFee")] fba_pick_and_pack_fee: Option<f64>,
    #[serde(rename = "referralFeePercent")] referral_fee_percent: Option<f64>,
    #[serde(rename = "referralFeeBasedOnCurrentBuyBoxPrice")] referral_fee_buybox: Option<f64>,
    #[serde(rename = "rootCategory")] root_category: Option<String>,
    categories: Vec<String>,
    #[serde(rename = "categoryTreeList")] category_tree_list: Vec<String>,
    brand: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Settings {
    #[serde(rename = "clickpostLength1")] clickpost_length1: f64,
    #[serde(rename = "clickpostLength2")] clickpost_length2: f64,
    #[serde(rename = "clickpostLength3")] clickpost_length3: f64,
    #[serde(rename = "clickpostWeight")]  clickpost_weight:  f64,
    #[serde(rename = "nekoposLongest")]     nekopos_longest:      f64,
    #[serde(rename = "nekoposShortest")]    nekopos_shortest:     f64,
    #[serde(rename = "nekoposTotalLength")] nekopos_total_length: f64,
    #[serde(rename = "nekoposWeight")]      nekopos_weight:       f64,
}

struct SizeParams {
    sales_price: f64,
    fba_pick_and_pack_fee: Option<f64>,
    referral_fee_percent: Option<f64>,
    referral_fee_buybox: Option<f64>,
    root_category: String,
    sub_tree_category: String,
    brand: String,
    month: u32,
    size_list: [f64; 3],
    size_total: f64,
    weight: f64,
    size_kind: i32,
    is_no_size_no_weight: bool,
    is_no_size: bool,
    is_no_weight: bool,
}

// JS の `x || 0` 相当 (null/0 → 0、-1 等の truthy はそのまま)。
#[inline]
fn or0(x: Option<f64>) -> f64 {
    match x { Some(v) => v, None => 0.0 }
}

// ── サイズ判定 ────────────────────────────────────────────────
fn get_size_parameters(item: &KeepaItem, sales_price: f64, month: u32) -> SizeParams {
    // サブ + ツリーを連結 (JS と同じ結合)。
    let mut sub_tree_category = item.categories.join(",");
    if !item.category_tree_list.is_empty() {
        sub_tree_category.push(',');
        sub_tree_category.push_str(&item.category_tree_list.join(","));
    }

    let mut length = or0(item.package_length);
    let mut width  = or0(item.package_width);
    let mut height = or0(item.package_height);
    let mut weight = or0(item.package_weight);

    if length <= 0.0 || width <= 0.0 || height <= 0.0 {
        length = or0(item.item_length);
        width  = or0(item.item_width);
        height = or0(item.item_height);
    }
    if length <= 0.0 { length = 0.0; }
    if width  <= 0.0 { width  = 0.0; }
    if height <= 0.0 { height = 0.0; }
    if weight <= 0.0 { weight = or0(item.item_weight); }
    if weight <= 0.0 { weight = 0.0; }
    weight /= 1000.0;

    let mut size_list = [length, width, height];
    size_list.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let mut size_total = length + width + height;

    let mut size_kind: i32 = 2;
    if weight > 40.0 { size_kind = 4; }
    else if size_total > 200.0 { size_kind = 4; }
    else if weight > 9.0 { size_kind = 3; }
    else if size_total > 100.0 { size_kind = 3; }
    else if size_list[0] > 20.0 { size_kind = 3; }
    else if size_list[1] > 35.0 { size_kind = 3; }
    else if size_list[2] > 45.0 { size_kind = 3; }
    else if weight > 0.25 { size_kind = 2; }
    else if size_total > 45.0 { size_kind = 2; }
    else if size_list[0] > 2.0 { size_kind = 2; }
    else if size_list[1] > 18.0 { size_kind = 2; }
    else if size_list[2] > 25.0 { size_kind = 2; }
    else { size_kind = 1; }

    let mut is_no_size_no_weight = false;
    let mut is_no_size = false;
    let mut is_no_weight = false;

    if (length == 0.0 || width == 0.0 || height == 0.0) && weight == 0.0 {
        is_no_size_no_weight = true;
        is_no_size = true;
        is_no_weight = true;
        size_list = [20.0, 25.0, 30.0];
        weight = 4.5;
        size_kind = 2;
    } else if length == 0.0 || width == 0.0 || height == 0.0 {
        is_no_size = true;
        size_list = match size_kind {
            4 => [40.0, 50.0, 60.0],
            3 => [5.0, 15.0, 25.0],
            2 => [2.0, 20.0, 25.0],
            _ => [1.0, 10.0, 15.0],
        };
    } else if weight == 0.0 {
        is_no_weight = true;
        weight = match size_kind {
            4 => 45.0,
            3 => 1.5,
            2 => 0.5,
            1 => 0.1,
            _ => 4.5,
        };
    }

    size_total = size_list[0] + size_list[1] + size_list[2];

    SizeParams {
        sales_price,
        fba_pick_and_pack_fee: item.fba_pick_and_pack_fee,
        referral_fee_percent: item.referral_fee_percent,
        referral_fee_buybox: item.referral_fee_buybox,
        root_category: item.root_category.clone().unwrap_or_default(),
        sub_tree_category,
        brand: item.brand.clone().unwrap_or_default(),
        month,
        size_list,
        size_total,
        weight,
        size_kind,
        is_no_size_no_weight,
        is_no_size,
        is_no_weight,
    }
}

// 化粧品ブランド (Amazon 手数料率の上振れ判定)。ブランド名と完全一致。
const COSME_BRANDS: &[&str] = &[
    "AMPLEUR", "Amplitude", "APOTHIA", "artis", "B.A", "bamford", "bareMinerals",
    "BAUM", "BOTANICALS", "Celvoke", "COCUU", "COVERMARK", "CUTECH キューテック",
    "Davids", "Dermalogica", "DEUXER", "Do Organic", "Dr. Hauschka", "Dr.Scalp",
    "ecostore", "eLGON", "enisie エニシー", "ERUCALA", "est", "F organics",
    "FIVEISM × THREE", "FORM（フォルム）", "giovanni", "gue:", "H201JAPAN", "HACCI",
    "Hahonico ハホニコ", "HAIR RITUEL BY SISLEY", "HERBIVORE BOTANICALS",
    "HIKARIMIRAI", "HUE GLOSS", "HUE", "I'm La Floria", "INTERLOCK インターロック",
    "IPST", "Josiane Laure", "kai fragrance", "KAIIAGE", "KANEBO", "KESHIKI",
    "La Fare 1789", "La Roche-Posay", "LE LUMISS", "Les parfums de Rosine",
    "MARVIS", "MDNA SKIN", "Mediplorer", "Melvita", "MiMC", "Mineral Air",
    "MODERN NOTES", "MOLTON BROWN", "MOROCCANOIL", "MUCOTA", "NANOAMINO",
    "NEAL'S YARD REMEDIES", "NUMBER THREE", "Obagi", "OPI", "PHYT'S", "plus eau",
    "PROACTION for C", "promille", "RECOLLAGE", "Red B.A", "ReKERA", "RevitaLash",
    "RMK", "Roots hair", "ROSE LABO", "SHISEIDO MEN", "SISLEY", "THREE", "to/one",
    "TOOFRUIT", "track", "WELEDA", "YOU&OIL",
];

#[inline]
fn is_cosme_brand(brand: &str) -> bool {
    COSME_BRANDS.iter().any(|&b| b == brand)
}

// ── Amazon 販売手数料: カテゴリ表から (rate1, rate2, rate1Price, amazonFee) ──
fn get_amazon_fee_by_category(p: &SizeParams) -> (f64, f64, f64, f64) {
    let root = &p.root_category;
    let sub = &p.sub_tree_category;
    let brand = &p.brand;
    let sp = p.sales_price;

    let hr = |kw: &str| root.contains(kw);
    let hs = |kw: &str| sub.contains(kw);

    let mut r1: f64;
    let mut r2: f64;
    let mut r1p: f64 = 0.0;
    let mut fee: f64;

    if hr("本") || hr("洋書") || hr("CD・レコード") || hr("ミュージック")
        || hr("クラシック") || hr("DVD") || hr("ビデオ") || hr("PCソフト")
    {
        r1 = 0.15; r2 = r1; r1p = 0.0; fee = r1 * sp + 140.0;
    } else if hr("ホームアプライアンス") || hr("DIY・工具")
        || hr("産業・研究開発用品") || hr("その他のカテゴリー")
    {
        r1 = if sp <= 750.0 { 0.05 } else { 0.154 };
        r2 = r1; fee = r1 * sp;
    } else if hr("楽器") || (hr("スポーツ") && hr("アウトドア")) || hr("車")
        || hr("バイク") || hr("バイク用品") || hr("おもちゃ") || hr("ホビー")
    {
        r1 = if sp <= 750.0 { 0.05 } else { 0.104 };
        r2 = r1; fee = r1 * sp;
    } else if hr("エレクトロニクス") || (hr("家電") && hr("カメラ"))
        || hr("パソコン・周辺機器")
    {
        r1 = if sp <= 750.0 { 0.05 } else { 0.084 };
        r2 = r1; fee = r1 * sp;
        if hr("楽器") {
            r1 = if sp <= 750.0 { 0.05 } else { 0.104 };
            r2 = r1; fee = r1 * sp;
        }
    } else if hr("Amazonデバイス用アクセサリ") {
        r1 = 0.45; r2 = r1; fee = r1 * sp;
    } else if hr("ドラッグストア") || hr("業務用医療用品") {
        r1 = if sp <= 750.0 { 0.05 } else if sp <= 1500.0 { 0.084 } else { 0.104 };
        r2 = r1; fee = r1 * sp;
    } else if hr("ビューティー") {
        if sp <= 750.0 { r1 = 0.05; r2 = r1; fee = r1 * sp; }
        else if sp <= 1500.0 { r1 = 0.084; r2 = r1; fee = r1 * sp; }
        else {
            r1 = 0.104; r2 = r1; fee = r1 * sp;
            if is_cosme_brand(brand) { r1 = 0.154; r2 = r1; fee = r1 * sp; }
        }
    } else if hr("ゲーム") {
        if hs("ゲーム機本体") {
            r1 = if sp <= 750.0 { 0.05 } else { 0.084 };
        } else { r1 = 0.154; }
        r2 = r1; fee = r1 * sp;
    } else if hr("ペット用品") {
        r1 = if sp <= 750.0 { 0.05 } else if sp <= 1500.0 { 0.084 } else { 0.154 };
        r2 = r1; fee = r1 * sp;
    } else if hr("文房具・オフィス用品") {
        if hs("電子辞書") || hs("電子辞書アクセサリ") {
            r1 = 0.08; r2 = r1; fee = r1 * sp;
        } else {
            r1 = if sp <= 750.0 { 0.05 } else { 0.154 };
            r2 = r1; fee = r1 * sp;
        }
    } else if hr("ホーム") && hr("キッチン") {
        if hs("キッチン家電") { r1 = if sp <= 750.0 { 0.05 } else { 0.104 }; }
        else if hs("家電") { r1 = if sp <= 750.0 { 0.05 } else { 0.084 }; }
        else if hs("家具") || hs("マットレス") { r1 = if sp <= 750.0 { 0.05 } else { 0.154 }; }
        else { r1 = if sp <= 750.0 { 0.05 } else { 0.154 }; }
        r2 = r1; fee = r1 * sp;
    } else if hr("食品") && hr("飲料") {
        r1 = if sp <= 750.0 { 0.05 } else if sp <= 1500.0 { 0.084 } else { 0.104 };
        r2 = r1; fee = r1 * sp;
        if hs("ビール") {
            r1 = if sp <= 750.0 { 0.05 } else { 0.069 };
            r2 = r1; fee = r1 * sp;
        }
    } else if hr("腕時計") {
        r1 = if sp <= 750.0 { 0.05 } else { 0.154 };
        r2 = r1; fee = r1 * sp;
    } else if hr("ジュエリー") {
        if sp <= 750.0 { r1 = 0.05; r2 = r1; fee = r1 * sp; }
        else if sp <= 10000.0 { r1 = 0.104; r2 = r1; fee = r1 * sp; }
        else { r1 = 0.104; r2 = 0.064; r1p = 10000.0; fee = r2 * (sp - r1p) + r1 * r1p; }
    } else if hr("ベビー") && hr("マタニティ") {
        r1 = if sp <= 750.0 { 0.05 } else if sp <= 1500.0 { 0.084 } else { 0.154 };
        r2 = r1; fee = r1 * sp;
    } else if hr("服") || hr("ファッション") {
        if sp <= 750.0 { r1 = 0.05; r2 = r1; fee = r1 * sp; }
        else if sp <= 2500.0 { r1 = 0.084; r2 = r1; fee = r1 * sp; }
        else if sp <= 3000.0 { r1 = 0.124; r2 = r1; fee = r1 * sp; }
        else { r1 = 0.124; r2 = 0.084; r1p = 3000.0; fee = r2 * (sp - r1p) + r1 * r1p; }

        if hs("シューズ") || hs("バッグ") || hs("バグ") {
            if sp <= 750.0 { r1 = 0.05; r2 = r1; r1p = 0.0; fee = r1 * sp; }
            else if sp <= 7500.0 { r1 = 0.124; r2 = r1; r1p = 0.0; fee = r1 * sp; }
            else { r1 = 0.124; r2 = 0.064; r1p = 7500.0; fee = r2 * (sp - r1p) + r1 * r1p; }
        }
    } else if hs("サングラス") || hs("メガネ") || hs("眼鏡") {
        if sp <= 750.0 { r1 = 0.05; r2 = r1; fee = r1 * sp; }
        else if sp <= 3000.0 { r1 = 0.124; r2 = r1; fee = r1 * sp; }
        else { r1 = 0.124; r2 = 0.084; r1p = 3000.0; fee = r2 * (sp - r1p) + r1 * r1p; }
    } else if hr("シューズ") && hr("バッグ") {
        if sp <= 750.0 { r1 = 0.05; r2 = r1; fee = r1 * sp; }
        else if sp <= 7500.0 { r1 = 0.124; r2 = r1; fee = r1 * sp; }
        else { r1 = 0.124; r2 = 0.064; r1p = 7500.0; fee = r2 * (sp - r1p) + r1 * r1p; }
    } else {
        r1 = 0.084; r2 = r1; fee = r1 * sp;
    }

    (r1, r2, r1p, fee)
}

// salesPrice / referralFee / referralFeePercent の相互補完。
// 戻り値: (is_sp_valid, is_rf_valid, is_pct_valid, sp, rf, pct)
fn amazon_fee_referral_complement(
    sales_price: Option<f64>,
    referral_fee: Option<f64>,
    referral_pct: Option<f64>,
) -> (bool, bool, bool, f64, f64, f64) {
    let mut sp = sales_price.unwrap_or(0.0);
    let mut rf = referral_fee.unwrap_or(0.0);
    let mut pct = referral_pct.unwrap_or(0.0);

    let mut is_sp = sp > 0.0;
    let mut is_rf = rf > 0.0;
    let mut is_pct = pct > 0.0;

    if is_pct {
        pct = (pct * 10.0).round() / 10.0;
    }

    if is_sp && is_rf && is_pct {
        // (1)
    } else if !is_sp && is_rf && is_pct {
        sp = rf / pct * 100.0; is_sp = true;          // (2)
    } else if is_sp && !is_rf && is_pct {
        rf = sp * pct / 100.0; is_rf = true;          // (3)
    } else if !is_sp && !is_rf && is_pct {
        // (4) 計算不能
    } else if is_sp && is_rf && !is_pct {
        pct = rf / sp * 100.0; is_pct = true;         // (5)
    } else {
        // (6)(7)(8) 計算不能
    }

    (is_sp, is_rf, is_pct, sp, rf, pct)
}

// Amazon 販売手数料 (初回経路)。Keepa 紹介料が有効ならそれを採用、
// 無ければカテゴリ表で算出し ¥30 下限。
fn get_amazon_fee(p: &SizeParams) -> f64 {
    let (is_sp, is_rf, _is_pct, _sp, rf, _pct) = amazon_fee_referral_complement(
        if p.sales_price > 0.0 { Some(p.sales_price) } else { None },
        p.referral_fee_buybox,
        p.referral_fee_percent,
    );

    if is_rf {
        return rf;
    }
    let mut fee = 0.0;
    if is_sp {
        fee = get_amazon_fee_by_category(p).3;
    }
    if fee < 30.0 { fee = 30.0; }
    fee
}

// 大型ランク (寸法 or 重量の大きい方)。
fn oogata_rank(size_total: f64, weight: f64) -> i32 {
    let sunpou = if size_total > 180.0 { 8 } else if size_total > 160.0 { 7 }
        else if size_total > 140.0 { 6 } else if size_total > 120.0 { 5 }
        else if size_total > 100.0 { 4 } else if size_total > 80.0 { 3 }
        else if size_total > 60.0 { 2 } else { 1 };
    let wrank = if weight > 30.0 { 8 } else if weight > 25.0 { 7 }
        else if weight > 20.0 { 6 } else if weight > 15.0 { 5 }
        else if weight > 10.0 { 4 } else if weight > 5.0 { 3 }
        else if weight > 2.0 { 2 } else { 1 };
    if sunpou >= wrank { sunpou } else { wrank }
}

// 標準区分 (寸法/重量ランクから label と fee を返す)。
fn resolve_hyoujun(size_list: &[f64; 3], size_total: f64, weight: f64, hyoujun: &[f64; 8]) -> (i32, f64) {
    let sunpou = if size_total > 80.0 { 8 } else if size_total > 60.0 { 7 }
        else if size_total > 50.0 { 6 } else if size_total > 40.0 { 5 }
        else if size_total > 30.0 { 4 } else if size_total > 20.0 { 3 }
        else if size_list[0] > 3.3 || size_list[1] > 30.0 || size_list[2] > 35.0 { 2 }
        else { 1 };
    let wrank = if weight > 5.0 { 8 } else if weight > 2.0 { 7 }
        else if weight > 1.0 { 2 } else { 1 };
    let rank = if sunpou >= wrank { sunpou } else { wrank };
    let label = if rank == 1
        || (size_list[0] <= 3.3 && size_list[1] <= 30.0 && size_list[2] <= 35.0 && weight <= 1.0)
    { 1 } else { rank };
    (label, hyoujun[(label - 1) as usize])
}

// ── FBA 手数料 + サイズ区分 ───────────────────────────────────
fn get_fba_fee(p: &SizeParams, s: &Settings) -> (String, Option<f64>) {
    let sp = p.sales_price;
    let mut fba_fee = p.fba_pick_and_pack_fee;
    let size_kind = p.size_kind;
    let sl = p.size_list;
    let st = p.size_total;
    let w = p.weight;
    let is_nsnw = p.is_no_size_no_weight;
    let is_ns = p.is_no_size;
    let is_nw = p.is_no_weight;

    let mut tokudai = [2755.0, 3573.0, 4496.0, 5625.0, 13950.0, 20000.0];
    let mut oogata  = [589.0, 624.0, 675.0, 781.0, 1020.0, 1100.0, 1532.0, 1756.0];
    let mut hyoujun = [318.0, 410.0, 415.0, 420.0, 425.0, 430.0, 472.0, 532.0];
    let mut kogata  = [288.0];
    if sp <= 1000.0 {
        tokudai = [2689.0, 3507.0, 4430.0, 5559.0, 13884.0, 20000.0];
        oogata  = [523.0, 558.0, 609.0, 715.0, 954.0, 1034.0, 1466.0, 1690.0];
        hyoujun = [252.0, 344.0, 358.0, 371.0, 379.0, 391.0, 427.0, 466.0];
        kogata  = [222.0];
    }

    let mut k = String::new();

    let is_clickpost = sl[0] <= s.clickpost_length3 && sl[1] <= s.clickpost_length2
        && sl[2] <= s.clickpost_length1 && w <= s.clickpost_weight && !is_ns && !is_nw;
    let is_nekopos = sl[0] <= s.nekopos_shortest
        && sl[1] <= (s.nekopos_total_length - s.nekopos_shortest - s.nekopos_longest)
        && sl[2] <= s.nekopos_longest && w <= s.nekopos_weight && !is_ns && !is_nw;

    let no_fee = match fba_fee { None => true, Some(v) => v <= 0.0 };

    if no_fee {
        if is_nsnw {
            fba_fee = Some(548.0);
        } else {
            if is_clickpost { k.push_str("クリックポスト,"); }
            if is_nekopos { k.push_str("ネコポス,"); }
            if size_kind == 4 {
                if st > 400.0 { fba_fee = Some(tokudai[5]); k.push_str("特大型6"); }
                else if st > 260.0 { fba_fee = Some(tokudai[4]); k.push_str("特大型5"); }
                else if st > 240.0 { fba_fee = Some(tokudai[3]); k.push_str("特大型4"); }
                else if st > 220.0 { fba_fee = Some(tokudai[2]); k.push_str("特大型3"); }
                else if st > 200.0 { fba_fee = Some(tokudai[1]); k.push_str("特大型2"); }
                else { fba_fee = Some(tokudai[0]); k.push_str("特大型1"); }
            } else if size_kind == 3 {
                let r = oogata_rank(st, w);
                fba_fee = Some(oogata[(r - 1) as usize]);
                k.push_str(&format!("大型{}", r));
            } else if size_kind == 2 {
                let (label, fee) = resolve_hyoujun(&sl, st, w, &hyoujun);
                fba_fee = Some(fee);
                k.push_str(&format!("標準{}", label));
            } else if size_kind == 1 {
                fba_fee = Some(kogata[0]);
                k.push_str("小型");
            }
        }
    } else if !is_nsnw {
        if is_clickpost { k.push_str("クリックポスト,"); }
        if is_nekopos { k.push_str("ネコポス,"); }
        if size_kind == 4 {
            if st > 240.0 { k.push_str("特大型4"); }
            else if st > 220.0 { k.push_str("特大型3"); }
            else if st > 200.0 { k.push_str("特大型2"); }
            else { k.push_str("特大型1"); }
        } else if size_kind == 3 {
            let r = oogata_rank(st, w);
            k.push_str(&format!("大型{}", r));
        } else if size_kind == 2 {
            let (label, fee) = resolve_hyoujun(&sl, st, w, &hyoujun);
            fba_fee = Some(fee);
            k.push_str(&format!("標準{}", label));
        } else if size_kind == 1 {
            k.push_str("小型");
        }
    }

    if is_ns || is_nw || is_nsnw {
        k = "不明".to_string();
    }

    (k, fba_fee)
}

// ── 在庫保管料 ────────────────────────────────────────────────
fn get_inventory_storage_fee(p: &SizeParams) -> f64 {
    let root = &p.root_category;
    let month = p.month;
    let size_kind = p.size_kind;
    let sl = p.size_list;
    let is_nsnw = p.is_no_size_no_weight;
    let has = |kw: &str| root.contains(kw);
    let vol = sl[0] * sl[1] * sl[2];

    if is_nsnw {
        return 8.0;
    }
    if (has("服") && has("ファッション小物")) || (has("シューズ") && has("バッグ")) {
        if (1..=9).contains(&month) { (((3.1 * vol) / 1000.0) * 30.0) / 30.0 }
        else { (((5.5 * vol) / 1000.0) * 30.0) / 30.0 }
    } else if (1..=9).contains(&month) {
        if size_kind >= 3 { (((3.278 * vol) / 1000.0) * 30.0) / 30.0 }
        else { (((5.676 * vol) / 1000.0) * 30.0) / 30.0 }
    } else if size_kind >= 3 {
        (((6.984 * vol) / 1000.0) * 30.0) / 30.0
    } else {
        (((10.087 * vol) / 1000.0) * 30.0) / 30.0
    }
}

// ── napi エントリ ─────────────────────────────────────────────
#[napi(
    js_name = "computeFees",
    ts_args_type = "keepaItemJson: string, salesPrice: number, settingsJson: string, month: number"
)]
pub fn compute_fees(
    keepa_item_json: String,
    sales_price: f64,
    settings_json: String,
    month: u32,
) -> napi::Result<String> {
    let item: KeepaItem = serde_json::from_str(&keepa_item_json)
        .map_err(|e| napi::Error::from_reason(format!("keepaItem JSON parse: {e}")))?;
    let settings: Settings = serde_json::from_str(&settings_json)
        .map_err(|e| napi::Error::from_reason(format!("settings JSON parse: {e}")))?;

    let sp = if sales_price > 0.0 { sales_price } else { 0.0 };
    let params = get_size_parameters(&item, sp, month);

    let (size_kubun, fba_fee) = get_fba_fee(&params, &settings);
    let storage = get_inventory_storage_fee(&params);
    let amazon_fee = get_amazon_fee(&params);

    let fba_json = match fba_fee {
        Some(v) if v.is_finite() => serde_json::Value::from(v.round() as i64),
        _ => serde_json::Value::Null,
    };

    // 「Amazon販売手数料」には消費税(10%)が別途かかるため、表示・保存値は
    // int(本体手数料 × 1.1) とする (client request 2026-06 項目4)。
    // FBA販売手数料・在庫保管料は対象外。int() は正値のため floor 相当。
    let amazon_fee_taxed = ((amazon_fee.round() as i64) as f64 * 1.1).floor() as i64;

    let out = serde_json::json!({
        "sizeKubun": if size_kubun.is_empty() { serde_json::Value::Null } else { serde_json::Value::from(size_kubun) },
        "fbaFee": fba_json,
        "inventoryStorageFee": storage.round() as i64,
        "amazonFee": amazon_fee_taxed,
    });
    Ok(out.to_string())
}

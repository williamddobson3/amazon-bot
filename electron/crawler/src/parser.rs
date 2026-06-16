//! Amazon.co.jp search-result HTML parser — ported from
//! `electron/src/main/scraper/search-parser.js`.
//!
//! Extracts the spec fields from each `s-search-result` card. The
//! tricky edge cases from the JS version are preserved verbatim:
//!   * `:contains()` (a jQuery extension, unsupported by standard CSS)
//!     is replaced by an explicit text scan over `.a-section` elements.
//!   * `safe_text` strips `<style>` / `<script>` subtrees so leaked CSS
//!     rules do not pollute the delivery string.
//!   * `strip_code_noise` scrubs any CSS-rule debris that survives.
//!   * the points / seller-count regexes keep their disambiguating
//!     qualifiers so promo banners are not mistaken for real data.
//!   * BuyBox 価格 / 発送情報 / 送料 抽出はマーケットプレイス節
//!     (= 「こちらからもご購入いただけます」セクション) を除外した
//!     状態で行い、Featured Offer 由来の値で揃える。
//!   * 送料 + 月間販売数の抽出 (2026-05 追加)。

use std::sync::LazyLock;

use ego_tree::{NodeId, NodeRef};
use regex::Regex;
use scraper::{ElementRef, Html, Node, Selector};

use crate::protocol::Product;

// ── Cached selectors ────────────────────────────────────────
fn sel(s: &str) -> Selector {
    Selector::parse(s).expect("static selector must parse")
}
static SEL_CARD: LazyLock<Selector> =
    LazyLock::new(|| sel(r#"[data-component-type="s-search-result"][data-asin]"#));
static SEL_TITLE: LazyLock<Selector> = LazyLock::new(|| sel("h2 a span"));
static SEL_TITLE_ALT: LazyLock<Selector> = LazyLock::new(|| sel(".a-text-normal"));
static SEL_IMAGE: LazyLock<Selector> = LazyLock::new(|| sel("img.s-image"));
static SEL_PRICE: LazyLock<Selector> = LazyLock::new(|| sel(".a-price .a-offscreen"));
static SEL_PRICE_RECIPE: LazyLock<Selector> =
    LazyLock::new(|| sel(r#"[data-cy="price-recipe"] .a-price .a-offscreen"#));
static SEL_SHIPPING_RECIPE: LazyLock<Selector> =
    LazyLock::new(|| sel(r#"[data-cy="shipping-info-recipe"]"#));
static SEL_COLOR_PRICE: LazyLock<Selector> = LazyLock::new(|| sel(".a-color-price"));
static SEL_DELIVERY_RECIPE: LazyLock<Selector> =
    LazyLock::new(|| sel(r#"[data-cy="delivery-recipe"]"#));
static SEL_DELIVERY_UDM: LazyLock<Selector> = LazyLock::new(|| {
    sel(r#".udm-primary-delivery-message, [data-component-type="s-delivery-block"]"#)
});
static SEL_DELIVERY_ARIA: LazyLock<Selector> =
    LazyLock::new(|| sel(r#"[aria-label*="お届け"]"#));
static SEL_DELIVERY_ATTR: LazyLock<Selector> =
    LazyLock::new(|| sel("[data-csa-c-delivery-time]"));
static SEL_A_SECTION: LazyLock<Selector> = LazyLock::new(|| sel(".a-section"));
static SEL_OFFER_LINK: LazyLock<Selector> =
    LazyLock::new(|| sel(r#"a[href*="/gp/offer-listing/"]"#));
// Featured Offer (BuyBox) の確定価格 — 「カートに入れる」ウィジェットの
// data-csa-c-price-to-pay 属性。機械可読・一意で、Buy Box が無い商品
// (「オプションを表示」) には存在しない。最も確実な BuyBox 価格ソース。
static SEL_PRICE_TO_PAY: LazyLock<Selector> =
    LazyLock::new(|| sel(r#"[data-cy="add-to-cart"] [data-csa-c-price-to-pay]"#));
// 「より速くお届け」等の別オファー節 (BuyBox とは別の出品)。ポイント抽出で
// 除外する — そうしないと BuyBox の価格に別オファーのポイントが混ざる。
static SEL_MULTI_OFFER: LazyLock<Selector> =
    LazyLock::new(|| sel(r#"[data-cy="multi-offer-display"]"#));

// ── Cached regexes ──────────────────────────────────────────
// First numeric token: "4,482" or "17.26".
static RE_NUMBER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\d,]+(?:\.\d+)?").unwrap());
// Earned-points line, anchored — requires the "(N%)" suffix so promo
// copy ("200ポイント還元中" etc.) never matches.
static RE_POINTS_ANCHORED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(\d[\d,]*)\s*(?:ポイント|pt)\s*\(\s*\d+(?:\.\d+)?\s*%\s*\)").unwrap()
});
// Same pattern unanchored — fallback scan over the whole card text.
static RE_POINTS_LOOSE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(\d[\d,]*)\s*(?:ポイント|pt)\s*\(\s*\d+(?:\.\d+)?\s*%\s*\)").unwrap()
});
// Marketplace price — yen-prefixed, then any-number fallback.
static RE_MP_PRICE_YEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[¥￥]\s*([\d,]+)").unwrap());
// Seller count — must be qualified by 新品/中古 so the
// 「過去1か月で1000点以上購入」 banner is not counted.
static RE_MP_COUNT_QUALIFIED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(\d+)\s*点\s*(?:の)?\s*(?:新品|中古)").unwrap());
static RE_MP_COUNT_KEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(\d+)\s*件").unwrap());
// CSS-noise scrubbers for the delivery string.
static RE_CSS_RULE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[.#][\w-]+\s*\{[^}]*\}").unwrap());
static RE_CSS_DECL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\w-]+\s*:\s*[^;]+;").unwrap());
static RE_HEX_COLOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"#[0-9a-fA-F]{3,8}\b").unwrap());
// Tight, shipping-only delivery patterns — tried in priority order.
static RE_DELIVERY_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"明日中にお届け",
        r"本日中にお届け",
        r"\d+月\d+日(?:\s*[（(]?[月火水木金土日][)）]?(?:曜日)?)?\s*にお届け",
        r"\d+\s*日後にお届け",
        r"無料配送",
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});
// 送料 (shipping fee): "配送料 ¥526" 等。「配送料 別途」「無料配送」
// など金額無しの表記は別途。
static RE_SHIPPING_FEE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"配送料\s*[:：]?\s*[¥￥]\s*([\d,]+)").unwrap());
// 月間販売数: 「過去1か月で○○点以上購入されました/購入されています」
// - 半角 / 全角 1 (1, １) を許容
// - か / ヵ / ヶ / カ (Amazon が日替わりで変える)
// - 半角 , / 全角 ， をサポート
// - 全角数字 ０-９ も含む数字シーケンス
// - 動詞形は ました / ています どちらも許容
static RE_MONTHLY_SALES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"過去\s*[1１]\s*[かヵヶカ]月で\s*([\d,，０-９]+)\s*点\s*以上\s*購入され(?:ました|ています)")
        .unwrap()
});

/// Parse an Amazon search-result page into product cards.
pub fn parse_search_results(html: &str) -> Vec<Product> {
    let doc = Html::parse_document(html);
    let mut out = Vec::new();

    for card in doc.select(&SEL_CARD) {
        let asin = match card.value().attr("data-asin") {
            Some(a) if a.len() == 10 => a.to_string(),
            _ => continue,
        };

        // マーケットプレイス節を 1 度だけ特定し、
        // BuyBox 系の抽出 (価格・送料・発送情報) で共通利用。
        // None の場合は「他の出品」表記が無い ASIN。
        let mp_section = find_marketplace_section(&card);
        let mp_skip_id: Option<NodeId> = mp_section.as_ref().map(|s| s.id());

        let (mp_price, mp_count, mp_condition) =
            extract_marketplace_info(mp_section.as_ref());

        out.push(Product {
            asin,
            title: extract_title(&card),
            image_url: extract_image_url(&card),
            price: extract_price(&card, mp_skip_id),
            shipping_fee: extract_shipping_fee(&card, mp_skip_id),
            points: extract_points(&card, mp_skip_id),
            delivery: extract_delivery(&card, mp_skip_id),
            mp_price,
            mp_count,
            mp_condition,
            monthly_sales: extract_monthly_sales(&card),
        });
    }
    out
}

// ── Field extractors ────────────────────────────────────────

fn extract_title(card: &ElementRef) -> Option<String> {
    if let Some(el) = card.select(&SEL_TITLE).next() {
        let t = normalize_ws(&el.text().collect::<String>());
        if !t.is_empty() {
            return Some(t);
        }
    }
    if let Some(el) = card.select(&SEL_TITLE_ALT).next() {
        let t = normalize_ws(&el.text().collect::<String>());
        if !t.is_empty() {
            return Some(t);
        }
    }
    None
}

fn extract_image_url(card: &ElementRef) -> Option<String> {
    card.select(&SEL_IMAGE)
        .next()
        .and_then(|img| img.value().attr("src"))
        .map(|s| s.to_string())
}

/// BuyBox 価格。優先順位:
///   1. `[data-cy="price-recipe"] .a-price .a-offscreen` — 新テンプレート
///      では Featured Offer 専用ノードなので最も確実。
///   2. `.a-price .a-offscreen` のうち、マーケットプレイス節の中に
///      含まれていない最初の要素。ASIN 単体検索では同一カード内に
///      Featured Offer と他の出品の両方が並ぶことがあり、テンプレート
///      によっては DOM 順で「他の出品」が先に来るため、無条件に first
///      を取ると ¥1,562 (他の出品) を BuyBox 扱いにしてしまう。
fn extract_price(card: &ElementRef, mp_skip_id: Option<NodeId>) -> Option<i64> {
    // 0. ★ Featured Offer の確定 BuyBox 価格 (2026-06): 「カートに入れる」ウィジェットの
    //    data-csa-c-price-to-pay 属性。一意・機械可読で、別オファー (multi-offer-display /
    //    マーケットプレイス) や参考価格 (取り消し線) を絶対に拾わない。Buy Box が無い商品
    //    (「オプションを表示」) には存在しないので、その場合は None になり下のフォールバック
    //    も価格を返さず「BuyBox 無し」を正しく表現する。最優先。
    if let Some(el) = card.select(&SEL_PRICE_TO_PAY).next() {
        if let Some(v) = el.value().attr("data-csa-c-price-to-pay") {
            if let Ok(f) = v.trim().parse::<f64>() {
                if f.is_finite() && f > 0.0 {
                    return Some(f.round() as i64);
                }
            }
        }
    }
    // 1. price-recipe (フォールバック — 旧テンプレート / 属性欠落時)。
    if let Some(el) = card.select(&SEL_PRICE_RECIPE).next() {
        if let Some(n) = parse_price(&el.text().collect::<String>()) {
            return Some(n);
        }
    }
    // 2. マーケットプレイス節の外側の最初の .a-price .a-offscreen (最終フォールバック)。
    for el in card.select(&SEL_PRICE) {
        if is_inside_skipped(*el, mp_skip_id) {
            continue;
        }
        if let Some(n) = parse_price(&el.text().collect::<String>()) {
            return Some(n);
        }
    }
    None
}

fn extract_points(card: &ElementRef, mp_skip_id: Option<NodeId>) -> Option<i64> {
    // ★ ポイントは BuyBox (Featured Offer) のものだけを読む (2026-06 fix)。
    // 「より速くお届け」(multi-offer-display) や「こちらからも」(マーケットプレイス) の
    // 別オファーのポイントを拾うと、価格=BuyBox・ポイント=別オファー、という食い違いで
    // 最新実質BuyBox が過小に化ける (B0CCTXFCDP: ¥4,566 の BuyBox に ¥6,534 オファーの
    // 1876pt が混ざり、実質が 2690 に化けた)。両節を除外する。
    let multi_id = card.select(&SEL_MULTI_OFFER).next().map(|e| e.id());
    // 1. Targeted scan over .a-color-price spans (anchored regex) — 別オファー節は除外。
    for span in card.select(&SEL_COLOR_PRICE) {
        if is_inside_skipped(*span, mp_skip_id) || is_inside_skipped(*span, multi_id) {
            continue;
        }
        let text = span.text().collect::<String>();
        if let Some(c) = RE_POINTS_ANCHORED.captures(text.trim()) {
            return parse_int_commas(&c[1]);
        }
    }
    // 2. Fallback — 別オファー節を除外したテキストで走査。
    let text = text_excluding_multi(**card, mp_skip_id, multi_id);
    if let Some(c) = RE_POINTS_LOOSE.captures(&text) {
        return parse_int_commas(&c[1]);
    }
    None
}

/// 発送情報。data-cy="delivery-recipe" 系列が最有力。マーケット
/// プレイス節の中の delivery-recipe (他の出品者の配送日) を拾わない
/// よう、全候補で is_inside_skipped() チェックする。
fn extract_delivery(card: &ElementRef, mp_skip_id: Option<NodeId>) -> Option<String> {
    // 1. Structured delivery block.
    for el in card.select(&SEL_DELIVERY_RECIPE) {
        if is_inside_skipped(*el, mp_skip_id) {
            continue;
        }
        let t = strip_code_noise(&normalize_ws(&safe_text(&el)));
        if !t.is_empty() {
            return Some(t);
        }
    }
    // 2. Alternate template.
    for el in card.select(&SEL_DELIVERY_UDM) {
        if is_inside_skipped(*el, mp_skip_id) {
            continue;
        }
        let t = strip_code_noise(&normalize_ws(&safe_text(&el)));
        if !t.is_empty() {
            return Some(t);
        }
    }
    // 3. aria-label containing a delivery phrase.
    for el in card.select(&SEL_DELIVERY_ARIA) {
        if is_inside_skipped(*el, mp_skip_id) {
            continue;
        }
        if let Some(aria) = el.value().attr("aria-label") {
            let t = strip_code_noise(&normalize_ws(aria));
            if !t.is_empty() {
                return Some(t);
            }
        }
    }
    // 4. Structured delivery-time attribute.
    for el in card.select(&SEL_DELIVERY_ATTR) {
        if is_inside_skipped(*el, mp_skip_id) {
            continue;
        }
        if let Some(v) = el.value().attr("data-csa-c-delivery-time") {
            let t = strip_code_noise(&normalize_ws(v));
            if !t.is_empty() {
                return Some(t);
            }
        }
    }
    // 5. Last-resort tight regex on the card text (marketplace-stripped).
    let all = text_excluding(**card, mp_skip_id);
    for re in RE_DELIVERY_PATTERNS.iter() {
        if let Some(m) = re.find(&all) {
            return Some(normalize_ws(m.as_str()));
        }
    }
    None
}

/// 送料 (shipping fee). Featured Offer の BuyBox 価格に既に加算される
/// ことが多いが、送料単独の値も UI 列に表示するため抽出。
///   1. [data-cy="shipping-info-recipe"] が最有力 — 構造化されており、
///      Featured Offer 領域内にしか出ない。中身が「無料配送」など
///      非金額表記なら None (送料無し扱い)。
///   2. フォールバック: マーケットプレイス節を除外したテキストから
///      「配送料 ¥XXX」 を拾う。
fn extract_shipping_fee(card: &ElementRef, mp_skip_id: Option<NodeId>) -> Option<i64> {
    if let Some(el) = card.select(&SEL_SHIPPING_RECIPE).next() {
        if !is_inside_skipped(*el, mp_skip_id) {
            let t = safe_text(&el);
            if let Some(c) = RE_SHIPPING_FEE.captures(&t) {
                return parse_int_commas(&c[1]);
            }
            // 構造化ノードが存在するが金額無し → 無料配送扱い (None)。
            return None;
        }
    }
    let text = text_excluding(**card, mp_skip_id);
    let c = RE_SHIPPING_FEE.captures(&text)?;
    parse_int_commas(&c[1])
}

/// 月間販売数 — Amazon 表記「過去1か月で○○点以上購入されました」。
/// 商品の人気度指標として保存。表記が無い商品は None。
/// 全角数字・全角コンマは半角に正規化してから parse する。
fn extract_monthly_sales(card: &ElementRef) -> Option<i64> {
    let text = card.text().collect::<String>();
    let c = RE_MONTHLY_SALES.captures(&text)?;
    let normalized: String = c[1]
        .chars()
        .map(|ch| match ch {
            // 全角数字 (０-９) → 半角 (0-9)。U+FF10 = '０', U+FF19 = '９'。
            '\u{FF10}'..='\u{FF19}' => {
                char::from_u32(ch as u32 - 0xFEE0).unwrap_or(ch)
            }
            _ => ch,
        })
        .filter(|c| *c != ',' && *c != '\u{FF0C}') // ',' 半角 / '，' 全角
        .collect();
    normalized.parse::<i64>().ok()
}

/// Extract third-party seller price / offer count / condition from
/// a previously-located marketplace section. Returns (None, None, None)
/// when no marketplace section was found.
fn extract_marketplace_info<'a>(
    section: Option<&ElementRef<'a>>,
) -> (Option<i64>, Option<i64>, Option<String>) {
    let section = match section {
        Some(s) => s,
        None => return (None, None, None),
    };
    let text = section.text().collect::<String>();

    // Price: yen-prefixed first, then any number.
    let price = RE_MP_PRICE_YEN
        .captures(&text)
        .and_then(|c| parse_int_commas(&c[1]))
        .or_else(|| RE_NUMBER.find(&text).and_then(|m| parse_price(m.as_str())));

    // Count: must be qualified by 新品/中古; 件 fallback is also safe.
    let count = RE_MP_COUNT_QUALIFIED
        .captures(&text)
        .or_else(|| RE_MP_COUNT_KEN.captures(&text))
        .and_then(|c| c[1].parse::<i64>().ok());

    // Condition.
    let mut conditions: Vec<&str> = Vec::new();
    if text.contains("新品") {
        conditions.push("新品");
    }
    if text.contains("中古品") || text.contains("中古") {
        conditions.push("中古品");
    }
    let condition = if conditions.is_empty() {
        None
    } else {
        Some(conditions.join("と"))
    };

    (price, count, condition)
}

/// Locate the "other sellers" section of a card. Two known layouts:
///   A. an `.a-section` whose text holds 「こちらからもご購入いただけます」
///   B. an `/gp/offer-listing/` link — walk up to the enclosing `.a-row`
fn find_marketplace_section<'a>(card: &ElementRef<'a>) -> Option<ElementRef<'a>> {
    for sec in card.select(&SEL_A_SECTION) {
        if sec
            .text()
            .collect::<String>()
            .contains("こちらからもご購入いただけます")
        {
            return Some(sec);
        }
    }
    if let Some(link) = card.select(&SEL_OFFER_LINK).next() {
        if let Some(row) = closest_a_row(&link) {
            return Some(row);
        }
        if let Some(parent) = link.parent().and_then(ElementRef::wrap) {
            return Some(parent);
        }
    }
    None
}

/// Nearest ancestor element carrying the `a-row` class.
fn closest_a_row<'a>(el: &ElementRef<'a>) -> Option<ElementRef<'a>> {
    for anc in el.ancestors() {
        if let Some(e) = ElementRef::wrap(anc) {
            if has_class(&e, "a-row") {
                return Some(e);
            }
        }
    }
    None
}

fn has_class(el: &ElementRef, class: &str) -> bool {
    el.value()
        .attr("class")
        .map(|c| c.split_whitespace().any(|x| x == class))
        .unwrap_or(false)
}

/// True when `node` is `skip` or a descendant of `skip`. Used to filter
/// out marketplace-section descendants when extracting BuyBox-side
/// fields (price / delivery / shipping). `None` skip → always false.
fn is_inside_skipped(node: NodeRef<Node>, skip: Option<NodeId>) -> bool {
    let target = match skip {
        Some(id) => id,
        None => return false,
    };
    let mut cur = Some(node);
    while let Some(n) = cur {
        if n.id() == target {
            return true;
        }
        cur = n.parent();
    }
    false
}

// ── Text helpers ────────────────────────────────────────────

/// Collapse all whitespace runs to single spaces and trim.
fn normalize_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Collect descendant text but skip `<style>` / `<script>` /
/// `<noscript>` subtrees so leaked CSS does not pollute the result.
fn safe_text(el: &ElementRef) -> String {
    let mut out = String::new();
    for child in el.children() {
        collect_text_skip_code(child, &mut out);
    }
    out
}

fn collect_text_skip_code(node: NodeRef<Node>, out: &mut String) {
    match node.value() {
        Node::Text(t) => out.push_str(&t.text),
        Node::Element(e) => {
            let name = e.name();
            if name.eq_ignore_ascii_case("style")
                || name.eq_ignore_ascii_case("script")
                || name.eq_ignore_ascii_case("noscript")
            {
                return;
            }
            for c in node.children() {
                collect_text_skip_code(c, out);
            }
        }
        _ => {
            for c in node.children() {
                collect_text_skip_code(c, out);
            }
        }
    }
}

/// Walk all descendants of `root` and collect text content, skipping
/// any subtree rooted at `skip` (used to exclude the marketplace
/// section when scanning BuyBox-side text). Also skips style/script.
fn text_excluding(root: NodeRef<Node>, skip: Option<NodeId>) -> String {
    let mut out = String::new();
    walk_excluding(root, skip, &mut out);
    out
}

fn walk_excluding(node: NodeRef<Node>, skip: Option<NodeId>, out: &mut String) {
    if let Some(id) = skip {
        if node.id() == id {
            return;
        }
    }
    match node.value() {
        Node::Text(t) => out.push_str(&t.text),
        Node::Element(e) => {
            let name = e.name();
            if name.eq_ignore_ascii_case("style")
                || name.eq_ignore_ascii_case("script")
                || name.eq_ignore_ascii_case("noscript")
            {
                return;
            }
            for c in node.children() {
                walk_excluding(c, skip, out);
            }
        }
        _ => {
            for c in node.children() {
                walk_excluding(c, skip, out);
            }
        }
    }
}

/// Like `text_excluding` but prunes TWO subtrees (marketplace + multi-offer),
/// so points/text scans only see the BuyBox (Featured Offer) region.
fn text_excluding_multi(root: NodeRef<Node>, a: Option<NodeId>, b: Option<NodeId>) -> String {
    let mut out = String::new();
    walk_excluding_multi(root, a, b, &mut out);
    out
}

fn walk_excluding_multi(node: NodeRef<Node>, a: Option<NodeId>, b: Option<NodeId>, out: &mut String) {
    let id = node.id();
    if a == Some(id) || b == Some(id) {
        return;
    }
    match node.value() {
        Node::Text(t) => out.push_str(&t.text),
        Node::Element(e) => {
            let name = e.name();
            if name.eq_ignore_ascii_case("style")
                || name.eq_ignore_ascii_case("script")
                || name.eq_ignore_ascii_case("noscript")
            {
                return;
            }
            for c in node.children() {
                walk_excluding_multi(c, a, b, out);
            }
        }
        _ => {
            for c in node.children() {
                walk_excluding_multi(c, a, b, out);
            }
        }
    }
}

/// Strip text that looks like leaked CSS rules / declarations / hex
/// colors — some Amazon delivery wrappers embed inline `<style>`.
fn strip_code_noise(s: &str) -> String {
    let s = RE_CSS_RULE.replace_all(s, "");
    let s = RE_CSS_DECL.replace_all(&s, "");
    let s = s.replace(['{', '}'], "");
    let s = RE_HEX_COLOR.replace_all(&s, "");
    normalize_ws(&s)
}

// ── Number parsing ──────────────────────────────────────────

/// Parse a price from any format ("¥4,482", "EUR 17.26", "4,482").
/// Strips the thousands separators and rounds to an integer.
fn parse_price(text: &str) -> Option<i64> {
    let m = RE_NUMBER.find(text)?;
    let cleaned: String = m.as_str().chars().filter(|c| *c != ',').collect();
    let n: f64 = cleaned.parse().ok()?;
    if n.is_finite() {
        Some(n.round() as i64)
    } else {
        None
    }
}

/// Parse an integer that may contain thousands separators.
fn parse_int_commas(text: &str) -> Option<i64> {
    let cleaned: String = text.chars().filter(|c| *c != ',').collect();
    cleaned.parse::<i64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(html: &str) -> Product {
        let v = parse_search_results(html);
        assert_eq!(v.len(), 1, "expected exactly one s-search-result card");
        v.into_iter().next().unwrap()
    }

    // Card A (real B0CCTXFCDP, IP variant): BuyBox = ¥4,566 (price-recipe + the
    // add-to-cart price-to-pay). The ¥6,534 + 1876pt are an ALTERNATIVE offer
    // ("より速くお届け") in multi-offer-display — must NOT be picked.
    const CARD_BUYBOX_4566: &str = r##"<div data-component-type="s-search-result" data-asin="B0CCTXFCDP">
      <div data-cy="price-recipe" class="a-section"><div class="a-row a-size-base a-color-base"><div class="a-row">
        <a aria-describedby="price-link">
          <span class="a-price" data-a-color="price"><span class="a-offscreen">￥4,566</span></span>
          <span class="a-offscreen">参考: ￥5,400</span>
          <div class="a-section aok-inline-block"><span class="a-color-secondary">参考: </span>
            <span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">￥5,400</span></span></div>
        </a></div></div></div>
      <div data-cy="add-to-cart"><div class="ax-atc atc-btn-container" data-csa-c-price-to-pay="4566.0">
        <div data-csa-c-type="action" data-csa-c-price-to-pay="4566.0"><button>カートに入れる</button></div></div></div>
      <div data-cy="multi-offer-display" class="a-row"><a><span class="a-color-link a-text-bold">より速くお届け</span></a>
        <div class="a-row"><a aria-describedby="price-link"><span class="a-price" data-a-color="price"><span class="a-offscreen">￥6,534</span></span></a></div>
        <div class="a-row a-color-secondary"><span class="a-color-price">1876ポイント(29%)</span></div></div>
    </div>"##;

    // Card B (real B0CCTXFCDP, other IP): BuyBox = ¥6,534 (price-recipe) WITH its
    // own 1876pt in price-recipe; the ¥4,566 is the "こちらからも" other-seller.
    const CARD_BUYBOX_6534: &str = r##"<div data-component-type="s-search-result" data-asin="B0CCTXFCDP">
      <div data-cy="price-recipe" class="a-section"><div class="a-row a-size-base a-color-base"><div class="a-row">
        <a aria-describedby="price-link"><span class="a-price" data-a-color="price"><span class="a-offscreen">￥6,534</span></span></a></div></div>
        <div class="a-row a-color-secondary"><span class="a-color-price">1876ポイント(29%)</span></div></div>
      <div data-cy="add-to-cart"><div class="ax-atc atc-btn-container" data-csa-c-price-to-pay="6534.0"><button>カートに入れる</button></div></div>
      <div data-cy="secondary-offer-recipe" class="a-section"><div class="a-row a-color-secondary">
        <span class="a-color-secondary">こちらからもご購入いただけます</span><br>
        <span class="a-color-price">￥4,566</span>
        <a href="/gp/offer-listing/B0CCTXFCDP/">（14点の新品）</a></div></div>
    </div>"##;

    // No Buy Box: only third-party ¥4,893, "オプションを表示", no add-to-cart.
    const CARD_NO_BUYBOX: &str = r##"<div data-component-type="s-search-result" data-asin="B0CCTXFCDP">
      <div data-cy="secondary-offer-recipe" class="a-section"><div class="a-row a-color-secondary">
        <span class="a-color-secondary">「おすすめ出品」の要件を満たす出品はありません</span><br>
        <span class="a-color-price">￥4,893</span>
        <a href="/gp/offer-listing/B0CCTXFCDP/">（2点の新品）</a></div></div>
    </div>"##;

    #[test]
    fn buybox_price_from_price_to_pay_4566_points_excluded() {
        let p = one(CARD_BUYBOX_4566);
        assert_eq!(p.price, Some(4566), "BuyBox price must be the price-to-pay 4566, not the ¥6,534 alt offer");
        assert_eq!(p.points, None, "1876pt belongs to the ¥6,534 multi-offer, not the ¥4,566 BuyBox → none");
    }

    #[test]
    fn buybox_price_6534_keeps_its_own_points() {
        let p = one(CARD_BUYBOX_6534);
        assert_eq!(p.price, Some(6534), "BuyBox price must be 6534");
        assert_eq!(p.points, Some(1876), "1876pt is inside price-recipe = the BuyBox's own points");
        assert_eq!(p.mp_price, Some(4566), "the ¥4,566 こちらからも offer → mp_price (other-seller)");
    }

    #[test]
    fn no_buybox_yields_no_price() {
        let p = one(CARD_NO_BUYBOX);
        assert_eq!(p.price, None, "no Featured Offer (no add-to-cart) → no BuyBox price");
        assert_eq!(p.points, None);
        assert_eq!(p.mp_price, Some(4893), "the third-party ¥4,893 → mp_price");
    }
}

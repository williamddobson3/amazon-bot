'use strict';

// TimeSeriesChart — minimal canvas line chart purpose-built for the
// product-detail modal. Four of these render stacked in the modal
// (price / effective price / MP price / MP count).
//
// Deliberately NOT a general charting library. Only the features the
// spec asks for: auto Y scale with nice ticks, 5-tick X axis with
// date-range-aware formatting, click-to-configure on both axes via
// callback, line + dots, "no data" empty state.
//
// Exposed globally (window.TimeSeriesChart) because renderer.js is a
// non-module script.

class TimeSeriesChart {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.color = opts.color || '#FF9900';
    this.yFormatter = opts.yFormatter || ((v) => String(v));

    this.points = [];
    this.xMin = 0;
    this.xMax = 0;

    this.userY = null;     // { min, max, tick } — set via setYAxis
    this.autoRange = !!opts.autoRange;   // spec auto-range formula
    // Minimum Y-axis tick interval. Used to prevent fractional ticks on
    // integer-only data (e.g., the seller-count chart should never show
    // 10.5 / 11.5 — clamp tick ≥ 1 so labels stay whole numbers).
    // Range is still allowed to grow when actual variance demands it.
    this.minTick = (typeof opts.minTick === 'number' && isFinite(opts.minTick))
      ? opts.minTick : null;
    this._regions = null;  // hit-test rects for axis clicks
    this._yRange  = null;  // resolved { min, max, tick } from last draw
    this.onAxisClickCb = null;

    this._setupResize();
    this._setupClicks();
  }

  // Toggle the spec's auto-range mode. When ON, Y axis recomputes from
  // visible data using tick = (max-min)/8, ymin = low - tick,
  // ymax = high + tick — i.e., 10 even divisions with one tick of head/
  // foot padding. Overrides any user-set Y axis until cleared.
  setAutoRange(on) {
    this.autoRange = !!on;
    if (this.autoRange) this.userY = null;
    this.draw();
  }

  setData(points, xMin, xMax) {
    // Single-series convenience shim: wrap as one-series array and
    // delegate to the multi-series path so draw() has only one path.
    this.setSeries([{ points: points || [], color: this.color, lineWidth: 2 }], xMin, xMax);
  }

  // Multi-series variant: each entry in `series` is { points, color,
  // [lineWidth], [showDots] }. All series share one Y axis (auto-
  // scaled to encompass every visible point) and one X axis.
  setSeries(series, xMin, xMax) {
    this.series = Array.isArray(series) ? series : [];
    this.points = [];   // not used in multi-series mode
    this.xMin = xMin;
    this.xMax = xMax;
    this.userY = null;
    this.draw();
  }

  setYAxis({ min, max, tick }) {
    this.userY = { min, max, tick };
    this.draw();
  }

  setXRange(min, max) {
    this.xMin = min;
    this.xMax = max;
    this.draw();
  }

  onAxisClick(cb) { this.onAxisClickCb = cb; }

  destroy() {
    if (this._ro) this._ro.disconnect();
  }

  // ── Private ───────────────────────────────────────────────

  _setupResize() {
    this._ro = new ResizeObserver(() => {
      this._resizeCanvas();
      this.draw();
    });
    this._ro.observe(this.canvas);
    this._resizeCanvas();
  }

  _resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width  = Math.max(1, Math.floor(rect.width  * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
    this.width  = rect.width;
    this.height = rect.height;
  }

  _setupClicks() {
    this.canvas.addEventListener('click', (e) => {
      if (!this.onAxisClickCb || !this._regions) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (this._inRegion(x, y, this._regions.y)) {
        this.onAxisClickCb('y', { ...this._yRange });
      } else if (this._inRegion(x, y, this._regions.x)) {
        this.onAxisClickCb('x', { min: this.xMin, max: this.xMax });
      }
    });
  }

  _inRegion(x, y, r) {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  // Draw a rounded-rect path on the current ctx. Uses the native
  // ctx.roundRect when available (Chromium ≥ 99), else falls back to
  // an arcTo-based polyfill so the price-tag callouts still render on
  // older renderers.
  _roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    const radius = Math.min(r, w / 2, h / 2);
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius);
      return;
    }
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.arcTo(x + w, y, x + w, y + radius, radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
    ctx.lineTo(x + radius, y + h);
    ctx.arcTo(x, y + h, x, y + h - radius, radius);
    ctx.lineTo(x, y + radius);
    ctx.arcTo(x, y, x + radius, y, radius);
    ctx.closePath();
  }

  // Draw a single data marker. Shapes match the spec legend:
  //   circle   — 実質価格
  //   square   — 他の出品価格
  //   triangle — 出品者数
  // Filled marker; size is the half-extent in CSS px.
  _drawMarker(x, y, shape, size) {
    const ctx = this.ctx;
    const r = size;
    if (shape === 'square') {
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    } else if (shape === 'triangle') {
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.lineTo(x - r, y + r);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Find a "nice" tick interval that yields roughly `target` ticks
  // across `range`. Snaps to 1/2/5 × 10^n — the conventional choices
  // for chart axes.
  _niceTick(range, target) {
    if (range <= 0 || !isFinite(range)) return 1;
    const rough = range / target;
    const mag   = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm  = rough / mag;
    let nice;
    if      (norm < 1.5) nice = 1;
    else if (norm < 3)   nice = 2;
    else if (norm < 7)   nice = 5;
    else                 nice = 10;
    return nice * mag;
  }

  _formatX(t, range) {
    const d = new Date(t);
    const md = `${d.getMonth() + 1}/${d.getDate()}`;
    if (range <= 86_400_000 * 7) {
      // ≤ 7 days — show 「M/D H時」 so users can read both the date
      // AND the hour at every tick (e.g., "5/2 21時", "5/3 9時"),
      // matching the format the client requested.
      return `${md} ${d.getHours()}時`;
    } else if (range < 86_400_000 * 60) {           // < 2 months → M/D
      return md;
    } else {                                        // longer → YY/M
      return `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}`;
    }
  }

  draw() {
    const { ctx, width, height } = this;
    if (!width || !height) return;
    ctx.clearRect(0, 0, width, height);

    const series = this.series || [];

    // Pool every visible point across every series for Y-scale calc.
    let allValues = [];
    for (const s of series) {
      const pts = s.points || [];
      for (const p of pts) {
        if (p.v != null && isFinite(p.v)) allValues.push(p.v);
      }
    }

    // ── Y range ─────────────────────────────────────────────
    let yMin, yMax, yTick;
    if (this.userY && this.userY.min != null && this.userY.max != null) {
      yMin = this.userY.min;
      yMax = this.userY.max;
      yTick = this.userY.tick || this._niceTick(yMax - yMin, 5);
    } else if (this.autoRange && allValues.length > 0) {
      // Spec formula — 10-division axis with one-tick head/foot padding.
      const dMin = Math.min(...allValues);
      const dMax = Math.max(...allValues);
      const span = dMax - dMin;
      if (span > 0) {
        yTick = span / 8;
        // Enforce a per-chart floor on the tick interval (used by the
        // seller-count chart to keep integer-only labels). Without
        // this, a span of 2 (e.g., 10〜12) yields tick=0.25 → labels
        // round to non-monotonic "12,12,12,11,11,11,10,10,10,10".
        if (this.minTick != null && yTick < this.minTick) {
          yTick = this.minTick;
        }
        yMin  = dMin - yTick;
        yMax  = dMax + yTick;
      } else {
        const pad = Math.max(1, Math.abs(dMax) * 0.05);
        yTick = pad / 4;
        if (this.minTick != null && yTick < this.minTick) {
          yTick = this.minTick;
        }
        yMin = dMin - pad;
        yMax = dMax + pad;
      }
    } else if (allValues.length > 0) {
      const dMin = Math.min(...allValues);
      const dMax = Math.max(...allValues);
      const pad = (dMax - dMin) * 0.12 || Math.abs(dMax) * 0.1 || 1;
      yMin = Math.max(0, dMin - pad);
      yMax = dMax + pad;
      yTick = this._niceTick(yMax - yMin, 5);
      yMin = Math.floor(yMin / yTick) * yTick;
      yMax = Math.ceil(yMax / yTick) * yTick;
    } else {
      yMin = 0; yMax = 1; yTick = 1;
    }

    // ── Layout ──────────────────────────────────────────────
    // padR widened so right-edge price tags ("¥1,234" + connector) fit
    // outside the plot area without overlapping data.
    const padL = 52, padR = 92, padT = 10, padB = 26;
    const chartW = Math.max(10, width - padL - padR);
    const chartH = Math.max(10, height - padT - padB);
    const xRange = this.xMax - this.xMin || 1;
    const yRange = yMax - yMin || 1;
    const xToPx = (t) => padL + ((t - this.xMin) / xRange) * chartW;
    const yToPx = (v) => padT + chartH - ((v - yMin) / yRange) * chartH;

    // ── Gridlines + Y labels ────────────────────────────────
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(226,232,240,.55)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    // Iterate ticks by count to avoid float accumulation past yMax.
    const yTickCount = Math.round((yMax - yMin) / yTick);
    for (let i = 0; i <= yTickCount; i++) {
      const v = yMin + i * yTick;
      const y = yToPx(v);
      ctx.strokeStyle = 'rgba(255,255,255,.06)';
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + chartW, y);
      ctx.stroke();
      ctx.fillText(this.yFormatter(v), padL - 4, y);
    }

    // ── X labels + gridlines (5 divisions) ──────────────────
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTickCount = 5;
    for (let i = 0; i <= xTickCount; i++) {
      const t = this.xMin + (xRange * i / xTickCount);
      const x = xToPx(t);
      if (i > 0 && i < xTickCount) {
        ctx.strokeStyle = 'rgba(255,255,255,.04)';
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, padT + chartH);
        ctx.stroke();
      }
      ctx.fillText(this._formatX(t, xRange), x, padT + chartH + 4);
    }

    // ── Axis lines ──────────────────────────────────────────
    ctx.strokeStyle = 'rgba(255,255,255,.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + chartH);
    ctx.lineTo(padL + chartW, padT + chartH);
    ctx.stroke();

    // ── Data lines + dots — one stroke per series ───────────
    if (allValues.length > 0) {
      for (const s of series) {
        const pts = (s.points || []).filter(
          (p) => p.v != null && isFinite(p.v) && p.t >= this.xMin && p.t <= this.xMax
        );
        if (pts.length === 0) continue;

        ctx.strokeStyle = s.color || this.color;
        ctx.lineWidth = s.lineWidth != null ? s.lineWidth : 1.6;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        // Optional dashed pattern (used for the selected average line
        // per spec — only one of the 5 averages renders at a time).
        ctx.setLineDash(s.dashed ? [6, 4] : []);

        ctx.beginPath();
        if (s.stepLine) {
          // Step-line: hold value horizontally until the next sample,
          // then jump vertically. Per spec annotation:
          // 「価格が変わったタイミングで実線が垂直なラインで価格移動」
          for (let i = 0; i < pts.length; i++) {
            const x = xToPx(pts[i].t);
            const y = yToPx(pts[i].v);
            if (i === 0) {
              ctx.moveTo(x, y);
            } else {
              const prevY = yToPx(pts[i - 1].v);
              ctx.lineTo(x, prevY);   // horizontal carry of previous value
              ctx.lineTo(x, y);       // vertical jump to new value
            }
          }
        } else {
          for (let i = 0; i < pts.length; i++) {
            const x = xToPx(pts[i].t);
            const y = yToPx(pts[i].v);
            if (i === 0) ctx.moveTo(x, y);
            else         ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Per-point markers. Skip if explicitly disabled, or if no shape
        // configured AND the legacy single-series path is engaged. The
        // *last* in-range point is skipped here and emphasized below as
        // a "now marker" with glow + tag.
        const wantDots = s.showDots !== false &&
                         (s.pointShape || series.length === 1);
        if (wantDots) {
          ctx.fillStyle = s.color || this.color;
          ctx.strokeStyle = s.color || this.color;
          ctx.lineWidth = 1.2;
          const lastIdx = pts.length - 1;
          for (let i = 0; i < pts.length; i++) {
            if (i === lastIdx) continue;     // reserved for now-marker
            this._drawMarker(xToPx(pts[i].t), yToPx(pts[i].v), s.pointShape || 'circle', s.markerSize || 4);
          }
        }
      }

      // ── 「Now」 markers + right-edge price tags ──────────────
      // For every visible series, replace the very last in-range point
      // with a glowing oversized marker, and float a value tag on the
      // right margin so the user can read the latest value at a glance.
      // Tags collide-resolve vertically so two series on similar Y
      // values don't overlap.
      const labelEntries = [];
      for (const s of series) {
        const pts = (s.points || []).filter(
          (p) => p.v != null && isFinite(p.v) && p.t >= this.xMin && p.t <= this.xMax
        );
        if (pts.length === 0) continue;
        const last = pts[pts.length - 1];
        const x = xToPx(last.t);
        const y = yToPx(last.v);
        const color = s.color || this.color;
        const shape = s.pointShape || 'circle';
        const baseSize = s.markerSize || 4;

        // For the dashed average line, draw just a small dash callout
        // at the last point (the line is plotted but no per-point
        // markers exist), and label it with a smaller italic tag.
        if (s.dashed) {
          ctx.save();
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(x - 6, y);
          ctx.lineTo(x + 6, y);
          ctx.stroke();
          ctx.restore();
          labelEntries.push({ y, color, value: this.yFormatter(last.v), dashed: true });
          continue;
        }

        // Glow halo via shadow blur — gives a soft premium "current"
        // pulse around the marker without an extra geometry pass.
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 14;
        ctx.fillStyle = color;
        this._drawMarker(x, y, shape, baseSize * 1.65);
        ctx.restore();

        // Crisp white outline ring on circles for extra "you-are-here"
        // legibility against the chart background.
        if (shape === 'circle') {
          ctx.strokeStyle = 'rgba(255,255,255,.92)';
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.arc(x, y, baseSize * 1.65, 0, Math.PI * 2);
          ctx.stroke();
        }

        labelEntries.push({ y, color, value: this.yFormatter(last.v), dashed: false });
      }

      // Stagger labels that would overlap on the right edge.
      labelEntries.sort((a, b) => a.y - b.y);
      const minGap = 22;
      for (let i = 1; i < labelEntries.length; i++) {
        if (labelEntries[i].y - labelEntries[i - 1].y < minGap) {
          labelEntries[i].y = labelEntries[i - 1].y + minGap;
        }
      }
      const yTopClamp = padT + 9;
      const yBotClamp = padT + chartH - 9;
      for (const lbl of labelEntries) {
        lbl.y = Math.min(yBotClamp, Math.max(yTopClamp, lbl.y));
      }

      // Connector + rounded-rect tag, drawn beyond the plot's right edge.
      const labelX = padL + chartW + 6;
      for (const lbl of labelEntries) {
        // Dashed connector from the chart-area edge to the tag.
        ctx.save();
        ctx.strokeStyle = lbl.color;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.55;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(padL + chartW, lbl.y);
        ctx.lineTo(labelX, lbl.y);
        ctx.stroke();
        ctx.restore();

        // Tag background — rounded pill, color-bordered.
        ctx.font = lbl.dashed
          ? 'italic 10px "Segoe UI", system-ui, sans-serif'
          : 'bold 11px "Segoe UI", system-ui, sans-serif';
        const text = String(lbl.value);
        const w = ctx.measureText(text).width + 12;
        const h = 18;
        const rectY = lbl.y - h / 2;
        ctx.fillStyle = 'rgba(15,15,30,0.96)';
        ctx.strokeStyle = lbl.color;
        ctx.lineWidth = lbl.dashed ? 1 : 1.5;
        this._roundRect(labelX, rectY, w, h, 5);
        ctx.fill();
        ctx.stroke();

        // Value text in series color.
        ctx.fillStyle = lbl.color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, labelX + 6, lbl.y + 0.5);
      }
    } else {
      ctx.fillStyle = 'rgba(226,232,240,.35)';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('データなし', padL + chartW / 2, padT + chartH / 2);
    }

    // Hit-test regions for axis clicks — recorded after every draw
    // so the layout stays in sync with the current canvas size.
    this._regions = {
      y: { x: 0,    y: padT,            w: padL,   h: chartH },
      x: { x: padL, y: padT + chartH,   w: chartW, h: padB   },
    };
    this._yRange = { min: yMin, max: yMax, tick: yTick };
  }
}

window.TimeSeriesChart = TimeSeriesChart;

// ─────────────────────────────────────────────────────────────
// Sparkline — tiny inline price chart drawn into the table-row
// canvas that replaces the old Keepa thumbnail. No axes, no labels;
// just a single line with a highlighted last-point dot. Auto-scales
// Y to data range with a small padding so flat lines don't sit on
// the cell border.
// ─────────────────────────────────────────────────────────────
class Sparkline {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.color = opts.color || '#fbbf24';
    this.lineWidth = opts.lineWidth || 1.8;
    this.points = [];
    this._sized = false;

    // ResizeObserver guards against the case where the first draw()
    // happens before layout has assigned dimensions to the canvas
    // (e.g., the row was just appended to a flex/grid parent and CSS
    // hasn't propagated yet). Without this, a tiny timing race leaves
    // the canvas's pixel buffer at 0×0 and the chart never appears
    // even though the data arrives correctly.
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => {
        if (!this._sized || this._lastRectW !== this.canvas.getBoundingClientRect().width) {
          this._sized = false;
          this.draw();
        }
      });
      this._ro.observe(this.canvas);
    }

    // Belt-and-suspenders: in some Chromium edge cases (canvas already
    // at its final CSS size at observation time) ResizeObserver may
    // not fire. Schedule a few rAF-spaced redraw attempts so the chart
    // is guaranteed to paint as soon as the canvas mounts and has a
    // non-zero box. Stops once a draw succeeds.
    this._bootstrapTries = 0;
    const bootstrap = () => {
      if (this._sized) return;
      this.draw();
      if (this._sized) return;
      if (this._bootstrapTries++ < 8) requestAnimationFrame(bootstrap);
    };
    requestAnimationFrame(bootstrap);
  }

  // points: 時系列 [{t, v}, …]
  // xMin/xMax (optional): 横軸を指定範囲で固定する。renderer 側で「直近
  // 180日」など期間を選んだ時、その期間でレンジを固定して、データが
  // 揃っていない期間は空白として描画する。null/undefined を渡せば従来
  // 通りデータの最古〜最新でフィット。
  setData(points, xMin, xMax) {
    this.points = Array.isArray(points) ? points : [];
    this._xMin = (typeof xMin === 'number' && isFinite(xMin)) ? xMin : null;
    this._xMax = (typeof xMax === 'number' && isFinite(xMax)) ? xMax : null;
    this.draw();
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
  }

  _ensureSize() {
    if (this._sized) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width  = Math.floor(rect.width  * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
    this.width  = rect.width;
    this.height = rect.height;
    this._lastRectW = rect.width;
    this._sized = true;
  }

  draw() {
    this._ensureSize();
    const { ctx, width, height, points } = this;
    if (!width || !height) return;
    ctx.clearRect(0, 0, width, height);

    // Empty-state for genuinely no-data cases (just-added products,
    // unscraped ASINs). Bumped from .32 → .65 alpha + bold so the
    // user can clearly tell "this cell is waiting on data" rather
    // than misreading it as a broken/empty rectangle. Adds two faint
    // dots either side of the text for visual weight.
    if (points.length === 0) {
      ctx.fillStyle = 'rgba(226,232,240,.65)';
      ctx.font = 'bold 9.5px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('データ収集中…', width / 2, height / 2);
      // Subtle dotted baseline so the cell has a visible line, not
      // just text on void background.
      ctx.fillStyle = 'rgba(226,232,240,.18)';
      const baseY = height * 0.78;
      for (let dx = 6; dx < width - 6; dx += 5) {
        ctx.fillRect(dx, baseY, 2, 1);
      }
      return;
    }

    // 横軸レンジ — setData() で xMin/xMax が渡されていれば「指定期間で
    // 固定」モード (= 詳細グラフと同じ挙動)。渡されていなければ従来通り
    // データ extent で auto-fit する (= 全期間モード相当)。
    const fixedRange = (this._xMin != null && this._xMax != null && this._xMax > this._xMin);
    const tMin = fixedRange ? this._xMin : points[0].t;
    const tMax = fixedRange ? this._xMax : points[points.length - 1].t;
    const tRange = (tMax - tMin) || 1;

    // Single-data-point fallback: draw a horizontal "current price"
    // line + dot. Without this, a product with one observation would
    // hit the < 2 path and look empty even though we have a real
    // value to display. fixedRange モードのときは点の実時刻に応じた
    // 位置にプロットする (右端付近に来るのが普通)。
    if (points.length === 1) {
      const p = points[0];
      const y = height / 2;
      const padXSingle = 3;
      const wSingle = width - padXSingle * 2;
      const x = fixedRange
        ? padXSingle + Math.min(1, Math.max(0, (p.t - tMin) / tRange)) * wSingle
        : width * 0.82;
      ctx.strokeStyle = this.color;
      ctx.lineWidth = this.lineWidth;
      ctx.lineCap = 'round';
      ctx.beginPath();
      // 短い水平インジケータ — fixedRange のときは点の左側に短く伸ばす。
      ctx.moveTo(Math.max(padXSingle, x - width * 0.18), y);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.arc(x, y, 2.4, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    let vMin = points[0].v, vMax = points[0].v;
    for (const p of points) {
      if (p.v < vMin) vMin = p.v;
      if (p.v > vMax) vMax = p.v;
    }
    // For perfectly flat series (vMin === vMax), pad a synthetic ±2%
    // range so the line draws in the middle of the canvas instead of
    // pinned to the very bottom edge where it competes with rounded
    // corners and the cell border.
    let vLo = vMin, vHi = vMax;
    if (vHi === vLo) {
      const pad = Math.max(1, Math.abs(vHi) * 0.02);
      vLo -= pad; vHi += pad;
    }
    const vRange = vHi - vLo || 1;

    const padX = 3, padY = 6;
    const w = width - padX * 2;
    const h = height - padY * 2;
    const xToPx = (t) => padX + ((t - tMin) / tRange) * w;
    const yToPx = (v) => padY + h - ((v - vLo) / vRange) * h;

    // Line
    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.lineWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const x = xToPx(points[i].t);
      const y = yToPx(points[i].v);
      if (i === 0) ctx.moveTo(x, y);
      else         ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Highlight dot on the last (= current) point.
    const last = points[points.length - 1];
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(xToPx(last.t), yToPx(last.v), 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

window.Sparkline = Sparkline;

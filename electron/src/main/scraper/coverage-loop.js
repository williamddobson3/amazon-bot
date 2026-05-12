'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { fetchPage, isPaused } = require('./fetcher');
const { parseSearchResults } = require('./search-parser');
const {
  AMAZON_BASE,
  JA_LANG_QUERY,
  BATCH_SIZE,
  BATCH_SIZE_MIN,
  BATCH_SIZE_MAX,
  MAX_COVERAGE_ATTEMPTS,
} = require('../../shared/constants');

// Build a search URL for a batch of ASINs using the |-separator trick.
// Amazon treats | as OR in the search query, returning results for any
// of the listed ASINs.
//
// IMPORTANT: the | must NOT be URL-encoded. Amazon's search expects raw
// pipe characters in the query string. encodeURIComponent would turn |
// into %7C which Amazon does not interpret as OR.
function buildSearchUrl(asins) {
  const query = asins.join('|');
  // Encode only the individual ASINs (they're alphanumeric so encoding
  // is a no-op), NOT the | separator.
  return `${AMAZON_BASE}/s?k=${query}&${JA_LANG_QUERY}`;
}

// Run one full coverage cycle for a list of ASINs. The cycle splits
// the list into batches of BATCH_SIZE (135), fetches each batch's search
// page, collects the ~45 results Amazon shows, and re-queues unseen
// ASINs until all are covered (or max attempts are hit).
//
// `onPageResult(results, pageIndex, totalPages)` is called after each
// successful page fetch with the parsed product data.
//
// `onProgress({ done, total, page, totalPages })` is called after each
// page so the UI can update a progress bar.
//
// Returns { total, found, missed, pages, errors }.
async function runCoverageLoop(allAsins, { onPageResult, onProgress, signal } = {}) {
  if (!allAsins || allAsins.length === 0) {
    return { total: 0, found: 0, missed: 0, pages: 0, errors: 0 };
  }

  const unseen = new Set(allAsins);
  const totalAsins = allAsins.length;
  let pageCount = 0;
  let errorCount = 0;
  const aborted = () => signal && signal.aborted;
  const result = (extra = {}) => ({
    total: totalAsins,
    found: totalAsins - unseen.size,
    missed: unseen.size,
    pages: pageCount,
    errors: errorCount,
    ...extra,
  });

  // Estimate total pages for progress reporting. Uses the mean batch
  // size and the ~1/3 show-ratio to project how many HTTP requests a
  // full coverage sweep will need.
  const estimatedPages = Math.ceil(totalAsins / (BATCH_SIZE / 3));

  // Process in waves. Each wave takes all currently-unseen ASINs,
  // chunks them into batches of BATCH_SIZE, and fetches each batch.
  // ASINs that Amazon didn't show remain in `unseen` and get retried
  // in the next wave.
  let wave = 0;
  while (unseen.size > 0 && wave < MAX_COVERAGE_ATTEMPTS) {
    if (aborted()) {
      console.info('[coverage] aborted between waves');
      return result({ aborted: true });
    }
    wave++;
    // Shuffle each wave so consecutive cycles don't re-issue the same
    // URL text, and use a jittered batch size so "135 items in k="
    // isn't a constant signature Amazon's WAF can cache-match on.
    const waveAsins = shuffle([...unseen]);
    const batches = chunkRandom(waveAsins, BATCH_SIZE_MIN, BATCH_SIZE_MAX);

    for (const batch of batches) {
      if (aborted()) {
        console.info('[coverage] aborted between batches');
        return result({ aborted: true });
      }
      if (isPaused()) {
        // If we're in a CAPTCHA pause, stop the loop. The scheduler
        // will restart it after the pause lifts.
        return result({ paused: true });
      }

      const url = buildSearchUrl(batch);
      const response = await fetchPage(url, { signal });

      // ABORTED means stop() was hit during awaitFetchSlot or the
      // in-flight HTTP fetch. Bail without counting the page as an
      // error or pushing a partial result.
      if (response.error === 'ABORTED' || aborted()) {
        console.info('[coverage] aborted mid-batch');
        return result({ aborted: true });
      }

      pageCount++;

      if (response.error) {
        errorCount++;
        console.warn(`[coverage] page ${pageCount} error: ${response.error}`);
        // Don't break the whole loop on a single error — move to next batch.
        continue;
      }

      const results = parseSearchResults(response.html);

      console.log(
        `[coverage] page ${pageCount}: fetched ${response.htmlLen} bytes, ` +
        `parsed ${results.length} product cards ` +
        `(batch had ${batch.length} ASINs, unseen=${unseen.size})`
      );

      // If we got HTML but zero results, save the full HTML for debugging
      // and log a snippet.
      if (results.length === 0 && response.html) {
        const snippet = response.html.slice(0, 500).replace(/\s+/g, ' ');
        console.warn(`[coverage] zero results — HTML snippet: ${snippet}`);
        try {
          const debugPath = path.join(app.getPath('userData'), 'debug-last-fetch.html');
          fs.writeFileSync(debugPath, response.html);
          console.warn(`[coverage] full HTML saved to: ${debugPath}`);
        } catch { /* non-critical */ }
      }

      // Mark found ASINs as seen.
      for (const r of results) {
        unseen.delete(r.asin);
      }

      if (onPageResult) {
        onPageResult(results, pageCount, estimatedPages);
      }

      if (onProgress) {
        onProgress({
          done: totalAsins - unseen.size,
          total: totalAsins,
          page: pageCount,
          totalPages: estimatedPages,
          wave,
        });
      }
    }

    // If this wave didn't reduce unseen at all, bail out to prevent
    // infinite looping on permanently-missing ASINs.
    if (unseen.size === waveAsins.length) {
      console.warn(
        `[coverage] wave ${wave} found 0 new ASINs — ` +
        `${unseen.size} permanently unseen, giving up`
      );
      break;
    }
  }

  const found = totalAsins - unseen.size;
  const missed = unseen.size;
  if (missed > 0) {
    console.warn(`[coverage] cycle complete: ${found}/${totalAsins} found, ${missed} missed`);
  } else {
    console.info(`[coverage] cycle complete: ${found}/${totalAsins} found in ${pageCount} pages`);
  }

  return { total: totalAsins, found, missed, pages: pageCount, errors: errorCount };
}

function chunk(arr, size) {
  const result = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

// Split into batches whose size is drawn uniformly from [min, max] per
// batch, not a fixed value. Breaks per-URL signature hashing.
function chunkRandom(arr, min, max) {
  const result = [];
  let i = 0;
  while (i < arr.length) {
    const size = min + Math.floor(Math.random() * (max - min + 1));
    result.push(arr.slice(i, i + size));
    i += size;
  }
  return result;
}

// Fisher–Yates shuffle, returns a new array.
function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

module.exports = { runCoverageLoop, buildSearchUrl };

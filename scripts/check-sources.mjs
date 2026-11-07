import { PLAYER_SOURCES, getSourceUrl } from "../src/utils/api.js";

const MOVIE_ID = 550;
const TV_ID = 1399;
const SEASON = 1;
const EPISODE = 1;
const UNKNOWN_ID = 999999999;
const TIMEOUT_MS = 20_000;
const ATTEMPTS = 3;
const REQUIRED_PASSES = 2;
const PAUSE_BETWEEN_ATTEMPTS_MS = 1_000;
const MAX_BODY_CHARS = 200_000;
// VidLink answers an unknown TMDB id with HTTP 500, so 500 counts as the site rejecting the id.
const REJECTION_STATUSES = [400, 404, 410, 422, 500];
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36";

const PARKED_PATTERN =
  /domain (is )?(for sale|available)|this domain (is|may be) (for sale|parked)|buy this domain|parked (free|domain)/;
const NOT_FOUND_PATTERN =
  /not found|no results|unavailable|has been removed|does not exist|invalid (id|tmdb)|couldn't find|could not find/;
const PLAYER_PATTERN =
  /<iframe[^>]+(?:src=|id=["']player_iframe["'])|<video[\s>]|jwplayer|plyr|video\.js|videojs|hls\.js/;

async function probe({ source, type, tmdbId }) {
  let url = "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    url = getSourceUrl(source.id, type, tmdbId, SEASON, EPISODE);
    const expectedHost = new URL(url).hostname;

    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT },
    });
    const base = { url, status: response.status, finalUrl: response.url };

    if (!response.ok) {
      const kind = REJECTION_STATUSES.includes(response.status) ? "content" : "network";
      return { ...base, ok: false, kind, reason: `HTTP ${response.status}` };
    }

    const finalHost = new URL(response.url).hostname;
    if (finalHost !== expectedHost) {
      return { ...base, ok: false, kind: "content", reason: `redirected to ${finalHost}` };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) {
      return { ...base, ok: false, kind: "content", reason: `content-type ${contentType || "missing"}` };
    }

    const html = (await response.text()).slice(0, MAX_BODY_CHARS);
    const visibleText = html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(script|style|noscript)\b[\s\S]*$/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .toLowerCase();
    if (PARKED_PATTERN.test(visibleText)) {
      return { ...base, ok: false, kind: "content", reason: "parked domain page" };
    }
    if (NOT_FOUND_PATTERN.test(visibleText)) {
      return { ...base, ok: false, kind: "content", reason: "not-found text in page" };
    }

    const playerMatch = html.toLowerCase().match(PLAYER_PATTERN);
    if (!playerMatch) {
      return { ...base, ok: false, kind: "content", reason: "no player markup" };
    }

    return { ...base, ok: true, kind: "content", reason: `player markup: ${playerMatch[0]}` };
  } catch (error) {
    const reason = error.name === "AbortError" ? "timeout" : error.message;
    return { url, status: null, finalUrl: null, ok: false, kind: "network", reason };
  } finally {
    clearTimeout(timer);
  }
}

async function probeRepeatedly({ source, type, tmdbId }) {
  const results = [];
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, PAUSE_BETWEEN_ATTEMPTS_MS));
    }
    results.push(await probe({ source, type, tmdbId }));
  }
  return results;
}

const sources = PLAYER_SOURCES.filter((source) => !source.async);
const skippedCount = PLAYER_SOURCES.length - sources.length;

if (sources.length === 0) {
  console.error("No synchronous player sources to probe: refusing to report success.");
  process.exit(1);
}

console.log(`Probing ${sources.length} sources (${skippedCount} async sources skipped, not checked).`);

const cases = [
  { type: "movie", tmdbId: MOVIE_ID },
  { type: "tv", tmdbId: TV_ID },
];

let unstableCount = 0;
let unverifiableCount = 0;

for (const source of sources) {
  console.log(`\n${source.label} (${source.id})`);

  for (const testCase of cases) {
    const attempts = await probeRepeatedly({ source, type: testCase.type, tmdbId: testCase.tmdbId });
    const passCount = attempts.filter((attempt) => attempt.ok).length;

    const controls = await probeRepeatedly({ source, type: testCase.type, tmdbId: UNKNOWN_ID });
    const controlRejected = controls.every((control) => !control.ok && control.kind === "content");
    const controlReasons = new Set(controls.map((control) => control.reason));

    let verdict = "STABLE";
    if (passCount < REQUIRED_PASSES) {
      verdict = "UNSTABLE";
      unstableCount++;
    } else if (!controlRejected) {
      verdict = "UNVERIFIABLE";
      unverifiableCount++;
    }

    console.log(`  ${testCase.type}: ${verdict} (${passCount}/${ATTEMPTS} passed)`);
    for (const attempt of attempts) {
      console.log(`    ${attempt.ok ? "ok  " : "FAIL"} ${attempt.reason} ${attempt.finalUrl ?? attempt.url}`);
    }
    console.log(
      `    unknown-id control: ${controlRejected ? "rejected" : "NOT rejected"} (${[...controlReasons].join("; ")})`,
    );
  }
}

console.log(`\nUnstable: ${unstableCount}. Unverifiable (control not rejected): ${unverifiableCount}.`);

if (unstableCount > 0) process.exit(1);
if (unverifiableCount > 0) process.exit(2);
process.exit(0);

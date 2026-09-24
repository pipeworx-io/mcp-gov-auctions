interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Government Auctions MCP — physical-asset auctions (surplus, seized, forfeited,
 * tax-deed) that agencies sell to the public. Reads the
 * auction_lots table (ingested daily by workers/auction-scraper) via PostgREST.
 *
 * Coverage: GovDeals + AllSurplus (state/local surplus — vehicles, equipment,
 * real estate) and IRS seized/forfeited property. Distinct from the gsa-auctions
 * pack (live GSA federal-surplus API); this pack is the multi-source, DB-backed
 * store whose differentiator is SOLD-PRICE HISTORY (auctions_sold_comps) — we
 * never delete closed lots, so hammer prices accumulate.
 *
 * The pack is stateless (gateway handles auth/rate-limit) and never throws for
 * expected empty results — it shapes LLM-friendly objects and returns { error }.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Government Auctions');
}

const ASSET_TYPES = ['vehicle', 'equipment', 'realestate', 'electronics', 'other'] as const;

const tools: McpToolExport['tools'] = [
  {
    name: 'auctions_search',
    description:
      'Search live US government auction lots for physical assets sold to the public — surplus vehicles, heavy equipment, real estate, electronics — from state/local governments (GovDeals, AllSurplus) and IRS seized/forfeited property. Filter by free-text keyword (matched on the item title, e.g. "truck", "excavator", "pickup"), 2-letter state, asset_type (vehicle|equipment|realestate|electronics|other), max_price (current bid ceiling), and closing_within_hours. Returns each lot with source, title, location, current bid, close time, and a link. For historical sold prices use auctions_sold_comps instead.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Free-text matched (case-insensitive) against the lot title, e.g. "truck", "forklift", "generator".' },
        state: { type: 'string', description: '2-letter state code of the item location, e.g. "TX", "CA".' },
        asset_type: { type: 'string', description: `One of: ${ASSET_TYPES.join(' | ')}.` },
        source: { type: 'string', description: 'Restrict to one source: govdeals | allsurplus | irs.' },
        max_price: { type: ['number', 'string'], description: 'Only lots whose current bid is at or below this.' },
        closing_within_hours: { type: ['number', 'string'], description: 'Only lots closing within this many hours from now.' },
        limit: { type: ['number', 'string'], description: 'Max lots (1-100, default 25).' },
      },
      required: [],
    },
  },
  {
    name: 'auctions_closing_soon',
    description:
      'Live government auction lots ordered by soonest close time — the "what can I still bid on before it ends" view across all sources (GovDeals, AllSurplus, IRS). Optionally filter by state, asset_type, or keyword. Returns lots with time remaining, current bid, location, and link.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: '2-letter state code.' },
        asset_type: { type: 'string', description: `One of: ${ASSET_TYPES.join(' | ')}.` },
        keyword: { type: 'string', description: 'Free-text title match.' },
        limit: { type: ['number', 'string'], description: 'Max lots (1-100, default 25).' },
      },
      required: [],
    },
  },
  {
    name: 'auction_lot_details',
    description:
      'Full details for a single government auction lot, looked up by its source + source_lot_id (as returned by auctions_search) or by its listing URL. Returns title, description, category, location, bid, close time, seller agency, and link.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Lot source: govdeals | allsurplus | irs.' },
        source_lot_id: { type: 'string', description: 'The lot id within that source.' },
        url: { type: 'string', description: 'Alternatively, the full listing URL.' },
      },
      required: [],
    },
  },
  {
    name: 'auctions_sold_comps',
    description:
      'Historical SOLD prices for government auction items — the final hammer price of closed lots, which no upstream site keeps but Pipeworx retains. Use to answer "what do seized pickup trucks actually sell for" or to comp an asset. Filter by keyword (title match), asset_type, and/or state. Returns count, min/median/max/average final price, and recent examples. Only includes lots that have closed with a recorded final price.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Free-text title match, e.g. "f-150", "excavator", "trailer".' },
        asset_type: { type: 'string', description: `One of: ${ASSET_TYPES.join(' | ')}.` },
        state: { type: 'string', description: '2-letter state code.' },
        limit: { type: ['number', 'string'], description: 'Max example lots to return (1-50, default 10).' },
      },
      required: [],
    },
  },
  {
    name: 'auctions_coverage',
    description:
      'Which government-auction data is currently available: per-source active lot counts and data freshness (when each source was last refreshed). Use to gauge coverage and how current the data is before relying on it.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

interface SupabaseConfig {
  url: string;
  key: string;
}

async function pg<T>(cfg: SupabaseConfig, table: string, query: string): Promise<T> {
  const res = await pwFetch(`${cfg.url}/rest/v1/${table}?${query}`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`data query ${table}: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

// Exact row count for a filter, via PostgREST's Content-Range header. Used
// instead of a count() aggregate (aggregate functions are disabled on the
// project). Requests a single row with Prefer: count=exact and parses the
// "0-0/1234" range tail.
//
// RETURNS null, NEVER 0, WHEN THE COUNT DID NOT RUN. This used to `return 0`
// on a non-ok response, and that one line was the whole of fleet #1081: an
// exact count over a table this size exceeds the statement timeout, the 500
// was swallowed, and coverage reported "govdeals: 0 active lots" to every
// caller while 55,669 were live and searchable. Zero and "we could not count"
// are not the same fact and must not share a value — the caller has to be able
// to tell an empty source from an uncounted one. Matches us-auctions' pgCount.
async function pgCount(cfg: SupabaseConfig, table: string, query: string): Promise<number | null> {
  const res = await pwFetch(`${cfg.url}/rest/v1/${table}?${query}&limit=1`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, Prefer: 'count=exact' },
  });
  if (!res.ok) return null;
  const range = res.headers.get('content-range') ?? '';
  const total = range.split('/')[1];
  const n = Number(total);
  return Number.isFinite(n) ? n : null;
}

// The sources this pack ingests. Kept explicit (aggregate/distinct is disabled)
// and matched to the auction-scraper adapters.
//
// KEEP THIS IN SYNC with workers/auction-scraper/src/sources/index.ts — minus
// any commercial source, which belongs to the us-auctions pack. It drifted once
// already: publicsurplus, bid4assets and txauction shipped in July and were
// still missing here on 2026-08-26, so auctions_coverage — the one tool whose
// whole job is reporting what we hold — under-reported us by three sources and
// ~24k lots while returning a clean 200. Nothing failed loudly; it just lied.
// It drifted a SECOND time, found 2026-09-02 while fixing fleet #1081: municibid
// (municipal surplus — towns, school districts, fire companies) shipped into
// ALL_SOURCES with segment 'government' and was never added here, so coverage
// was omitting a whole source again. Compare against ALL_SOURCES in the scraper,
// not against the other pack's list — us-auctions is missing three of them.
const KNOWN_SOURCES = ['govdeals', 'allsurplus', 'irs', 'publicsurplus', 'bid4assets', 'txauction', 'municibid'] as const;

// This pack is the GOVERNMENT view of auction_lots. The table also holds
// commercial lots (HiBid, ~684k of them) served by the us-auctions pack; without
// this filter a search for surplus pickup trucks would start returning
// estate-sale antiques. Every query in this file must carry it.
const GOV_SEGMENT = 'segment=eq.government';

interface LotRow {
  source: string;
  source_lot_id: string;
  title: string;
  description: string | null;
  category: string | null;
  asset_type: string | null;
  location_city: string | null;
  location_state: string | null;
  location_zip: string | null;
  currency: string;
  current_bid: number | null;
  bid_count: number | null;
  final_price: number | null;
  starts_at: string | null;
  closes_at: string | null;
  status: string;
  seller_agency: string | null;
  url: string | null;
}

const LOT_SELECT =
  'select=source,source_lot_id,title,category,asset_type,location_city,location_state,location_zip,currency,current_bid,bid_count,closes_at,status,seller_agency,url';

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.trunc(n), lo), hi);
}

function shapeLot(r: LotRow) {
  return {
    source: r.source,
    source_lot_id: r.source_lot_id,
    title: r.title,
    category: r.category,
    asset_type: r.asset_type,
    location: [r.location_city, r.location_state].filter(Boolean).join(', ') || null,
    state: r.location_state,
    current_bid: r.current_bid,
    currency: r.currency,
    bid_count: r.bid_count,
    closes_at: r.closes_at,
    seller: r.seller_agency,
    url: r.url,
  };
}

// Shared filter builder for the active-lot list tools.
function activeLotFilters(args: Record<string, unknown>): string[] {
  const parts = ['status=eq.active', GOV_SEGMENT];
  // Accept the common param aliases agents reach for (query/q/search/keywords)
  // — previously anything but `keyword` was silently ignored, returning the
  // whole unfiltered pool as if it had matched.
  parts.push(...titleKeywordParts(args));
  const state = String(args.state ?? args.location_state ?? '').trim();
  if (state) parts.push(`location_state=eq.${encodeURIComponent(state.toUpperCase())}`);
  const assetType = normalizeAssetType(String(args.asset_type ?? args.category ?? args.type ?? '').trim());
  if (assetType) parts.push(`asset_type=eq.${encodeURIComponent(assetType)}`);
  const source = String(args.source ?? '').trim().toLowerCase();
  if (source) parts.push(`source=eq.${encodeURIComponent(source)}`);
  return parts;
}

// Keyword → PostgREST title filters, shared by all keyword tools. Accepts the
// param aliases agents use (query/q/search/keywords), and tokenizes multi-word
// keywords into AND-ed substring matches so word order/adjacency don't matter.
function titleKeywordParts(args: Record<string, unknown>): string[] {
  const keyword = String(args.keyword ?? args.query ?? args.q ?? args.search ?? args.keywords ?? '').trim();
  if (!keyword) return [];
  return keyword
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 6)
    .map((tok) => `title=ilike.*${encodeURIComponent(tok)}*`);
}

// Map plural/synonym asset categories agents pass to the enum values.
function normalizeAssetType(raw: string): string {
  if (!raw) return '';
  const t = raw.toLowerCase();
  const map: Record<string, string> = {
    vehicles: 'vehicle', car: 'vehicle', cars: 'vehicle', truck: 'vehicle', trucks: 'vehicle', auto: 'vehicle',
    equipment: 'equipment', machinery: 'equipment', heavy: 'equipment',
    realestate: 'realestate', 'real estate': 'realestate', property: 'realestate', land: 'realestate',
    electronics: 'electronics', electronic: 'electronics', computers: 'electronics',
  };
  if ((ASSET_TYPES as readonly string[]).includes(t)) return t;
  return map[t] ?? '';
}

async function search(cfg: SupabaseConfig, args: Record<string, unknown>) {
  const parts = activeLotFilters(args);
  if (args.max_price !== undefined && String(args.max_price).trim() !== '') {
    parts.push(`current_bid=lte.${Number(args.max_price)}`);
  }
  const nowIso = new Date().toISOString();
  const limit = clampInt(args.limit, 1, 100, 25);

  if (args.closing_within_hours !== undefined && String(args.closing_within_hours).trim() !== '') {
    const cutoff = new Date(Date.now() + Number(args.closing_within_hours) * 3600_000).toISOString();
    parts.push(`closes_at=lte.${cutoff}`);
    parts.push(`closes_at=gte.${nowIso}`);
    parts.push(LOT_SELECT, 'order=closes_at.asc.nullslast', `limit=${limit}`);
    const rows = await pg<LotRow[]>(cfg, 'auction_lots', parts.join('&'));
    return { count: rows.length, lots: rows.map(shapeLot) };
  }

  // Results are ordered soonest-close-first, so without a floor the most-
  // stale already-ended lots surface at the TOP. The source is enumerated
  // ~daily while lots close throughout the day, so ~8% of 'active' lots are
  // past their close time at any given moment (close-out only fires when a
  // lot vanishes from the source's listing, not when closes_at passes).
  // Exclude past-close lots; keep null-close lots (legitimately listed with
  // no published end time).
  //
  // That floor used to be one `or=(closes_at.gte.NOW,closes_at.is.null)`, which
  // Postgres cannot serve from an index once it is also sorting on closes_at.
  // A state- or keyword-filtered search stayed fast because the filter narrowed
  // first, but an UNFILTERED search — the plainest "what's for sale" call there
  // is — scanned and sorted the whole active pool and intermittently blew the
  // statement timeout (57014). Worse, that failure alternated between a hard
  // 500 and a silent empty result under load, so some callers were told nothing
  // was for sale while the table held live lots. Two index-friendly passes
  // return the identical rows in the identical order, because `nullslast` puts
  // every null-close lot after every dated one anyway.
  const dated = await pg<LotRow[]>(
    cfg,
    'auction_lots',
    [...parts, `closes_at=gte.${nowIso}`, LOT_SELECT, 'order=closes_at.asc', `limit=${limit}`].join('&'),
  );
  const rows =
    dated.length >= limit
      ? dated
      : dated.concat(
          await pg<LotRow[]>(
            cfg,
            'auction_lots',
            [...parts, 'closes_at=is.null', LOT_SELECT, `limit=${limit - dated.length}`].join('&'),
          ),
        );
  return { count: rows.length, lots: rows.map(shapeLot) };
}

async function closingSoon(cfg: SupabaseConfig, args: Record<string, unknown>) {
  const parts = activeLotFilters(args);
  parts.push('closes_at=gte.' + new Date().toISOString());
  const limit = clampInt(args.limit, 1, 100, 25);
  parts.push(LOT_SELECT, 'order=closes_at.asc.nullslast', `limit=${limit}`);
  const rows = await pg<LotRow[]>(cfg, 'auction_lots', parts.join('&'));
  const now = Date.now();
  return {
    count: rows.length,
    lots: rows.map((r) => ({
      ...shapeLot(r),
      hours_remaining: r.closes_at ? Math.round(((new Date(r.closes_at).getTime() - now) / 3600_000) * 10) / 10 : null,
    })),
  };
}

async function lotDetails(cfg: SupabaseConfig, args: Record<string, unknown>) {
  const parts: string[] = ['limit=1', 'select=*', GOV_SEGMENT];
  const url = String(args.url ?? '').trim();
  const source = String(args.source ?? '').trim();
  const id = String(args.source_lot_id ?? '').trim();
  if (url) {
    parts.push(`url=eq.${encodeURIComponent(url)}`);
  } else if (source && id) {
    parts.push(`source=eq.${encodeURIComponent(source)}`, `source_lot_id=eq.${encodeURIComponent(id)}`);
  } else {
    return { error: 'missing_args', message: 'Provide either url, or both source and source_lot_id.' };
  }
  const rows = await pg<LotRow[]>(cfg, 'auction_lots', parts.join('&'));
  if (rows.length === 0) return { error: 'not_found', message: 'No matching lot.' };
  const r = rows[0];
  return {
    ...shapeLot(r),
    description: r.description,
    zip: r.location_zip,
    status: r.status,
    final_price: r.final_price,
  };
}

async function soldComps(cfg: SupabaseConfig, args: Record<string, unknown>) {
  const parts = ['status=eq.closed', 'final_price=not.is.null', GOV_SEGMENT];
  const keyword = String(args.keyword ?? args.query ?? args.q ?? args.search ?? args.keywords ?? '').trim();
  parts.push(...titleKeywordParts(args));
  const assetType = normalizeAssetType(String(args.asset_type ?? args.category ?? args.type ?? '').trim());
  if (assetType) parts.push(`asset_type=eq.${encodeURIComponent(assetType)}`);
  const state = String(args.state ?? args.location_state ?? '').trim();
  if (state) parts.push(`location_state=eq.${encodeURIComponent(state.toUpperCase())}`);

  // Pull final prices for stats (cap to keep it bounded) + a few recent examples.
  const statRows = await pg<Array<{ final_price: number }>>(
    cfg,
    'auction_lots',
    [...parts, 'select=final_price', 'order=closes_at.desc', 'limit=1000'].join('&'),
  );
  if (statRows.length === 0) {
    return {
      error: 'no_comps',
      message: `No closed lots with a recorded sold price match${keyword ? ` "${keyword}"` : ''} yet. Sold-price history accumulates as active lots close.`,
    };
  }
  const prices = statRows.map((r) => Number(r.final_price)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  const avg = Math.round(prices.reduce((s, n) => s + n, 0) / prices.length);
  const exLimit = clampInt(args.limit, 1, 50, 10);
  const examples = await pg<LotRow[]>(
    cfg,
    'auction_lots',
    [...parts, 'select=title,location_state,final_price,closes_at,url', 'order=closes_at.desc', `limit=${exLimit}`].join('&'),
  );
  return {
    matched_lots: prices.length,
    final_price: { min: prices[0], median, average: avg, max: prices[prices.length - 1], currency: 'USD' },
    recent_examples: examples.map((r) => ({
      title: r.title,
      state: r.location_state,
      sold_for: r.final_price,
      closed_at: r.closes_at,
      url: r.url,
    })),
  };
}

async function coverage(cfg: SupabaseConfig) {
  const sources = await pg<Array<{ source: string; last_success_at: string | null }>>(
    cfg,
    'auction_sources',
    'select=source,last_success_at&limit=200',
  );
  const freshness = new Map(sources.map((s) => [s.source, s.last_success_at]));
  const perSource = await Promise.all(
    KNOWN_SOURCES.map(async (source) => ({
      source,
      // No GOV_SEGMENT here, deliberately, and it is not a hole in the rule
      // above: every entry in KNOWN_SOURCES *is* a government source, so
      // source=eq.<x> already implies segment=government and the extra
      // predicate can only ever be true. It was not free, though — carrying it
      // was the difference between this count timing out and us-auctions'
      // identical count succeeding on a source 15x larger (fleet #1081).
      active_lots: await pgCount(cfg, 'auction_lots', `status=eq.active&source=eq.${source}`),
      last_refreshed_at: freshness.get(source) ?? null,
    })),
  );
  // GOV_SEGMENT is NOT redundant here: comps span both segments.
  const soldComps = await pgCount(cfg, 'auction_lots', `status=eq.closed&final_price=not.is.null&${GOV_SEGMENT}`);

  // A source whose count did not run contributes nothing to the sum and is
  // named instead, so the total reads as an explicit partial rather than as a
  // smaller number presented as a complete one.
  const uncounted = perSource.filter((s) => s.active_lots === null).map((s) => s.source);
  return {
    total_active_lots: perSource.reduce((s, c) => s + (c.active_lots ?? 0), 0),
    ...(uncounted.length
      ? {
          total_active_lots_partial:
            `Counts did not complete for ${uncounted.join(', ')} — those sources are NOT empty, they ` +
            `are UNCOUNTED, and they contribute 0 to total_active_lots. Call auctions_search or ` +
            `auctions_closing_soon to confirm a source is live.`,
          uncounted_sources: uncounted,
        }
      : {}),
    sold_comps_retained: soldComps,
    ...(soldComps === null
      ? {
          sold_comps_retained_unavailable:
            'The exact count of retained sold comps did not complete. Comps ARE retained — call ' +
            'auctions_sold_comps to read them. null here means uncounted, not zero.',
        }
      : {}),
    sources: perSource,
    note: 'Data is refreshed daily. Sold-price comps (auctions_sold_comps) retain closed lots indefinitely. An active_lots of null means the count did not complete, not that the source is empty.',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const supabaseUrl = (args._supabaseUrl as string | undefined)?.trim();
  const supabaseKey = (args._supabaseKey as string | undefined)?.trim();
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('gov-auctions is not configured on this deployment — an operator must enable its data credentials. This is a setup problem, not your arguments.');
  }
  const cfg: SupabaseConfig = { url: supabaseUrl, key: supabaseKey };

  switch (name) {
    case 'auctions_search':
      return search(cfg, args);
    case 'auctions_closing_soon':
      return closingSoon(cfg, args);
    case 'auction_lot_details':
      return lotDetails(cfg, args);
    case 'auctions_sold_comps':
      return soldComps(cfg, args);
    case 'auctions_coverage':
      return coverage(cfg);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;

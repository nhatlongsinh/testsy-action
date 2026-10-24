#!/usr/bin/env node
// Testsy command-line client (Node 18+, no dependencies). Runs tests from CI and waits for the results.
//   export QA_AI_API_KEY=qa_…            (Settings → API keys)
//   node qa-ai.mjs run --project p_123   (every test in the project)
//   node qa-ai.mjs run --test t_1,t_2 --junit qa-ai.xml
//   node qa-ai.mjs run --project p_123 --url https://pr-42.preview.example.com   (website tests start at this deploy instead of their saved address)
//   node qa-ai.mjs status j_abc   |   node qa-ai.mjs projects   |   node qa-ai.mjs tests --project p_123
//   Mobile apps: node qa-ai.mjs run --project p_123 --build app-debug.apk   (uploads the build — or reuses it if that exact file is already there — and runs the app's tests with it)
//                node qa-ai.mjs build upload MyApp.app.zip --project p_123 --label "$GITHUB_SHA"   |   node qa-ai.mjs builds --project p_123
//                node qa-ai.mjs build ensure app.apk --project p_123 --fingerprint "$FP"   (upload only if missing)
//                node qa-ai.mjs run --project p_123 --build build/Build/Products/Debug-iphonesimulator/MyApp.app   (a raw .app folder is zipped for you)
//                node qa-ai.mjs build find --project p_123 --fingerprint "$FP"             (is the native build already there? exit 0 yes / 1 no)
//                node qa-ai.mjs build upload MyApp.app.zip --upload "<signed link from create_build_upload>"   (no API key needed)
//                node qa-ai.mjs run --project p_123 --build https://…/app.apk   |   node qa-ai.mjs build import <https link> --project p_123 [--header "Authorization: Bearer …"]
// Exit codes: 0 passed · 1 a run ended in a --fail-on result (build find: not found) · 2 usage, API or run-start error · 3 timed out.
import {writeFileSync, appendFileSync, openSync, readSync, closeSync, statSync, existsSync, readFileSync, mkdirSync} from 'node:fs';
import {basename} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';

const VERSION = '1.8.0';

// Where the run comes from, shown on the Runs page ("GitHub Actions, main a41c2e"): the CI provider, commit, branch, job
// and a link to the job, read from the CI's own environment variables. Nothing is sent outside a known CI.
export function ciInfo(e = process.env) {
  const pick = (provider, commit, branch, job, url) => ({ provider, commit: commit || '', branch: branch || '', job: job || '', url: url && /^https:\/\//.test(url) ? url : '' });
  if (e.GITHUB_ACTIONS === 'true') return pick('github', e.GITHUB_SHA, e.GITHUB_HEAD_REF || e.GITHUB_REF_NAME, [e.GITHUB_WORKFLOW, e.GITHUB_JOB].filter(Boolean).join(' / '),
    e.GITHUB_SERVER_URL && e.GITHUB_REPOSITORY && e.GITHUB_RUN_ID ? `${e.GITHUB_SERVER_URL}/${e.GITHUB_REPOSITORY}/actions/runs/${e.GITHUB_RUN_ID}` : '');
  if (e.GITLAB_CI === 'true') return pick('gitlab', e.CI_COMMIT_SHA, e.CI_COMMIT_REF_NAME, e.CI_JOB_NAME, e.CI_JOB_URL);
  if (e.CIRCLECI === 'true') return pick('circleci', e.CIRCLE_SHA1, e.CIRCLE_BRANCH, e.CIRCLE_JOB, e.CIRCLE_BUILD_URL);
  if (e.BITBUCKET_BUILD_NUMBER) return pick('bitbucket', e.BITBUCKET_COMMIT, e.BITBUCKET_BRANCH, `pipeline ${e.BITBUCKET_BUILD_NUMBER}`, e.BITBUCKET_GIT_HTTP_ORIGIN ? `${e.BITBUCKET_GIT_HTTP_ORIGIN}/pipelines/results/${e.BITBUCKET_BUILD_NUMBER}` : '');
  if (e.BUILDKITE === 'true') return pick('buildkite', e.BUILDKITE_COMMIT, e.BUILDKITE_BRANCH, e.BUILDKITE_LABEL, e.BUILDKITE_BUILD_URL);
  if (e.TF_BUILD === 'True') return pick('azure', e.BUILD_SOURCEVERSION, e.BUILD_SOURCEBRANCHNAME, e.BUILD_DEFINITIONNAME, '');
  if (e.JENKINS_URL) return pick('jenkins', e.GIT_COMMIT, e.GIT_BRANCH, e.JOB_NAME, e.BUILD_URL);
  if (e.CI) return pick('ci', e.CI_COMMIT_SHA || e.COMMIT_SHA || e.GIT_COMMIT, e.CI_COMMIT_REF_NAME || e.BRANCH_NAME, '', '');
  return null;
}
/** Is the repository public? Then the run's watch link is for signed-in members only (a CI log anyone can read must not open it). */
export function ciPublic(e = process.env) {
  if (e.GITLAB_CI === 'true') return e.CI_PROJECT_VISIBILITY === 'public';
  if (e.GITHUB_ACTIONS === 'true' && e.GITHUB_EVENT_PATH) { try { return JSON.parse(readFileSync(e.GITHUB_EVENT_PATH, 'utf8'))?.repository?.private === false; } catch { return false; } }
  return false;
}
const CI = ciInfo(), CI_HEADERS = CI ? Object.fromEntries(Object.entries({ 'X-QA-CI-Provider': CI.provider, 'X-QA-CI-Commit': CI.commit, 'X-QA-CI-Branch': CI.branch, 'X-QA-CI-Job': CI.job, 'X-QA-CI-Url': CI.url, 'X-QA-CI-Public': ciPublic() ? '1' : '' })
  .filter(([, v]) => v).map(([k, v]) => [k, String(v).replace(/[^\x20-\x7e]/g, '?').slice(0, 400)])) : {};
const BASE = (process.env.QA_AI_URL || 'https://app.testsy.dev').replace(/\/+$/, '');
const KEY = process.env.QA_AI_API_KEY || '';
const FINAL = new Set(['passed', 'failed', 'blocked', 'inconclusive', 'error', 'cancelled']);
const RUN_POLL_BATCH_SIZE = 50; // /runs?ids returns at most 50 full run views per request.

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--no-')) out[a.slice(5)] = false;
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('='), val = v ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
      if (k === 'build' || k === 'header') (out[k] ||= []).push(val); else out[k] = val;   // --build once per app; --header once per header
    }
    else out._.push(a);
  }
  return out;
}
const die = (msg, code = 2) => { console.error(`qa-ai: ${msg}`); process.exit(code); };
/** idem: send an Idempotency-Key (run starts), the same on every retry, so a retried request whose first response was
 * lost returns that response instead of starting (and billing) a second run. */
async function call(method, path, body, idem = false, { allowNotStarted = false } = {}) {
  if (!KEY) die('set QA_AI_API_KEY (create a key in Settings → API keys).');
  const idemKey = idem ? `cli-${randomUUID()}` : null;
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${BASE}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${KEY}`, 'X-QA-Source': 'ci', 'User-Agent': `qa-ai-cli/${VERSION}`, ...CI_HEADERS, ...(idemKey ? { 'Idempotency-Key': idemKey } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      if (res.status === 409 && idemKey && (await res.clone().json().catch(() => ({}))).code === 'idempotency_in_progress') throw new Error('HTTP 409 (first request still in progress)');
      break;
    } catch (e) { if (attempt >= 4) die(`cannot reach ${BASE}: ${e.message}`); await sleep(2000 * (attempt + 1)); }
  }
  const data = await res.json().catch(() => ({}));
  // A project whose entire suite could not start still supplies per-test errors for the CI report.
  const notStarted = allowNotStarted && res.status === 402 && data.code === 'not_started'
    && Array.isArray(data.started) && data.started.length === 0 && Array.isArray(data.skipped) && data.skipped.length > 0;
  if (!res.ok && !notStarted) die(data.error || `HTTP ${res.status}`);
  return data;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const parseDuration = s => { const m = /^(\d+)(s|m|h)?$/.exec(String(s)); if (!m) die(`bad duration: ${s}`); return Number(m[1]) * ({ s: 1, m: 60, h: 3600 }[m[2] || 'm']) * 1000; };
const xml = s => String(s ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const icon = s => ({ passed: '✅', failed: '❌', blocked: '⛔', inconclusive: '❔', error: '⚠️', cancelled: '⏹️', not_started: '⚠️' }[s] || '⏳');

function junit(runs) {
  const failures = runs.filter(r => r.status === 'failed').length, errors = runs.filter(r => !['passed', 'failed'].includes(r.status)).length;
  const cases = runs.map(r => {
    const name = xml(r.testTitle || r.testId), time = ((r.durationMs || 0) / 1000).toFixed(1);
    const detail = xml([r.headline, ...(r.requirements || []).map(q => `${q.outcome === 'pass' ? '✓' : q.outcome === 'fail' ? '✗' : '?'} ${q.requirement} — ${q.reason}`), r.link].filter(Boolean).join('\n'));
    const body = r.status === 'passed' ? '' : r.status === 'failed' ? `<failure message="${xml(r.headline || 'failed')}">${detail}</failure>` : `<error message="${xml(r.status)}">${detail}</error>`;
    return `  <testcase classname="qa-ai" name="${name}" time="${time}">${body}<system-out>${xml([r.link, r.watchUrl ? `watch: ${r.watchUrl}` : ''].filter(Boolean).join('\n'))}</system-out></testcase>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="Testsy" tests="${runs.length}" failures="${failures}" errors="${errors}">\n${cases.join('\n')}\n</testsuite>\n`;
}
function summary(runs) {
  const rows = runs.map(r => {
    const name = (r.testTitle || r.testId).replace(/\|/g, '\\|');
    return `| ${icon(r.status)} ${r.status} | ${r.link ? `[${name}](${r.link})` : name} | ${(r.headline || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 200)} | ${r.watchUrl ? `[watch](${r.watchUrl})` : ''} |`;
  });
  return `### Testsy results\n\n| Result | Test | Summary | No-login link |\n|---|---|---|---|\n${rows.join('\n')}\n`;
}

// App builds: uploaded in parts (the size the server asks for, three at a time), then checked by the server.
const mb = n => `${(n / 1048576).toFixed(1)} MB`;
const describe = b => `build ${b.id}: ${b.platform === 'ios' ? 'iOS' : 'Android'} ${b.appId} ${b.version ?? ''}${b.versionCode && b.versionCode !== b.version ? ` (${b.versionCode})` : ''}${b.warnings?.length ? ` — ${b.warnings.join(' ')}` : ''}`;
/** A raw iOS Simulator .app folder is zipped (symlinks and resource forks kept, as Xcode's own zip does) into a temp file
 * named MyApp.app.zip; anything else is returned as is. */
function packIfAppFolder(file) {
  if (!/\.app\/?$/i.test(file) || !existsSync(file) || !statSync(file).isDirectory()) return file;
  const dir = file.replace(/\/+$/, ''), name = basename(dir), tmp = `${tmpdir()}/qa-ai-${process.pid}`, out = `${tmp}/${name}.zip`;
  mkdirSync(tmp, { recursive: true });
  const parent = dir.slice(0, dir.length - name.length) || '.';
  console.log(`zipping ${name} as ${name}.zip`);
  const r = process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${dir}' -DestinationPath '${out}' -Force`], { stdio: 'inherit' })
    : spawnSync('zip', ['-qry', out, name], { cwd: parent, stdio: 'inherit' });
  if (r.status !== 0 || !existsSync(out)) die(`could not zip ${dir}${r.error ? `: ${r.error.message}` : ''} (is \`zip\` installed?)`);
  return out;
}
/** sha256 of a file, read in 16 MB pieces (a build may be 1 GB). */
function fileSha256(file) {
  const fd = openSync(file, 'r'), h = createHash('sha256'), buf = Buffer.alloc(16 * 1048576); let n;
  try { while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); } finally { closeSync(fd); }
  return h.digest('hex');
}
/** "Do you already have this build?": the project's ready build with this file's sha256, else this fingerprint; null when neither. */
async function findBuild(project, { sha256, fingerprint }) {
  if (!project) die('give --project <id>');
  if (!sha256 && !fingerprint) die('give --file <build>, --sha256 <hex> and/or --fingerprint <text>');
  const q = new URLSearchParams(); if (sha256) q.set('sha256', sha256); if (fingerprint) q.set('fingerprint', fingerprint);
  return call('GET', `/projects/${project}/builds/lookup?${q}`);
}
/** PUT one part with retries; with a signed link no key is sent. */
async function putPart(url, buf, keyed) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try { res = await fetch(url, { method: 'PUT', headers: { ...(keyed ? { Authorization: `Bearer ${KEY}` } : {}), 'X-QA-Source': 'ci', 'User-Agent': `qa-ai-cli/${VERSION}`, 'Content-Type': 'application/octet-stream' }, body: buf }); }
    catch (e) { if (attempt >= 4) die(`upload failed: ${e.message}`); await sleep(2000 * (attempt + 1)); continue; }
    const d = await res.json().catch(() => ({}));
    if (res.ok) return d;
    if ((res.status >= 500 || res.status === 429) && attempt < 4) { await sleep(2000 * (attempt + 1)); continue; }
    die(d.error || `upload failed: HTTP ${res.status}`);
  }
}
/** Send a file's parts (three at a time) and complete the upload. links: { id, partBytes, parts, partUrl(n), complete() }. */
async function sendParts(file, size, name, s) {
  console.log(`uploading ${name} (${mb(size)}) as ${s.id}`);
  const fd = openSync(file, 'r'), parts = []; let next = 1, sent = 0, shown = 0;
  const put = async n => {
    const len = Math.min(s.partBytes, size - (n - 1) * s.partBytes), buf = Buffer.alloc(len); readSync(fd, buf, 0, len, (n - 1) * s.partBytes);
    const d = await putPart(s.partUrl(n), buf, s.keyed);
    parts.push({ partNumber: n, etag: d.etag }); sent += len; if (sent / size - shown >= 0.25 || sent === size) { shown = sent / size; console.log(`  ${Math.round(shown * 100)}%`); }
  };
  const lane = async () => { while (next <= s.parts) await put(next++); };
  try { await Promise.all([lane(), lane(), lane()]); } finally { closeSync(fd); }
  const { build: b } = await s.complete(parts);
  console.log(describe(b));
  return b;
}
async function uploadBuild(file, project, label, fingerprint) {
  if (!project) die('give --project <id> to upload a build');
  if (!existsSync(file)) die(`no such file: ${file}`);
  file = packIfAppFolder(file);
  const size = statSync(file).size, name = basename(file);
  const s = await call('POST', `/projects/${project}/builds`, { fileName: name, size, label: label || undefined, fingerprint: fingerprint || undefined });
  return sendParts(file, size, name, { ...s, keyed: true, partUrl: n => `${BASE}/api/v1/builds/${s.id}/parts/${n}`, complete: parts => call('POST', `/builds/${s.id}/complete`, { parts }) });
}
/** Upload with a signed link from create_build_upload (an MCP agent's shell): the link carries the authorisation, so no API key is needed. */
async function uploadSigned(file, link) {
  if (!existsSync(file)) die(`no such file: ${file}`);
  file = packIfAppFolder(file);
  let u; try { u = new URL(link); } catch { die('--upload needs the signed link from create_build_upload'); }
  if (!u.searchParams.get('token') || !/\/api\/v1\/builds\/ab_\w+\/upload$/.test(u.pathname)) die('--upload needs the signed link from create_build_upload');
  const base = `${u.origin}${u.pathname.replace(/\/upload$/, '')}`, q = `?token=${encodeURIComponent(u.searchParams.get('token'))}`;
  const get = async (url, init) => { const res = await fetch(url, init).catch(e => die(`cannot reach ${u.origin}: ${e.message}`)); const d = await res.json().catch(() => ({})); if (!res.ok) die(d.error || `HTTP ${res.status}`); return d; };
  const s = await get(`${base}/upload${q}`, { headers: { 'User-Agent': `qa-ai-cli/${VERSION}` } });
  const size = statSync(file).size;
  if (s.status !== 'uploading') die(`this upload is ${s.status}; create a new one`);
  if (s.size !== size) die(`${basename(file)} is ${size} bytes; the upload was created for ${s.size} bytes (${s.fileName}). Create the upload with the file's real size.`);
  return sendParts(file, size, basename(file), { ...s, keyed: false, partUrl: n => `${base}/parts/${n}${q}`,
    complete: parts => get(`${base}/complete${q}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': `qa-ai-cli/${VERSION}` }, body: JSON.stringify({ parts }) }) });
}
/** Fetch a build from an https link (EAS, Bitrise, S3, GitHub artifact…): the server downloads and checks it. */
async function importBuild(url, project, label, fingerprint, headerFlags) {
  if (!project) die('give --project <id>');
  const headers = {};
  for (const h of [].concat(headerFlags || [])) { const m = /^([^:]+):\s*(.+)$/.exec(String(h)); if (!m) die(`--header needs "Name: value", got ${h}`); headers[m[1].trim()] = m[2]; }
  console.log(`importing ${url.replace(/\?.*$/, '?…')}`);
  const { build: b } = await call('POST', `/projects/${project}/builds/import`, { url, ...(Object.keys(headers).length ? { headers } : {}), label: label || undefined, fingerprint: fingerprint || undefined });
  console.log(describe(b));
  return b;
}
/** Upload only when the project does not already hold this exact file (sha256) or, with a fingerprint, this native build. */
async function ensureBuild(file, project, label, fingerprint) {
  if (!project) die('give --project <id>');
  if (!existsSync(file)) die(`no such file: ${file}`);
  file = packIfAppFolder(file);
  const sha256 = fileSha256(file);
  const found = await findBuild(project, { sha256, fingerprint });
  if (found.build) { console.log(`reusing ${found.build.id} (same ${found.matchedBy === 'sha256' ? 'file' : 'native build'} already uploaded) — ${describe(found.build)}`); return { ...found.build, reused: true, matchedBy: found.matchedBy }; }
  return { ...await uploadBuild(file, project, label, fingerprint), reused: false, matchedBy: null };
}
const githubOutput = lines => { if (process.env.GITHUB_OUTPUT) try { appendFileSync(process.env.GITHUB_OUTPUT, lines.map(([k, v]) => `${k}=${v}\n`).join('')); } catch {} };
/** --build values: build ids (ab_…) as they are; files are uploaded first, unless that exact file is already there. */
async function resolveBuilds(a) {
  const label = a.label || process.env.GITHUB_SHA?.slice(0, 12) || process.env.CI_COMMIT_SHORT_SHA || '';
  const out = [];
  for (const v of a.build || []) {
    if (typeof v !== 'string') die('--build needs a file or a build id');
    if (/^ab_\w+$/.test(v)) { const { build } = await call('GET', `/builds/${v}`); out.push(build); }
    else if (/^https?:\/\//i.test(v)) out.push(await importBuild(v, a.project, label, (a.build.length === 1 && a.fingerprint) || undefined, a.header));
    else out.push(await ensureBuild(v, a.project, label, (a.build.length === 1 && a.fingerprint) || undefined));
  }
  return out;
}

async function run(a) {
  const mode = a.mode || 'auto', failOn = new Set(String(a['fail-on'] || 'failed,error').split(',').map(s => s.trim()));
  const target = typeof a.url === 'string' && a.url ? a.url : null;   // a preview/staging deploy: website tests start here
  if (a.url && !target) die('--url needs an address, e.g. --url https://pr-42.preview.example.com');
  const builds = await resolveBuilds(a);
  let started = [], skipped = [];
  if (a.project) {
    const r = await call('POST', `/projects/${a.project}/run`, { mode, ...(builds.length ? { buildIds: builds.map(b => b.id) } : {}), ...(target ? { url: target } : {}) }, true, { allowNotStarted: true });
    started = r.started; skipped = r.skipped || []; for (const s of skipped) console.warn(`not started ${s.testId}: ${s.reason}`);
  }
  for (const t of String(a.test || '').split(',').filter(Boolean)) {
    let buildId;
    if (builds.length) { const { test } = await call('GET', `/tests/${t}`); buildId = builds.find(b => b.platform === test.options?.platform && b.appId === test.options?.appId)?.id; }
    const r = await call('POST', `/tests/${t}/run`, { mode, ...(buildId ? { buildId } : {}), ...(target ? { url: target } : {}) }, true); started.push({ testId: t, runId: r.runId, mode: r.mode, link: r.link, watchUrl: r.watchUrl });
  }
  if (!started.length && !skipped.length) die(a.project || a.test ? 'no runs started' : 'give --project <id> and/or --test <id,…>');
  // The watch link opens the run live and its result without signing in: for whoever reads this log, a PR or a chat.
  for (const s of started) console.log(`started ${s.runId} (${s.mode}) ${s.link || ''}${s.watchUrl ? `\n   watch (no login): ${s.watchUrl}` : ''}`);
  githubOutput([['watch-urls', started.map(s => s.watchUrl).filter(Boolean).join(' ')]]);
  // A partial suite is a startup error, regardless of the verdicts of the tests that did start.
  const notStarted = skipped.map(s => ({ testId: s.testId, status: 'not_started', final: true, headline: s.reason }));
  if (a.wait === false) {
    console.log(JSON.stringify(started.map(s => s.runId)));
    if (skipped.length && a.junit) writeFileSync(a.junit, junit([
      ...started.map(s => ({ testId: s.testId, link: s.link, status: 'unknown', headline: 'Run started; the CLI did not wait for its result.' })), ...notStarted,
    ]));
    return skipped.length ? 2 : 0;
  }
  const deadline = Date.now() + parseDuration(a.timeout || '45m'), ids = [...new Set(started.map(s => s.runId))], seen = new Map();
  // Retain a row for every started run: an omitted result cannot make a suite complete or disappear from JUnit.
  const results = new Map(started.map(s => [s.runId, { id: s.runId, testId: s.testId, mode: s.mode, link: s.link, watchUrl: s.watchUrl,
    status: 'unknown', final: false, headline: 'The API has not returned this run; completion is unverified.' }]));
  let runs = [];
  while (true) {
    for (let offset = 0; offset < ids.length; offset += RUN_POLL_BATCH_SIZE) {
      const batch = ids.slice(offset, offset + RUN_POLL_BATCH_SIZE);
      const { runs: polled } = await call('GET', `/runs?ids=${batch.join(',')}`);
      for (const r of polled) if (results.has(r.id)) {
        // not_found is not a verdict, even if an API response marks it final.
        results.set(r.id, { ...results.get(r.id), headline: '', ...r, final: r.final === true && FINAL.has(r.status) });
      }
    }
    runs = [...ids.map(id => results.get(id)), ...notStarted];
    for (const r of runs) if (FINAL.has(r.status) && !seen.has(r.id)) { seen.set(r.id, r.status); console.log(`${icon(r.status)} ${r.status.padEnd(12)} ${r.testTitle || r.testId}${r.headline ? ` — ${r.headline}` : ''}\n   ${r.link}`); }
    if (runs.every(r => r.final)) break;
    if (Date.now() > deadline) { console.error(`timed out with ${runs.filter(r => !r.final).length} run(s) unfinished`); if (a.junit) writeFileSync(a.junit, junit(runs)); return 3; }
    await sleep(15000);
  }
  if (a.junit) { writeFileSync(a.junit, junit(runs)); console.log(`JUnit report: ${a.junit}`); }
  if (process.env.GITHUB_STEP_SUMMARY) try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(runs)); } catch {}
  const bad = runs.filter(r => failOn.has(r.status));
  const counts = runs.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
  console.log(`\n${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  return skipped.length ? 2 : bad.length ? 1 : 0;
}

const a = args(process.argv.slice(2)), cmd = a._[0];
const code = await (async () => {
  if (cmd === 'run') return run(a);
  if (cmd === 'status') { for (const id of a._.slice(1)) { const { run: r } = await call('GET', `/runs/${id}`); console.log(JSON.stringify(r, null, 2)); } return 0; }
  if (cmd === 'projects') { for (const p of (await call('GET', '/projects')).projects) console.log(`${p.id}\t${p.name}`); return 0; }
  if (cmd === 'tests') { if (!a.project) die('give --project <id>'); for (const t of (await call('GET', `/projects/${a.project}/tests`)).tests) console.log(`${t.id}\t${t.lastRun?.status ?? 'never run'}\t${t.options?.platform && t.options.platform !== 'web' ? `${t.options.platform}:${t.options.appId}\t` : ''}${t.title}`); return 0; }
  if (cmd === 'build' && (a._[1] === 'upload' || a._[1] === 'ensure')) {
    if (!a._[2]) die(`give the build file: qa-ai build ${a._[1]} app.apk --project <id>`);
    const label = a.label || process.env.GITHUB_SHA?.slice(0, 12) || process.env.CI_COMMIT_SHORT_SHA || '';
    const b = a.upload ? await uploadSigned(a._[2], a.upload) : a._[1] === 'ensure' ? await ensureBuild(a._[2], a.project, label, a.fingerprint) : await uploadBuild(a._[2], a.project, label, a.fingerprint);
    if (a.json) console.log(JSON.stringify(b)); else console.log(b.id);
    githubOutput([['build-id', b.id], ['build-reused', b.reused ? 'true' : 'false']]);
    return 0;
  }
  if (cmd === 'build' && a._[1] === 'import') {
    if (!a._[2]) die('give the link: qa-ai build import https://… --project <id>');
    const b = await importBuild(a._[2], a.project, a.label || process.env.GITHUB_SHA?.slice(0, 12) || process.env.CI_COMMIT_SHORT_SHA || '', a.fingerprint, a.header);
    if (a.json) console.log(JSON.stringify(b)); else console.log(b.id);
    githubOutput([['build-id', b.id]]);
    return 0;
  }
  if (cmd === 'build' && a._[1] === 'find') {
    const sha256 = a.sha256 || (a.file ? (existsSync(a.file) ? fileSha256(packIfAppFolder(a.file)) : die(`no such file: ${a.file}`)) : undefined);
    const found = await findBuild(a.project, { sha256, fingerprint: a.fingerprint });
    const needed = !found.build;
    if (a.json) console.log(JSON.stringify(found)); else if (found.build) console.log(found.build.id); else console.error('no build found: build and upload it');
    githubOutput([['build-id', found.build?.id ?? ''], ['build-needed', needed ? 'true' : 'false']]);
    if (a.dotenv) writeFileSync(a.dotenv, `QA_AI_BUILD_NEEDED=${needed}\nQA_AI_BUILD_ID=${found.build?.id ?? ''}\n`);
    return needed ? 1 : 0;
  }
  if (cmd === 'builds') { if (!a.project) die('give --project <id>'); for (const b of (await call('GET', `/projects/${a.project}/builds`)).builds) console.log(`${b.id}\t${b.platform}\t${b.appId}\t${b.version ?? ''}${b.versionCode && b.versionCode !== b.version ? ` (${b.versionCode})` : ''}\t${b.label ?? ''}\t${b.createdAt}`); return 0; }
  if (cmd === 'version' || a.version) { console.log(VERSION); return 0; }
  console.log(`Testsy CLI ${VERSION}
usage:
  qa-ai run --project <p_id> [--test <t_id,…>] [--mode auto|cold|warm] [--timeout 45m] [--junit file.xml] [--fail-on failed,error] [--no-wait] [--url <https://preview…>]
            [--build <app.apk | MyApp.app.zip | MyApp.app folder | https link | ab_id>]…  (app tests run these builds; files are uploaded, links imported) [--label <text>]
  qa-ai build upload <app.apk | MyApp.app.zip> --project <p_id> [--label <text>] [--fingerprint <text>] [--json]
  qa-ai build upload <file> --upload <signed link from create_build_upload>   (no API key)
  qa-ai build import <https link> --project <p_id> [--header "Name: value"]… [--label <text>] [--fingerprint <text>] [--json]
  qa-ai build ensure <app.apk | MyApp.app.zip> --project <p_id> [--fingerprint <text>] [--label <text>] [--json]   (upload only if missing)
  qa-ai build find --project <p_id> [--file <build> | --sha256 <hex>] [--fingerprint <text>] [--json] [--dotenv <file>]   (exit 0 found / 1 not)
  qa-ai builds --project <p_id>
  qa-ai status <j_id…>
  qa-ai projects
  qa-ai tests --project <p_id>
env: QA_AI_API_KEY (required), QA_AI_URL (default ${BASE})`);
  return cmd ? 2 : 0;
})();
process.exitCode = code; // Let piped CI output drain before exiting, including large suites' final summaries.

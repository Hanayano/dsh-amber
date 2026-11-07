/**
 * dsh-amber
 *
 * Replaces the stock compaction backend with one that never folds the seq
 * ranges listed in the core file — but only for sessions the user enabled in
 * the settings panel. For all other sessions it delegates to the stock logic.
 *
 * The core file (default `~/.dsh/amber.json`, overridable via the
 * `DSH_AMBER_FILE` environment variable) holds:
 *   {
 *     "enabledSessions": ["session-..."],
 *     "cores": { "<sessionId>": [[start, end], ...] }
 *   }
 *
 * Settings UI (client.js) reads/writes this file through the JSON routes below.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import zlib from 'node:zlib';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';

const DEFAULT_CORE_FILE = join(homedir(), '.dsh', 'amber.json');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions');
const PREFIX = '/dsh-amber';

function loadCoreFile(file) {
  try {
    if (!existsSync(file)) return { enabledSessions: [], cores: {} };
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const enabledSessions = Array.isArray(parsed.enabledSessions)
      ? parsed.enabledSessions.filter((s) => typeof s === 'string' && s.length > 0)
      : [];
    const cores = {};
    const src = parsed.cores && typeof parsed.cores === 'object' && !Array.isArray(parsed.cores) ? parsed.cores : {};
    for (const [sid, ranges] of Object.entries(src)) {
      if (Array.isArray(ranges)) {
        cores[sid] = ranges
          .filter((r) => Array.isArray(r) && r.length === 2 && Number.isInteger(r[0]) && Number.isInteger(r[1]))
          .map((r) => [r[0], r[1]]);
      }
    }
    return { enabledSessions, cores };
  } catch {
    return { enabledSessions: [], cores: {} };
  }
}

function saveCoreFile(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ enabledSessions: data.enabledSessions ?? [], cores: data.cores ?? {} }, null, 2), 'utf8');
}

function inCore(ranges, seq) {
  for (const [s, e] of ranges) if (seq >= s && seq <= e) return true;
  return false;
}

function routedTarget(session) {
  const config = session.requestHeader?.()?.config;
  if (!config || !config.provider || !config.model) return undefined;
  return { provider: config.provider, model: config.model };
}

function selectSkippingCore(session, measurement, retainTokens, ranges, logger) {
  const priced = measurement.nodes;
  const surface = session.surface.nodes;
  if (!priced || priced.length === 0) return null;
  if (surface.length !== priced.length || surface.some((seq, i) => seq !== priced[i]?.seq)) {
    logger?.warn?.('[amber] token-meter surface mismatch; skip');
    return null;
  }
  const head = session.eventAt?.(surface[0]);
  const firstIdx = head?.type === 'system/message' ? 1 : 0;
  if (firstIdx >= priced.length) return null;

  let keepFromIdx = priced.length;
  let accumulated = 0;
  for (let i = priced.length - 1; i >= firstIdx; i -= 1) {
    accumulated += priced[i].tokens;
    keepFromIdx = i;
    if (accumulated >= retainTokens) break;
  }

  let startIdx = firstIdx;
  while (startIdx < keepFromIdx && inCore(ranges, surface[startIdx])) startIdx += 1;
  let endIdx = startIdx;
  while (endIdx + 1 < keepFromIdx && !inCore(ranges, surface[endIdx + 1])) endIdx += 1;
  if (startIdx >= endIdx + 1) return null;

  while (endIdx >= startIdx) {
    const next = surface[endIdx + 1];
    if (next === undefined) break;
    try { if (toolPairingBalancedBefore(session, next)) break; } catch { break; }
    endIdx -= 1;
  }
  while (startIdx <= endIdx) {
    try { if (toolPairingBalancedBefore(session, surface[startIdx])) break; } catch { break; }
    startIdx += 1;
  }
  if (startIdx > endIdx) return null;
  return { start: surface[startIdx], end: surface[endIdx] };
}

// ---- session/message readers (used by the settings panel) ----
function decompressFrames(file) {
  const buf = readFileSync(file);
  const offs = [];
  let i = -1;
  while ((i = buf.indexOf(MAGIC, i + 1)) !== -1) offs.push(i);
  const parts = [];
  for (let k = 0; k < offs.length; k++) {
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(offs[k], k + 1 < offs.length ? offs[k + 1] : buf.length)).toString('utf8')); } catch { /* skip partial tail */ }
  }
  return parts.join('');
}
function parseEvents(text) {
  const ev = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { ev.push(JSON.parse(line)); } catch { /* ignore */ } }
  return ev;
}
function contentText(c) { return Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text || '').join('') : (typeof c === 'string' ? c : ''); }

function listSessionFiles() {
  const out = [];
  function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'session.v4.jsonl.zstd') out.push(p);
    }
  }
  if (existsSync(SESSIONS_ROOT)) walk(SESSIONS_ROOT);
  return out;
}

function sessionMeta(file) {
  const events = parseEvents(decompressFrames(file));
  const head = events.find((e) => e.type === 'session');
  const title = events.find((e) => e.type === 'session/title');
  const users = events.filter((e) => e.type === 'user/message' && e.data?.source?.kind === 'user');
  return {
    id: head?.data?.id ?? head?.id ?? '',
    cwd: head?.data?.cwd ?? '',
    title: title?.data?.title ?? title?.data?.name ?? '',
    userMessages: users.length,
    events: events.length,
  };
}

let sessionListCache = { at: 0, data: null };

function listSessions() {
  const now = Date.now();
  if (sessionListCache.data && now - sessionListCache.at < 5000) return sessionListCache.data;
  const files = listSessionFiles();
  const out = [];
  for (const f of files) {
    try {
      const m = sessionMeta(f);
      if (m.id) out.push({ ...m, size: statSync(f).size });
    } catch { /* skip */ }
  }
  out.sort((a, b) => b.userMessages - a.userMessages);
  sessionListCache = { at: now, data: out };
  return out;
}

function listMessages(sessionId) {
  const files = listSessionFiles();
  const file = files.find((f) => {
    try { const events = parseEvents(decompressFrames(f)); const head = events.find((e) => e.type === 'session'); return (head?.data?.id ?? head?.id) === sessionId; } catch { return false; }
  });
  if (!file) return null;
  const events = parseEvents(decompressFrames(file));
  // Only messages after the last compaction/end seq are still on the surface;
  // earlier text was already replaced by a checkpoint.
  let surfaceFloor = -1;
  for (const e of events) {
    if (e.type === 'compaction/end' && typeof e.seq === 'number') surfaceFloor = Math.max(surfaceFloor, e.seq);
  }
  const out = [];
  for (const e of events) {
    const onSurface = typeof e.seq === 'number' && e.seq > surfaceFloor;
    if (e.type === 'user/message' && e.data?.source?.kind === 'user') {
      out.push({ seq: e.seq, time: e.time, role: 'user', preview: contentText(e.data?.content).slice(0, 80), compressed: !onSurface });
    } else if (e.type === 'assistant/message') {
      const t = contentText(e.data?.message?.content);
      if (t) out.push({ seq: e.seq, time: e.time, role: 'assistant', preview: t.slice(0, 80), compressed: !onSurface });
    }
  }
  return out;
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

export default class AmberEngine extends BasicCompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions', 'webServer', 'connection'];

  constructor(ctx, config = {}) {
    super(ctx, config);
    this.coreFile = process.env.DSH_AMBER_FILE || DEFAULT_CORE_FILE;
    const data = loadCoreFile(this.coreFile);
    this.cores = data.cores;
    this.enabledSessions = new Set(data.enabledSessions);
    this.rangeMissCount = 0;
    const rangeCount = Object.values(this.cores).reduce((n, r) => n + r.length, 0);
    ctx?.logger?.info?.(`[amber] active · ${rangeCount} range(s) · ${this.enabledSessions.size} enabled session(s)`);
    this._registerRoutes(ctx);
  }

  _registerRoutes(ctx) {
    const self = this;
    const route = async (req, res) => {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname.replace(/\/+$/, '');
      try {
        if (path === `${PREFIX}/config` && req.method === 'GET') {
          return json(res, 200, { coreFile: self.coreFile, enabledSessions: [...self.enabledSessions], cores: self.cores });
        }
        if (path === `${PREFIX}/config` && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}');
          const enabledSessions = Array.isArray(body.enabledSessions) ? body.enabledSessions.filter((s) => typeof s === 'string' && s.length > 0) : [];
          const cores = {};
          const src = body.cores && typeof body.cores === 'object' && !Array.isArray(body.cores) ? body.cores : {};
          for (const [sid, ranges] of Object.entries(src)) {
            if (Array.isArray(ranges)) {
              cores[sid] = ranges.filter((r) => Array.isArray(r) && r.length === 2 && Number.isInteger(r[0]) && Number.isInteger(r[1]));
            }
          }
          saveCoreFile(self.coreFile, { enabledSessions, cores });
          self.cores = cores;
          self.enabledSessions = new Set(enabledSessions);
          const rangeCount = Object.values(cores).reduce((n, r) => n + r.length, 0);
          ctx?.logger?.info?.(`[amber] config saved · ${rangeCount} range(s) · ${enabledSessions.length} session(s)`);
          return json(res, 200, { ok: true, enabledSessions, cores });
        }
        if (path === `${PREFIX}/sessions`) {
          return json(res, 200, { sessions: listSessions() });
        }
        if (path === `${PREFIX}/messages`) {
          const id = url.searchParams.get('id');
          if (!id) return json(res, 400, { error: 'missing id' });
          if (!/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return json(res, 400, { error: 'invalid id' });
          const messages = listMessages(id);
          return json(res, 200, { messages: messages ?? null });
        }
        if (path === `${PREFIX}/diag`) {
          return json(res, 200, {
            config: {
              thresholdRatio: self.config.thresholdRatio,
              retainTokens: self.config.retainTokens,
              headroomTokens: self.config.headroomTokens,
              compactionRetries: self.config.compactionRetries,
            },
            enabledSessions: [...self.enabledSessions],
            cores: self.cores,
          });
        }
        return json(res, 404, { error: 'not found' });
      } catch (error) {
        ctx?.logger?.warn?.(`[amber] route error: ${error?.message ?? error}`);
        return json(res, 500, { error: String(error?.message ?? error) });
      }
    };

    // Register after the host is ready: `webServer` may not be on `ctx` yet in the constructor.
    ctx.effect?.(() => {
      let webServer;
      try { webServer = ctx.get('webServer'); } catch { webServer = undefined; }
      if (!webServer?.register) return;

      const guarded = async (req, res) => {
        try {
          const conn = ctx.get('connection');
          if (!conn) return json(res, 503, { error: 'connection unavailable' });
          const rejection = conn.requestRejection?.(req);
          if (rejection) return json(res, rejection.status ?? 403, { error: rejection.message ?? 'forbidden' });
        } catch {
          return json(res, 503, { error: 'trust check failed' });
        }
        await route(req, res);
      };

      const disposers = [];
      try {
        const d = webServer.register({ kind: 'prefix', path: PREFIX, handler: guarded });
        if (typeof d === 'function') disposers.push(d);
        else if (d && typeof d.dispose === 'function') disposers.push(() => d.dispose());
      } catch (error) {
        ctx?.logger?.warn?.(`[amber] route registration failed: ${error?.message ?? error}`);
      }
      return () => { for (const d of disposers) { try { d(); } catch { /* ignore */ } } };
    });
  }

  _shouldDegrade() {
    this.rangeMissCount += 1;
    if (this.rangeMissCount >= 3) { this.rangeMissCount = 0; return true; }
    return false;
  }

  _resetMiss() { this.rangeMissCount = 0; }

  async compactRegion(start, end, agent, signal) {
    // Hard gate: refuse any compaction request that overlaps a protected core range.
    // Automatic compaction uses selectSkippingCore (which already avoids core ranges);
    // this mainly blocks a manual context_compact that targets the core directly.
    const sessionId = agent?.session?.id;
    const ranges = this.cores?.[sessionId] ?? [];
    for (const [s, e] of ranges) {
      if (typeof s === 'number' && typeof e === 'number' && start <= e && end >= s) {
        const err = new Error(`[amber] refusing to compact protected core range [${s},${e}] (requested [${start},${end}])`);
        this.ctx?.logger?.warn?.(err.message);
        throw err;
      }
    }
    return super.compactRegion(start, end, agent, signal);
  }

  async compactIfNeeded(agent, trigger, signal) {
    const sessionId = agent?.session?.id;
    if (!sessionId || !this.enabledSessions.has(sessionId)) {
      return super.compactIfNeeded(agent, trigger, signal);
    }
    const logger = this.ctx?.logger;
    const ranges = this.cores?.[sessionId] ?? [];
    const target = routedTarget(agent.session);
    if (target === undefined) return null;

    const meter = this.ctx.tokenMeter;
    let measurement = meter.measure(agent.session);
    let prune;
    try { prune = this.ctx.get('toolResultPruner'); } catch { prune = undefined; }

    if (trigger === 'context-overflow') {
      try {
        if (prune !== undefined) { prune.pruneSession(agent.session); measurement = meter.measure(agent.session); }
        const range = selectSkippingCore(agent.session, measurement, 0, ranges, logger);
        if (range === null) {
          if (this._shouldDegrade()) { logger?.warn?.('[amber] degrading to stock compaction after repeated misses'); return super.compactIfNeeded(agent, trigger, signal); }
          logger?.warn?.('[amber] overflow: no non-core span left'); return null;
        }
        this._resetMiss();
        return await this.compactRegion(range.start, range.end, agent, signal);
      } catch (error) {
        logger?.warn?.(`[amber] overflow failed: ${error?.message ?? error}`);
        return null;
      }
    }

    try {
      const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
      if (info.context === undefined) return null;
      const contextWindow = info.context.contextWindow;
      const reserved = agent.session.requestHeader?.()?.config.maxTokens ?? info.defaultMaxTokens ?? 0;
      const messageBudget = contextWindow - reserved;
      const pressureBudget = messageBudget - (this.config.headroomTokens ?? 0);
      const thresholdTokens = Math.floor(Math.min(contextWindow * (this.config.thresholdRatio ?? 0.8), pressureBudget));
      const retainTokens = this.config.retainTokens ?? Math.floor(messageBudget * (this.config.retainRatio ?? 0.16));
      if (measurement.totalTokens < thresholdTokens) return null;
      if (prune !== undefined) { prune.pruneSession(agent.session); measurement = meter.measure(agent.session); }
      if (measurement.totalTokens < thresholdTokens) return null;

      let result = null;
      const retries = this.config.compactionRetries ?? 0;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const range = selectSkippingCore(agent.session, measurement, retainTokens, ranges, logger);
        if (range === null) {
          if (this._shouldDegrade()) { logger?.warn?.('[amber] degrading to stock compaction after repeated misses'); return super.compactIfNeeded(agent, trigger, signal); }
          logger?.warn?.('[amber] no non-core span left; leaving as is'); break;
        }
        this._resetMiss();
        result = await this.compactRegion(range.start, range.end, agent, signal);
        measurement = meter.measure(agent.session);
        if (measurement.totalTokens < thresholdTokens) return result;
      }
      return result;
    } catch (error) {
      logger?.warn?.(`[amber] compaction failed: ${error?.message ?? error}`);
      return null;
    }
  }
}

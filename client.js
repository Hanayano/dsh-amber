/**
 * client.js — browser half: the DSH "Settings → Compaction guard" section.
 * Data flow: section ⇄ same-origin fetch /dsh-amber/* ⇄ the core file.
 */
window.__ModuleLoader__.load({
  id: 'dsh-amber',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const { createElement: h, useCallback, useEffect, useRef, useState } = React;

    const API = '/dsh-amber';
    const NS = 'amber';

    function mergeToRanges(seqs) {
      const sorted = [...seqs].sort((a, b) => a - b);
      const ranges = [];
      for (const s of sorted) {
        const last = ranges[ranges.length - 1];
        if (last && s <= last[1] + 1) last[1] = Math.max(last[1], s);
        else ranges.push([s, s]);
      }
      return ranges;
    }

    const box = { border: '1px solid var(--dsw-alias-line, #ddd)', borderRadius: '6px', padding: '8px 10px', marginBottom: '8px' };
    const row = { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' };
    const btn = { padding: '4px 12px', borderRadius: '5px', cursor: 'pointer' };
    const dim = { color: 'var(--dsw-alias-text-secondary, #888)', fontSize: '12px' };
    const hint = { color: 'var(--dsw-alias-text-secondary, #888)', fontSize: '12px', margin: '4px 0 10px' };

    function Section() {
      const [config, setConfig] = useState(null);
      const [sessions, setSessions] = useState([]);
      const [messages, setMessages] = useState([]);
      const [enabled, setEnabled] = useState([]);
      const [activeId, setActiveId] = useState('');
      const [picked, setPicked] = useState([]);
      const [msg, setMsg] = useState('');
      const [busy, setBusy] = useState(false);

      const reloadConfig = useCallback(async () => {
        try {
          const r = await fetch(`${API}/config`);
          const d = await r.json();
          setConfig(d);
          setEnabled(d.enabledSessions || []);
          setMsg('');
        } catch (e) {
          setMsg(`加载失败：${e?.message || e}`);
          setConfig({});
        }
      }, []);

      const reloadSessions = useCallback(async () => {
        try {
          const r = await fetch(`${API}/sessions`);
          const d = await r.json();
          setSessions(d.sessions || []);
        } catch (e) {
          setMsg(`会话加载失败：${e?.message || e}`);
        }
      }, []);

      const loadMessages = useCallback(async (id) => {
        setActiveId(id);
        setPicked([]);
        const r = await fetch(`${API}/messages?id=${encodeURIComponent(id)}`);
        const d = await r.json();
        setMessages(d.messages || []);
      }, []);

      useEffect(() => { reloadConfig(); reloadSessions(); }, [reloadConfig, reloadSessions]);

      // 用 ref 兜住最新值，避免 save 的闭包旧值把别的操作刚写进去的核心区覆盖掉。
      const configRef = useRef(config);
      const enabledRef = useRef(enabled);
      useEffect(() => { configRef.current = config; }, [config]);
      useEffect(() => { enabledRef.current = enabled; }, [enabled]);

      const save = useCallback(async (nextEnabled, nextCores) => {
        setBusy(true);
        setMsg('');
        try {
          const r = await fetch(`${API}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabledSessions: nextEnabled, cores: nextCores }),
          });
          const d = await r.json();
          if (d.ok) { setConfig({ ...d }); setEnabled(d.enabledSessions); setMsg('已保存'); }
          else setMsg('保存失败');
        } catch (e) {
          setMsg(`保存失败：${e?.message || e}`);
        } finally {
          setBusy(false);
        }
      }, []);

      const toggleSession = useCallback((id) => {
        const cur = enabledRef.current;
        const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
        setEnabled(next);
        save(next, configRef.current?.cores || {});
      }, [save]);

      const addPicked = useCallback(() => {
        if (!picked.length || !activeId) return;
        const cfg = configRef.current;
        const sorted = [...picked].sort((a, b) => a - b);
        // 一次勾选的一批视为「连续的一段对话」：保护 [min, max] 整段，中间的用户/助手/思考一起覆盖。
        const batch = sorted.length === 1 ? [sorted[0], sorted[0]] : [sorted[0], sorted[sorted.length - 1]];
        const cur = cfg?.cores?.[activeId] || [];
        // cur 是区间数组，batch 也是区间；合并区间（排序 + 相邻/重叠合并）。
        const ranges = [...cur, batch].sort((a, b) => a[0] - b[0]);
        const merged = [];
        for (const r of ranges) {
          const last = merged[merged.length - 1];
          if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
          else merged.push([r[0], r[1]]);
        }
        const nextCores = { ...(cfg?.cores || {}), [activeId]: merged };
        save(enabledRef.current, nextCores);
        setPicked([]);
      }, [picked, activeId, save]);

      const removeRange = useCallback((sid, idx) => {
        const cfg = configRef.current;
        const cur = cfg?.cores?.[sid] || [];
        const next = cur.filter((_, i) => i !== idx);
        const nextCores = { ...(cfg?.cores || {}) };
        if (next.length) nextCores[sid] = next; else delete nextCores[sid];
        save(enabledRef.current, nextCores);
      }, [save]);

      if (!config) return h('div', { className: 'dim' }, '加载中…');

      const enabledSet = new Set(enabled);
      const cores = config.cores || {};
      const activeCores = activeId ? (Array.isArray(cores[activeId]) ? cores[activeId] : []) : [];
      const activeTitle = activeId ? (sessions.find((s) => s.id === activeId)?.title || activeId.slice(-8)) : '';

      return h('div', null,
        h('p', { style: hint }, '勾选哪些会话启用「核心区保护」；保护会话的自动压缩只压核心区之外的空隙，永不折叠你选中的核心对话。'),

        h('div', { style: box },
          h('div', { style: { fontWeight: 'bold', marginBottom: '6px' } }, '① 启用保护的会话'),
          sessions.length === 0 ? h('div', { className: 'dim' }, '没有会话') : null,
          sessions.map((s) => h('label', { key: s.id, style: { ...row, justifyContent: 'space-between' } },
            h('span', null,
              h('input', { type: 'checkbox', checked: enabledSet.has(s.id), onChange: () => toggleSession(s.id) }),
              h('span', { style: { marginLeft: '6px' } }, `${s.title || '(无标题)'} `),
              h('span', { style: dim }, `${s.cwd} · ${s.userMessages} 条消息`),
            ),
            h('button', { type: 'button', style: btn, onClick: () => loadMessages(s.id) }, '挑核心对话'),
          )),
        ),

        activeId ? h('div', { style: box },
          h('div', { style: { fontWeight: 'bold', marginBottom: '6px' } }, '② 挑核心对话（勾选消息，点「加入核心区」）'),
          h('div', { style: row },
            h('button', { type: 'button', style: btn, disabled: !picked.length || busy, onClick: addPicked }, `加入核心区（已选 ${picked.length} 条）`),
            h('button', { type: 'button', style: btn, onClick: () => setPicked([]) }, '清空选择'),
            h('button', { type: 'button', style: btn, onClick: () => { setActiveId(''); setMessages([]); } }, '收起'),
          ),
          h('div', { style: { maxHeight: '340px', overflow: 'auto', marginTop: '8px' } },
            messages.map((m) => {
              const on = picked.includes(m.seq);
              const isCompressed = !!m.compressed;
              return h('label', { key: m.seq, style: { ...row, alignItems: 'flex-start' } },
                h('input', { type: 'checkbox', checked: on, onChange: () => setPicked((p) => (on ? p.filter((x) => x !== m.seq) : [...p, m.seq])) }),
                h('span', { style: { fontFamily: 'monospace', minWidth: '56px' } }, `seq ${m.seq}`),
                h('span', { style: { color: isCompressed ? '#aaa' : (m.role === 'user' ? 'var(--dsw-alias-text-primary, #222)' : 'var(--dsw-alias-text-secondary, #666)') } }, `[${m.role === 'user' ? 'user' : 'assistant'}] ${m.preview}`),
                isCompressed ? h('span', { style: { ...dim, color: '#c0392b' } }, '已压缩') : h('span', { style: { ...dim, color: '#1a7f37' } }, '在上下文'),
              );
            }),
          ),
        ) : null,

        h('div', { style: box },
          h('div', { style: { fontWeight: 'bold', marginBottom: '6px' } }, activeId ? `③ 核心区（${activeCores.length} 段）· ${activeTitle}` : '③ 核心区（先点「挑核心对话」选择会话）'),
          activeCores.length === 0 ? h('div', { className: 'dim' }, activeId ? '该会话还没有核心区' : '') : null,
          activeCores.map((r, i) => h('div', { key: i, style: { ...row, justifyContent: 'space-between' } },
            h('span', { style: { fontFamily: 'monospace' } }, `seq ${r[0]} – ${r[1]}`),
            h('button', { type: 'button', style: btn, onClick: () => removeRange(activeId, i) }, '移除'),
          )),
        ),

        msg ? h('div', { style: { ...dim, marginTop: '4px' } }, msg) : null,
      );
    }

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: NS, order: 8, label: () => '压缩保护' },
              Section,
            ),
            'amber: settings section',
          ),
        'amber: settings section',
      );
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    exports.Section = Section;
    return module.exports;
  },
});

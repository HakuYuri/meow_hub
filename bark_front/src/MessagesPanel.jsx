import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Search,
  RefreshCcw,
  ChevronDown,
  Info,
  Trash2,
  RotateCcw,
  CheckSquare,
  Square,
  MinusSquare,
  X,
  CheckCircle,
  XCircle,
  Copy,
  Check,
  KeyRound
} from 'lucide-react';
import { extractCode } from './otp';

const PAGE_SIZE = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ICON = 'https://day.app/assets/images/avatar.jpg';

const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 非安全上下文或旧浏览器的兜底
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
  }
};

function CodeBadge({ code }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (e) => {
    e.stopPropagation();
    await copyText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="mt-2 flex items-center gap-3 bg-blue-50 border border-blue-100 rounded-2xl px-3 py-2 w-fit max-w-full">
      <KeyRound size={16} className="text-blue-500 flex-shrink-0" />
      <span className="text-xs text-blue-500 font-bold">验证码</span>
      <span className="font-mono text-lg font-bold tracking-widest text-slate-800 select-all">{code}</span>
      <button onClick={handleCopy} className={`p-1.5 rounded-lg transition ${copied ? 'text-green-600' : 'text-blue-600 hover:bg-blue-100'}`} title={copied ? '已复制' : '复制验证码'}>
        {copied ? <Check size={18} /> : <Copy size={18} />}
      </button>
    </div>
  );
}

// 消息流（mode="inbox"）与回收站（mode="trash"）共用的列表：服务端搜索、多选、批量操作
export default function MessagesPanel({ apiBase, user, mode, refreshKey, onAuthFail }) {
  const isTrash = mode === 'trash';
  const [messages, setMessages] = useState([]);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [total, setTotal] = useState(0);
  const [retentionDays, setRetentionDays] = useState(30);
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [notice, setNotice] = useState({ type: '', text: '' });

  // 父组件每次渲染都会传入新的回调，用 ref 保存，避免触发重新加载
  const onAuthFailRef = useRef(onAuthFail);
  useEffect(() => { onAuthFailRef.current = onAuthFail; }, [onAuthFail]);

  const post = useCallback(async (path, body) => {
    const res = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: user.token, password: user.password, ...body })
    });
    if (res.status === 401) {
      onAuthFailRef.current();
      throw new Error('unauthorized');
    }
    if (!res.ok) {
      let detail = '操作失败';
      try {
        const data = await res.json();
        if (typeof data.detail === 'string') detail = data.detail;
      } catch { /* 非 JSON 响应 */ }
      throw new Error(detail);
    }
    return res.json();
  }, [apiBase, user]);

  const clearSelection = () => {
    setSelected(new Set());
    setAllMatching(false);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, count] = await Promise.all([
        post('/messages', { limit, q: query, trash: isTrash }),
        post('/messages/count', { q: query, trash: isTrash })
      ]);
      setMessages(list || []);
      setTotal(count.count);
      if (count.retention_days) setRetentionDays(count.retention_days);
    } catch (err) {
      if (err.message !== 'unauthorized') setNotice({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  }, [post, limit, query, isTrash]);

  useEffect(() => { load(); }, [load, refreshKey]);

  // 输入停顿 300ms 后再搜索，并重置分页与选择
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== query) {
        setQuery(searchInput.trim());
        setLimit(PAGE_SIZE);
        clearSelection();
      }
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, query]);

  const loadedIds = messages.map(m => m.id);
  const selectedCount = allMatching ? total : selected.size;
  const allLoadedSelected = loadedIds.length > 0 && loadedIds.every(id => selected.has(id));
  const someSelected = selected.size > 0 && !allLoadedSelected;

  const toggleOne = (id) => {
    setAllMatching(false);
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAllLoaded = () => {
    if (allLoadedSelected || allMatching) clearSelection();
    else setSelected(new Set(loadedIds));
  };

  const exitSelecting = () => {
    setSelecting(false);
    clearSelection();
  };

  const runBatch = async (path, target, describe) => {
    setBusy(true);
    setNotice({ type: '', text: '' });
    try {
      const data = await post(path, target);
      setNotice({ type: 'success', text: describe(data.count) });
      clearSelection();
      await load();
    } catch (err) {
      if (err.message !== 'unauthorized') setNotice({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const selectionTarget = () => (allMatching ? { all_matching: true, q: query } : { ids: [...selected] });
  const scopeText = query ? `全部 ${total} 条匹配「${query}」的消息` : `全部 ${total} 条消息`;

  const deleteToTrash = (target) => {
    if (target.all_matching && !window.confirm(`确定将${scopeText}移到回收站？`)) return;
    runBatch('/messages/delete', target, n => `已将 ${n} 条消息移到回收站，${retentionDays} 天内可恢复`);
  };

  const restore = (target) => {
    runBatch('/messages/restore', target, n => `已恢复 ${n} 条消息`);
  };

  const purge = (target, count) => {
    if (!window.confirm(`确定永久删除${target.all_matching ? scopeText : ` ${count} 条消息`}？此操作无法撤销。`)) return;
    runBatch('/messages/purge', target, n => `已永久删除 ${n} 条消息`);
  };

  const emptyTrash = () => {
    if (!window.confirm(`确定清空回收站？回收站里的全部消息将被永久删除，无法撤销。`)) return;
    runBatch('/messages/purge', { all_matching: true, q: null }, n => `已清空回收站，共永久删除 ${n} 条消息`);
  };

  const daysLeft = (deletedAt) => {
    const left = Math.ceil((new Date(deletedAt).getTime() + retentionDays * DAY_MS - Date.now()) / DAY_MS);
    return Math.max(left, 0);
  };

  const hasMore = messages.length < total;
  const SelectAllIcon = allLoadedSelected || allMatching ? CheckSquare : someSelected ? MinusSquare : Square;

  return (
    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 px-1">
        <span className="text-sm font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
          {isTrash ? 'Trash' : 'Notification Stream'}
          <span className="text-[10px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full normal-case tracking-normal">{total} 条</span>
        </span>
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder={isTrash ? '搜索回收站...' : '搜索消息...'}
            className="w-full pl-10 pr-9 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500 transition shadow-sm"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          {searchInput && (
            <button onClick={() => setSearchInput('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-1" title="清除搜索"><X size={14}/></button>
          )}
        </div>
        <div className="flex items-center gap-1">
          {total > 0 && (
            <button onClick={() => (selecting ? exitSelecting() : setSelecting(true))} className="text-slate-600 p-2 rounded-lg hover:bg-slate-100 transition flex items-center gap-1 text-sm font-bold">
              {selecting ? <><X size={18}/> 完成</> : <><CheckSquare size={18}/> 多选</>}
            </button>
          )}
          {isTrash && total > 0 && !selecting && (
            <button onClick={emptyTrash} disabled={busy} className="text-red-500 p-2 rounded-lg hover:bg-red-50 transition flex items-center gap-1 text-sm font-bold">
              <Trash2 size={18}/> 清空
            </button>
          )}
          <button onClick={load} className="text-blue-600 p-2 rounded-lg hover:bg-blue-50 transition flex items-center gap-1 text-sm font-bold">
            <RefreshCcw size={18} className={loading ? 'animate-spin' : ''} /> 刷新
          </button>
        </div>
      </div>

      {isTrash && (
        <p className="px-1 text-xs text-slate-400 flex items-center gap-1"><Info size={14}/> 回收站中的消息会在删除 {retentionDays} 天后自动彻底删除。</p>
      )}

      {notice.text && (
        <div className={`px-4 py-3 rounded-xl flex items-center gap-2 text-sm border ${notice.type === 'success' ? 'bg-green-50 border-green-100 text-green-700' : 'bg-red-50 border-red-100 text-red-600'}`}>
          {notice.type === 'success' ? <CheckCircle size={16}/> : <XCircle size={16}/>}
          <span className="flex-1">{notice.text}</span>
          <button onClick={() => setNotice({ type: '', text: '' })} className="opacity-60 hover:opacity-100"><X size={14}/></button>
        </div>
      )}

      {selecting && messages.length > 0 && (
        <div className="sticky top-16 z-[5] bg-white/95 backdrop-blur border border-slate-200 rounded-2xl px-4 py-3 shadow-sm space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={toggleAllLoaded} className="flex items-center gap-2 text-sm font-bold text-slate-700">
              <SelectAllIcon size={18} className={selectedCount > 0 ? 'text-blue-600' : 'text-slate-400'} />
              全选{hasMore ? '已加载' : ''}
            </button>
            <span className="text-sm text-slate-500">已选 {selectedCount} 条</span>
            <div className="flex-1" />
            {isTrash ? (
              <>
                <button disabled={busy || selectedCount === 0} onClick={() => restore(selectionTarget())} className="flex items-center gap-1 text-sm font-bold px-3 py-1.5 rounded-lg text-blue-600 hover:bg-blue-50 disabled:opacity-40 transition">
                  <RotateCcw size={16}/> 恢复
                </button>
                <button disabled={busy || selectedCount === 0} onClick={() => purge(selectionTarget(), selectedCount)} className="flex items-center gap-1 text-sm font-bold px-3 py-1.5 rounded-lg text-red-600 hover:bg-red-50 disabled:opacity-40 transition">
                  <Trash2 size={16}/> 永久删除
                </button>
              </>
            ) : (
              <button disabled={busy || selectedCount === 0} onClick={() => deleteToTrash(selectionTarget())} className="flex items-center gap-1 text-sm font-bold px-3 py-1.5 rounded-lg text-red-600 hover:bg-red-50 disabled:opacity-40 transition">
                <Trash2 size={16}/> 删除
              </button>
            )}
          </div>
          {allLoadedSelected && hasMore && !allMatching && (
            <p className="text-xs text-slate-500">
              已选择已加载的 {selected.size} 条。
              <button onClick={() => setAllMatching(true)} className="text-blue-600 font-bold hover:underline ml-1">选择{scopeText}</button>
            </p>
          )}
          {allMatching && (
            <p className="text-xs text-slate-500">
              已选择{scopeText}。
              <button onClick={clearSelection} className="text-blue-600 font-bold hover:underline ml-1">取消选择</button>
            </p>
          )}
        </div>
      )}

      {messages.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-3xl border border-slate-200 text-slate-400">
          {loading ? '加载中...' : query ? '找不到任何猫鸣记录' : isTrash ? '回收站是空的' : '暂无任何消息记录'}
        </div>
      ) : (
        <>
          <div className="space-y-4">
            {messages.map(msg => {
              const checked = allMatching || selected.has(msg.id);
              const code = extractCode(msg.body, msg.title, msg.subtitle);
              return (
                <div
                  key={msg.id}
                  onClick={selecting ? () => toggleOne(msg.id) : undefined}
                  className={`group bg-white p-5 rounded-3xl border shadow-sm flex gap-4 hover:shadow-md transition ${selecting ? 'cursor-pointer select-none' : ''} ${checked && selecting ? 'border-blue-400 ring-2 ring-blue-100' : 'border-slate-200'}`}
                >
                  {selecting && (
                    <div className="pt-2 flex-shrink-0">
                      {checked ? <CheckSquare size={20} className="text-blue-600"/> : <Square size={20} className="text-slate-300"/>}
                    </div>
                  )}
                  <img src={msg.params?.icon || DEFAULT_ICON} className="w-10 h-10 rounded-xl bg-slate-50 flex-shrink-0" onError={e => { e.target.src = DEFAULT_ICON; }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-start mb-1 gap-2">
                      <h4 className="font-bold text-slate-800 truncate">{msg.title || '无标题'}</h4>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <span className="text-[10px] text-slate-400 whitespace-nowrap">{new Date(msg.created_at).toLocaleString()}</span>
                        {!selecting && (isTrash ? (
                          <>
                            <button onClick={() => restore({ ids: [msg.id] })} disabled={busy} className="text-slate-300 hover:text-blue-500 p-1 transition md:opacity-0 md:group-hover:opacity-100" title="恢复"><RotateCcw size={16}/></button>
                            <button onClick={() => purge({ ids: [msg.id] }, 1)} disabled={busy} className="text-slate-300 hover:text-red-500 p-1 transition md:opacity-0 md:group-hover:opacity-100" title="永久删除"><Trash2 size={16}/></button>
                          </>
                        ) : (
                          <button onClick={() => deleteToTrash({ ids: [msg.id] })} disabled={busy} className="text-slate-300 hover:text-red-500 p-1 transition md:opacity-0 md:group-hover:opacity-100" title="删除"><Trash2 size={16}/></button>
                        ))}
                      </div>
                    </div>
                    {msg.subtitle && <p className="text-xs text-slate-500 font-medium mb-1">{msg.subtitle}</p>}
                    <div className="text-sm text-slate-600 leading-relaxed bg-slate-50 p-3 rounded-2xl mt-2 whitespace-pre-wrap break-words">{msg.body}</div>
                    {code && <CodeBadge code={code} />}
                    {isTrash && msg.deleted_at && (
                      <p className="text-[10px] text-slate-400 mt-2">
                        删除于 {new Date(msg.deleted_at).toLocaleString()} · {daysLeft(msg.deleted_at)} 天后彻底删除
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {hasMore && (
            <button onClick={() => setLimit(prev => prev + PAGE_SIZE)} className="w-full mt-6 py-4 flex items-center justify-center gap-2 text-sm font-bold text-slate-500 bg-white border border-slate-200 rounded-3xl hover:bg-slate-50 transition">
              <ChevronDown size={18} /> 加载更多（还有 {total - messages.length} 条）
            </button>
          )}
          {!hasMore && messages.length > 0 && (
            <div className="text-center py-8 text-slate-400 flex items-center justify-center gap-2 text-xs">
              <Info size={14} /> {isTrash ? '没有更多了' : '这里的猫咪只有这么多了'}
            </div>
          )}
        </>
      )}
    </div>
  );
}

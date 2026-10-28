import React, { useState, useEffect } from 'react';
import { 
  Send, 
  ShieldCheck, 
  Key, 
  Server, 
  PlusCircle, 
  Trash2, 
  Copy, 
  LogOut, 
  RefreshCcw,
  MessageSquare,
  Smartphone,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Download,
  Upload,
  Database,
  ChevronDown,
  Info,
  Search,
  Lock,
  ArrowLeft
} from 'lucide-react';

const API_BASE = "https://meowapi.3geeks.top";

export default function App() {
  // --- 状态定义 ---
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem('meow_user'); 
    return saved ? JSON.parse(saved) : null;
  });
  
  const [newRegUser, setNewRegUser] = useState(null);
  const [activeTab, setActiveTab] = useState('messages'); // 默认显示消息页
  const [devices, setDevices] = useState([]);
  const [messages, setMessages] = useState([]);
  const [messageLimit, setMessageLimit] = useState(20); // 分页限制
  const [hasMore, setHasMore] = useState(true); // 是否还有更多消息
  const [newDeviceUrl, setNewDeviceUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [authInput, setAuthInput] = useState({ username: '', password: '', confirmPassword: '' });
  const [authMode, setAuthMode] = useState('login'); // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [loginError, setLoginError] = useState('');
  const [importMode, setImportMode] = useState(null);
  const [copyTip, setCopyTip] = useState(''); // 复制成功提示文本
  const [searchTerm, setSearchTerm] = useState(''); // 搜索关键词
  // 找回密码：null = 不在找回流程，'request' = 输入 Token，'confirm' = 输入验证码与新密码
  const [resetStep, setResetStep] = useState(null);
  const [resetInput, setResetInput] = useState({ username: '', code: '', newPassword: '', confirmPassword: '' });
  const [resetNotice, setResetNotice] = useState('');
  const [pwInput, setPwInput] = useState({ current: '', newPassword: '', confirmPassword: '' });
  const [pwMessage, setPwMessage] = useState({ type: '', text: '' });

  // --- 辅助功能 ---
  const copyToClipboard = (text, type = "") => {
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    
    setCopyTip(type);
    setTimeout(() => setCopyTip(''), 2000);
  };

  // --- API 调用 ---
  
  const handleRegister = async (e) => {
    e.preventDefault();
    const username = authInput.username.trim();
    if (!username || !authInput.password) {
      setLoginError('请填写用户名和密码');
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/.test(username)) {
      setLoginError('用户名需为 3-32 位字母、数字或 _ . -，且以字母或数字开头');
      return;
    }
    const pwError = checkNewPassword(authInput.password, authInput.confirmPassword);
    if (pwError) {
      setLoginError(pwError.replace('新密码', '密码'));
      return;
    }
    setLoading(true);
    setLoginError('');
    try {
      const res = await fetch(`${API_BASE}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: authInput.password })
      });
      if (!res.ok) {
        setLoginError(await readError(res, '注册失败'));
        return;
      }
      const data = await res.json();
      setNewRegUser({ token: data.token, username: data.username, password: authInput.password });
    } catch {
      setLoginError("无法连接到服务器，请确保 Meow 后端已启动");
    } finally {
      setLoading(false);
    }
  };

  const confirmRegistration = () => {
    if (newRegUser) {
      saveUser(newRegUser);
      setNewRegUser(null);
      setAuthInput({ username: '', password: '', confirmPassword: '' });
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!authInput.username.trim() || !authInput.password) {
      setLoginError('请填写完整信息');
      return;
    }
    setLoading(true);
    setLoginError('');
    try {
      const res = await fetch(`${API_BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: authInput.username.trim(), password: authInput.password })
      });
      if (res.ok) {
        const data = await res.json();
        saveUser({ token: data.token, username: data.username, password: authInput.password });
        setAuthInput({ username: '', password: '', confirmPassword: '' });
      } else if (res.status === 401 || res.status === 429) {
        setLoginError(await readError(res, '用户名或密码不正确'));
      } else {
        setLoginError('服务器响应异常');
      }
    } catch {
      setLoginError('网络连接失败，请检查 Meow 服务是否运行');
    } finally {
      setLoading(false);
    }
  };

  const readError = async (res, fallback) => {
    try {
      const data = await res.json();
      return typeof data.detail === 'string' ? data.detail : fallback;
    } catch {
      return fallback;
    }
  };

  const checkNewPassword = (newPassword, confirmPassword) => {
    if (newPassword.length < 8 || newPassword.length > 128) return '新密码长度需为 8-128 位';
    if (newPassword !== confirmPassword) return '两次输入的新密码不一致';
    return '';
  };

  const saveUser = (u) => {
    setUser(u);
    localStorage.setItem('meow_user', JSON.stringify(u));
  };

  const openReset = () => {
    setResetStep('request');
    setResetInput({ username: authInput.username, code: '', newPassword: '', confirmPassword: '' });
    setResetNotice('');
    setLoginError('');
  };

  const closeReset = () => {
    setResetStep(null);
    setResetNotice('');
    setLoginError('');
  };

  const handleResetRequest = async (e) => {
    e?.preventDefault();
    if (!resetInput.username.trim()) {
      setLoginError('请填写用户名');
      return;
    }
    setLoading(true);
    setLoginError('');
    try {
      const res = await fetch(`${API_BASE}/password/reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: resetInput.username.trim() })
      });
      if (!res.ok) {
        setLoginError(await readError(res, '发送验证码失败'));
        return;
      }
      const data = await res.json();
      setResetNotice(data.message);
      setResetStep('confirm');
    } catch {
      setLoginError('网络连接失败，请检查 Meow 服务是否运行');
    } finally {
      setLoading(false);
    }
  };

  const handleResetConfirm = async (e) => {
    e.preventDefault();
    const pwError = checkNewPassword(resetInput.newPassword, resetInput.confirmPassword);
    if (!resetInput.code) return setLoginError('请填写验证码');
    if (pwError) return setLoginError(pwError);
    setLoading(true);
    setLoginError('');
    try {
      const name = resetInput.username.trim();
      const res = await fetch(`${API_BASE}/password/reset/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name, code: resetInput.code.trim(), new_password: resetInput.newPassword })
      });
      if (!res.ok) {
        setLoginError(await readError(res, '重置失败'));
        return;
      }
      // 重置后用新密码登录，换取 token
      const loginRes = await fetch(`${API_BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name, password: resetInput.newPassword })
      });
      closeReset();
      if (loginRes.ok) {
        const data = await loginRes.json();
        saveUser({ token: data.token, username: data.username, password: resetInput.newPassword });
      } else {
        setLoginError('密码已重置，请使用新密码登录');
      }
    } catch {
      setLoginError('网络连接失败，请检查 Meow 服务是否运行');
    } finally {
      setLoading(false);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    const pwError = checkNewPassword(pwInput.newPassword, pwInput.confirmPassword);
    if (!pwInput.current) return setPwMessage({ type: 'error', text: '请填写当前密码' });
    if (pwError) return setPwMessage({ type: 'error', text: pwError });
    setLoading(true);
    setPwMessage({ type: '', text: '' });
    try {
      const res = await fetch(`${API_BASE}/password/change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: user.token, password: pwInput.current, new_password: pwInput.newPassword })
      });
      if (res.status === 401) {
        setPwMessage({ type: 'error', text: '当前密码不正确' });
        return;
      }
      if (!res.ok) {
        setPwMessage({ type: 'error', text: await readError(res, '修改失败') });
        return;
      }
      saveUser({ ...user, password: pwInput.newPassword });
      setPwInput({ current: '', newPassword: '', confirmPassword: '' });
      setPwMessage({ type: 'success', text: '密码已修改' });
    } catch {
      setPwMessage({ type: 'error', text: '网络连接失败，请检查 Meow 服务是否运行' });
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    setUser(null);
    localStorage.removeItem('meow_user');
    setDevices([]);
    setMessages([]);
    setAuthInput({ username: '', password: '', confirmPassword: '' });
    setAuthMode('login');
    setUsername('');
    setSearchTerm('');
    setPwInput({ current: '', newPassword: '', confirmPassword: '' });
    setPwMessage({ type: '', text: '' });
  };

  const fetchDevices = async () => {
    if (!user) return;
    try {
      // 修改为 POST 请求
      const res = await fetch(`${API_BASE}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: user.token, password: user.password })
      });
      if (res.status === 401) return handleLogout();
      const data = await res.json();
      setDevices(data.devices || []);
      setUsername(data.username || '');
    } catch (err) {
      console.error("获取设备失败", err);
    }
  };

  const addDevice = async () => {
    if (!newDeviceUrl) return;
    try {
      // 修改为 POST 请求
      await fetch(`${API_BASE}/config/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: user.token, password: user.password, url: newDeviceUrl })
      });
      setNewDeviceUrl('');
      fetchDevices();
    } catch (err) {
      console.error("添加设备失败", err);
    }
  };

  const deleteDevice = async (id) => {
    try {
      // 修改为 POST 请求
      await fetch(`${API_BASE}/config/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: user.token, password: user.password, device_id: id })
      });
      fetchDevices();
    } catch (err) {
      console.error("删除设备失败", err);
    }
  };

  const fetchMessages = async (limit = messageLimit) => {
    if (!user) return;
    setLoading(true);
    try {
      // 修改为 POST 请求
      const res = await fetch(`${API_BASE}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: user.token, password: user.password, limit: limit })
      });
      if (res.status === 401) return handleLogout();
      const data = await res.json();
      setMessages(data || []);
      if (data.length < limit) {
        setHasMore(false);
      } else {
        setHasMore(true);
      }
    } catch (err) {
      console.error("获取消息失败", err);
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async () => {
    setLoading(true);
    try {
      // 修改为 POST 请求
      const res = await fetch(`${API_BASE}/data/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: user.token, password: user.password })
      });
      if (!res.ok) throw new Error("导出失败");
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `meow_backup_${new Date().getTime()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert("导出失败: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async (event, mode) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const jsonData = JSON.parse(e.target.result);
        setLoading(true);
        // 修改为 POST 请求，传递 token, password, mode 和 data
        const res = await fetch(`${API_BASE}/data/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            token: user.token, 
            password: user.password, 
            mode: mode, 
            data: jsonData 
          })
        });
        if (!res.ok) throw new Error("导入失败");
        alert("数据导入成功！");
        fetchDevices();
        fetchMessages();
        setImportMode(null);
      } catch (err) {
        alert("导入失败: " + err.message);
      } finally {
        setLoading(false);
      }
    };
    reader.readAsText(file);
  };

  const filteredMessages = messages.filter(m => {
    const search = searchTerm.toLowerCase();
    return (
      (m.title?.toLowerCase().includes(search)) ||
      (m.subtitle?.toLowerCase().includes(search)) ||
      (m.body?.toLowerCase().includes(search))
    );
  });

  useEffect(() => {
    if (user) {
      fetchDevices();
      fetchMessages(messageLimit);
    }
  }, [user, messageLimit]);

  if (newRegUser) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-3xl shadow-xl border border-blue-100 p-8">
          <div className="text-center mb-6">
            <div className="bg-green-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckCircle className="text-green-500 w-8 h-8" />
            </div>
            <h1 className="text-2xl font-bold text-slate-800">注册成功</h1>
            <p className="text-slate-500 text-sm mt-2">用户名 <span className="font-bold text-slate-700">{newRegUser.username}</span>，以后用用户名和密码登录</p>
          </div>
          <div className="space-y-4 mb-8">
            <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100 relative">
              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">你的推送 URL</label>
              <div className="flex items-center justify-between gap-2 font-mono text-sm">
                <span className="truncate">{`${API_BASE}/${newRegUser.token}`}</span>
                <button onClick={() => copyToClipboard(`${API_BASE}/${newRegUser.token}`, 'reg-url')} className="text-blue-500 hover:bg-blue-50 p-1 rounded transition relative">
                  <Copy size={16}/>
                  {copyTip === 'reg-url' && <span className="absolute -top-8 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-[10px] px-2 py-1 rounded shadow-lg animate-in fade-in zoom-in duration-200">已复制</span>}
                </button>
              </div>
              <p className="text-xs text-slate-400 mt-2">把它填到 Bark / SMSForwarder 等应用里即可推送；登录后也能随时查看。</p>
            </div>
            <p className="text-xs text-slate-400 flex items-start gap-1"><Info size={14} className="flex-shrink-0 mt-0.5"/>登录后在「设备分发」绑定你的 Bark 地址，忘记密码时验证码会推送到这些设备。</p>
          </div>
          <button onClick={confirmRegistration} className="w-full bg-blue-600 text-white py-4 rounded-2xl font-bold hover:bg-blue-700 transition shadow-lg">进入 Meow</button>
        </div>
      </div>
    );
  }

  const inputClass = "w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none";

  if (!user && resetStep) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-3xl shadow-xl border border-slate-100 p-8">
          <button onClick={closeReset} className="flex items-center gap-1 text-sm text-slate-400 hover:text-slate-600 mb-6"><ArrowLeft size={16}/> 返回登录</button>
          <div className="text-center mb-8">
            <div className="bg-blue-500 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-200">
              <Lock className="text-white w-8 h-8" />
            </div>
            <h1 className="text-2xl font-bold text-slate-800">找回密码</h1>
            <p className="text-slate-500 text-sm mt-1">验证码将推送到该账号已绑定的设备</p>
          </div>
          {loginError && <div className="mb-6 bg-red-50 border border-red-100 text-red-600 px-4 py-3 rounded-xl flex items-center gap-2 text-sm"><XCircle size={16}/>{loginError}</div>}
          {resetStep === 'request' ? (
            <form onSubmit={handleResetRequest} className="space-y-4">
              <input type="text" autoComplete="username" placeholder="用户名（老用户为推送 Token）" className={inputClass} value={resetInput.username} onChange={e => {setResetInput({...resetInput, username: e.target.value}); setLoginError('');}} />
              <button type="submit" disabled={loading} className="w-full bg-slate-900 text-white py-3 rounded-xl font-bold hover:bg-slate-800 transition flex justify-center items-center gap-2">
                {loading && <RefreshCcw size={18} className="animate-spin" />} 发送验证码
              </button>
            </form>
          ) : (
            <form onSubmit={handleResetConfirm} className="space-y-4">
              {resetNotice && <div className="bg-blue-50 border border-blue-100 text-blue-700 px-4 py-3 rounded-xl flex items-center gap-2 text-sm"><Info size={16} className="flex-shrink-0"/>{resetNotice}</div>}
              <input type="text" inputMode="numeric" autoComplete="one-time-code" placeholder="6 位验证码" className={inputClass} value={resetInput.code} onChange={e => {setResetInput({...resetInput, code: e.target.value}); setLoginError('');}} />
              <input type="password" autoComplete="new-password" placeholder="新密码（8-128 位）" className={inputClass} value={resetInput.newPassword} onChange={e => {setResetInput({...resetInput, newPassword: e.target.value}); setLoginError('');}} />
              <input type="password" autoComplete="new-password" placeholder="确认新密码" className={inputClass} value={resetInput.confirmPassword} onChange={e => {setResetInput({...resetInput, confirmPassword: e.target.value}); setLoginError('');}} />
              <button type="submit" disabled={loading} className="w-full bg-slate-900 text-white py-3 rounded-xl font-bold hover:bg-slate-800 transition flex justify-center items-center gap-2">
                {loading && <RefreshCcw size={18} className="animate-spin" />} 重置密码并登录
              </button>
              <button type="button" disabled={loading} onClick={handleResetRequest} className="w-full text-sm text-slate-400 hover:text-slate-600">没收到？重新发送</button>
            </form>
          )}
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-3xl shadow-xl border border-slate-100 p-8">
          <div className="text-center mb-8">
            <div className="bg-blue-500 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-200">
              <Send className="text-white w-8 h-8" />
            </div>
            <h1 className="text-2xl font-bold text-slate-800">Meow</h1>
            <p className="text-slate-500 text-sm mt-1">你的私有通知中转站</p>
          </div>
          {loginError && <div className="mb-6 bg-red-50 border border-red-100 text-red-600 px-4 py-3 rounded-xl flex items-center gap-2 text-sm"><XCircle size={16}/>{loginError}</div>}
          {authMode === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-4">
              <input type="text" autoComplete="username" placeholder="用户名（老用户为推送 Token）" className={inputClass} value={authInput.username} onChange={e => {setAuthInput({...authInput, username: e.target.value}); setLoginError('');}} />
              <input type="password" autoComplete="current-password" placeholder="密码" className={inputClass} value={authInput.password} onChange={e => {setAuthInput({...authInput, password: e.target.value}); setLoginError('');}} />
              <button type="submit" disabled={loading} className="w-full bg-slate-900 text-white py-3 rounded-xl font-bold hover:bg-slate-800 transition flex justify-center items-center gap-2">
                {loading && <RefreshCcw size={18} className="animate-spin" />} {loading ? "正在连接..." : "登录 Meow"}
              </button>
              <button type="button" onClick={openReset} className="w-full text-sm text-slate-400 hover:text-slate-600">忘记密码？</button>
            </form>
          ) : (
            <form onSubmit={handleRegister} className="space-y-4">
              <input type="text" autoComplete="username" placeholder="用户名（3-32 位字母、数字或 _ . -）" className={inputClass} value={authInput.username} onChange={e => {setAuthInput({...authInput, username: e.target.value}); setLoginError('');}} />
              <input type="password" autoComplete="new-password" placeholder="密码（8-128 位）" className={inputClass} value={authInput.password} onChange={e => {setAuthInput({...authInput, password: e.target.value}); setLoginError('');}} />
              <input type="password" autoComplete="new-password" placeholder="确认密码" className={inputClass} value={authInput.confirmPassword} onChange={e => {setAuthInput({...authInput, confirmPassword: e.target.value}); setLoginError('');}} />
              <button type="submit" disabled={loading} className="w-full bg-slate-900 text-white py-3 rounded-xl font-bold hover:bg-slate-800 transition flex justify-center items-center gap-2">
                {loading && <RefreshCcw size={18} className="animate-spin" />} {loading ? "正在注册..." : "注册并加入 Meow"}
              </button>
            </form>
          )}
          <div className="relative my-8"><div className="absolute inset-0 flex items-center"><span className="w-full border-t border-slate-100"></span></div><div className="relative flex justify-center text-xs uppercase"><span className="bg-white px-2 text-slate-400">或者</span></div></div>
          <button onClick={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setLoginError(''); setAuthInput({ ...authInput, password: '', confirmPassword: '' }); }} className="w-full border-2 border-slate-900 text-slate-900 py-3 rounded-xl font-bold hover:bg-slate-50 transition">
            {authMode === 'login' ? '注册新账号' : '已有账号，去登录'}
          </button>
        </div>
      </div>
    );
  }

  const fullMeowUrl = `${API_BASE}/${user.token}`;

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 pb-20">
      <nav className="sticky top-0 z-10 bg-white/80 backdrop-blur-md border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold text-xl"><Send className="text-blue-500 w-6 h-6" /><span>Meow Hub</span></div>
          <div className="flex items-center gap-2">
            {(username || user.username) && <span className="text-sm text-slate-500 truncate max-w-[12rem]" title={username || user.username}>{username || user.username}</span>}
            <button onClick={handleLogout} className="flex items-center gap-2 text-sm font-medium text-red-500 hover:bg-red-50 px-3 py-2 rounded-lg transition"><LogOut size={18} /><span>退出</span></button>
          </div>
        </div>
      </nav>

      <main className="max-w-5xl mx-auto px-4 mt-8">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-10">
          <div className="bg-gradient-to-br from-blue-600 to-blue-700 rounded-3xl p-6 text-white shadow-xl relative">
            <div className="flex justify-between items-center mb-4">
              <span className="text-blue-100 text-sm font-semibold uppercase tracking-wider">Meow 推送接口 URL</span>
              <Key size={20} className="opacity-60" />
            </div>
            <div className="flex items-center gap-3 bg-blue-800/40 p-3 rounded-xl backdrop-blur-sm border border-white/10 relative">
              <code className="text-sm font-mono truncate flex-1">{fullMeowUrl}</code>
              <button onClick={() => copyToClipboard(fullMeowUrl, 'full-url')} className="p-2 hover:bg-white/20 rounded-lg transition relative">
                <Copy size={16}/>
                {copyTip === 'full-url' && <span className="absolute -top-10 left-1/2 -translate-x-1/2 bg-white text-slate-900 text-[10px] px-2 py-1 rounded shadow-lg font-bold">已复制</span>}
              </button>
            </div>
            <p className="text-xs text-blue-100 mt-4 leading-relaxed opacity-80">
              直接在 Meow、Bark、SMSForwarder 中使用此 URL 即可分发消息。
            </p>
          </div>
          <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-sm flex flex-col justify-center">
            <div className="flex justify-between items-center mb-2 text-slate-500"><span className="text-sm font-semibold uppercase tracking-wider">Meow 服务端</span><Server size={20} className="opacity-60" /></div>
            <div className="flex items-center gap-2">
              <span className="text-xl font-mono font-bold text-slate-800">{API_BASE}</span>
            </div>
            <p className="text-xs text-slate-400 mt-2">确保你的设备在同一局域网或内网穿透正常</p>
          </div>
        </div>

        {/* 选项卡 */}
        <div className="flex gap-8 border-b border-slate-200 mb-8 overflow-x-auto whitespace-nowrap">
          <button 
            onClick={() => { if (activeTab === 'messages') fetchMessages(); setActiveTab('messages'); }} 
            className={`pb-4 px-2 text-sm font-bold transition-all flex items-center gap-2 ${activeTab === 'messages' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-slate-400 hover:text-slate-600'}`}
          >
            <MessageSquare size={18} /> 消息流
          </button>
          <button onClick={() => setActiveTab('devices')} className={`pb-4 px-2 text-sm font-bold transition-all flex items-center gap-2 ${activeTab === 'devices' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-slate-400 hover:text-slate-600'}`}>
            <Smartphone size={18} /> 设备分发
          </button>
          <button onClick={() => setActiveTab('data')} className={`pb-4 px-2 text-sm font-bold transition-all flex items-center gap-2 ${activeTab === 'data' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-slate-400 hover:text-slate-600'}`}>
            <Database size={18} /> 数据备份
          </button>
          <button onClick={() => setActiveTab('security')} className={`pb-4 px-2 text-sm font-bold transition-all flex items-center gap-2 ${activeTab === 'security' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-slate-400 hover:text-slate-600'}`}>
            <ShieldCheck size={18} /> 账号安全
          </button>
        </div>

        {/* 内容 */}
        {activeTab === 'messages' && (
          <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 px-1">
              <span className="text-sm font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
                Notification Stream
              </span>
              <div className="relative flex-1 max-w-sm">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input 
                  type="text" 
                  placeholder="搜索消息..."
                  className="w-full pl-10 pr-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500 transition shadow-sm"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              <button onClick={() => fetchMessages()} className="text-blue-600 p-2 rounded-lg hover:bg-blue-50 transition flex items-center gap-1 text-sm font-bold">
                <RefreshCcw size={18} className={loading ? 'animate-spin' : ''} /> 刷新
              </button>
            </div>

            {filteredMessages.length === 0 ? (
              <div className="text-center py-20 bg-white rounded-3xl border border-slate-200 text-slate-400">
                {searchTerm ? "找不到任何猫鸣记录" : "暂无任何消息记录"}
              </div>
            ) : (
              <>
                <div className="space-y-4">
                  {filteredMessages.map(msg => (
                    <div key={msg.id} className="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm flex gap-4 hover:shadow-md transition">
                      <img src={msg.params.icon || 'https://day.app/assets/images/avatar.jpg'} className="w-10 h-10 rounded-xl bg-slate-50 flex-shrink-0" onError={e => e.target.src='https://day.app/assets/images/avatar.jpg'} />
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-start mb-1">
                          <h4 className="font-bold text-slate-800 truncate pr-2">{msg.title || '无标题'}</h4>
                          <span className="text-[10px] text-slate-400 whitespace-nowrap">{new Date(msg.created_at).toLocaleString()}</span>
                        </div>
                        {msg.subtitle && <p className="text-xs text-slate-500 font-medium mb-1">{msg.subtitle}</p>}
                        <div className="text-sm text-slate-600 leading-relaxed bg-slate-50 p-3 rounded-2xl mt-2 whitespace-pre-wrap">{msg.body}</div>
                      </div>
                    </div>
                  ))}
                </div>
                {hasMore && !searchTerm && (
                  <button onClick={() => setMessageLimit(prev => prev + 20)} className="w-full mt-6 py-4 flex items-center justify-center gap-2 text-sm font-bold text-slate-500 bg-white border border-slate-200 rounded-3xl hover:bg-slate-50 transition">
                    <ChevronDown size={18} /> 加载更多消息
                  </button>
                )}
                {!hasMore && !searchTerm && messages.length > 0 && (
                  <div className="text-center py-8 text-slate-400 flex items-center justify-center gap-2 text-xs">
                    <Info size={14} /> 这里的猫咪只有这么多了
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {activeTab === 'devices' && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-sm">
              <h3 className="font-bold mb-4 flex items-center gap-2 text-slate-800"><PlusCircle size={18}/> 绑定下级 Bark 地址</h3>
              <div className="flex gap-3">
                <input type="text" placeholder="https://api.day.app/..." className="flex-1 px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500 transition text-sm" value={newDeviceUrl} onChange={e => setNewDeviceUrl(e.target.value)} />
                <button onClick={addDevice} className="bg-blue-600 text-white px-6 py-2 rounded-xl font-bold hover:bg-blue-700 transition">绑定</button>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4">
              {devices.map(d => (
                <div key={d.id} className="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm flex justify-between items-center group">
                  <div className="min-w-0 pr-4">
                    <p className="text-[10px] bg-slate-100 text-slate-500 w-fit px-2 py-0.5 rounded-full font-bold mb-2 tracking-wide">ID: {d.id}</p>
                    <p className="text-sm font-mono text-slate-600 truncate">{d.url}</p>
                  </div>
                  <button onClick={() => deleteDevice(d.id)} className="text-slate-300 hover:text-red-500 p-2 transition opacity-0 group-hover:opacity-100"><Trash2 size={20}/></button>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'data' && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="bg-white rounded-3xl p-8 border border-slate-200 shadow-sm text-center">
              <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-6"><Database className="text-blue-500 w-8 h-8" /></div>
              <h3 className="text-xl font-bold mb-2 text-slate-800">Meow 数据导出</h3>
              <p className="text-slate-500 text-sm mb-8 leading-relaxed">导出的 JSON 将包含您所有的配置与历史记录。</p>
              <button onClick={handleExport} className="inline-flex items-center gap-2 bg-slate-900 text-white px-10 py-3 rounded-2xl font-bold hover:bg-slate-800 transition"><Download size={20}/> 下载备份 JSON</button>
            </div>
            <div className="bg-white rounded-3xl p-8 border border-slate-200 shadow-sm text-center relative">
              <h3 className="text-xl font-bold mb-6 text-slate-800">从备份恢复</h3>
              {!importMode ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <button onClick={() => setImportMode('append')} className="p-6 rounded-3xl border-2 border-dashed border-slate-200 hover:border-blue-400 hover:bg-blue-50 transition"><PlusCircle className="mx-auto mb-2 text-slate-400" /><p className="font-bold">追加数据</p><p className="text-[10px] text-slate-400">保留现有设置</p></button>
                  <button onClick={() => setImportMode('overwrite')} className="p-6 rounded-3xl border-2 border-dashed border-slate-200 hover:border-red-400 hover:bg-red-50 transition"><RefreshCcw className="mx-auto mb-2 text-slate-400" /><p className="font-bold text-red-600">清空并替换</p><p className="text-[10px] text-slate-400">以备份为准</p></button>
                </div>
              ) : (
                <div>
                  <p className="mb-4 text-sm font-semibold">模式：<span className={importMode === 'append' ? 'text-blue-600 font-bold' : 'text-red-600 font-bold'}>{importMode === 'append' ? '追加数据' : '覆盖原数据'}</span></p>
                  <label className="inline-flex items-center gap-2 bg-blue-600 text-white px-8 py-3 rounded-2xl font-bold cursor-pointer hover:bg-blue-700 transition shadow-lg">
                    <Upload size={20}/> 选择备份文件
                    <input type="file" accept=".json" className="hidden" onChange={(e) => handleImport(e, importMode)} />
                  </label>
                  <button onClick={() => setImportMode(null)} className="block mx-auto mt-4 text-xs text-slate-400 hover:underline">取消导入</button>
                </div>
              )}
            </div>
          </div>
        )}
        {activeTab === 'security' && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="bg-white rounded-3xl p-8 border border-slate-200 shadow-sm max-w-lg">
              <h3 className="text-xl font-bold mb-2 text-slate-800 flex items-center gap-2"><Lock size={20}/> 修改密码</h3>
              <p className="text-slate-500 text-sm mb-6">忘记密码时，可在登录页通过推送到已绑定设备的验证码找回。</p>
              {pwMessage.text && (
                <div className={`mb-4 px-4 py-3 rounded-xl flex items-center gap-2 text-sm border ${pwMessage.type === 'success' ? 'bg-green-50 border-green-100 text-green-700' : 'bg-red-50 border-red-100 text-red-600'}`}>
                  {pwMessage.type === 'success' ? <CheckCircle size={16}/> : <XCircle size={16}/>}{pwMessage.text}
                </div>
              )}
              <form onSubmit={handleChangePassword} className="space-y-4">
                <input type="password" autoComplete="current-password" placeholder="当前密码" className={inputClass} value={pwInput.current} onChange={e => {setPwInput({...pwInput, current: e.target.value}); setPwMessage({ type: '', text: '' });}} />
                <input type="password" autoComplete="new-password" placeholder="新密码（8-128 位）" className={inputClass} value={pwInput.newPassword} onChange={e => {setPwInput({...pwInput, newPassword: e.target.value}); setPwMessage({ type: '', text: '' });}} />
                <input type="password" autoComplete="new-password" placeholder="确认新密码" className={inputClass} value={pwInput.confirmPassword} onChange={e => {setPwInput({...pwInput, confirmPassword: e.target.value}); setPwMessage({ type: '', text: '' });}} />
                <button type="submit" disabled={loading} className="w-full bg-slate-900 text-white py-3 rounded-xl font-bold hover:bg-slate-800 transition flex justify-center items-center gap-2">
                  {loading && <RefreshCcw size={18} className="animate-spin" />} 保存新密码
                </button>
              </form>
              {devices.length === 0 && (
                <p className="mt-4 text-xs text-amber-600 flex items-center gap-1"><AlertTriangle size={14}/> 你还没有绑定任何设备，忘记密码时将无法收到验证码。</p>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
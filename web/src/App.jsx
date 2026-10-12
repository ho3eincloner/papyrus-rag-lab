import { useEffect, useRef, useState } from 'react'
import './App.css'

const suggestions = [
  { text: 'پاپیروس چیست؟', icon: '◈' },
  { text: 'چطور وارد سیستم شوم؟', icon: '⌘' },
  { text: 'چطور یک پروفایل بسازم؟', icon: '◉' },
]
const NAV = [
  ['Chat', '◈', 'گفتگو'],
  ['Knowledge base', '▤', 'پایگاه دانش'],
  ['Search history', '◷', 'تاریخچه‌ی جستجو'],
]
const UNREACHABLE =
  'ارتباط با سرور RAG یا مدل محلی برقرار نشد. مطمئن شوید FastAPI (پورت 8001) و llama.cpp (پورت 8081) در حال اجرا هستند و دوباره تلاش کنید.'

const load = (key) => {
  try {
    const v = JSON.parse(localStorage.getItem(key))
    return Array.isArray(v) ? v : []
  } catch { return [] }
}
const save = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage blocked or full */ }
}
const SAVED_CHAT = load('raglab.chat')

// Persian digits; falls back to the raw value when it is not a number.
const fa = (n, digits = 0) => {
  if (n == null || n === '' || !Number.isFinite(Number(n))) return String(n ?? '—')
  return Number(n).toLocaleString('fa-IR', { useGrouping: false, minimumFractionDigits: digits, maximumFractionDigits: digits })
}

// Remove invisible bidi marks and collapse whitespace so extracted PDF text reads cleanly.
const clean = t => String(t ?? '').replace(/[\u200e\u200f\u202a-\u202e]/g, '').replace(/\s+/g, ' ').trim()

let uid = 0
const nextId = () => `${Date.now().toString(36)}${(++uid).toString(36)}`

function describeError(err) {
  if (err instanceof TypeError || err.empty) return UNREACHABLE
  return err.message || 'مشکلی پیش آمد.'
}

function SourceCard({ source, index, open, flash, onToggle }) {
  const text = clean(source.text)
  const score = Number(source.score)
  const hasScore = Number.isFinite(score)
  const pct = hasScore ? Math.round(Math.max(0, Math.min(1, score)) * 100) : 0
  return (
    <article className={`src-card${open ? ' open' : ''}${flash ? ' flash' : ''}`} data-src={index}>
      <header>
        <span className="src-num">{fa(index + 1)}</span>
        <strong dir="ltr" title={source.source}>{source.source || 'سند'}</strong>
      </header>
      <div className="src-meta">
        <span className="badge">صفحه {fa(source.page)}</span>
        {hasScore && (
          <span className="score" title="میزان شباهت به سؤال">
            <span className="bar"><i style={{ width: `${pct}%` }} /></span>
            {fa(score, 2)}
          </span>
        )}
      </div>
      <p className="src-text" dir="auto">{text || 'متنی برای این بخش برگردانده نشد.'}</p>
      {text.length > 160 && (
        <button className="link-btn" onClick={onToggle}>{open ? 'نمایش کمتر' : 'نمایش بیشتر'}</button>
      )}
    </article>
  )
}

function App() {
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState(SAVED_CHAT)
  const [history, setHistory] = useState(() => load('raglab.history'))
  const [view, setView] = useState('Chat')
  const [loading, setLoading] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [selectedId, setSelectedId] = useState(() => [...SAVED_CHAT].reverse().find(m => m.sources)?.id ?? null)
  const [openIdx, setOpenIdx] = useState(null)
  const [flashIdx, setFlashIdx] = useState(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [copiedId, setCopiedId] = useState(null)
  const abortRef = useRef(null)
  const endRef = useRef(null)
  const inputRef = useRef(null)
  const panelRef = useRef(null)

  const sources = messages.find(m => m.id === selectedId)?.sources ?? []
  const viewLabel = NAV.find(n => n[0] === view)?.[2]

  useEffect(() => { save('raglab.chat', messages.slice(-30)) }, [messages])
  useEffect(() => { save('raglab.history', history) }, [history])

  useEffect(() => {
    if (!loading) return
    const t0 = Date.now()
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [loading])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, loading, view])

  useEffect(() => {
    if (flashIdx == null) return
    panelRef.current?.querySelector(`[data-src="${flashIdx}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    const t = setTimeout(() => setFlashIdx(null), 1600)
    return () => clearTimeout(t)
  }, [flashIdx])

  async function sendMessage(value = question, retryOf = null) {
    const text = value.trim()
    if (!text || loading) return

    const userMsg = { id: nextId(), role: 'user', text }
    setMessages(cur => [
      ...(retryOf ? cur.filter(m => m.id !== retryOf.errId && m.id !== retryOf.userId) : cur),
      userMsg,
    ])
    setHistory(cur => [text, ...cur.filter(q => q !== text)].slice(0, 50))
    setQuestion('')
    if (inputRef.current) inputRef.current.style.height = 'auto'
    setSelectedId(null)
    setOpenIdx(null)
    setElapsed(0)
    setView('Chat')
    setLoading(true)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: text }),
        signal: controller.signal,
      })

      const raw = await response.text()
      let data = null
      try { data = JSON.parse(raw) } catch { /* handled below */ }

      if (!response.ok) {
        const detail = typeof data?.detail === 'string'
          ? data.detail
          : data?.detail ? JSON.stringify(data.detail) : data?.error
        const err = new Error(detail || (raw.trim() ? `خطای API ${response.status}: ${raw.slice(0, 200)}` : ''))
        err.status = response.status
        err.empty = !detail && !raw.trim()
        throw err
      }
      if (typeof data?.answer !== 'string') {
        throw new Error('سرور پاسخ داد، اما در پاسخ آن متنی وجود نداشت.')
      }

      const id = nextId()
      setMessages(cur => [...cur, {
        id,
        role: 'assistant',
        text: data.answer,
        sources: Array.isArray(data.sources) ? data.sources : [],
      }])
      setSelectedId(id)
    } catch (err) {
      if (controller.discarded) return
      if (err.name === 'AbortError') {
        setMessages(cur => [...cur, { id: nextId(), role: 'assistant', cancelled: true, text: 'درخواست متوقف شد.' }])
      } else {
        setMessages(cur => [...cur, {
          id: nextId(),
          role: 'assistant',
          error: describeError(err),
          retry: { text, userId: userMsg.id },
        }])
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null
        setLoading(false)
      }
    }
  }

  function stop() {
    abortRef.current?.abort()
  }

  function newChat() {
    if (abortRef.current) {
      abortRef.current.discarded = true
      abortRef.current.abort()
      abortRef.current = null
    }
    setLoading(false)
    setMessages([])
    setSelectedId(null)
    setOpenIdx(null)
    setQuestion('')
    setPanelOpen(false)
    setView('Chat')
  }

  function selectSource(msgId, i) {
    setSelectedId(msgId)
    setOpenIdx(i)
    setFlashIdx(i)
    setPanelOpen(true)
  }

  async function copy(m) {
    try { await navigator.clipboard.writeText(m.text) } catch { return }
    setCopiedId(m.id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  const last = messages[messages.length - 1]

  return (
    <main className="app-shell" dir="rtl" lang="fa">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">پ</div>
          <div className="brand-text"><strong>پاپیروس</strong><small>دستیار هوشمند آرشیو دیجیتال</small></div>
        </div>
        <button className="new-chat" onClick={newChat}>
          <span className="plus">＋</span><span className="label">گفتگوی جدید</span>
        </button>
        <div className="nav-label">فضای کار</div>
        {NAV.map(([key, icon, label]) => (
          <button key={key} className={`nav-item${view === key ? ' active' : ''}`}
            aria-current={view === key ? 'page' : undefined} onClick={() => setView(key)}>
            <span className="nav-icon">{icon}</span><span className="label">{label}</span>
          </button>
        ))}
        <div className="sidebar-bottom">
          <div className="connection">
            <span className="status-dot" />
            <div><strong>محیط محلی</strong><small>اسناد روی دستگاه شما می‌مانند</small></div>
          </div>
          <div className="profile">
            <div className="avatar">ح</div>
            <div className="profile-text"><strong>فضای کار شخصی</strong><small>نسخه‌ی نمایشی پاپیروس</small></div>
          </div>
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div className="breadcrumb">پاپیروس <span>/</span> <strong>{viewLabel}</strong></div>
          <div className="topbar-right">
            <button className="sources-toggle" onClick={() => setPanelOpen(true)}>
              ◫ منابع{sources.length > 0 && <em>{fa(sources.length)}</em>}
            </button>
            <span className="model-pill"><span className="status-dot" /> مدل محلی</span>
          </div>
        </header>

        <div className="chat-layout">
          <section className="conversation">
            <div className="thread">
              <div className="thread-inner">
                {view === 'Knowledge base' ? (
                  <div className="placeholder">
                    <div className="context-art"><span>▤</span></div>
                    <strong>پایگاه دانش هنوز فعال نیست</strong>
                    <p>این بخش به یک endpoint جداگانه در بک‌اند نیاز دارد. فعلاً از بخش گفتگو استفاده کنید.</p>
                    <button className="ghost-btn" onClick={() => setView('Chat')}>بازگشت به گفتگو</button>
                  </div>
                ) : view === 'Search history' ? (
                  history.length === 0 ? (
                    <div className="placeholder">
                      <div className="context-art"><span>◷</span></div>
                      <strong>هنوز سؤالی نپرسیده‌اید</strong>
                      <p>سؤال‌هایی که می‌پرسید اینجا ذخیره می‌شوند و با یک کلیک دوباره پرسیده می‌شوند.</p>
                      <button className="ghost-btn" onClick={() => setView('Chat')}>رفتن به گفتگو</button>
                    </div>
                  ) : (
                    <div className="history">
                      <div className="history-head">
                        <strong>سؤال‌های اخیر</strong>
                        <button className="ghost-btn" onClick={() => setHistory([])}>پاک کردن همه</button>
                      </div>
                      {history.map(q => (
                        <button key={q} className="history-item" dir="auto" onClick={() => sendMessage(q)}>{q}</button>
                      ))}
                    </div>
                  )
                ) : messages.length === 0 ? (
                  <>
                    <div className="welcome">
                      <span className="brand-pill">◈ دستیار مستندات آرشیو دیجیتال پاپیروس</span>
                      <h1>هر چه درباره‌ی پاپیروس<br /><span>می‌خواهید بدانید، بپرسید.</span></h1>
                      <p>پاسخ‌ها بر پایه‌ی مستندات پاپیروس ساخته می‌شوند و نام سند و شماره‌ی صفحه‌ی منبع کنارشان می‌آید. همه‌چیز روی دستگاه شما پردازش می‌شود.</p>
                    </div>
                    <div className="section-caption">نمونه سؤال‌ها</div>
                    <div className="suggestion-grid">
                      {suggestions.map(s => (
                        <button key={s.text} className="suggestion-card" onClick={() => sendMessage(s.text)}>
                          <span className="suggestion-icon">{s.icon}</span>
                          <span dir="auto">{s.text}</span>
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="messages">
                    {messages.map(m => (
                      <article key={m.id} className={`message ${m.role}${m.cancelled ? ' muted' : ''}`}>
                        <div className="message-avatar">{m.role === 'user' ? 'ح' : 'پ'}</div>
                        <div className="message-body">
                          <small>{m.role === 'user' ? 'شما' : 'دستیار پاپیروس'}</small>
                          {m.error ? (
                            <div className="error-box" role="alert">
                              <span>⚠</span>
                              <div>
                                <p>{m.error}</p>
                                {m === last && !loading && (
                                  <button className="ghost-btn" onClick={() => sendMessage(m.retry.text, { errId: m.id, userId: m.retry.userId })}>↻ تلاش دوباره</button>
                                )}
                              </div>
                            </div>
                          ) : (
                            <p className="msg-text" dir="auto">{m.text}</p>
                          )}
                          {m.role === 'assistant' && !m.error && !m.cancelled && (
                            <div className="msg-actions">
                              <button className="ghost-btn" onClick={() => copy(m)}>{copiedId === m.id ? '✓ کپی شد' : '⧉ کپی'}</button>
                              {m.sources.map((s, i) => (
                                <button key={i} className={`src-chip${m.id === selectedId && openIdx === i ? ' on' : ''}`}
                                  title={`${s.source} · صفحه ${fa(s.page)}`} onClick={() => selectSource(m.id, i)}>
                                  <b>{fa(i + 1)}</b><span dir="ltr">{s.source}</span><em>ص {fa(s.page)}</em>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </article>
                    ))}
                    {loading && (
                      <article className="message assistant">
                        <div className="message-avatar">پ</div>
                        <div className="message-body">
                          <small>دستیار پاپیروس</small>
                          <div className="typing" role="status">
                            <span className="dots"><i /><i /><i /></span>
                            <span>در حال جستجو در اسناد و نوشتن پاسخ… {fa(elapsed)} ثانیه</span>
                            <button className="ghost-btn" onClick={stop}>■ توقف</button>
                          </div>
                        </div>
                      </article>
                    )}
                  </div>
                )}
                <div ref={endRef} />
              </div>
            </div>

            <div className="composer-wrap">
              <form className="composer" onSubmit={e => { e.preventDefault(); sendMessage() }}>
                <textarea
                  ref={inputRef}
                  dir="auto"
                  autoFocus
                  value={question}
                  onChange={e => {
                    setQuestion(e.target.value)
                    e.target.style.height = 'auto'
                    e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      sendMessage()
                    }
                  }}
                  placeholder="هر سؤالی درباره‌ی پاپیروس دارید بپرسید…"
                  rows={1}
                  aria-label="سؤال شما"
                />
                <div className="composer-footer">
                  <div className="composer-hints">
                    <span className="privacy-label">⌑ محلی و خصوصی</span>
                    <span><bdi>Enter</bdi> ارسال · <bdi>Shift+Enter</bdi> خط جدید</span>
                  </div>
                  <button className="send-button" type="submit" aria-label="ارسال" disabled={!question.trim() || loading}>↑</button>
                </div>
              </form>
              <p className="disclaimer">
                هوش مصنوعی ممکن است اشتباه کند؛ جزئیات مهم را با منابع بررسی کنید.<br />
                نسخه‌ی نمایشی بر پایه‌ی مستندات پاپیروس · پروژه‌ی شخصی و غیررسمی
              </p>
            </div>
          </section>

          <aside ref={panelRef} className={`context-panel${panelOpen ? ' open' : ''}`}>
            <div className="context-heading">
              <span>◫</span><strong>منابع پاسخ</strong>
              {sources.length > 0 && !loading && <em className="count">{fa(sources.length)}</em>}
              <button className="panel-close" onClick={() => setPanelOpen(false)} aria-label="بستن منابع">✕</button>
            </div>
            <div className="context-scroll">
              {loading ? (
                [0, 1, 2].map(i => <div key={i} className="skeleton" />)
              ) : sources.length === 0 ? (
                <div className="context-empty">
                  <div className="context-art"><span>▤</span></div>
                  <strong>منابع اینجا نمایش داده می‌شوند</strong>
                  <p>بعد از پرسیدن سؤال، بخش‌هایی از اسناد پاپیروس که پاسخ بر پایه‌ی آن‌هاست در این پنل می‌آید.</p>
                </div>
              ) : (
                sources.map((s, i) => (
                  <SourceCard key={`${s.source}-${s.page}-${i}`} source={s} index={i}
                    open={openIdx === i} flash={flashIdx === i}
                    onToggle={() => setOpenIdx(openIdx === i ? null : i)} />
                ))
              )}
            </div>
            <div className="context-stats">
              <div><span>بازیابی</span><strong>{fa(5)} قطعه‌ی برتر</strong></div>
              <div><span>مدل جاسازی</span><strong dir="ltr">Multilingual E5</strong></div>
            </div>
          </aside>
          {panelOpen && <div className="backdrop" onClick={() => setPanelOpen(false)} />}
        </div>
      </section>
    </main>
  )
}

export default App

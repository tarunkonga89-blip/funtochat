import { useEffect, useRef, useState } from 'react'
import './App.css'
import { supabase } from './lib/supabase'

function App() {
  const [messages, setMessages] = useState([])
  const [text, setText] = useState('')
  const [username, setUsername] = useState(
    () => localStorage.getItem('funtochat_username') || 'Guest'
  )
  const [status, setStatus] = useState(
    supabase ? 'Connecting to Supabase…' : 'Demo mode (Supabase not connected)'
  )
  const bottomRef = useRef(null)

  useEffect(() => {
    localStorage.setItem('funtochat_username', username)
  }, [username])

  useEffect(() => {
    if (!supabase) return

    let channel
    const load = async () => {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .order('created_at', { ascending: true })
        .limit(100)
      if (error) {
        setStatus(`Supabase error: ${error.message}`)
        return
      }
      setMessages(data || [])
      setStatus('Connected to Supabase')
    }

    load()

    channel = supabase
      .channel('public:messages')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          setMessages((prev) => [...prev, payload.new])
        }
      )
      .subscribe()

    return () => {
      if (channel) supabase.removeChannel(channel)
    }
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const send = async (e) => {
    e.preventDefault()
    const content = text.trim()
    if (!content) return

    const msg = {
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      content,
      username: username.trim() || 'Guest',
      created_at: new Date().toISOString(),
    }

    if (!supabase) {
      setMessages((prev) => [...prev, msg])
      setText('')
      return
    }

    const { error } = await supabase.from('messages').insert([
      { content: msg.content, username: msg.username },
    ])
    if (error) {
      setStatus(`Send failed: ${error.message}`)
      return
    }
    setText('')
  }

  return (
    <div className="app">
      <header className="header">
        <h1>FuntoChat</h1>
        <p className="status">{status}</p>
      </header>

      <div className="profile">
        <label>
          Name
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Your name"
            maxLength={30}
          />
        </label>
      </div>

      <main className="chat">
        <ul className="messages">
          {messages.length === 0 && (
            <li className="empty">No messages yet. Say hi!</li>
          )}
          {messages.map((m) => (
            <li key={m.id} className="message">
              <span className="meta">
                <strong>{m.username || 'Guest'}</strong>
                {m.created_at && (
                  <time>{new Date(m.created_at).toLocaleTimeString()}</time>
                )}
              </span>
              <span className="content">{m.content}</span>
            </li>
          ))}
          <div ref={bottomRef} />
        </ul>

        <form className="composer" onSubmit={send}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a message…"
            aria-label="Message"
          />
          <button type="submit">Send</button>
        </form>
      </main>

      <footer className="footer">
        <small>
          Basic chatbox platform. Configure Supabase via <code>.env</code> to
          enable realtime messages.
        </small>
      </footer>
    </div>
  )
}

export default App

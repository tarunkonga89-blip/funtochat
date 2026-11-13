/* ============================================================
   PingMe — live backend layer
   ------------------------------------------------------------
   Turns the single-file demo into a real app:
     • Supabase Auth (email/password, Google, password reset)
     • profile editing + avatar upload
     • "Find people" search, follow, message requests
     • live conversations + messages over Realtime
     • typing indicators and presence
     • read receipts (seen) from conversation_members.last_read_at
     • media uploads to the private `media` bucket
     • GIFs (GIPHY via Edge Function), stickers, memes
     • edit (15 min), delete for me, unsend for everyone, forward
     • PingBot AI chat (Edge Function → Google Gemini free tier)

   The demo engine in index.html stays untouched: when a session
   exists we override the Store methods in place, so all rendering
   keeps working exactly as before.
   ============================================================ */

import { createClient } from '@supabase/supabase-js';

const env = import.meta.env || {};
const SUPABASE_URL = env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = env.VITE_SUPABASE_ANON_KEY;

const F = window.PingMe;
if (!F) throw new Error('PingMe hooks missing — check index.html');

const { Store, UI, Runtime, Bot, BOT_ID, $, toast, esc, initials, renderAll } = F;
const isBot = (convId) => convId === BOT_ID;

const PALETTE = ['#7C3AED', '#EC4899', '#F59E0B', '#10B981', '#0EA5E9', '#6366F1', '#F43F5E', '#14B8A6'];
const MAX_UPLOAD = 50 * 1024 * 1024;   // 50 MB
const SIGNED_TTL = 60 * 60 * 24 * 7;   // 1 week
const MODE_KEY = 'pingme.mode';

const Live = {
  sb: null,
  user: null,
  profile: null,
  members: new Map(),   // convId -> [{ user_id, profile, last_read_at }]
  media: new Map(),     // storage path -> signed url
  msgConv: new Map(),   // messageId -> convId
  online: new Set(),
  dbChannel: null,
  presence: null,
  lastTypingSent: 0,
  lastTypingIn: {},
  booted: false,
  busy: false,
};

const uuid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  }));

function colorFor(id = '') {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 100000;
  return PALETTE[h % PALETTE.length];
}

const displayName = (p) => (p && (p.display_name || p.username)) || 'Someone';
const handle = (p) => (p && p.username ? '@' + p.username : '');

function seenLabel(iso) {
  if (!iso) return 'Offline';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 2) return 'Active now';
  if (mins < 60) return 'Active ' + mins + 'm ago';
  if (mins < 1440) return 'Active ' + Math.floor(mins / 60) + 'h ago';
  return 'Active ' + new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/* ------------------------------------------------------------
   AUTH UI helpers
   ------------------------------------------------------------ */
function setAuthMsg(text, ok = false) {
  const el = $('#authMsg');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('ok', !!ok);
}

function showAuth(view = 'login') {
  const screen = $('#authScreen');
  if (!screen) return;
  screen.hidden = false;
  setAuthView(view);
  setAuthMsg('');
}

function hideAuth() {
  const screen = $('#authScreen');
  if (screen) screen.hidden = true;
}

function setAuthView(view) {
  const login = $('#loginForm');
  const signup = $('#signupForm');
  const reset = $('#resetForm');
  if (!login || !signup || !reset) return;
  login.classList.toggle('hidden', view !== 'login');
  signup.classList.toggle('hidden', view !== 'signup');
  reset.classList.toggle('hidden', view !== 'reset');
  $('#tabLogin').classList.toggle('active', view === 'login');
  $('#tabSignup').classList.toggle('active', view === 'signup');
  $('#tabLogin').setAttribute('aria-selected', String(view === 'login'));
  $('#tabSignup').setAttribute('aria-selected', String(view === 'signup'));
  $('#forgotBtn').classList.toggle('hidden', view === 'reset');
  setAuthMsg('');
}

function busy(btn, on, label) {
  if (!btn) return;
  btn.disabled = !!on;
  if (on) {
    btn.dataset.label = btn.textContent;
    btn.textContent = label || 'One moment…';
  } else if (btn.dataset.label) {
    btn.textContent = btn.dataset.label;
  }
}

/* ------------------------------------------------------------
   Boot
   ------------------------------------------------------------ */
async function boot() {
  const app = document.getElementById('app');
  // Hide the demo shell while we work out whether a real session exists,
  // so signed-in users never see fake chats flash by.
  if (app) app.style.visibility = 'hidden';

  const reveal = () => { if (app) app.style.visibility = ''; };

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn('PingMe: no Supabase env vars — running in demo mode only.');
    reveal();
    return;
  }

  Runtime.hasBackend = true;
  Live.sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  window.__PingMeLive = Live;   // handy while developing

  wireAuthUI();

  const { data: { session } } = await Live.sb.auth.getSession();

  if (session && session.user) {
    await enterLive(session.user);
    reveal();
  } else if (sessionStorage.getItem(MODE_KEY) === 'demo') {
    applyDemoFooter();
    reveal();
  } else {
    reveal();
    showAuth('login');
  }

  Live.sb.auth.onAuthStateChange(async (event, next) => {
    if (event === 'PASSWORD_RECOVERY') {
      showAuth('reset');
      enterRecoveryMode();
      return;
    }
    if (event === 'SIGNED_IN' && next && next.user && !Live.booted) {
      await enterLive(next.user);
    }
    if (event === 'SIGNED_OUT') {
      Live.booted = false;
      Live.user = null;
      Live.profile = null;
      location.reload();
    }
  });
}

/* ------------------------------------------------------------
   Auth actions
   ------------------------------------------------------------ */
function wireAuthUI() {
  $('#tabLogin').addEventListener('click', () => setAuthView('login'));
  $('#tabSignup').addEventListener('click', () => setAuthView('signup'));
  $('#forgotBtn').addEventListener('click', () => setAuthView('reset'));

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#loginEmail').value.trim();
    const password = $('#loginPassword').value;
    if (!email || !password) return setAuthMsg('Enter your email and password.');
    const btn = $('#loginSubmit');
    busy(btn, true, 'Logging in…');
    const { error } = await Live.sb.auth.signInWithPassword({ email, password });
    busy(btn, false);
    if (error) setAuthMsg(error.message);
  });

  $('#signupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#signupUsername').value.trim().toLowerCase();
    const name = $('#signupName').value.trim();
    const email = $('#signupEmail').value.trim();
    const password = $('#signupPassword').value;

    if (!/^[a-z0-9_]{3,20}$/.test(username)) {
      return setAuthMsg('Username: 3–20 letters, numbers or underscores.');
    }
    if (!name) return setAuthMsg('Add a display name.');
    if (password.length < 8) return setAuthMsg('Password needs at least 8 characters.');

    const btn = $('#signupSubmit');
    busy(btn, true, 'Creating account…');
    const { data, error } = await Live.sb.auth.signUp({
      email,
      password,
      options: {
        data: { username, display_name: name },
        emailRedirectTo: location.origin,
      },
    });
    busy(btn, false);

    if (error) {
      setAuthMsg(/already|duplicate/i.test(error.message)
        ? 'That email or username is already taken.'
        : error.message);
      return;
    }
    if (data && data.session) return;            // onAuthStateChange takes over
    setAuthMsg('Check your email to confirm your account ✉️', true);
  });

  $('#resetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#resetSubmit');

    if ($('#newPassLabel').classList.contains('hidden') === false) {
      const pw = $('#newPassword').value;
      if (pw.length < 8) return setAuthMsg('Use at least 8 characters.');
      busy(btn, true, 'Saving…');
      const { error } = await Live.sb.auth.updateUser({ password: pw });
      busy(btn, false);
      if (error) return setAuthMsg(error.message);
      setAuthMsg('Password updated. You are signed in ✅', true);
      hideAuth();
      return;
    }

    const email = $('#resetEmail').value.trim();
    if (!email) return setAuthMsg('Enter your email first.');
    busy(btn, true, 'Sending…');
    const { error } = await Live.sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
    busy(btn, false);
    if (error) return setAuthMsg(error.message);
    setAuthMsg('Reset link sent — check your inbox ✉️', true);
  });

  $('#googleBtn').addEventListener('click', async () => {
    const { error } = await Live.sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin },
    });
    if (error) setAuthMsg(error.message || 'Google sign-in is not configured yet.');
  });

  $('#demoBtn').addEventListener('click', () => {
    sessionStorage.setItem(MODE_KEY, 'demo');
    hideAuth();
    applyDemoFooter();
    toast('Demo mode — messages stay on this device 👋');
  });

  $('#accountBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAccountMenu();
  });

  $('#menuProfile').addEventListener('click', () => { closeAccountMenu(); openProfile(); });
  $('#menuPeople').addEventListener('click', () => { closeAccountMenu(); openPeople(); });
  $('#menuSignIn').addEventListener('click', () => { closeAccountMenu(); showAuth('login'); });
  $('#menuSignOut').addEventListener('click', logout);

  $('#closeProfile').addEventListener('click', () => $('#profileModal').classList.add('hidden'));
  $('#profileModal').addEventListener('click', (e) => { if (e.target.id === 'profileModal') $('#profileModal').classList.add('hidden'); });
  $('#profileForm').addEventListener('submit', saveProfile);

  $('#avatarPickBtn').addEventListener('click', () => $('#avatarInput').click());
  $('#avatarInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) uploadAvatar(file);
  });

  $('#peopleBtn').addEventListener('click', openPeople);
  $('#closePeople').addEventListener('click', () => $('#peopleModal').classList.add('hidden'));
  $('#peopleModal').addEventListener('click', (e) => { if (e.target.id === 'peopleModal') $('#peopleModal').classList.add('hidden'); });
  $('#peopleSearch').addEventListener('input', debounce(() => searchPeople($('#peopleSearch').value), 320));

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#accountMenu') && !e.target.closest('#accountBtn')) closeAccountMenu();
  });
}

function enterRecoveryMode() {
  $('#newPassLabel').classList.remove('hidden');
  $('#resetEmail').closest('label').classList.add('hidden');
  $('#resetSubmit').textContent = 'Save new password';
  setAuthMsg('Choose a new password for your account.');
}

async function logout() {
  closeAccountMenu();
  sessionStorage.removeItem(MODE_KEY);
  // never leave a previous real account's chats in the demo cache
  try { localStorage.removeItem('pingme.demo.v1'); } catch { /* ignore */ }
  await Live.sb.auth.signOut();
}

/* ------------------------------------------------------------
   Account menu + footer
   ------------------------------------------------------------ */
function toggleAccountMenu() {
  const menu = $('#accountMenu');
  const open = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !open);
  $('#accountBtn').setAttribute('aria-expanded', String(open));
  if (open) {
    $('#menuSignIn').classList.toggle('hidden', !!Live.user);
    $('#menuSignOut').classList.toggle('hidden', !Live.user);
    $('#menuProfile').classList.toggle('hidden', !Live.user);
    $('#menuPeople').classList.toggle('hidden', !Live.user);
  }
}

function closeAccountMenu() {
  $('#accountMenu').classList.add('hidden');
  $('#accountBtn').setAttribute('aria-expanded', 'false');
}

function paintMe(profile) {
  const name = profile ? displayName(profile) : ((Store.state.me && Store.state.me.name) || 'You');
  const avatar = $('#meAvatar');
  const sub = profile
    ? (profile.status === 'online' ? 'Online' : profile.status === 'busy' ? 'Busy' : 'Away')
    : 'Demo mode';

  $('#meName').textContent = name;
  $('#meSub').textContent = sub;
  $('#menuName').textContent = name;
  $('#menuHandle').textContent = handle(profile) || 'demo';

  avatar.textContent = '';
  avatar.style.background = profile && profile.avatar_url
    ? 'url(' + profile.avatar_url + ') center/cover'
    : 'linear-gradient(135deg, #7C3AED, #EC4899)';
  if (!profile || !profile.avatar_url) avatar.textContent = initials(name);
  avatar.appendChild(makeDot(profile && profile.status === 'online'));
}

function makeDot(online) {
  const dot = document.createElement('span');
  dot.className = 'dot';
  if (!online) dot.style.background = '#9CA3AF';
  return dot;
}

function applyDemoFooter() {
  paintMe(null);
}

/* ------------------------------------------------------------
   Live mode
   ------------------------------------------------------------ */
async function enterLive(user) {
  if (Live.busy) return;
  Live.busy = true;
  Live.user = user;
  Runtime.mode = 'live';
  Runtime.demoReplies = false;
  sessionStorage.setItem(MODE_KEY, 'live');

  try {
    hideAuth();
    const hint = document.querySelector('#chatEmpty p');
    if (hint) {
      hint.innerHTML = 'Pick a chat on the left, or find someone new.<br />Your messages are synced across devices.';
    }
    await loadProfile();
    await loadWorkspace();
    installLiveStore();
    subscribeDb();
    joinPresence();
    wireTyping();
    setupCalls();
    Live.booted = true;
    renderAll();
  } catch (err) {
    console.error('PingMe live boot failed', err);
    toast('Could not load your chats — please retry.');
    showAuth('login');
  } finally {
    Live.busy = false;
  }
}

async function loadProfile() {
  const { data, error } = await Live.sb
    .from('profiles')
    .select('*')
    .eq('id', Live.user.id)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    // Trigger should have created this; make one if it did not.
    const fallback = {
      id: Live.user.id,
      username: (Live.user.email || 'user').split('@')[0].replace(/[^a-z0-9_]/gi, '').toLowerCase().slice(0, 16) || 'user',
      display_name: Live.user.email || 'Friend',
    };
    const ins = await Live.sb.from('profiles').insert(fallback).select().single();
    Live.profile = ins.data || fallback;
  } else {
    Live.profile = data;
  }

  Store.state.me = { name: displayName(Live.profile), username: Live.profile.username };
  paintMe(Live.profile);
}

async function loadWorkspace() {
  const me = Live.user.id;

  const { data: mine, error } = await Live.sb
    .from('conversation_members')
    .select('conversation_id, pinned, muted, archived, last_read_at, conversations(id, kind, updated_at)')
    .eq('user_id', me);

  if (error) throw error;

  const convIds = (mine || []).map((r) => r.conversation_id);
  Live.members.clear();

  if (!convIds.length) {
    Store.state.conversations = [];
    Bot.attach('pingme.bot.' + me);
    if (Store.state.openId !== BOT_ID) Store.state.openId = null;
    renderAll();
    return;
  }

  const { data: allMembers } = await Live.sb
    .from('conversation_members')
    .select('conversation_id, user_id, last_read_at')
    .in('conversation_id', convIds);

  const userIds = Array.from(new Set((allMembers || []).map((m) => m.user_id)));
  const { data: profiles } = await Live.sb
    .from('profiles')
    .select('id, username, display_name, avatar_url, bio, status, last_seen')
    .in('id', userIds);

  const byId = new Map((profiles || []).map((p) => [p.id, p]));

  (allMembers || []).forEach((m) => {
    if (!Live.members.has(m.conversation_id)) Live.members.set(m.conversation_id, []);
    Live.members.get(m.conversation_id).push({ ...m, profile: byId.get(m.user_id) || null });
  });

  // newest 600 messages (then oldest → newest for display), minus "deleted for me"
  const [{ data: rows }, { data: hidden }] = await Promise.all([
    Live.sb
      .from('messages')
      .select('*')
      .in('conversation_id', convIds)
      .order('created_at', { ascending: false })
      .limit(600),
    Live.sb.from('message_deletions').select('message_id').eq('user_id', me),
  ]);

  const hiddenIds = new Set((hidden || []).map((r) => r.message_id));
  const messages = (rows || []).filter((m) => !hiddenIds.has(m.id)).reverse();
  const byMsg = new Map(messages.map((m) => [m.id, m]));

  const { data: reactionRows } = messages.length
    ? await Live.sb.from('message_reactions').select('message_id, user_id, emoji').in('message_id', messages.map((m) => m.id))
    : { data: [] };

  await signMedia(messages.map((m) => m.media_url).filter(isPath));

  const grouped = new Map(convIds.map((id) => [id, []]));
  messages.forEach((m) => {
    const list = grouped.get(m.conversation_id);
    if (list) list.push(toUIMsg(m, byMsg, reactionRows || []));
  });

  Store.state.conversations = (mine || []).map((row) => {
    const others = (Live.members.get(row.conversation_id) || []).filter((m) => m.user_id !== me);
    const other = others[0] || {};
    const prof = other.profile;
    const list = grouped.get(row.conversation_id) || [];

    Live.msgConv.forEach((v, k) => { if (v === row.conversation_id) Live.msgConv.delete(k); });
    list.forEach((m) => Live.msgConv.set(m.id, row.conversation_id));

    const readUpTo = others.reduce((max, m) => Math.max(max, new Date(m.last_read_at || 0).getTime()), 0);
    list.forEach((m) => {
      if (m.from !== 'me') return;
      m.status = new Date(m.time).getTime() <= readUpTo ? 'seen' : (m.status === 'sending' ? 'sending' : 'sent');
    });

    // keep locally-known reactions we already toggled
    const prev = Store.get(row.conversation_id);
    if (prev) {
      const prevById = new Map(prev.messages.map((m) => [m.id, m]));
      list.forEach((m) => {
        const old = prevById.get(m.id);
        if (old && old._mine) m._mine = old._mine;
      });
    }

    return {
      id: row.conversation_id,
      name: displayName(prof),
      username: prof ? prof.username : '',
      avatarUrl: (prof && prof.avatar_url) || '',
      color: colorFor(other.user_id || row.conversation_id),
      online: Live.online.has(other.user_id),
      lastSeen: seenLabel(prof && prof.last_seen),
      pinned: !!row.pinned,
      muted: !!row.muted,
      archived: !!row.archived,
      blocked: false,
      unread: 0,
      about: (prof && prof.bio) || '',
      otherId: other.user_id || null,
      messages: list,
    };
  });

  Bot.attach('pingme.bot.' + me);
  if (Store.state.openId && !Store.get(Store.state.openId)) Store.state.openId = null;
  renderAll();
}

function isPath(value) {
  return typeof value === 'string' && value.length > 0 && !/^https?:/i.test(value);
}

async function signMedia(paths) {
  const todo = Array.from(new Set((paths || []).filter((p) => isPath(p) && !Live.media.has(p))));
  if (!todo.length) return;
  const { data, error } = await Live.sb.storage.from('media').createSignedUrls(todo, SIGNED_TTL);
  if (error) {
    console.warn('PingMe: could not sign media', error.message);
    return;
  }
  (data || []).forEach((row) => {
    if (row && row.path && row.signedUrl) Live.media.set(row.path, row.signedUrl);
  });
}

function mediaUrl(pathOrUrl) {
  if (!pathOrUrl) return '';
  if (!isPath(pathOrUrl)) return pathOrUrl;
  return Live.media.get(pathOrUrl) || '';
}

function toUIMsg(row, byMsg, reactionRows) {
  const mine = row.sender_id === Live.user.id;
  const type = row.type;
  const meta = row.media_meta || {};

  const msg = {
    id: row.id,
    from: mine ? 'me' : 'them',
    type: 'text',
    time: row.created_at,
    text: row.deleted_for_all ? 'This message was deleted' : (row.content || ''),
    reactions: {},
    status: mine ? 'sent' : undefined,
    _deleted: !!row.deleted_for_all,
    _path: isPath(row.media_url) ? row.media_url : '',
    edited: !!row.edited_at,
    forwarded: !!meta.forwarded,
  };

  if (type === 'sticker' && !row.media_url) {
    msg.type = 'sticker';
    msg.sticker = row.content || '🙂';
    msg.text = '';
  } else if (type === 'photo' || type === 'gif' || type === 'meme' || type === 'sticker') {
    msg.type = 'image';
    msg.image = mediaUrl(row.media_url);
    msg.gif = type === 'gif';
    msg.meme = type === 'meme';
    if (msg.gif) msg.gifMeta = { width: meta.width || 0, height: meta.height || 0, title: meta.title || '' };
  } else if (type === 'voice') {
    msg.type = 'voice';
    msg.audio = mediaUrl(row.media_url);
    msg.duration = meta.duration || 0;
  } else if (type === 'video') {
    msg.type = 'video';
    msg.video = mediaUrl(row.media_url);
    msg.duration = meta.duration || 0;
    msg.file = { name: meta.name || 'Video', size: meta.size || 0 };
  } else if (type === 'file') {
    msg.type = 'file';
    msg.file = { name: meta.name || (type === 'video' ? 'Video' : type === 'voice' ? 'Voice note' : 'File'), size: meta.size || 0 };
    msg.mediaUrl = mediaUrl(row.media_url);
    msg._kind = type;
  }

  if (row.reply_to) {
    const parent = byMsg.get(row.reply_to);
    msg.replyTo = {
      name: parent ? (parent.sender_id === Live.user.id ? 'You' : 'Message') : 'Message',
      text: parent ? (parent.content || parent.type) : 'Earlier message',
      from: parent && parent.sender_id === Live.user.id ? 'me' : 'them',
    };
  }

  (reactionRows || []).forEach((r) => {
    if (r.message_id !== row.id) return;
    msg.reactions[r.emoji] = (msg.reactions[r.emoji] || 0) + 1;
  });

  return msg;
}

/* ------------------------------------------------------------
   Live Store overrides
   ------------------------------------------------------------ */
function installLiveStore() {
  const local = F.local;

  // PingBot is AI-only and lives on this device — no database
  Bot.ask = askBot;
  UI.gifProvider = searchGifs;
  if (UI.gifOpen && F.renderGifPanel) F.renderGifPanel();

  Store.open = function (id) {
    if (isBot(id)) return local.open.call(this, id);
    const conv = this.get(id);
    if (!conv) return;
    this.state.openId = id;
    conv.unread = 0;
    this.emit();
    markRead(id);
  };

  Store.send = function (convId, payload) {
    if (isBot(convId)) return local.send.call(this, convId, payload);
    const conv = this.get(convId);
    if (!conv) return null;

    const id = uuid();
    const msg = {
      id,
      from: 'me',
      type: 'text',
      time: new Date().toISOString(),
      reactions: {},
      status: 'sending',
      ...payload,
      _new: true,
    };

    conv.messages.push(msg);
    conv.unread = 0;
    this.emit();

    persistMessage(convId, msg);
    return msg;
  };

  Store.setStatus = function (convId, msgId, status) {
    const conv = this.get(convId);
    const msg = conv && conv.messages.find((m) => m.id === msgId);
    if (!msg) return;
    msg.status = status;
    this.emit();
  };

  Store.markMineSeen = function (convId) {
    if (isBot(convId)) return local.markMineSeen.call(this, convId);
    markRead(convId);
  };

  Store.react = function (convId, msgId, emoji) {
    if (isBot(convId)) return local.react.call(this, convId, msgId, emoji);
    const conv = this.get(convId);
    if (!conv) return;
    const msg = conv.messages.find((m) => m.id === msgId);
    if (!msg) return;

    msg.reactions = msg.reactions || {};
    const mine = msg._mine || (msg._mine = new Set());
    const has = mine.has(emoji);

    // optimistic
    if (has) {
      mine.delete(emoji);
      msg.reactions[emoji] = (msg.reactions[emoji] || 1) - 1;
      if (msg.reactions[emoji] <= 0) delete msg.reactions[emoji];
    } else {
      mine.add(emoji);
      msg.reactions[emoji] = (msg.reactions[emoji] || 0) + 1;
    }
    this.emit();

    const q = Live.sb.from('message_reactions');
    const run = has
      ? q.delete().eq('message_id', msgId).eq('user_id', Live.user.id).eq('emoji', emoji)
      : q.insert({ message_id: msgId, user_id: Live.user.id, emoji });

    run.then(({ error }) => { if (error) toast('Could not save that reaction'); });
  };

  Store.toggleMute = function (convId) {
    if (isBot(convId)) return local.toggleMute.call(this, convId);
    const conv = this.get(convId);
    if (!conv) return;
    conv.muted = !conv.muted;
    this.emit();
    Live.sb.from('conversation_members')
      .update({ muted: conv.muted })
      .eq('conversation_id', convId)
      .eq('user_id', Live.user.id)
      .then(() => {});
  };

  Store.toggleBlock = function (convId) {
    if (isBot(convId)) return;
    const conv = this.get(convId);
    if (!conv || !conv.otherId) return;
    conv.blocked = !conv.blocked;
    this.emit();

    const run = conv.blocked
      ? Live.sb.from('blocks').insert({ blocker_id: Live.user.id, blocked_id: conv.otherId })
      : Live.sb.from('blocks').delete().eq('blocker_id', Live.user.id).eq('blocked_id', conv.otherId);

    run.then(({ error }) => {
      if (!error) return;
      conv.blocked = !conv.blocked;
      Store.emit();
      toast('Could not update the block');
    });
  };

  Store.editMessage = function (convId, msgId, text) {
    if (isBot(convId)) return local.editMessage.call(this, convId, msgId, text);
    const msg = this.findMsg(convId, msgId);
    if (!msg || msg.from !== 'me') return false;
    const before = { text: msg.text, edited: msg.edited };
    msg.text = text;
    msg.edited = true;
    this.emit();

    Live.sb.from('messages')
      .update({ content: text, edited_at: new Date().toISOString() })
      .eq('id', msgId)
      .eq('sender_id', Live.user.id)
      .select('id')
      .then(({ data, error }) => {
        if (!error && data && data.length) return;
        msg.text = before.text;
        msg.edited = before.edited;
        Store.emit();
        toast('Could not edit that message');
      });
    return true;
  };

  Store.deleteForMe = function (convId, msgId) {
    if (isBot(convId)) return local.deleteForMe.call(this, convId, msgId);
    const conv = this.get(convId);
    if (!conv) return;
    const idx = conv.messages.findIndex((m) => m.id === msgId);
    if (idx < 0) return;
    const [removed] = conv.messages.splice(idx, 1);
    this.emit();
    if (removed.status === 'failed' || removed.status === 'sending') return; // never reached the server

    Live.sb.from('message_deletions')
      .insert({ message_id: msgId, user_id: Live.user.id })
      .then(({ error }) => {
        if (!error || /duplicate/i.test(error.message)) return;
        conv.messages.splice(Math.min(idx, conv.messages.length), 0, removed);
        Store.emit();
        toast('Could not delete that message');
      });
  };

  Store.deleteForAll = function (convId, msgId) {
    if (isBot(convId)) return local.deleteForAll.call(this, convId, msgId);
    const conv = this.get(convId);
    if (!conv) return;
    const idx = conv.messages.findIndex((m) => m.id === msgId);
    if (idx < 0 || conv.messages[idx].from !== 'me') return;
    const [removed] = conv.messages.splice(idx, 1);
    this.emit();
    if (removed.status === 'failed') return;

    Live.sb.from('messages')
      .delete()
      .eq('id', msgId)
      .eq('sender_id', Live.user.id)
      .select('id')
      .then(({ data, error }) => {
        if (!error && data && data.length) {
          Live.msgConv.delete(msgId);
          if (removed._path) Live.sb.storage.from('media').remove([removed._path]).then(() => {});
          return;
        }
        conv.messages.splice(Math.min(idx, conv.messages.length), 0, removed);
        Store.emit();
        toast('Could not unsend that message');
      });
  };

  // In live mode "New message" opens Find people instead of the demo contacts.
  const btn = $('#newChatBtn');
  if (btn) {
    const clone = btn.cloneNode(true);
    btn.replaceWith(clone);
    clone.addEventListener('click', openPeople);
  }
}

async function persistMessage(convId, msg) {
  try {
    let media_path = null;
    let meta = {};
    let dbType = 'text';
    let content = msg.text || null;
    const raw = msg._raw || null;

    if (msg.type === 'sticker') {
      dbType = 'sticker';
      content = msg.sticker || '🙂';
    } else if (msg.type === 'image' && msg.gif) {
      // GIPHY GIFs are already hosted — store the URL, upload nothing
      dbType = 'gif';
      media_path = msg.image;
      meta = { provider: 'giphy', ...(msg.gifMeta || {}) };
    } else if (msg.type === 'image' && msg.image) {
      dbType = msg.meme ? 'meme' : 'photo';
      const blob = raw || await (await fetch(msg.image)).blob();
      const name = msg.meme ? 'meme.jpg' : (msg.file && msg.file.name) || 'photo.jpg';
      media_path = await uploadMedia(convId, blob, name);
      meta = { name, size: blob.size, mime: blob.type };
      msg.image = Live.media.get(media_path) || msg.image;
    } else if (msg.type === 'voice' || msg.type === 'video') {
      dbType = msg.type;
      const src = msg.type === 'voice' ? msg.audio : msg.video;
      const blob = raw || await (await fetch(src)).blob();
      const name = msg.type === 'voice' ? 'voice-note.' + (/mp4/.test(blob.type) ? 'm4a' : 'webm') : (msg.file && msg.file.name) || 'video.mp4';
      media_path = await uploadMedia(convId, blob, name);
      meta = { name, size: blob.size, mime: blob.type, duration: Math.round(msg.duration || 0) };
      const signed = Live.media.get(media_path);
      if (signed) { if (msg.type === 'voice') msg.audio = signed; else msg.video = signed; }
    } else if (msg.type === 'file' && msg.file) {
      dbType = 'file';
      let blob = raw;
      // forwarding a file: copy it from its current (signed) URL
      if (!blob && msg.mediaUrl) blob = await (await fetch(msg.mediaUrl)).blob();
      if (blob) {
        if (blob.size > MAX_UPLOAD) throw new Error('That file is over 50 MB.');
        media_path = await uploadMedia(convId, blob, msg.file.name);
        meta = { name: msg.file.name, size: blob.size, mime: blob.type };
        msg.mediaUrl = Live.media.get(media_path) || '';
      } else {
        meta = { name: msg.file.name, size: msg.file.size };
      }
    }

    if (msg.forwarded) meta.forwarded = true;
    delete msg._raw;

    const { data, error } = await Live.sb.from('messages').insert({
      id: msg.id,
      conversation_id: convId,
      sender_id: Live.user.id,
      type: dbType,
      content,
      media_url: media_path,
      media_meta: meta,
      reply_to: msg.replyTo && msg.replyTo.id ? msg.replyTo.id : null,
    }).select().single();

    if (error) throw error;

    msg.status = 'sent';
    msg.id = data.id;
    Live.msgConv.set(data.id, convId);
    if (isPath(media_path)) msg._path = media_path;

    // a workspace reload may have replaced the conversation while we uploaded
    const current = Store.get(convId);
    if (current && !current.messages.find((m) => m.id === data.id)) {
      current.messages.push({ ...msg, id: data.id, status: 'sent' });
      current.unread = 0;
    }
    Store.emit();
  } catch (err) {
    console.error('send failed', err);
    msg.status = 'failed';
    Store.emit();
    const raw = (err && err.message) || '';
    toast(/row-level security/i.test(raw)
      ? 'You can’t message this person right now.'
      : /over 50 MB/i.test(raw)
        ? 'That file is over 50 MB.'
        : 'Message not sent — check your connection');
  }
}

async function uploadMedia(convId, blob, name) {
  if (blob.size > MAX_UPLOAD) throw new Error('That file is over 50 MB.');
  const safe = String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60);
  const path = convId + '/' + Live.user.id + '/' + Date.now() + '-' + safe;

  const { error } = await Live.sb.storage.from('media').upload(path, blob, {
    contentType: blob.type || 'application/octet-stream',
    upsert: false,
  });
  if (error) throw error;

  const { data } = await Live.sb.storage.from('media').createSignedUrl(path, SIGNED_TTL);
  if (data && data.signedUrl) Live.media.set(path, data.signedUrl);
  return path;
}

/* ------------------------------------------------------------
   Read receipts
   ------------------------------------------------------------ */
async function markRead(convId) {
  if (!Live.user || isBot(convId)) return;
  const now = new Date().toISOString();
  const members = Live.members.get(convId) || [];
  const me = members.find((m) => m.user_id === Live.user.id);
  if (me) me.last_read_at = now;

  Live.sb.from('conversation_members')
    .update({ last_read_at: now })
    .eq('conversation_id', convId)
    .eq('user_id', Live.user.id)
    .then(() => {});
}

function refreshSeen(convId) {
  const conv = Store.get(convId);
  if (!conv) return;
  const others = (Live.members.get(convId) || []).filter((m) => m.user_id !== Live.user.id);
  const readUpTo = others.reduce((max, m) => Math.max(max, new Date(m.last_read_at || 0).getTime()), 0);

  let changed = false;
  conv.messages.forEach((m) => {
    if (m.from !== 'me' || m.status === 'sending' || m.status === 'failed') return;
    const next = new Date(m.time).getTime() <= readUpTo ? 'seen' : 'sent';
    if (m.status !== next) { m.status = next; changed = true; }
  });
  if (changed) Store.emit();
}

/* ------------------------------------------------------------
   Realtime
   ------------------------------------------------------------ */
function subscribeDb() {
  if (Live.dbChannel) Live.sb.removeChannel(Live.dbChannel);

  const ch = Live.sb.channel('pingme-db');

  ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
    onIncoming(payload.new);
  });

  ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (payload) => {
    onUpdated(payload.new);
  });

  // "Unsend for everyone": with RLS on, Realtime sends only the primary key of a deleted row
  ch.on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, (payload) => {
    onDeleted(payload.old && payload.old.id);
  });

  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions' }, () => {
    // the row does not carry the conversation — refresh the reactions we know about
    refreshReactions();
  });

  ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversation_members' }, (payload) => {
    const row = payload.new;
    if (!row || row.user_id === Live.user.id) return;
    const list = Live.members.get(row.conversation_id);
    if (!list) return;
    const member = list.find((m) => m.user_id === row.user_id);
    if (member) member.last_read_at = row.last_read_at;
    refreshSeen(row.conversation_id);
  });

  ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conversations' }, (payload) => {
    if (payload && payload.new && Store.get(payload.new.id)) return;
    reloadSoon();
  });

  ch.subscribe();
  Live.dbChannel = ch;
}

let reloadTimer = null;
function reloadSoon() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    loadWorkspace().then(() => { installLiveStore(); renderAll(); }).catch(() => {});
  }, 600);
}

function onIncoming(row) {
  if (!row || row.conversation_id === undefined) return;
  const conv = Store.get(row.conversation_id);
  if (!conv) { reloadSoon(); return; }

  const existing = conv.messages.find((m) => m.id === row.id);
  if (existing) {
    existing.status = 'sent';
    if (isPath(row.media_url)) {
      existing._path = row.media_url;
      signMedia([row.media_url]).then(() => {
        existing.image = mediaUrl(row.media_url);
        Store.emit();
      });
    }
    Store.emit();
    return;
  }

  const ui = toUIMsg(row, new Map(), []);
  Live.msgConv.set(row.id, row.conversation_id);
  if (isPath(row.media_url)) {
    signMedia([row.media_url]).then(() => {
      const url = mediaUrl(row.media_url);
      if (ui.type === 'voice') ui.audio = url;
      else if (ui.type === 'video') ui.video = url;
      else { ui.image = url; ui.mediaUrl = url; }
      Store.emit();
    });
  }

  ui._new = true;
  conv.messages.push(ui);

  if (Store.state.openId === row.conversation_id) {
    markRead(row.conversation_id);
  } else {
    conv.unread = (conv.unread || 0) + 1;
    if (!UI.stickBottom) UI.newCount += 1;
  }

  Store.emit();
}

function onUpdated(row) {
  const conv = Store.get(row.conversation_id);
  if (!conv) return;
  const msg = conv.messages.find((m) => m.id === row.id);
  if (!msg) return;
  if (row.deleted_for_all) {
    msg._deleted = true;
    msg.type = 'text';
    msg.image = '';
    msg.file = null;
    msg.text = 'This message was deleted';
  }
  if (msg.type === 'sticker') {
    if (row.content) msg.sticker = row.content;
  } else if (row.content !== null && row.content !== undefined) {
    msg.text = row.content;
  }
  if (row.edited_at) msg.edited = true;
  Store.emit();
}

function onDeleted(id) {
  if (!id) return;
  const convId = Live.msgConv.get(id);
  const conv = convId ? Store.get(convId) : null;
  Live.msgConv.delete(id);
  if (!conv) return;
  const before = conv.messages.length;
  conv.messages = conv.messages.filter((m) => m.id !== id);
  if (conv.messages.length !== before) Store.emit();
}

function refreshReactions() {
  const ids = Array.from(Live.msgConv.keys());
  if (!ids.length) return;
  Live.sb.from('message_reactions')
    .select('message_id, emoji')
    .in('message_id', ids.slice(-300))
    .then(({ data }) => {
      const counts = new Map();
      (data || []).forEach((r) => {
        if (!counts.has(r.message_id)) counts.set(r.message_id, {});
        const bucket = counts.get(r.message_id);
        bucket[r.emoji] = (bucket[r.emoji] || 0) + 1;
      });
      let changed = false;
      Store.state.conversations.forEach((conv) => {
        conv.messages.forEach((m) => {
          if (!Live.msgConv.has(m.id)) return;
          const next = counts.get(m.id) || {};
          if (JSON.stringify(next) !== JSON.stringify(m.reactions || {})) {
            m.reactions = next;
            changed = true;
          }
        });
      });
      if (changed) Store.emit();
    });
}

/* ------------------------------------------------------------
   Presence + typing
   ------------------------------------------------------------ */
function joinPresence() {
  if (Live.presence) Live.sb.removeChannel(Live.presence);

  const ch = Live.sb.channel('pingme-presence', {
    config: { presence: { key: Live.user.id } },
  });

  ch.on('presence', { event: 'sync' }, () => {
    const state = ch.presenceState();
    Live.online = new Set(Object.keys(state));
    Store.state.conversations.forEach((conv) => {
      if (!conv.bot) conv.online = Live.online.has(conv.otherId);
    });
    Store.emit();
  });

  ch.on('broadcast', { event: 'typing' }, ({ payload }) => {
    if (!payload || payload.userId === Live.user.id || isBot(payload.convId)) return;
    const conv = Store.get(payload.convId);
    if (!conv) return;
    UI.typing[conv.id] = true;
    clearTimeout(Live.lastTypingIn[conv.id]);
    Live.lastTypingIn[conv.id] = setTimeout(() => {
      UI.typing[conv.id] = false;
      Store.emit();
    }, 3200);
    Store.emit();
  });

  ch.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      await ch.track({ user_id: Live.user.id, at: new Date().toISOString() });
      Live.presence = ch;
    }
  });
}

function wireTyping() {
  const input = $('#msgInput');
  if (input) {
    input.addEventListener('input', () => {
      const convId = Store.state.openId;
      if (!convId || isBot(convId) || !Live.presence) return;
      const now = Date.now();
      if (now - Live.lastTypingSent < 2200) return;
      Live.lastTypingSent = now;
      Live.presence.send({
        type: 'broadcast',
        event: 'typing',
        payload: { convId, userId: Live.user.id },
      });
    });
  }

  // keep presence fresh: refresh last_seen every minute + on unload
  setInterval(() => {
    if (!Live.user) return;
    Live.sb.from('profiles').update({ last_seen: new Date().toISOString() }).eq('id', Live.user.id).then(() => {});
    if (Live.presence) Live.presence.track({ user_id: Live.user.id, at: new Date().toISOString() });
  }, 60000);

  window.addEventListener('beforeunload', () => {
    if (!Live.user) return;
    Live.sb.auth.getSession();
  });
}

/* ------------------------------------------------------------
   Calls — WebRTC signaling over Realtime broadcast.
   Everyone listens on their own channel; to reach someone we
   send on theirs.
   ------------------------------------------------------------ */
const callChannels = new Map();

function callChannel(userId) {
  if (callChannels.has(userId)) return callChannels.get(userId);
  const ch = Live.sb.channel('pingme-call-' + userId, { config: { broadcast: { self: false } } });
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('call channel timeout')), 8000);
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') { clearTimeout(t); resolve(ch); }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(t); reject(new Error(status)); }
    });
  });
  const entry = { ch, ready };
  callChannels.set(userId, entry);
  ready.catch(() => callChannels.delete(userId));
  return entry;
}

function setupCalls() {
  if (Live.callsReady) return;
  Live.callsReady = true;
  const mine = callChannel(Live.user.id);
  mine.ch.on('broadcast', { event: 'signal' }, ({ payload }) => {
    if (payload && payload.to === Live.user.id) F.onCallSignal(payload);
  });

  const turn = env.VITE_TURN_URL;
  if (turn) {
    F.Calls.ice.push({ urls: turn.split(','), username: env.VITE_TURN_USERNAME, credential: env.VITE_TURN_CREDENTIAL });
  }

  F.Calls.signal = {
    myId: Live.user.id,
    get myName() { return displayName(Live.profile); },
    async send(toUserId, payload) {
      const { ch } = await callChannel(toUserId).ready.then(() => callChannel(toUserId));
      return ch.send({ type: 'broadcast', event: 'signal', payload: { ...payload, to: toUserId, from: Live.user.id } });
    },
  };
}

/* ------------------------------------------------------------
   PingBot (AI) + GIF search — both go through Supabase Edge
   Functions so API keys never reach the browser.
   ------------------------------------------------------------ */
async function functionError(error) {
  let detail = '';
  try {
    const res = error && error.context;
    if (res && typeof res.json === 'function') {
      const body = await res.json();
      detail = (body && (body.error || body.message)) || '';
    }
  } catch { /* not JSON */ }
  const status = error && error.context && error.context.status;
  return { status, detail: String(detail || (error && error.message) || '') };
}

async function askBot(history) {
  const { data, error } = await Live.sb.functions.invoke('ai-chat', { body: { messages: history } });
  if (error) {
    const { status, detail } = await functionError(error);
    console.warn('PingBot error', status, detail);
    const err = new Error(detail || 'PingBot failed');
    err.botMessage =
      status === 404 || /not found/i.test(detail)
        ? 'I’m not switched on yet 🔌 — the ai-chat function still needs to be deployed to Supabase.'
        : /GEMINI_API_KEY|not configured/i.test(detail)
          ? 'I’m not switched on yet 🔌 — add the free Gemini API key to Supabase (see README).'
          : status === 429 || /quota|rate/i.test(detail)
            ? 'Too many questions at once 😅 The free AI tier needs a short breather — try again in a minute.'
            : 'Oops, my AI brain is offline right now 😵 Try again in a minute.';
    throw err;
  }
  return (data && data.reply) || '';
}

async function searchGifs(q) {
  const qs = new URLSearchParams(q ? { q } : { trending: '1' });
  const { data, error } = await Live.sb.functions.invoke('giphy?' + qs.toString(), { method: 'GET' });
  if (error) {
    const { status, detail } = await functionError(error);
    console.warn('GIF search error', status, detail);
    const err = new Error(detail || 'GIF search failed');
    err.gifMessage = status === 404 || /GIPHY_API_KEY|not configured|not found/i.test(detail)
      ? '🎞️ GIF search isn’t set up yet — it needs a free GIPHY key (see README). Stickers and the Meme maker work right now! 😄'
      : 'Could not load GIFs right now 😕 Try Stickers or the Meme maker.';
    throw err;
  }
  return (data && data.items) || [];
}

/* ------------------------------------------------------------
   Profile editing
   ------------------------------------------------------------ */
function openProfile() {
  if (!Live.user || !Live.profile) return showAuth('login');
  const p = Live.profile;
  $('#profileUsername').value = p.username || '';
  $('#profileName').value = p.display_name || '';
  $('#profileBio').value = p.bio || '';
  $('#profileStatus').value = p.status || 'online';

  const av = $('#profileAvatar');
  av.textContent = p.avatar_url ? '' : initials(displayName(p));
  av.style.background = p.avatar_url
    ? 'url(' + p.avatar_url + ') center/cover'
    : 'linear-gradient(135deg, #7C3AED, #EC4899)';

  $('#profileMsg').textContent = '';
  $('#profileModal').classList.remove('hidden');
  $('#profileUsername').focus();
}

async function saveProfile(e) {
  e.preventDefault();
  const username = $('#profileUsername').value.trim().toLowerCase();
  const name = $('#profileName').value.trim();
  const bio = $('#profileBio').value.trim();
  const status = $('#profileStatus').value;

  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    return setProfileMsg('Username: 3–20 letters, numbers or underscores.');
  }
  if (!name) return setProfileMsg('Add a display name.');

  const btn = $('#profileSave');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  const { error } = await Live.sb.from('profiles')
    .update({ username, display_name: name, bio, status })
    .eq('id', Live.user.id);

  btn.disabled = false;
  btn.textContent = 'Save changes';

  if (error) {
    setProfileMsg(/duplicate|unique/i.test(error.message) ? 'That username is taken.' : error.message);
    return;
  }

  Live.profile = { ...Live.profile, username, display_name: name, bio, status };
  Store.state.me = { name, username };
  paintMe(Live.profile);
  setProfileMsg('Saved ✅', true);
  setTimeout(() => $('#profileModal').classList.add('hidden'), 600);
}

function setProfileMsg(text, ok = false) {
  const el = $('#profileMsg');
  el.textContent = text;
  el.classList.toggle('ok', !!ok);
}

async function uploadAvatar(file) {
  if (!file) return;
  setProfileMsg('Uploading…', true);
  try {
    const blob = await downscale(file, 512);
    const path = Live.user.id + '/avatar-' + Date.now() + '.jpg';
    const { error } = await Live.sb.storage.from('avatars').upload(path, blob, { contentType: 'image/jpeg', upsert: true });
    if (error) throw error;

    const { data } = Live.sb.storage.from('avatars').getPublicUrl(path);
    const url = data.publicUrl + '?v=' + Date.now();
    const upd = await Live.sb.from('profiles').update({ avatar_url: url }).eq('id', Live.user.id);
    if (upd.error) throw upd.error;

    Live.profile.avatar_url = url;
    const av = $('#profileAvatar');
    av.textContent = '';
    av.style.background = 'url(' + url + ') center/cover';
    paintMe(Live.profile);
    setProfileMsg('Photo updated ✅', true);
  } catch (err) {
    console.error(err);
    setProfileMsg(err.message || 'Upload failed');
  } finally {
    $('#avatarInput').value = '';
  }
}

function downscale(file, max) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that image'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not read that image'));
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not process that image'))), 'image/jpeg', 0.86);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ------------------------------------------------------------
   Find people
   ------------------------------------------------------------ */
function openPeople() {
  if (!Live.user) {
    showAuth('login');
    setAuthMsg('Log in to find people.');
    return;
  }
  $('#peopleModal').classList.remove('hidden');
  $('#peopleSearch').value = '';
  searchPeople('');
  setTimeout(() => $('#peopleSearch').focus(), 30);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

async function searchPeople(q) {
  if (!Live.user) return;
  const list = $('#peopleList');
  const term = String(q || '').trim().replace(/^@/, '').replace(/[,()*]/g, ' ').slice(0, 40);

  let query = Live.sb.from('profiles')
    .select('id, username, display_name, avatar_url, bio, status, last_seen')
    .neq('id', Live.user.id)
    .order('last_seen', { ascending: false })
    .limit(15);

  if (term) query = query.or('username.ilike.%' + term + '%,display_name.ilike.%' + term + '%');

  const [{ data, error }, { data: following }] = await Promise.all([
    query,
    Live.sb.from('follows').select('following_id').eq('follower_id', Live.user.id),
  ]);

  if (error) {
    list.innerHTML = '<p class="auth-msg">' + esc(error.message) + '</p>';
    return;
  }

  const follows = new Set((following || []).map((f) => f.following_id));
  $('#peopleEmpty').classList.toggle('hidden', !!(data && data.length));

  list.innerHTML = (data || []).map((p) => {
    const isFollowing = follows.has(p.id);
    return '<div class="person-row" data-person="' + p.id + '">' +
      '<span class="avatar sm" style="' + (p.avatar_url ? 'background-image:url(' + esc(p.avatar_url) + ');background-size:cover;background-position:center' : 'background:linear-gradient(135deg,#7C3AED,#EC4899)') + '">' +
        (p.avatar_url ? '' : esc(initials(displayName(p)))) + '</span>' +
      '<span class="meta"><b>' + esc(displayName(p)) + '</b><span>@' + esc(p.username) + (p.bio ? ' · ' + esc(p.bio) : '') + '</span></span>' +
      '<span class="actions">' +
        '<button type="button" class="mini-btn" data-follow="' + p.id + '" data-on="' + (isFollowing ? '1' : '0') + '">' + (isFollowing ? 'Following' : 'Follow') + '</button>' +
        '<button type="button" class="mini-btn solid" data-message="' + p.id + '">Message</button>' +
      '</span>' +
    '</div>';
  }).join('');

  list.onclick = async (e) => {
    const followBtn = e.target.closest('[data-follow]');
    const msgBtn = e.target.closest('[data-message]');

    if (followBtn) {
      const id = followBtn.getAttribute('data-follow');
      const on = followBtn.getAttribute('data-on') === '1';
      followBtn.disabled = true;
      const run = on
        ? Live.sb.from('follows').delete().eq('follower_id', Live.user.id).eq('following_id', id)
        : Live.sb.from('follows').insert({ follower_id: Live.user.id, following_id: id });
      const { error: fErr } = await run;
      followBtn.disabled = false;
      if (fErr) return toast('Could not update follow');
      followBtn.setAttribute('data-on', on ? '0' : '1');
      followBtn.textContent = on ? 'Follow' : 'Following';
      return;
    }

    if (msgBtn) {
      const id = msgBtn.getAttribute('data-message');
      msgBtn.disabled = true;
      const { data: convId, error: rpcErr } = await Live.sb.rpc('start_dm', { p_other: id });
      msgBtn.disabled = false;
      if (rpcErr) return toast(rpcErr.message || 'Could not start that chat');
      $('#peopleModal').classList.add('hidden');
      await loadWorkspace();
      installLiveStore();
      F.openConversationUI(convId);
    }
  };
}

/* ------------------------------------------------------------
   Kickoff
   ------------------------------------------------------------ */
boot().catch((err) => {
  console.error('PingMe live boot error', err);
});
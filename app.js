// =====================================================================
// Entangle — messenger, powered by Supabase
// =====================================================================
const SUPABASE_URL = "https://alzqrzuxrboessglbmyf.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFsenFyenV4cmJvZXNzZ2xibXlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ3MzQ3NzUsImV4cCI6MjEwMDMxMDc3NX0.l9MlPji-lUSd9u8FDYop9U06Yx6mpvL9zkqto_xbBgA";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const IMAGE_BUCKET = "chat-images";
const AVATAR_BUCKET = "avatars";

const ICONS = {
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M5 20c0-4 3-7 7-7s7 3 7 7"/></svg>',
};

function renderAvatar(el, url) {
  if (!el) return;
  if (url) {
    el.innerHTML = '';
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    img.onerror = () => { el.innerHTML = ICONS.user; };
    el.appendChild(img);
  } else {
    el.innerHTML = ICONS.user;
  }
}

// -------------------- state --------------------
let me = null;
let activeConvo = null;
let activePeer = null;
let messagesChannel = null;
let convoCache = new Map();
let mobileView = 'list';

// -------------------- element refs --------------------
const authScreen = document.getElementById("authScreen");
const appScreen = document.getElementById("appScreen");
const listPanel = document.querySelector(".list-panel");
const chatPanel = document.querySelector(".chat-panel");

const loginForm = document.getElementById("loginForm");
const signupForm = document.getElementById("signupForm");
const loginError = document.getElementById("loginError");
const signupError = document.getElementById("signupError");
const backBtn = document.getElementById("backBtn");

// Auth tabs
document.querySelectorAll(".auth-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const isLogin = tab.dataset.tab === "login";
    loginForm.classList.toggle("hidden", !isLogin);
    signupForm.classList.toggle("hidden", isLogin);
  });
});

// -------------------- mobile navigation --------------------
function showMobileView(view) {
  mobileView = view;
  if (window.innerWidth <= 680) {
    listPanel.classList.toggle("show-mobile", view === "list");
    chatPanel.classList.toggle("show-mobile", view === "chat");
  }
}

function isMobile() {
  return window.innerWidth <= 680;
}

window.addEventListener("resize", () => {
  if (!isMobile()) {
    listPanel.classList.remove("show-mobile");
    chatPanel.classList.remove("show-mobile");
  } else {
    showMobileView(mobileView);
  }
});

backBtn.addEventListener("click", () => {
  showMobileView("list");
  activeConvo = null;
  activePeer = null;
  loadConversations();
});

// -------------------- signup avatar picker --------------------
const avatarPickBtn = document.getElementById("avatarPickBtn");
const signupAvatarInput = document.getElementById("signupAvatarInput");
const signupAvatarPreview = document.getElementById("signupAvatarPreview");
let pendingSignupAvatar = null;

avatarPickBtn.addEventListener("click", () => signupAvatarInput.click());
avatarPickBtn.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    signupAvatarInput.click();
  }
});

signupAvatarInput.addEventListener("change", () => {
  const file = signupAvatarInput.files[0];
  if (!file) return;
  pendingSignupAvatar = file;
  renderAvatar(signupAvatarPreview, URL.createObjectURL(file));
});

// -------------------- auth --------------------
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";
  const identifier = document.getElementById("loginIdentifier").value.trim();
  const password = document.getElementById("loginPassword").value;

  if (!identifier) return;

  let email = identifier;

  if (!identifier.includes("@")) {
    const { data: rows, error: lookupErr } = await sb.rpc(
      "get_email_by_username",
      { p_username: identifier },
    );

    if (lookupErr || !rows || rows.length === 0) {
      loginError.textContent = "No account found with that username";
      return;
    }
    email = rows;
  }

  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) loginError.textContent = error.message;
});

signupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  signupError.textContent = "";
  const username = document.getElementById("signupUsername").value.trim();
  const email = document.getElementById("signupEmail").value.trim();
  const password = document.getElementById("signupPassword").value;

  if (!/^[a-zA-Z0-9_]{2,24}$/.test(username)) {
    signupError.textContent =
      "Username must be 2-24 characters: letters, numbers, underscore";
    return;
  }

  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: {
      data: { username },
    },
  });

  if (error) {
    signupError.textContent = error.message;
    return;
  }

  if (!data.session) {
    signupError.textContent = "Check your email to confirm your account, then sign in.";
    return;
  }

  if (pendingSignupAvatar) {
    await uploadAvatar(data.user.id, pendingSignupAvatar);
  }
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await sb.auth.signOut();
});

sb.auth.onAuthStateChange(async (_event, session) => {
  if (session?.user) {
    await enterApp(session.user);
  } else {
    authScreen.classList.remove("hidden");
    appScreen.classList.add("hidden");
    me = null;
  }
});

async function enterApp(user) {
  const { data: profile, error } = await sb
    .from("profiles")
    .select("id, username, avatar_url")
    .eq("id", user.id)
    .single();

  if (error || !profile) {
    console.warn("no profile found for user", error);
    return;
  }

  me = profile;
  document.getElementById("meName").textContent = me.username;
  renderAvatar(document.getElementById("railAvatar"), me.avatar_url);

  const railImg = document.getElementById("railAvatarImg");
  if (me.avatar_url) {
    railImg.src = me.avatar_url;
    railImg.classList.remove("hidden");
    document.getElementById("railAvatarPlaceholder").classList.add("hidden");
  }

  authScreen.classList.add("hidden");
  appScreen.classList.remove("hidden");
  showMobileView("list");

  await sb.from("profiles").update({ status: "online" }).eq("id", me.id);
  loadConversations();
}

// -------------------- avatar upload --------------------
const railAvatar = document.getElementById("railAvatar");
const meAvatarInput = document.getElementById("meAvatarInput");

railAvatar.addEventListener("click", () => meAvatarInput.click());

meAvatarInput.addEventListener("change", async () => {
  const file = meAvatarInput.files[0];
  if (!file || !me) return;
  await uploadAvatar(me.id, file);
  meAvatarInput.value = "";
});

async function uploadAvatar(userId, file) {
  const path = `${userId}/${crypto.randomUUID()}-${file.name}`;
  const { error: upErr } = await sb.storage
    .from(AVATAR_BUCKET)
    .upload(path, file, { upsert: true });

  if (upErr) {
    alert("photo upload failed: " + upErr.message);
    return;
  }

  const { data: pub } = sb.storage.from(AVATAR_BUCKET).getPublicUrl(path);

  await sb
    .from("profiles")
    .update({ avatar_url: pub.publicUrl })
    .eq("id", userId);

  if (me && me.id === userId) {
    me.avatar_url = pub.publicUrl;
    renderAvatar(document.getElementById("railAvatar"), me.avatar_url);
    const railImg = document.getElementById("railAvatarImg");
    railImg.src = me.avatar_url;
    railImg.classList.remove("hidden");
    document.getElementById("railAvatarPlaceholder").classList.add("hidden");
  }
}

// -------------------- find / start conversation --------------------
const findHandle = document.getElementById("findHandle");
const findError = document.getElementById("findError");

document.getElementById("findBtn").addEventListener("click", startConversationFromInput);
findHandle.addEventListener("keydown", (e) => {
  if (e.key === "Enter") startConversationFromInput();
});

async function startConversationFromInput() {
  findError.textContent = "";
  const handle = findHandle.value.trim();
  if (!handle) return;

  const { data: peer, error } = await sb
    .from("profiles")
    .select("id, username, avatar_url")
    .ilike("username", handle)
    .neq("id", me.id)
    .maybeSingle();

  if (error || !peer) {
    findError.textContent = "No user found with that username";
    return;
  }

  const convoId = await getOrCreateDirectConvo(peer.id);
  findHandle.value = "";
  await loadConversations();
  openConversation(convoId, peer);
}

async function getOrCreateDirectConvo(peerId) {
  const { data: mine } = await sb
    .from("conversation_participants")
    .select("conversation_id")
    .eq("user_id", me.id);

  const myConvoIds = (mine || []).map((r) => r.conversation_id);

  if (myConvoIds.length) {
    const { data: shared } = await sb
      .from("conversation_participants")
      .select("conversation_id")
      .eq("user_id", peerId)
      .in("conversation_id", myConvoIds);

    if (shared && shared.length) {
      const { data: convo } = await sb
        .from("conversations")
        .select("id, is_group")
        .eq("id", shared[0].conversation_id)
        .eq("is_group", false)
        .maybeSingle();
      if (convo) return convo.id;
    }
  }

  const { data: newConvo, error: convoErr } = await sb
    .from("conversations")
    .insert({ is_group: false })
    .select()
    .single();
  if (convoErr) throw convoErr;

  await sb.from("conversation_participants").insert([
    { conversation_id: newConvo.id, user_id: me.id },
    { conversation_id: newConvo.id, user_id: peerId },
  ]);

  return newConvo.id;
}

// -------------------- conversation list --------------------
async function loadConversations() {
  const { data: parts } = await sb
    .from("conversation_participants")
    .select("conversation_id")
    .eq("user_id", me.id);

  const convoIds = (parts || []).map((r) => r.conversation_id);
  const list = document.getElementById("convoList");

  if (!convoIds.length) {
    list.innerHTML = `<p class="empty-hint">No conversations yet. Search to start chatting.</p>`;
    return;
  }

  const rows = [];
  for (const cid of convoIds) {
    const { data: others } = await sb
      .from("conversation_participants")
      .select("user_id, profiles ( id, username, avatar_url )")
      .eq("conversation_id", cid)
      .neq("user_id", me.id);

    const peer = others?.[0]?.profiles;
    if (!peer) continue;

    const { data: lastMsg } = await sb
      .from("messages")
      .select("content, image_url, created_at")
      .eq("conversation_id", cid)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    convoCache.set(cid, { id: cid, peer, lastMessage: lastMsg || null });
    rows.push(convoCache.get(cid));
  }

  rows.sort((a, b) => {
    const ta = a.lastMessage?.created_at || 0;
    const tb = b.lastMessage?.created_at || 0;
    return tb > ta ? 1 : -1;
  });

  list.innerHTML = "";
  rows.forEach((r) => {
    const el = document.createElement("div");
    el.className = "convo-item" + (activeConvo === r.id ? " active" : "");

    const timeStr = r.lastMessage ? formatTime(r.lastMessage.created_at) : "";
    let previewHtml = "No messages yet";
    if (r.lastMessage) {
      if (r.lastMessage.image_url) {
        previewHtml = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg><span>Photo</span>';
      } else {
        previewHtml = escapeHtml(r.lastMessage.content);
      }
    }

    el.innerHTML = `
      <div class="avatar"></div>
      <div class="meta">
        <div class="name-row">
          <div class="name">${escapeHtml(r.peer.username)}</div>
          <div class="time">${timeStr}</div>
        </div>
        <div class="preview">${previewHtml}</div>
      </div>`;

    renderAvatar(el.querySelector(".avatar"), r.peer.avatar_url);

    el.addEventListener("click", () => openConversation(r.id, r.peer));
    list.appendChild(el);
  });
}

// -------------------- open conversation --------------------
async function openConversation(convoId, peer) {
  activeConvo = convoId;
  activePeer = peer;

  showMobileView("chat");

  document.getElementById("emptyState").classList.add("hidden");
  document.getElementById("chatView").classList.remove("hidden");
  document.getElementById("peerName").textContent = peer.username;
  renderAvatar(document.getElementById("peerAvatar"), peer.avatar_url);

  document.querySelectorAll(".convo-item").forEach((el) => el.classList.remove("active"));
  loadConversations();

  const { data: msgs } = await sb
    .from("messages")
    .select("id, sender_id, content, image_url, created_at")
    .eq("conversation_id", convoId)
    .order("created_at", { ascending: true });

  const box = document.getElementById("messages");
  box.innerHTML = "";
  (msgs || []).forEach((m) => renderMessage(m, false));
  box.scrollTop = box.scrollHeight;

  if (messagesChannel) sb.removeChannel(messagesChannel);
  messagesChannel = sb
    .channel(`room:${convoId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "messages",
        filter: `conversation_id=eq.${convoId}`,
      },
      (payload) => {
        renderMessage(payload.new, true);
        box.scrollTop = box.scrollHeight;
        loadConversations();
      },
    )
    .subscribe();
}

function renderMessage(m, animate) {
  const box = document.getElementById("messages");
  const mine = m.sender_id === me.id;

  const row = document.createElement("div");
  row.className = "msg-row" + (mine ? " mine" : " theirs");

  const bubble = document.createElement("div");
  bubble.className = "bubble" + (animate ? " message-in" : "");

  if (m.image_url) {
    const img = document.createElement("img");
    img.src = m.image_url;
    img.alt = "shared image";
    img.onerror = () => { img.style.display = "none"; };
    bubble.appendChild(img);
  }
  if (m.content) {
    const p = document.createElement("span");
    p.textContent = m.content;
    bubble.appendChild(p);
  }
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = new Date(m.created_at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  bubble.appendChild(time);

  row.appendChild(bubble);
  box.appendChild(row);
}

// -------------------- composer --------------------
const composer = document.getElementById("composer");
const messageInput = document.getElementById("messageInput");
const attachBtn = document.getElementById("attachBtn");
const imageInput = document.getElementById("imageInput");
const imagePreviewWrap = document.getElementById("imagePreviewWrap");
const imagePreview = document.getElementById("imagePreview");
const clearImage = document.getElementById("clearImage");

let pendingFile = null;

attachBtn.addEventListener("click", () => imageInput.click());

imageInput.addEventListener("change", () => {
  const file = imageInput.files[0];
  if (!file) return;
  pendingFile = file;
  imagePreview.src = URL.createObjectURL(file);
  imagePreviewWrap.classList.remove("hidden");
});

clearImage.addEventListener("click", () => {
  pendingFile = null;
  imageInput.value = "";
  imagePreviewWrap.classList.add("hidden");
});

composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!activeConvo) return;

  const text = messageInput.value.trim();
  if (!text && !pendingFile) return;

  let imageUrl = null;

  if (pendingFile) {
    const path = `${activeConvo}/${crypto.randomUUID()}-${pendingFile.name}`;
    const { error: upErr } = await sb.storage
      .from(IMAGE_BUCKET)
      .upload(path, pendingFile);
    if (upErr) {
      alert("image upload failed: " + upErr.message);
      return;
    }
    const { data: pub } = sb.storage.from(IMAGE_BUCKET).getPublicUrl(path);
    imageUrl = pub.publicUrl;
  }

  const { error } = await sb.from("messages").insert({
    conversation_id: activeConvo,
    sender_id: me.id,
    content: text || null,
    image_url: imageUrl,
  });

  if (error) {
    alert("message failed to send: " + error.message);
    return;
  }

  messageInput.value = "";
  pendingFile = null;
  imageInput.value = "";
  imagePreviewWrap.classList.add("hidden");
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function formatTime(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const diffDays = Math.floor((now - d) / (1000 * 60 * 60 * 24));
  if (diffDays < 7) {
    return d.toLocaleDateString([], { weekday: "short" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

// =====================================================================
// ambient particle field
// =====================================================================
(function particleField() {
  const canvas = document.getElementById("field");
  const ctx = canvas.getContext("2d");
  let particles = [];
  let w, h;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  }
  window.addEventListener("resize", resize);
  resize();

  const COUNT = Math.min(70, Math.floor((w * h) / 22000));
  for (let i = 0; i < COUNT; i++) {
    particles.push({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.6 + 0.4,
      vx: (Math.random() - 0.5) * 0.15,
      vy: (Math.random() - 0.5) * 0.15,
      hue: Math.random() > 0.5 ? "212,168,83" : "180,140,60",
      phase: Math.random() * Math.PI * 2,
    });
  }

  function step() {
    ctx.clearRect(0, 0, w, h);
    particles.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.phase += 0.01;
      if (p.x < 0) p.x = w;
      if (p.x > w) p.x = 0;
      if (p.y < 0) p.y = h;
      if (p.y > h) p.y = 0;
      const flicker = 0.3 + 0.2 * Math.sin(p.phase);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${p.hue}, ${flicker})`;
      ctx.fill();
    });
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const a = particles[i], b = particles[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < 110) {
          ctx.strokeStyle = `rgba(212,168,83,${0.06 * (1 - d / 110)})`;
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
    if (!reduceMotion) requestAnimationFrame(step);
  }
  step();
})();

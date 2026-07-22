// =====================================================================
// Entangle — quantum-styled messenger, powered by Supabase
// Fill these in from your Supabase project: Settings → API
// =====================================================================
const SUPABASE_URL = "https://alzqrzuxrboessglbmyf.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFsenFyenV4cmJvZXNzZ2xibXlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ3MzQ3NzUsImV4cCI6MjEwMDMxMDc3NX0.l9MlPji-lUSd9u8FDYop9U06Yx6mpvL9zkqto_xbBgA";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const IMAGE_BUCKET = "chat-images";

// -------------------- state --------------------
let me = null; // { id, username }
let activeConvo = null; // conversation id currently open
let activePeer = null; // { id, username } for the open convo
let messagesChannel = null; // realtime subscription for open convo
let convoCache = new Map(); // convo_id -> { id, peer, lastMessage }

// -------------------- element refs --------------------
const authScreen = document.getElementById("authScreen");
const appScreen = document.getElementById("appScreen");

// mobile: single-pane nav between the conversation list and the open chat
const backBtn = document.getElementById("backBtn");
backBtn.addEventListener("click", () => {
  appScreen.classList.remove("mobile-chat-open");
});

const loginForm = document.getElementById("loginForm");
const signupForm = document.getElementById("signupForm");
const loginError = document.getElementById("loginError");
const signupError = document.getElementById("signupError");

document.querySelectorAll(".auth-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document
      .querySelectorAll(".auth-tab")
      .forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const isLogin = tab.dataset.tab === "login";
    loginForm.classList.toggle("hidden", !isLogin);
    signupForm.classList.toggle("hidden", isLogin);
  });
});

// -------------------- auth --------------------
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
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
      "handle must be 2-24 chars: letters, numbers, underscore";
    return;
  }

  // Pass username as user metadata — the trigger will read it
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: {
      data: { username }
    }
  });

  if (error) {
    signupError.textContent = error.message;
    return;
  }

  if (!data.session) {
    signupError.textContent = "check your email to confirm, then sign in.";
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
    .select("id, username")
    .eq("id", user.id)
    .single();

  if (error || !profile) {
    // signed in but no profile row yet (edge case) — bounce to signup flow
    console.warn("no profile found for user", error);
    return;
  }

  me = profile;
  document.getElementById("meName").textContent = me.username;
  authScreen.classList.add("hidden");
  appScreen.classList.remove("hidden");

  await sb.from("profiles").update({ status: "online" }).eq("id", me.id);
  loadConversations();
}

// -------------------- find / start conversation --------------------
const findHandle = document.getElementById("findHandle");
const findError = document.getElementById("findError");

document
  .getElementById("findBtn")
  .addEventListener("click", startConversationFromInput);
findHandle.addEventListener("keydown", (e) => {
  if (e.key === "Enter") startConversationFromInput();
});

async function startConversationFromInput() {
  findError.textContent = "";
  const handle = findHandle.value.trim();
  if (!handle) return;

  const { data: peer, error } = await sb
    .from("profiles")
    .select("id, username")
    .ilike("username", handle)
    .neq("id", me.id)
    .maybeSingle();

  if (error || !peer) {
    findError.textContent = "no one entangled under that handle";
    return;
  }

  const convoId = await getOrCreateDirectConvo(peer.id);
  findHandle.value = "";
  await loadConversations();
  openConversation(convoId, peer);
}

async function getOrCreateDirectConvo(peerId) {
  // find an existing 1:1 conversation shared with peer
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
      // confirm it's a direct (non-group) convo
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
    list.innerHTML = `<p class="empty-hint">No entanglements yet. Search a handle above to start one.</p>`;
    return;
  }

  const rows = [];
  for (const cid of convoIds) {
    const { data: others } = await sb
      .from("conversation_participants")
      .select("user_id, profiles ( id, username )")
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
    const preview = r.lastMessage
      ? r.lastMessage.image_url
        ? "📷 image"
        : r.lastMessage.content
      : "start the conversation";
    el.innerHTML = `
      <span class="avatar"></span>
      <div class="meta">
        <div class="name">${escapeHtml(r.peer.username)}</div>
        <div class="preview">${escapeHtml(preview)}</div>
      </div>`;
    el.addEventListener("click", () => openConversation(r.id, r.peer));
    list.appendChild(el);
  });
}

// -------------------- open conversation --------------------
async function openConversation(convoId, peer) {
  activeConvo = convoId;
  activePeer = peer;

  appScreen.classList.add("mobile-chat-open");
  document.getElementById("emptyState").classList.add("hidden");
  document.getElementById("chatView").classList.remove("hidden");
  document.getElementById("peerName").textContent = peer.username;

  document
    .querySelectorAll(".convo-item")
    .forEach((el) => el.classList.remove("active"));
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
  row.className = "msg-row" + (mine ? " mine" : "");

  const bubble = document.createElement("div");
  bubble.className = "bubble" + (animate ? " decohering" : "");

  if (m.image_url) {
    const img = document.createElement("img");
    img.src = m.image_url;
    img.alt = "shared image";
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

// -------------------- composer: send text + image --------------------
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

// =====================================================================
// ambient particle field — quiet, low-opacity "quantum foam" backdrop
// =====================================================================
(function particleField() {
  const canvas = document.getElementById("field");
  const ctx = canvas.getContext("2d");
  let particles = [];
  let w, h;
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

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
      hue: Math.random() > 0.5 ? "123,92,255" : "63,231,214",
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
      const flicker = 0.4 + 0.3 * Math.sin(p.phase);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${p.hue}, ${flicker})`;
      ctx.fill();
    });
    // faint entanglement lines between nearby particles
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const a = particles[i],
          b = particles[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < 110) {
          ctx.strokeStyle = `rgba(123,92,255,${0.08 * (1 - d / 110)})`;
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

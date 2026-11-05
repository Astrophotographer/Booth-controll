const LEVEL_NAME = { full: "포화", mid: "보통", ok: "여유" };
const LEVEL_RANK = { full: 0, mid: 1, ok: 2 };
const CHAT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const READ_PREFIX = "bazaar-read-v1";

const ui = {
  role: localStorage.getItem("bazaar-role"),
  boothId: localStorage.getItem("bazaar-booth-id"),
  sort: "status",
  tab: "board",
  chatBoothId: null,
  data: { booths: [], requests: [], messages: [] },
  dragging: false,
};

const pendingDelete = new Set();
let busy = 0;
let stateVersion = 0;
let refreshInFlight = false;
let levelPending = false;
let pushBusy = false;
let appReady = false;
let pendingNotificationChat = new URLSearchParams(window.location.search).get("chat");
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function clock(ms) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(ms);
}

function ago(ms) {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  return clock(ms);
}

function sentKey() {
  return `bazaar-sent-${ui.boothId}`;
}

function show(name) {
  for (const screen of $$("[data-screen]")) {
    screen.hidden = screen.dataset.screen !== name;
  }
}

function booth() {
  return ui.data.booths.find((item) => item.id === ui.boothId) || null;
}

async function api(method, path, body) {
  if (method !== "GET") stateVersion += 1;
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await res.text());
  if (res.status === 204) return null;
  return res.json();
}

function isIOSDevice() {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalonePwa() {
  return navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

function pushUnavailableMessage() {
  if (!window.isSecureContext) return "보안 연결(HTTPS)에서만 알림을 켤 수 있습니다.";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return "이 브라우저는 푸시 알림을 지원하지 않습니다.";
  }
  if (isIOSDevice() && !isStandalonePwa()) {
    return "iPhone에서는 홈 화면에 추가한 앱에서 알림을 켤 수 있습니다.";
  }
  return "";
}

function activePushIdentity() {
  if (ui.role === "control") return { role: "control" };
  if (ui.role === "booth" && booth()) return { role: "booth", boothId: ui.boothId };
  return null;
}

function pushButton(role) {
  return role === "booth" ? $("#boothPushBtn") : $("#controlPushBtn");
}

function pushStatus(role) {
  return role === "booth" ? $("#boothPushStatus") : $("#controlPushStatus");
}

function setPushFeedback(role, message) {
  const status = pushStatus(role);
  status.textContent = message;
  status.hidden = !message;
}

function setPushControls(label, disabled, message = "") {
  for (const role of ["booth", "control"]) {
    const button = pushButton(role);
    button.textContent = label;
    button.disabled = disabled || pushBusy;
    setPushFeedback(role, message);
  }
}

function decodeVapidKey(value) {
  let normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4) normalized += "=";
  const raw = atob(normalized);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

async function updatePushControls(syncIdentity = false) {
  const unavailable = pushUnavailableMessage();
  if (unavailable) {
    setPushControls(isIOSDevice() && !isStandalonePwa() ? "홈 화면에 추가" : "알림 미지원", true, unavailable);
    return;
  }
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = registration ? await registration.pushManager.getSubscription() : null;
    if (subscription && syncIdentity && Notification.permission === "granted") {
      const identity = activePushIdentity();
      if (identity) {
        try {
          await api("POST", "/api/push/subscriptions", {
            subscription: subscription.toJSON(),
            ...identity,
          });
        } catch {
          setPushControls("알림 켜짐", false, "알림 기기 정보를 갱신하지 못했습니다.");
          return;
        }
      }
    }
    const denied = Notification.permission === "denied";
    setPushControls(
      subscription ? "알림 끄기" : denied ? "알림 권한 차단" : "알림 켜기",
      denied && !subscription,
      denied ? "휴대폰 설정에서 이 앱의 알림을 허용해 주세요." : "",
    );
  } catch {
    setPushControls("알림 켜기", false);
  }
}

async function togglePush() {
  const identity = activePushIdentity();
  if (!identity || pushBusy) return;
  const role = identity.role;
  const unavailable = pushUnavailableMessage();
  if (unavailable) {
    setPushFeedback(role, unavailable);
    return;
  }
  pushBusy = true;
  for (const targetRole of ["booth", "control"]) pushButton(targetRole).disabled = true;
  let feedback = "";
  let createdSubscription = null;
  try {
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    let registration = await navigator.serviceWorker.getRegistration("/");
    let existing = registration ? await registration.pushManager.getSubscription() : null;
    if (existing) {
      await api("DELETE", "/api/push/subscriptions", { endpoint: existing.endpoint });
      await existing.unsubscribe();
      feedback = "알림을 껐습니다.";
    } else if (permission !== "granted") {
      feedback = permission === "denied"
        ? "휴대폰 설정에서 이 앱의 알림을 허용해 주세요."
        : "알림 권한을 허용해야 새 대화를 받을 수 있습니다.";
      return;
    } else {
      registration = registration || await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      const { publicKey } = await api("GET", "/api/push/public-key");
      createdSubscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeVapidKey(publicKey),
      });
      await api("POST", "/api/push/subscriptions", {
        subscription: createdSubscription.toJSON(),
        ...identity,
      });
      createdSubscription = null;
      feedback = "알림을 켰습니다.";
    }
    setOffline(false);
  } catch {
    if (createdSubscription) {
      try { await createdSubscription.unsubscribe(); } catch { /* Allow the next enable attempt. */ }
    }
    feedback = "알림 설정을 저장하지 못했습니다. 연결 상태를 확인해 주세요.";
    setOffline(true);
  } finally {
    pushBusy = false;
    await updatePushControls(false);
    setPushFeedback(role, feedback);
  }
}

function setOffline(off) {
  $("#net").hidden = !off;
}

async function refresh() {
  if (busy || refreshInFlight) return;
  const version = stateVersion;
  refreshInFlight = true;
  try {
    const data = await api("GET", "/api/state");
    if (busy || version !== stateVersion) return;
    ui.data = data;
    setOffline(false);
    paint();
  } catch {
    setOffline(true);
  } finally {
    refreshInFlight = false;
  }
}

function paint() {
  if (ui.role === "booth" && booth()) paintBooth();
  if (ui.role === "control") {
    if (ui.chatBoothId && !$("#chatSheet").hidden) {
      paintChat();
      if (document.visibilityState === "visible") markConversationRead(ui.chatBoothId, "control");
    }
    paintControl();
  }
}

function threadMessages(boothId) {
  return (ui.data.messages || [])
    .filter((item) => item.boothId === boothId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function readCursorKey(role, boothId) {
  return READ_PREFIX + ":" + role + ":" + boothId;
}

function unreadMessages(boothId, role) {
  const items = threadMessages(boothId);
  const cursor = localStorage.getItem(readCursorKey(role, boothId));
  const cursorIndex = cursor ? items.findIndex((item) => item.id === cursor) : -1;
  const incomingFrom = role === "control" ? "booth" : "control";
  return items.slice(cursorIndex + 1).filter((item) => item.from === incomingFrom);
}

function markConversationRead(boothId, role) {
  const items = threadMessages(boothId);
  const latest = items.at(-1);
  if (latest) localStorage.setItem(readCursorKey(role, boothId), latest.id);
  else localStorage.removeItem(readCursorKey(role, boothId));
}

function threadMarkup(items) {
  return items.map((item) => {
    const incoming = item.from === "control";
    const label = incoming ? ` · 관제` : "";
    return `<div class="bubble${incoming ? " in" : ""}">${esc(item.text)}<em>${clock(item.createdAt)}${label}</em></div>`;
  }).join("");
}

function chooseRole(role) {
  ui.role = role;
  localStorage.setItem("bazaar-role", role);
  if (role === "booth") show("setup");
  else show("control");
  paint();
  if (appReady) showPendingNotificationChat();
  void updatePushControls(true);
}

function paintBooth() {
  const current = booth();
  if (!current) return;
  $("#boothName").textContent = current.name;
  $("#boothStaff").textContent = current.staff;
  const pill = $("#levelPill");
  pill.textContent = `${LEVEL_NAME[current.level]} 유지 중`;
  pill.className = `live ${current.level}`;
  for (const lamp of $$(".lamp")) {
    lamp.classList.toggle("on", lamp.dataset.level === current.level);
  }
  const markup = threadMarkup(threadMessages(current.id));
  const thread = $("#thread");
  thread.classList.toggle("has-unread", unreadMessages(current.id, "booth").length > 0);
  if (thread.dataset.markup !== markup) {
    thread.dataset.markup = markup;
    thread.innerHTML = markup;
    thread.scrollTop = thread.scrollHeight;
  }
  if (document.visibilityState === "visible") {
    markConversationRead(current.id, "booth");
    thread.classList.remove("has-unread");
  }
}

function sortedBooths() {
  const list = ui.data.booths.map((item, index) => ({ ...item, index }));
  if (ui.sort === "status") {
    list.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || a.createdAt - b.createdAt);
  } else {
    list.sort((a, b) => a.createdAt - b.createdAt);
  }
  return list;
}

function paintControl() {
  const counts = { full: 0, mid: 0, ok: 0 };
  for (const item of ui.data.booths) counts[item.level] += 1;
  $("#countFull").textContent = counts.full;
  $("#countMid").textContent = counts.mid;
  $("#countOk").textContent = counts.ok;
  $("#reqCount").textContent = ui.data.requests.length;
  const unreadBooths = new Set(ui.data.booths
    .filter((item) => unreadMessages(item.id, "control").length > 0)
    .map((item) => item.id));
  const unreadCount = $("#reqUnreadCount");
  unreadCount.hidden = unreadBooths.size === 0;
  unreadCount.textContent = unreadBooths.size > 99 ? "99+" : String(unreadBooths.size);
  $("#requestsTab").classList.toggle("has-unread", unreadBooths.size > 0);
  $("#requestsTab").classList.toggle("has-open-requests", ui.data.requests.length > 0);
  for (const button of $$("[data-sort]")) {
    button.classList.toggle("on", button.dataset.sort === ui.sort);
  }
  for (const button of $$("[data-tab]")) {
    button.classList.toggle("on", button.dataset.tab === ui.tab);
  }
  $("#boardPane").hidden = ui.tab !== "board";
  $("#requestPane").hidden = ui.tab !== "requests";

  const booths = sortedBooths();
  const boardMarkup = booths.length
    ? '<div class="grid">' + booths.map((item) => {
      const unread = unreadBooths.has(item.id);
      const marker = unread ? '<i class="unread-mark" aria-hidden="true"></i>' : "";
      const label = esc(item.name + " " + item.staff + " 대화 열기");
      return '<button type="button" class="tile ' + item.level + '" data-chat-booth="' + esc(item.id) + '" aria-label="' + label + '">' + marker + '<b>' + esc(item.name) + '</b><small>' + esc(item.staff) + '</small></button>';
    }).join("") + '</div>'
    : `<p class="empty">아직 열린 부스가 없습니다.</p>`;
  const board = $("#board");
  if (board.dataset.markup !== boardMarkup) {
    const top = board.scrollTop;
    board.dataset.markup = boardMarkup;
    board.innerHTML = boardMarkup;
    board.scrollTop = top;
  }

  if (ui.dragging) return;
  const open = ui.data.requests
    .filter((item) => !pendingDelete.has(item.id))
    .sort((a, b) => b.createdAt - a.createdAt);
  const markup = open.length
    ? open.map((item) => {
      const tag = item.status === "doing"
        ? `<span class="tag doing">처리중</span>`
        : `<span class="tag quiet">새 요청</span>`;
      const unread = unreadBooths.has(item.boothId);
      const marker = unread ? '<i class="unread-mark" aria-hidden="true"></i>' : "";
      const actionLabel = unread ? "읽지 않은 대화 열기" : "대화 열기";
      return `<div class="swipe" data-id="${esc(item.id)}"><div class="reveal">처리완료</div><div class="req"><div class="meta"><b>${esc(item.boothName)} · ${esc(item.staff)}</b><span class="meta-actions"><button type="button" class="pencil${unread ? " has-unread" : ""}" data-booth="${esc(item.boothId)}" aria-label="${actionLabel}">${marker}<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 20l4.2-1.1L18.6 8.5 15.5 5.4 5.1 15.8 4 20z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M13.6 7.2l3.2 3.2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button><span>${ago(item.createdAt)}</span></span></div><p>${esc(item.text)}</p>${tag}</div></div>`;
    }).join("")
    : `<p class="empty">남은 요청이 없습니다.</p>`;
  const reqs = $("#reqs");
  if (reqs.dataset.markup !== markup) {
    const top = reqs.scrollTop;
    reqs.dataset.markup = markup;
    reqs.innerHTML = markup;
    reqs.scrollTop = top;
  }
}

async function setLevel(level) {
  const current = booth();
  if (!current || current.level === level || levelPending) return;
  const previousLevel = current.level;
  levelPending = true;
  current.level = level;
  paintBooth();
  busy += 1;
  try {
    await api("PATCH", `/api/booths/${current.id}`, { level });
    setOffline(false);
  } catch {
    current.level = previousLevel;
    paintBooth();
    setOffline(true);
  } finally {
    busy -= 1;
    levelPending = false;
  }
}

async function sendRequest(text) {
  const current = booth();
  if (!current) throw new Error("booth unavailable");
  busy += 1;
  try {
    await api("POST", "/api/requests", { boothId: current.id, text });
  } finally {
    busy -= 1;
  }
  await refresh();
}

function paintChat() {
  const boothId = ui.chatBoothId;
  if (!boothId) return;
  const log = $("#chatLog");
  const markup = threadMarkup(threadMessages(boothId)) || `<p class="empty">아직 대화가 없습니다.</p>`;
  if (log.dataset.markup !== markup) {
    log.dataset.markup = markup;
    log.innerHTML = markup;
    log.scrollTop = log.scrollHeight;
  }
}

function openChat(boothId) {
  ui.chatBoothId = boothId;
  const found = ui.data.booths.find((item) => item.id === boothId);
  const request = ui.data.requests.find((item) => item.boothId === boothId);
  const name = found?.name || request?.boothName || "부스";
  const staff = found?.staff || request?.staff || "";
  $("#chatTitle").textContent = staff ? `${name} · ${staff}` : name;
  $("#chatSheet").hidden = false;
  paintChat();
  if (document.visibilityState === "visible") markConversationRead(boothId, "control");
  paintControl();
}

function clearBoothSession() {
  localStorage.removeItem(sentKey());
  localStorage.removeItem("bazaar-role");
  localStorage.removeItem("bazaar-booth-id");
  ui.role = null;
  ui.boothId = null;
  $("#logoutConfirm").hidden = true;
  show("role");
}

function bindRequests() {
  const root = $("#reqs");
  let drag = null;

  root.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".pencil")) return;
    const card = event.target.closest(".req");
    if (!card) return;
    try { card.setPointerCapture(event.pointerId); } catch { /* synthetic or already gone */ }
    card.classList.add("dragging");
    ui.dragging = true;
    drag = { card, id: card.parentElement.dataset.id, x: event.clientX, y: event.clientY, dx: 0, sliding: false };
  });

  root.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    if (dx > 0 && Math.abs(dx) > Math.abs(dy)) {
      drag.sliding = true;
      drag.dx = dx;
      drag.card.style.transform = `translateX(${dx}px)`;
    }
  });

  async function endDrag() {
    if (!drag) return;
    const { card, id, dx, sliding } = drag;
    drag = null;
    card.classList.remove("dragging");
    ui.dragging = false;
    if (sliding && dx > 88) {
      card.style.transition = "transform .2s ease";
      card.style.transform = "translateX(120%)";
      pendingDelete.add(id);
      ui.data.requests = ui.data.requests.filter((item) => item.id !== id);
      setTimeout(() => paintControl(), 180);
      busy += 1;
      try {
        await api("DELETE", `/api/requests/${id}`);
        setOffline(false);
      } catch {
        pendingDelete.delete(id);
        setOffline(true);
      } finally {
        busy -= 1;
        pendingDelete.delete(id);
      }
      return;
    }
    card.style.transform = "";
    if (!sliding) {
      const item = ui.data.requests.find((row) => row.id === id);
      if (item && item.status !== "doing") {
        const previousStatus = item.status;
        item.status = "doing";
        paintControl();
        busy += 1;
        try {
          await api("PATCH", `/api/requests/${id}`, { status: "doing" });
          setOffline(false);
        } catch {
          item.status = previousStatus;
          paintControl();
          setOffline(true);
        } finally {
          busy -= 1;
        }
      }
    }
  }

  root.addEventListener("click", (event) => {
    const pencil = event.target.closest(".pencil");
    if (!pencil) return;
    event.preventDefault();
    openChat(pencil.dataset.booth);
  });

  root.addEventListener("pointerup", endDrag);
  root.addEventListener("pointercancel", () => {
    if (!drag) return;
    drag.card.style.transform = "";
    drag.card.classList.remove("dragging");
    drag = null;
    ui.dragging = false;
  });
}

function bind() {
  for (const button of $$("[data-role]")) {
    button.addEventListener("click", () => chooseRole(button.dataset.role));
  }

  $("#setupBack").addEventListener("click", () => {
    localStorage.removeItem("bazaar-role");
    ui.role = null;
    show("role");
  });

  $("#setupForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = $("#setupError");
    error.hidden = true;
    form.querySelector(".cta").disabled = true;
    try {
      const created = await api("POST", "/api/booths", {
        name: form.elements.namedItem("name").value,
        staff: form.elements.namedItem("staff").value,
      });
      ui.boothId = created.id;
      localStorage.setItem("bazaar-booth-id", created.id);
      ui.data.booths.push(created);
      setOffline(false);
      show("booth");
      paintBooth();
      if (appReady) showPendingNotificationChat();
      void updatePushControls(true);
    } catch {
      error.hidden = false;
      error.textContent = "부스를 열지 못했습니다. 다시 시도해 주세요.";
      setOffline(true);
    } finally {
      form.querySelector(".cta").disabled = false;
    }
  });

  $("#lamps").addEventListener("click", (event) => {
    const lamp = event.target.closest(".lamp");
    if (lamp) setLevel(lamp.dataset.level);
  });

  $("#composer").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = event.currentTarget.text;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    try {
      await sendRequest(text);
      setOffline(false);
    } catch {
      input.value = text;
      setOffline(true);
    }
  });

  $("#logoutBtn").addEventListener("click", () => {
    const current = booth();
    $("#logoutCopy").textContent = current
      ? `${current.name} · ${current.staff} 부스를 닫고, 이 폰은 역할 선택으로 돌아갑니다.`
      : "이 폰은 역할 선택으로 돌아갑니다.";
    $("#logoutConfirm").hidden = false;
  });
  $("#logoutCancel").addEventListener("click", () => {
    $("#logoutConfirm").hidden = true;
  });
  $("#logoutYes").addEventListener("click", async () => {
    const id = ui.boothId;
    if (!id) { clearBoothSession(); return; }
    const button = $("#logoutYes");
    button.disabled = true;
    try {
      await api("DELETE", `/api/booths/${id}`);
      clearBoothSession();
      setOffline(false);
    } catch {
      setOffline(true);
    } finally {
      button.disabled = false;
    }
  });

  $("#controlLogoutBtn").addEventListener("click", () => {
    $("#controlLogoutConfirm").hidden = false;
  });
  $("#controlLogoutCancel").addEventListener("click", () => {
    $("#controlLogoutConfirm").hidden = true;
  });
  $("#chatClose").addEventListener("click", () => {
    ui.chatBoothId = null;
    $("#chatSheet").hidden = true;
    paintControl();
  });
  $("#boothPushBtn").addEventListener("click", togglePush);
  $("#controlPushBtn").addEventListener("click", togglePush);
  $("#board").addEventListener("click", (event) => {
    const tile = event.target.closest("[data-chat-booth]");
    if (tile) openChat(tile.dataset.chatBooth);
  });
  navigator.serviceWorker?.addEventListener("message", (event) => {
    if (event.data?.type !== "OPEN_CHAT" || !CHAT_ID_PATTERN.test(event.data.boothId || "")) return;
    pendingNotificationChat = event.data.boothId;
    if (appReady) showPendingNotificationChat();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
  });
  $("#chatForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = event.currentTarget.text;
    const text = input.value.trim();
    if (!text || !ui.chatBoothId) return;
    input.value = "";
    busy += 1;
    try {
      const message = await api("POST", "/api/messages", { boothId: ui.chatBoothId, text });
      ui.data.messages = ui.data.messages || [];
      ui.data.messages.push(message);
      setOffline(false);
      paintChat();
    } catch {
      input.value = text;
      setOffline(true);
    } finally {
      busy -= 1;
    }
  });

  $("#controlLogoutYes").addEventListener("click", () => {
    localStorage.removeItem("bazaar-role");
    ui.role = null;
    $("#controlLogoutConfirm").hidden = true;
    show("role");
  });

  for (const button of $$("[data-tab]")) {
    button.addEventListener("click", () => {
      ui.tab = button.dataset.tab;
      paintControl();
    });
  }
  for (const button of $$("[data-sort]")) {
    button.addEventListener("click", () => {
      ui.sort = button.dataset.sort;
      paintControl();
    });
  }
  bindRequests();
}

function clearChatQuery() {
  const url = new URL(window.location.href);
  url.searchParams.delete("chat");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}

function showPendingNotificationChat() {
  const boothId = pendingNotificationChat;
  if (!boothId || !CHAT_ID_PATTERN.test(boothId)) return;
  if (ui.role === "control") {
    ui.tab = "requests";
    openChat(boothId);
  } else if (ui.role === "booth" && ui.boothId === boothId) {
    show("booth");
    paintBooth();
  } else {
    return;
  }
  pendingNotificationChat = null;
  clearChatQuery();
}

async function boot() {
  bind();
  await refresh();
  if (ui.role === "control") show("control");
  else if (ui.role === "booth" && (booth() || ui.boothId)) show("booth");
  else if (ui.role === "booth") show("setup");
  else show("role");
  paint();
  appReady = true;
  showPendingNotificationChat();
  void updatePushControls(true);
  setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 1500);
}

boot();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  }, { once: true });
}

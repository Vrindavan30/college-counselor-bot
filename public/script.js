const messagesEl = document.getElementById("messages");
const form = document.getElementById("chatForm");
const input = document.getElementById("userInput");
const sendBtn = document.getElementById("sendBtn");
const themeToggle = document.getElementById("themeToggle");
const clearChat = document.getElementById("clearChat");
const year = document.getElementById("year");
const suggestions = document.getElementById("suggestions");

year.textContent = new Date().getFullYear();

/* ---- Theme toggle (persist) ---- */
const savedTheme = localStorage.getItem("theme");
if (savedTheme === "light") document.body.classList.add("light");
updateThemeIcon();

themeToggle.addEventListener("click", () => {
  document.body.classList.toggle("light");
  localStorage.setItem("theme", document.body.classList.contains("light") ? "light" : "dark");
  updateThemeIcon();
});
function updateThemeIcon(){
  themeToggle.textContent = document.body.classList.contains("light") ? "🌙" : "☀️";
}

/* ---- chat helpers ---- */
function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

function appendMessage(role, text) {
  const row = el("div", `msg ${role}`);
  const avatar = el("div", "avatar");
  avatar.textContent = role === "user" ? "🙂" : "🤖";
  const bubble = el("div", "bubble");
  bubble.textContent = text;
  row.append(avatar, bubble);
  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendTyping() {
  const row = el("div", "msg assistant");
  row.id = "typingRow";
  const avatar = el("div", "avatar"); avatar.textContent = "🤖";
  const bubble = el("div", "bubble");
  const dots = el("span", "typing");
  dots.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  bubble.appendChild(dots);
  row.append(avatar, bubble);
  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function removeTyping() {
  const t = document.getElementById("typingRow");
  if (t) t.remove();
}

/* ---- suggestions ---- */
suggestions.addEventListener("click", (e) => {
  if (e.target.classList.contains("chip")) {
    input.value = e.target.textContent;
    input.focus();
  }
});

/* ---- Clear chat ---- */
clearChat.addEventListener("click", (e) => {
  e.preventDefault();
  messagesEl.innerHTML = "";
  localStorage.removeItem("chatHistory");
});

/* ---- Load previous session ---- */
(function restore(){
  const saved = JSON.parse(localStorage.getItem("chatHistory") || "[]");
  for (const m of saved) appendMessage(m.role, m.text);
})();

function save(role, text){
  const saved = JSON.parse(localStorage.getItem("chatHistory") || "[]");
  saved.push({ role, text });
  localStorage.setItem("chatHistory", JSON.stringify(saved.slice(-100))); // cap
}

/* ---- Send flow ---- */
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  appendMessage("user", text);
  save("user", text);
  input.value = "";
  input.focus();
  sendBtn.disabled = true;
  appendTyping();

  try {
    const r = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text })
    });
    const data = await r.json();
    removeTyping();
    const reply = data.reply || "Sorry, I didn’t get that.";
    appendMessage("assistant", reply);
    save("assistant", reply);
  } catch (err) {
    removeTyping();
    appendMessage("assistant", "⚠️ Network error. Please try again.");
  } finally {
    sendBtn.disabled = false;
  }

  
});

// Sidebar toggle
const sidebar = document.getElementById('sidebar');
const openBtn = document.getElementById('sidebarOpen');
const closeBtn = document.getElementById('sidebarClose');

if (openBtn) openBtn.addEventListener('click', () => sidebar.classList.add('open'));
if (closeBtn) closeBtn.addEventListener('click', () => sidebar.classList.remove('open'));

document.addEventListener('click', (e) => {
  if (!sidebar.classList.contains('open')) return;
  if (!sidebar.contains(e.target) && !openBtn.contains(e.target)) {
    sidebar.classList.remove('open');
  }
});

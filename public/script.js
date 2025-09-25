async function sendMessage() {
  const input = document.getElementById("userInput");
  const chatbox = document.getElementById("chatbox");
  const userMsg = input.value.trim();
  if (!userMsg) return;
  chatbox.innerHTML += `<div class="user"><b>You:</b> ${userMsg}</div>`;
  input.value = "";
  try {
    const response = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: userMsg })
    });
    const data = await response.json();
    chatbox.innerHTML += `<div class="bot"><b>Bot:</b> ${(data.reply || "No reply.").replaceAll("\n","<br>")}</div>`;
  } catch (e) {
    chatbox.innerHTML += `<div class="bot"><b>Bot:</b> Error contacting server.</div>`;
  }
  chatbox.scrollTop = chatbox.scrollHeight;
}

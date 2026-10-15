// Encrypted In-Meeting Chat Manager

class ChatManager {
  constructor(wsSignaling, currentUser, chatContainer, onUnreadCountChange) {
    this.ws = wsSignaling;
    this.currentUser = currentUser;
    this.container = chatContainer;
    this.onUnreadCountChange = onUnreadCountChange;
    this.unreadCount = 0;
    this.isOpen = false;
  }

  setOpenState(isOpen) {
    this.isOpen = isOpen;
    if (isOpen) {
      this.unreadCount = 0;
      if (this.onUnreadCountChange) this.onUnreadCountChange(0);
      this.scrollToBottom();
    }
  }

  async sendMessage(text) {
    if (!text || !text.trim()) return;

    const payloadObj = {
      text: text.trim(),
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    };

    // Encrypt payload if CryptoE2EE is ready
    let encryptedData = { ciphertext: JSON.stringify(payloadObj), iv: null, is_encrypted: false };
    if (typeof CryptoE2EE !== "undefined" && CryptoE2EE.isInitialized) {
      encryptedData = await CryptoE2EE.encrypt(payloadObj);
    }

    const message = {
      type: "chat_message",
      payload: encryptedData.ciphertext,
      iv: encryptedData.iv,
      is_encrypted: encryptedData.is_encrypted,
      timestamp: payloadObj.timestamp
    };

    this.ws.send(JSON.stringify(message));
  }

  async handleIncomingMessage(data) {
    let payload = null;

    if (data.is_encrypted && data.iv && typeof CryptoE2EE !== "undefined" && CryptoE2EE.isInitialized) {
      payload = await CryptoE2EE.decrypt(data.payload, data.iv);
    } else {
      try {
        payload = typeof data.payload === "string" ? JSON.parse(data.payload) : data.payload;
      } catch {
        payload = { text: data.payload, timestamp: data.timestamp };
      }
    }

    if (!payload) return;

    const isMine = data.peer_id === this.currentUser.peer_id;
    this.renderBubble(data.user, payload.text, payload.timestamp || data.timestamp, isMine, data.is_encrypted);

    if (!isMine && !this.isOpen) {
      this.unreadCount++;
      if (this.onUnreadCountChange) this.onUnreadCountChange(this.unreadCount);
    }

    this.scrollToBottom();
  }

  renderBubble(user, text, time, isMine, isEncrypted) {
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${isMine ? "mine" : "theirs"}`;

    const senderName = isMine ? "You" : (user.display_name || "Participant");
    const securityIcon = isEncrypted ? "🔒 " : "";

    bubble.innerHTML = `
      <div class="chat-bubble-sender">
        <span>${securityIcon}${escapeHtml(senderName)}</span>
        <span class="chat-bubble-time">${time || ""}</span>
      </div>
      <div class="chat-bubble-text">${escapeHtml(text)}</div>
    `;

    this.container.appendChild(bubble);
  }

  scrollToBottom() {
    this.container.scrollTop = this.container.scrollHeight;
  }
}

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.innerText = str;
  return div.innerHTML;
}

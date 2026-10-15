// NexusMeet Conference Coordinator & UI Orchestrator

document.addEventListener("DOMContentLoaded", async () => {
  // 1. Determine Room ID from URL path: /room/<roomId>
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const roomId = pathParts[pathParts.length - 1];

  if (!roomId || roomId === "room") {
    alert("Invalid Room ID. Redirecting to home.");
    window.location.href = "/";
    return;
  }

  // 2. Load User Profile (Authenticated or Guest)
  const currentUser = Auth.getOrCreateGuest();
  currentUser.peer_id = "peer_" + Math.random().toString(36).substring(2, 9);

  // Update header meta
  const roomTitleEl = document.getElementById("roomTitle");
  if (roomTitleEl) roomTitleEl.innerText = `Room: ${roomId}`;
  const roomTagEl = document.getElementById("roomTag");
  if (roomTagEl) roomTagEl.innerText = `#${roomId}`;

  // 3. Verify Room details and optional passcode protection
  let roomPasscode = null;
  try {
    const roomRes = await fetch(`/api/rooms/${roomId}`);
    const roomData = await roomRes.json();
    if (roomData.is_protected) {
      roomPasscode = prompt("This room is password protected. Enter passcode:");
      const verifyRes = await fetch(`/api/rooms/${roomId}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode: roomPasscode })
      });
      const verifyData = await verifyRes.json();
      if (!verifyData.valid) {
        alert(verifyData.message || "Invalid passcode.");
        window.location.href = "/";
        return;
      }
    }
  } catch (e) {
    console.warn("Could not fetch room metadata:", e);
  }

  // 4. Initialize End-to-End Encryption
  // The shared secret is derived from the room passcode or room ID
  await CryptoE2EE.init(roomPasscode || roomId);

  // 5. Connect WebSocket Signaling
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const token = Auth.getToken() || "";
  const wsUrl = `${protocol}//${window.location.host}/ws/signal/${roomId}?peer_id=${currentUser.peer_id}&display_name=${encodeURIComponent(currentUser.display_name)}&avatar_color=${encodeURIComponent(currentUser.avatar_color)}&token=${token}`;

  const ws = new WebSocket(wsUrl);

  // References to UI elements
  const videoGrid = document.getElementById("videoGrid");
  const localVideoCard = document.getElementById("localVideoCard");
  const localVideo = document.getElementById("localVideo");
  const localAvatar = document.getElementById("localAvatar");
  const localAvatarCircle = document.getElementById("localAvatarCircle");
  const localUserName = document.getElementById("localUserName");
  const localAudioBadge = document.getElementById("localAudioBadge");

  // Populate local card info
  if (localUserName) localUserName.innerText = `${currentUser.display_name} (You)`;
  if (localAvatarCircle) {
    localAvatarCircle.style.backgroundColor = currentUser.avatar_color;
    localAvatarCircle.innerText = currentUser.display_name.charAt(0).toUpperCase();
  }

  // 6. Instantiate Managers
  let webrtc = null;
  let whiteboard = null;
  let chatManager = null;
  let fileSharer = null;

  // Track state
  let isAudioEnabled = true;
  let isVideoEnabled = true;
  let isScreenSharing = false;
  let pinnedCardId = null;

  ws.onopen = async () => {
    console.log("Connected to Signaling Server");
    showToast("Connected to room signaling server");

    // Fetch ICE servers
    let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
    try {
      const iceRes = await fetch("/api/config/ice");
      const iceData = await iceRes.json();
      if (iceData.ice_servers) iceServers = iceData.ice_servers;
    } catch (e) {
      console.warn("Using default STUN server");
    }

    // Initialize WebRTC
    webrtc = new WebRTCManager(
      ws,
      iceServers,
      (peerId, stream, user) => handleRemoteStreamAdded(peerId, stream, user),
      (peerId) => handleRemoteStreamRemoved(peerId),
      (peerId, data) => {
        if (fileSharer) fileSharer.handleIncomingData(peerId, data);
      }
    );

    webrtc.onActiveSpeaker = (id, isSpeaking) => {
      const card = id === "local" ? localVideoCard : document.getElementById(`video_${id}`);
      if (card) {
        if (isSpeaking) card.classList.add("speaking");
        else card.classList.remove("speaking");
      }
    };

    // Request camera and microphone
    const localStream = await webrtc.initLocalMedia(true, true);
    if (localVideo) {
      localVideo.srcObject = localStream;
      localVideo.play().catch(() => {});
    }

    // Initialize Whiteboard
    const canvas = document.getElementById("whiteboardCanvas");
    if (canvas) {
      whiteboard = new Whiteboard(canvas, ws, roomId, currentUser);
      setupWhiteboardToolbar(whiteboard);
    }

    // Initialize Chat
    const chatContainer = document.getElementById("chatMessages");
    const unreadBadge = document.getElementById("chatUnreadBadge");
    chatManager = new ChatManager(ws, currentUser, chatContainer, (count) => {
      if (unreadBadge) {
        unreadBadge.innerText = count;
        unreadBadge.style.display = count > 0 ? "flex" : "none";
      }
    });

    // Initialize File Sharer
    fileSharer = new FileSharer(
      webrtc,
      ws,
      (fileId, percent, isUpload, meta) => updateFileProgress(fileId, percent, isUpload, meta),
      (fileObj) => renderReceivedFileCard(fileObj)
    );
  };

  // 7. Handle WebSocket Messages
  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case "room_state":
          // Existing peers in room: create WebRTC offer to each
          updateParticipantsList(data.peers);
          if (data.peers && webrtc) {
            for (const p of data.peers) {
              await webrtc.createOffer(p.peer_id, p.user);
            }
          }
          // Load whiteboard history
          if (data.whiteboard_history && whiteboard) {
            for (const stroke of data.whiteboard_history) {
              whiteboard.handleRemoteStroke(stroke);
            }
          }
          break;

        case "peer_joined":
          showToast(`${data.user.display_name} joined the meeting`);
          addParticipantToList(data.peer_id, data.user);
          // Wait for incoming offer or initiate
          break;

        case "offer":
          if (webrtc) {
            await webrtc.handleOffer(data.sender, data.sdp, data.user);
          }
          break;

        case "answer":
          if (webrtc) {
            await webrtc.handleAnswer(data.sender, data.sdp);
          }
          break;

        case "ice_candidate":
          if (webrtc) {
            await webrtc.handleIceCandidate(data.sender, data.candidate);
          }
          break;

        case "media_state":
          handlePeerMediaState(data);
          break;

        case "peer_left":
          showToast(`${data.user.display_name || "A participant"} left`);
          if (webrtc) webrtc.removePeer(data.peer_id);
          removeParticipantFromList(data.peer_id);
          if (whiteboard) whiteboard.removeRemoteCursor(data.peer_id);
          break;

        case "whiteboard_draw":
          if (whiteboard) whiteboard.handleRemoteStroke(data.data);
          break;

        case "whiteboard_clear":
          if (whiteboard) whiteboard.handleRemoteClear();
          break;

        case "whiteboard_cursor":
          if (whiteboard) whiteboard.handleRemoteCursor(data.peer_id, data.user, data.x, data.y);
          break;

        case "chat_message":
          if (chatManager) chatManager.handleIncomingMessage(data);
          break;

        case "file_announce":
          if (fileSharer) fileSharer.handleFileAnnounce(data);
          showToast(`File shared: ${data.file_name}`);
          break;

        case "kicked":
          alert(data.reason || "You were removed from the room.");
          window.location.href = "/";
          break;

        case "force_mute":
          if (webrtc && isAudioEnabled) {
            toggleMic();
            showToast("The host muted your microphone");
          }
          break;
      }
    } catch (e) {
      console.error("Error processing websocket message:", e);
    }
  };

  ws.onclose = () => {
    console.log("WebSocket connection closed.");
  };

  // ----------------- REMOTE MEDIA TILES -----------------

  function handleRemoteStreamAdded(peerId, stream, user) {
    let card = document.getElementById(`video_${peerId}`);
    if (!card) {
      card = document.createElement("div");
      card.className = "video-card";
      card.id = `video_${peerId}`;

      card.innerHTML = `
        <video id="vid_el_${peerId}" autoplay playsinline></video>
        <div class="avatar-placeholder" id="avatar_${peerId}" style="display: none;">
          <div class="avatar-circle" style="background-color: ${user.avatar_color || '#6366F1'};">
            ${(user.display_name || 'U').charAt(0).toUpperCase()}
          </div>
          <span>${escapeHtml(user.display_name || 'Participant')}</span>
        </div>
        <div class="video-card-overlay">
          <div class="video-user-badge">
            <span id="name_${peerId}">${escapeHtml(user.display_name || 'Participant')}</span>
            <span id="audio_badge_${peerId}" style="display:none; color: var(--danger);">🔇</span>
          </div>
          <div class="video-actions">
            <button class="video-btn-sm" title="Pin Video" onclick="togglePinCard('video_${peerId}')">📌</button>
            <button class="video-btn-sm" title="Fullscreen" onclick="toggleFullscreen('video_${peerId}')">⛶</button>
          </div>
        </div>
      `;
      videoGrid.appendChild(card);
    }

    const videoEl = document.getElementById(`vid_el_${peerId}`);
    if (videoEl) {
      videoEl.srcObject = stream;
      videoEl.play().catch(() => {});
    }
  }

  function handleRemoteStreamRemoved(peerId) {
    const card = document.getElementById(`video_${peerId}`);
    if (card) card.remove();
  }

  function handlePeerMediaState(data) {
    const card = document.getElementById(`video_${data.peer_id}`);
    if (!card) return;

    const avatar = document.getElementById(`avatar_${data.peer_id}`);
    const audioBadge = document.getElementById(`audio_badge_${data.peer_id}`);

    if (avatar) avatar.style.display = data.video_off ? "flex" : "none";
    if (audioBadge) audioBadge.style.display = data.audio_muted ? "inline" : "none";
    if (data.screen_sharing) card.classList.add("screen-share");
    else card.classList.remove("screen-share");
  }

  // ----------------- TOOLBAR CONTROLS -----------------

  const toggleMicBtn = document.getElementById("toggleMicBtn");
  const toggleCamBtn = document.getElementById("toggleCamBtn");
  const toggleScreenBtn = document.getElementById("toggleScreenBtn");
  const toggleWbBtn = document.getElementById("toggleWbBtn");
  const toggleChatBtn = document.getElementById("toggleChatBtn");
  const toggleParticipantsBtn = document.getElementById("toggleParticipantsBtn");
  const toggleFilesBtn = document.getElementById("toggleFilesBtn");
  const leaveBtn = document.getElementById("leaveBtn");

  function toggleMic() {
    isAudioEnabled = !isAudioEnabled;
    if (webrtc) webrtc.toggleAudio(isAudioEnabled);
    if (toggleMicBtn) {
      toggleMicBtn.classList.toggle("muted", !isAudioEnabled);
      toggleMicBtn.innerHTML = isAudioEnabled
        ? `<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/></svg>`
        : `<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2"/></svg>`;
    }
    if (localAudioBadge) localAudioBadge.style.display = isAudioEnabled ? "none" : "inline";

    // Broadcast state
    ws.send(JSON.stringify({
      type: "media_state",
      audio_muted: !isAudioEnabled,
      video_off: !isVideoEnabled,
      screen_sharing: isScreenSharing
    }));
  }

  function toggleCam() {
    isVideoEnabled = !isVideoEnabled;
    if (webrtc) webrtc.toggleVideo(isVideoEnabled);
    if (toggleCamBtn) {
      toggleCamBtn.classList.toggle("off", !isVideoEnabled);
      toggleCamBtn.innerHTML = isVideoEnabled
        ? `<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>`
        : `<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/></svg>`;
    }
    if (localAvatar) localAvatar.style.display = isVideoEnabled ? "none" : "flex";

    ws.send(JSON.stringify({
      type: "media_state",
      audio_muted: !isAudioEnabled,
      video_off: !isVideoEnabled,
      screen_sharing: isScreenSharing
    }));
  }

  async function toggleScreen() {
    if (!webrtc) return;
    const active = await webrtc.toggleScreenShare();
    isScreenSharing = active;
    if (toggleScreenBtn) toggleScreenBtn.classList.toggle("active", active);

    if (localVideo) {
      localVideo.srcObject = active ? webrtc.screenStream : webrtc.localStream;
      localVideo.play().catch(() => {});
    }

    if (active) localVideoCard.classList.add("screen-share");
    else localVideoCard.classList.remove("screen-share");

    ws.send(JSON.stringify({
      type: "media_state",
      audio_muted: !isAudioEnabled,
      video_off: !isVideoEnabled,
      screen_sharing: isScreenSharing
    }));
  }

  if (toggleMicBtn) toggleMicBtn.addEventListener("click", toggleMic);
  if (toggleCamBtn) toggleCamBtn.addEventListener("click", toggleCam);
  if (toggleScreenBtn) toggleScreenBtn.addEventListener("click", toggleScreen);

  // Whiteboard overlay
  const wbOverlay = document.getElementById("whiteboardOverlay");
  if (toggleWbBtn && wbOverlay) {
    toggleWbBtn.addEventListener("click", () => {
      const isVisible = wbOverlay.classList.toggle("visible");
      toggleWbBtn.classList.toggle("active", isVisible);
      if (isVisible && whiteboard) {
        whiteboard.handleResize();
      }
    });
  }

  // Sidebar drawers (Chat, Participants, Files)
  const sidebar = document.getElementById("roomSidebar");
  const tabChat = document.getElementById("tabContentChat");
  const tabParticipants = document.getElementById("tabContentParticipants");
  const tabFiles = document.getElementById("tabContentFiles");

  const tabBtnChat = document.getElementById("tabBtnChat");
  const tabBtnParticipants = document.getElementById("tabBtnParticipants");
  const tabBtnFiles = document.getElementById("tabBtnFiles");

  function openSidebarTab(targetTab) {
    sidebar.classList.remove("collapsed");

    [tabChat, tabParticipants, tabFiles].forEach(t => t && t.classList.remove("active"));
    [tabBtnChat, tabBtnParticipants, tabBtnFiles].forEach(b => b && b.classList.remove("active"));

    if (targetTab === "chat") {
      tabChat.classList.add("active");
      tabBtnChat.classList.add("active");
      if (chatManager) chatManager.setOpenState(true);
    } else if (targetTab === "participants") {
      tabParticipants.classList.add("active");
      tabBtnParticipants.classList.add("active");
    } else if (targetTab === "files") {
      tabFiles.classList.add("active");
      tabBtnFiles.classList.add("active");
    }
  }

  function toggleSidebar(targetTab) {
    if (!sidebar.classList.contains("collapsed")) {
      // If clicking same tab, collapse it
      const currentActive = tabChat.classList.contains("active") ? "chat" :
                            tabParticipants.classList.contains("active") ? "participants" : "files";
      if (currentActive === targetTab) {
        sidebar.classList.add("collapsed");
        if (chatManager) chatManager.setOpenState(false);
        return;
      }
    }
    openSidebarTab(targetTab);
  }

  if (toggleChatBtn) toggleChatBtn.addEventListener("click", () => toggleSidebar("chat"));
  if (toggleParticipantsBtn) toggleParticipantsBtn.addEventListener("click", () => toggleSidebar("participants"));
  if (toggleFilesBtn) toggleFilesBtn.addEventListener("click", () => toggleSidebar("files"));

  if (tabBtnChat) tabBtnChat.addEventListener("click", () => openSidebarTab("chat"));
  if (tabBtnParticipants) tabBtnParticipants.addEventListener("click", () => openSidebarTab("participants"));
  if (tabBtnFiles) tabBtnFiles.addEventListener("click", () => openSidebarTab("files"));

  const closeSidebarBtn = document.getElementById("closeSidebarBtn");
  if (closeSidebarBtn) {
    closeSidebarBtn.addEventListener("click", () => {
      sidebar.classList.add("collapsed");
      if (chatManager) chatManager.setOpenState(false);
    });
  }

  // Chat message send
  const chatInput = document.getElementById("chatInput");
  const chatSendBtn = document.getElementById("chatSendBtn");

  function doSendChat() {
    if (!chatInput) return;
    const text = chatInput.value;
    if (text && text.trim()) {
      if (chatManager) chatManager.sendMessage(text);
      chatInput.value = "";
    }
  }

  if (chatSendBtn) chatSendBtn.addEventListener("click", doSendChat);
  if (chatInput) {
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSendChat();
      }
    });
  }

  // File Dropzone & Input
  const fileDropzone = document.getElementById("fileDropzone");
  const fileInput = document.getElementById("fileInput");

  if (fileDropzone && fileInput) {
    fileDropzone.addEventListener("click", () => fileInput.click());
    fileDropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      fileDropzone.style.borderColor = "var(--primary)";
    });
    fileDropzone.addEventListener("dragleave", () => {
      fileDropzone.style.borderColor = "var(--border)";
    });
    fileDropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      fileDropzone.style.borderColor = "var(--border)";
      if (e.dataTransfer.files.length) {
        handleFileSend(e.dataTransfer.files[0]);
      }
    });
    fileInput.addEventListener("change", () => {
      if (fileInput.files.length) {
        handleFileSend(fileInput.files[0]);
      }
    });
  }

  function handleFileSend(file) {
    if (!file || !fileSharer) return;
    fileSharer.sendFile(file, currentUser);
    showToast(`Sending: ${file.name}`);
  }

  // Leave meeting
  if (leaveBtn) {
    leaveBtn.addEventListener("click", () => {
      if (confirm("Are you sure you want to leave the meeting?")) {
        if (webrtc) webrtc.destroy();
        if (ws) ws.close();
        window.location.href = "/";
      }
    });
  }

  // Copy meeting link
  const copyLinkBtn = document.getElementById("copyLinkBtn");
  if (copyLinkBtn) {
    copyLinkBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(window.location.href);
      showToast("Meeting link copied to clipboard!");
    });
  }

  // Window pin / fullscreen helpers
  window.togglePinCard = (cardId) => {
    const card = document.getElementById(cardId);
    if (!card) return;
    if (pinnedCardId === cardId) {
      card.classList.remove("pinned");
      pinnedCardId = null;
    } else {
      document.querySelectorAll(".video-card").forEach(c => c.classList.remove("pinned"));
      card.classList.add("pinned");
      pinnedCardId = cardId;
    }
  };

  window.toggleFullscreen = (cardId) => {
    const card = document.getElementById(cardId);
    if (card) {
      if (!document.fullscreenElement) card.requestFullscreen().catch(() => {});
      else document.exitFullscreen().catch(() => {});
    }
  };
});

// ----------------- PARTICIPANT LIST UI -----------------

function updateParticipantsList(peers) {
  const listEl = document.getElementById("participantsList");
  const countEl = document.getElementById("participantsCount");
  if (!listEl) return;

  listEl.innerHTML = "";
  // Local user first
  const me = Auth.getUser() || Auth.getOrCreateGuest();
  renderParticipantRow(listEl, "me", me, true);

  if (peers) {
    peers.forEach(p => renderParticipantRow(listEl, p.peer_id, p.user, false));
    if (countEl) countEl.innerText = peers.length + 1;
  }
}

function addParticipantToList(peerId, user) {
  const listEl = document.getElementById("participantsList");
  const countEl = document.getElementById("participantsCount");
  if (!listEl) return;
  renderParticipantRow(listEl, peerId, user, false);
  if (countEl) countEl.innerText = listEl.children.length;
}

function removeParticipantFromList(peerId) {
  const row = document.getElementById(`part_row_${peerId}`);
  const countEl = document.getElementById("participantsCount");
  if (row) row.remove();
  const listEl = document.getElementById("participantsList");
  if (listEl && countEl) countEl.innerText = listEl.children.length;
}

function renderParticipantRow(container, id, user, isMe) {
  const row = document.createElement("div");
  row.className = "participant-item";
  row.id = `part_row_${id}`;

  const displayName = isMe ? `${user.display_name} (You)` : user.display_name;
  const roleBadge = user.is_host ? `<span class="participant-role">Host</span>` : "";

  row.innerHTML = `
    <div class="participant-info">
      <div class="user-nav-avatar" style="background-color: ${user.avatar_color || '#6366F1'}; width: 28px; height: 28px;">
        ${(user.display_name || 'U').charAt(0).toUpperCase()}
      </div>
      <div>
        <div style="font-size: 0.85rem; font-weight: 600;">${escapeHtml(displayName)}</div>
      </div>
    </div>
    <div>${roleBadge}</div>
  `;
  container.appendChild(row);
}

// ----------------- FILE PROGRESS UI -----------------

function updateFileProgress(fileId, percent, isUpload, meta) {
  const fileList = document.getElementById("fileList");
  if (!fileList) return;

  let card = document.getElementById(`file_progress_${fileId}`);
  if (!card) {
    card = document.createElement("div");
    card.className = "file-card";
    card.id = `file_progress_${fileId}`;
    const filename = meta ? meta.file_name : "Transferring file...";
    card.innerHTML = `
      <div class="file-info">
        <div class="file-name">${escapeHtml(filename)}</div>
        <div class="file-size" id="file_size_${fileId}">${isUpload ? 'Uploading' : 'Receiving'}... ${percent}%</div>
        <div class="progress-bar-container">
          <div class="progress-bar-fill" id="fill_${fileId}" style="width: ${percent}%;"></div>
        </div>
      </div>
    `;
    fileList.prepend(card);
  }

  const fill = document.getElementById(`fill_${fileId}`);
  const label = document.getElementById(`file_size_${fileId}`);
  if (fill) fill.style.width = `${percent}%`;
  if (label) label.innerText = `${isUpload ? 'Uploading' : 'Receiving'}... ${percent}%`;
}

function renderReceivedFileCard(fileObj) {
  const fileList = document.getElementById("fileList");
  if (!fileList) return;

  const card = document.getElementById(`file_progress_${fileObj.fileId}`) || document.createElement("div");
  card.className = "file-card";
  card.id = `file_progress_${fileObj.fileId}`;

  card.innerHTML = `
    <div class="file-info">
      <div class="file-name">📄 ${escapeHtml(fileObj.name)}</div>
      <div class="file-size">${formatBytes(fileObj.size)} • from ${escapeHtml(fileObj.sender ? fileObj.sender.display_name : 'Peer')}</div>
    </div>
    <a href="${fileObj.url}" download="${fileObj.name}" class="btn btn-primary" style="padding: 0.4rem 0.75rem; font-size: 0.8rem;">
      Download
    </a>
  `;
  if (!card.parentElement) fileList.prepend(card);
}

// ----------------- WHITEBOARD TOOLBAR SETUP -----------------

function setupWhiteboardToolbar(wb) {
  const tools = ["pen", "highlighter", "eraser", "line", "arrow", "rect", "circle", "text"];
  tools.forEach(tool => {
    const btn = document.getElementById(`wb_tool_${tool}`);
    if (btn) {
      btn.addEventListener("click", () => {
        tools.forEach(t => {
          const b = document.getElementById(`wb_tool_${t}`);
          if (b) b.classList.remove("active");
        });
        btn.classList.add("active");
        wb.currentTool = tool;
      });
    }
  });

  // Undo / Redo / Clear / Export
  const undoBtn = document.getElementById("wb_undo");
  const redoBtn = document.getElementById("wb_redo");
  const clearBtn = document.getElementById("wb_clear");
  const exportBtn = document.getElementById("wb_export");

  if (undoBtn) undoBtn.addEventListener("click", () => wb.undo());
  if (redoBtn) redoBtn.addEventListener("click", () => wb.redo());
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (confirm("Clear the entire whiteboard for all participants?")) {
        wb.clear(true);
      }
    });
  }
  if (exportBtn) exportBtn.addEventListener("click", () => wb.exportImage());

  // Color Swatches
  const swatches = document.querySelectorAll(".color-swatch");
  swatches.forEach(swatch => {
    swatch.addEventListener("click", () => {
      swatches.forEach(s => s.classList.remove("active"));
      swatch.classList.add("active");
      wb.currentColor = swatch.dataset.color;
    });
  });

  // Stroke Width Slider
  const widthSlider = document.getElementById("wb_stroke_width");
  if (widthSlider) {
    widthSlider.addEventListener("input", (e) => {
      wb.currentWidth = parseInt(e.target.value, 10);
    });
  }
}

// ----------------- TOAST HELPERS -----------------

function showToast(message) {
  const container = document.getElementById("toastContainer") || document.body;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `<span>💬</span> <span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.3s ease";
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function formatBytes(bytes) {
  if (!bytes) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.innerText = str;
  return div.innerHTML;
}

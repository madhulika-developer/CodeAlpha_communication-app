// WebRTC Mesh Manager for Multi-Party Video & Media Streaming

class WebRTCManager {
  constructor(signalingSocket, iceServers, onRemoteStreamAdded, onRemoteStreamRemoved, onDataChannelMessage) {
    this.ws = signalingSocket;
    this.iceServers = iceServers || [{ urls: "stun:stun.l.google.com:19302" }];
    this.onRemoteStreamAdded = onRemoteStreamAdded;
    this.onRemoteStreamRemoved = onRemoteStreamRemoved;
    this.onDataChannelMessage = onDataChannelMessage;

    this.localStream = null;
    this.screenStream = null;
    this.isScreenSharing = false;

    // peer_id -> { pc: RTCPeerConnection, dc: RTCDataChannel, user: Object }
    this.peers = new Map();

    // Audio level analysis for active speaker detection
    this.audioContext = null;
    this.analyser = null;
    this.speakerInterval = null;
    this.onActiveSpeaker = null;
  }

  async initLocalMedia(video = true, audio = true) {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: video ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
        audio: audio ? { echoCancellation: true, noiseSuppression: true } : false
      });
      this.setupAudioAnalysis();
      return this.localStream;
    } catch (err) {
      console.warn("User media error (devices may be disabled/blocked):", err);
      // Fallback: create empty dummy stream so the user can still participate as listener
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#1e293b";
      ctx.fillRect(0, 0, 640, 480);
      this.localStream = canvas.captureStream(10);
      return this.localStream;
    }
  }

  setupAudioAnalysis() {
    if (!this.localStream || !this.localStream.getAudioTracks().length) return;
    try {
      window.AudioContext = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioContext();
      const source = this.audioContext.createMediaStreamSource(this.localStream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);

      const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      this.speakerInterval = setInterval(() => {
        if (!this.analyser || !this.onActiveSpeaker) return;
        this.analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        this.onActiveSpeaker("local", avg > 25);
      }, 250);
    } catch (e) {
      console.warn("AudioContext analyzer setup failed:", e);
    }
  }

  createPeerConnection(peerId, userInfo, isInitiator = false) {
    if (this.peers.has(peerId)) {
      return this.peers.get(peerId).pc;
    }

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peerEntry = { pc, dc: null, user: userInfo };
    this.peers.set(peerId, peerEntry);

    // Add local media tracks to peer connection
    const currentStream = this.isScreenSharing && this.screenStream ? this.screenStream : this.localStream;
    if (currentStream) {
      currentStream.getTracks().forEach(track => {
        pc.addTrack(track, currentStream);
      });
    }

    // ICE Candidate handling
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.ws.send(JSON.stringify({
          type: "ice_candidate",
          target: peerId,
          candidate: event.candidate
        }));
      }
    };

    // Remote Track handling
    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (this.onRemoteStreamAdded) {
        this.onRemoteStreamAdded(peerId, remoteStream, userInfo);
      }
    };

    // Data Channel for high-speed P2P files and messaging
    if (isInitiator) {
      const dc = pc.createDataChannel("nexus-datachannel", { ordered: true });
      this.setupDataChannel(peerId, dc);
      peerEntry.dc = dc;
    } else {
      pc.ondatachannel = (event) => {
        this.setupDataChannel(peerId, event.channel);
        peerEntry.dc = event.channel;
      };
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "disconnected" || pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.removePeer(peerId);
      }
    };

    return pc;
  }

  setupDataChannel(peerId, dc) {
    dc.binaryType = "arraybuffer";
    dc.onopen = () => console.log(`DataChannel open with peer: ${peerId}`);
    dc.onmessage = (event) => {
      if (this.onDataChannelMessage) {
        this.onDataChannelMessage(peerId, event.data);
      }
    };
  }

  async createOffer(peerId, userInfo) {
    const pc = this.createPeerConnection(peerId, userInfo, true);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.ws.send(JSON.stringify({
        type: "offer",
        target: peerId,
        sdp: pc.localDescription
      }));
    } catch (err) {
      console.error(`Failed to create offer for ${peerId}:`, err);
    }
  }

  async handleOffer(peerId, sdp, userInfo) {
    const pc = this.createPeerConnection(peerId, userInfo, false);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.ws.send(JSON.stringify({
        type: "answer",
        target: peerId,
        sdp: pc.localDescription
      }));
    } catch (err) {
      console.error(`Failed to handle offer from ${peerId}:`, err);
    }
  }

  async handleAnswer(peerId, sdp) {
    const peer = this.peers.get(peerId);
    if (peer && peer.pc) {
      try {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      } catch (err) {
        console.error(`Failed to set remote description for ${peerId}:`, err);
      }
    }
  }

  async handleIceCandidate(peerId, candidate) {
    const peer = this.peers.get(peerId);
    if (peer && peer.pc) {
      try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error(`Failed to add ICE candidate for ${peerId}:`, err);
      }
    }
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      if (peer.dc) peer.dc.close();
      if (peer.pc) peer.pc.close();
      this.peers.delete(peerId);
      if (this.onRemoteStreamRemoved) {
        this.onRemoteStreamRemoved(peerId);
      }
    }
  }

  toggleAudio(enabled) {
    if (!this.localStream) return false;
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = enabled !== undefined ? enabled : !audioTrack.enabled;
      return audioTrack.enabled;
    }
    return false;
  }

  toggleVideo(enabled) {
    if (!this.localStream) return false;
    const videoTrack = this.localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = enabled !== undefined ? enabled : !videoTrack.enabled;
      return videoTrack.enabled;
    }
    return false;
  }

  async toggleScreenShare() {
    if (this.isScreenSharing) {
      this.stopScreenShare();
      return false;
    } else {
      return await this.startScreenShare();
    }
  }

  async startScreenShare() {
    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: "always" },
        audio: false
      });

      const screenTrack = this.screenStream.getVideoTracks()[0];
      screenTrack.onended = () => this.stopScreenShare();

      // Replace track on all peer connections
      for (const [peerId, peer] of this.peers.entries()) {
        const senders = peer.pc.getSenders();
        const videoSender = senders.find(s => s.track && s.track.kind === "video");
        if (videoSender) {
          videoSender.replaceTrack(screenTrack);
        }
      }

      this.isScreenSharing = true;
      return true;
    } catch (err) {
      console.warn("Screen sharing cancelled or not supported:", err);
      return false;
    }
  }

  stopScreenShare() {
    if (!this.isScreenSharing) return;

    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
    }

    const localVideoTrack = this.localStream ? this.localStream.getVideoTracks()[0] : null;

    for (const [peerId, peer] of this.peers.entries()) {
      const senders = peer.pc.getSenders();
      const videoSender = senders.find(s => s.track && s.track.kind === "video");
      if (videoSender && localVideoTrack) {
        videoSender.replaceTrack(localVideoTrack);
      }
    }

    this.isScreenSharing = false;
  }

  broadcastData(data) {
    for (const [peerId, peer] of this.peers.entries()) {
      if (peer.dc && peer.dc.readyState === "open") {
        try {
          peer.dc.send(data);
        } catch (e) {
          console.warn(`Error sending data to peer ${peerId}:`, e);
        }
      }
    }
  }

  destroy() {
    if (this.speakerInterval) clearInterval(this.speakerInterval);
    if (this.audioContext) this.audioContext.close();
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
    }
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
    }
    for (const [peerId] of this.peers) {
      this.removePeer(peerId);
    }
  }
}

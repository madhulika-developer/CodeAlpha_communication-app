// P2P File Sharing Engine via WebRTC DataChannel

class FileSharer {
  constructor(webrtcManager, wsSignaling, onProgressUpdate, onFileReceived) {
    this.webrtc = webrtcManager;
    this.ws = wsSignaling;
    this.onProgressUpdate = onProgressUpdate;
    this.onFileReceived = onFileReceived;

    this.CHUNK_SIZE = 64 * 1024; // 64 KB chunks
    // file_id -> { name, size, type, chunks: [], receivedBytes: 0, sender: Object }
    this.incomingFiles = new Map();
  }

  async sendFile(file, user) {
    const fileId = "file_" + Math.random().toString(36).substring(2, 9);
    const totalChunks = Math.ceil(file.size / this.CHUNK_SIZE);

    // 1. Broadcast file announcement to room
    const announceMsg = {
      type: "file_announce",
      file_id: fileId,
      file_name: file.name,
      file_size: file.size,
      file_type: file.type || "application/octet-stream",
      total_chunks: totalChunks,
      sender: user
    };
    this.ws.send(JSON.stringify(announceMsg));

    // 2. Read and stream chunks over DataChannel to peers
    let offset = 0;
    let chunkIndex = 0;

    const readNextChunk = () => {
      const slice = file.slice(offset, offset + this.CHUNK_SIZE);
      const reader = new FileReader();

      reader.onload = (e) => {
        const buffer = e.target.result;
        const meta = JSON.stringify({
          type: "file_chunk_meta",
          file_id: fileId,
          chunk_index: chunkIndex,
          total_chunks: totalChunks
        });

        // Pack meta length + meta JSON + raw binary buffer
        const metaBuffer = new TextEncoder().encode(meta);
        const header = new Uint32Array([metaBuffer.byteLength]);

        const combined = new Uint8Array(4 + metaBuffer.byteLength + buffer.byteLength);
        combined.set(new Uint8Array(header.buffer), 0);
        combined.set(metaBuffer, 4);
        combined.set(new Uint8Array(buffer), 4 + metaBuffer.byteLength);

        // Send binary buffer to peers
        this.webrtc.broadcastData(combined.buffer);

        offset += this.CHUNK_SIZE;
        chunkIndex++;

        const percent = Math.min(100, Math.round((offset / file.size) * 100));
        if (this.onProgressUpdate) {
          this.onProgressUpdate(fileId, percent, true);
        }

        if (offset < file.size) {
          // Keep sending chunks with small yield to avoid blocking browser main thread
          setTimeout(readNextChunk, 2);
        } else {
          console.log(`File ${file.name} sent successfully.`);
        }
      };

      reader.readAsArrayBuffer(slice);
    };

    readNextChunk();
    return fileId;
  }

  handleIncomingData(peerId, arrayBuffer) {
    if (typeof arrayBuffer === "string") return;

    try {
      const view = new DataView(arrayBuffer);
      const metaLength = view.getUint32(0, true);
      const metaBytes = new Uint8Array(arrayBuffer, 4, metaLength);
      const metaStr = new TextDecoder().decode(metaBytes);
      const meta = JSON.parse(metaStr);

      if (meta.type === "file_chunk_meta") {
        const chunkData = arrayBuffer.slice(4 + metaLength);
        this.receiveChunk(meta.file_id, meta.chunk_index, meta.total_chunks, chunkData);
      }
    } catch (e) {
      console.warn("Could not parse incoming data channel chunk:", e);
    }
  }

  handleFileAnnounce(data) {
    this.incomingFiles.set(data.file_id, {
      name: data.file_name,
      size: data.file_size,
      type: data.file_type,
      total_chunks: data.total_chunks,
      chunks: new Array(data.total_chunks),
      receivedChunks: 0,
      sender: data.user
    });

    if (this.onProgressUpdate) {
      this.onProgressUpdate(data.file_id, 0, false, data);
    }
  }

  receiveChunk(fileId, chunkIndex, totalChunks, chunkBuffer) {
    const fileEntry = this.incomingFiles.get(fileId);
    if (!fileEntry) return;

    if (!fileEntry.chunks[chunkIndex]) {
      fileEntry.chunks[chunkIndex] = chunkBuffer;
      fileEntry.receivedChunks++;

      const percent = Math.round((fileEntry.receivedChunks / totalChunks) * 100);
      if (this.onProgressUpdate) {
        this.onProgressUpdate(fileId, percent, false);
      }

      // Check if complete
      if (fileEntry.receivedChunks === totalChunks) {
        const blob = new Blob(fileEntry.chunks, { type: fileEntry.type });
        const downloadUrl = URL.createObjectURL(blob);

        if (this.onFileReceived) {
          this.onFileReceived({
            fileId,
            name: fileEntry.name,
            size: fileEntry.size,
            type: fileEntry.type,
            url: downloadUrl,
            sender: fileEntry.sender
          });
        }
      }
    }
  }

  formatBytes(bytes) {
    if (!bytes) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }
}

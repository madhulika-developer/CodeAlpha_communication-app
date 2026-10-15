// Collaborative Whiteboard Engine

class Whiteboard {
  constructor(canvasElement, wsSignaling, roomId, currentUser) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext("2d");
    this.ws = wsSignaling;
    this.roomId = roomId;
    this.currentUser = currentUser;

    this.currentTool = "pen"; // pen, highlighter, eraser, line, arrow, rect, circle, text
    this.currentColor = "#6366F1";
    this.currentWidth = 4;

    this.isDrawing = false;
    this.startX = 0;
    this.startY = 0;
    this.points = [];

    // History for undo / redo
    this.actions = [];
    this.redoStack = [];

    // Temporary canvas for previewing shapes while dragging
    this.previewImageData = null;

    // Remote cursors overlay container
    this.remoteCursors = new Map(); // peer_id -> DOM element

    this.initCanvasSize();
    this.bindEvents();

    window.addEventListener("resize", () => this.handleResize());
  }

  initCanvasSize() {
    const parent = this.canvas.parentElement;
    const rect = parent.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    this.width = rect.width || window.innerWidth;
    this.height = rect.height || window.innerHeight;

    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    this.ctx.scale(dpr, dpr);
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";
    this.redrawAll();
  }

  handleResize() {
    this.initCanvasSize();
  }

  bindEvents() {
    const c = this.canvas;

    c.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    c.addEventListener("pointermove", (e) => this.onPointerMove(e));
    c.addEventListener("pointerup", (e) => this.onPointerUp(e));
    c.addEventListener("pointerleave", (e) => this.onPointerUp(e));

    // Send cursor movement throttled
    let lastCursorSend = 0;
    c.addEventListener("pointermove", (e) => {
      const now = Date.now();
      if (now - lastCursorSend > 50) {
        lastCursorSend = now;
        const rect = c.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;
        this.ws.send(JSON.stringify({
          type: "whiteboard_cursor",
          x, y
        }));
      }
    });
  }

  getCanvasCoords(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  }

  onPointerDown(e) {
    e.preventDefault();
    this.isDrawing = true;
    const { x, y } = this.getCanvasCoords(e);
    this.startX = x;
    this.startY = y;

    if (this.currentTool === "pen" || this.currentTool === "highlighter" || this.currentTool === "eraser") {
      this.points = [{ x, y }];
      this.ctx.beginPath();
      this.ctx.moveTo(x, y);
    } else if (this.currentTool === "text") {
      const text = prompt("Enter text to place on whiteboard:");
      if (text && text.trim()) {
        const action = {
          tool: "text",
          x,
          y,
          text: text.trim(),
          color: this.currentColor,
          size: Math.max(16, this.currentWidth * 4)
        };
        this.applyAction(action, true);
      }
      this.isDrawing = false;
    } else {
      // Shape tool: save canvas state for preview
      this.previewImageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  onPointerMove(e) {
    if (!this.isDrawing) return;
    const { x, y } = this.getCanvasCoords(e);

    if (this.currentTool === "pen" || this.currentTool === "highlighter" || this.currentTool === "eraser") {
      this.points.push({ x, y });
      this.renderFreehandSegment(this.points, this.currentTool, this.currentColor, this.currentWidth);
    } else if (this.previewImageData) {
      // Restore canvas and draw shape preview
      this.ctx.putImageData(this.previewImageData, 0, 0);
      this.drawShape(this.currentTool, this.startX, this.startY, x, y, this.currentColor, this.currentWidth);
    }
  }

  onPointerUp(e) {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    const { x, y } = this.getCanvasCoords(e);

    let action = null;
    if (this.currentTool === "pen" || this.currentTool === "highlighter" || this.currentTool === "eraser") {
      if (this.points.length > 0) {
        action = {
          tool: this.currentTool,
          points: [...this.points],
          color: this.currentColor,
          width: this.currentWidth
        };
      }
      this.points = [];
    } else {
      action = {
        tool: this.currentTool,
        x1: this.startX,
        y1: this.startY,
        x2: x,
        y2: y,
        color: this.currentColor,
        width: this.currentWidth
      };
      this.previewImageData = null;
    }

    if (action) {
      this.applyAction(action, true);
    }
  }

  applyAction(action, broadcast = false) {
    this.actions.push(action);
    this.redoStack = [];
    this.renderAction(action);

    if (broadcast) {
      this.ws.send(JSON.stringify({
        type: "whiteboard_draw",
        data: action
      }));
    }
  }

  renderAction(action) {
    if (!action) return;
    if (action.tool === "pen" || action.tool === "highlighter" || action.tool === "eraser") {
      this.renderFullFreehand(action.points, action.tool, action.color, action.width);
    } else if (action.tool === "text") {
      this.ctx.fillStyle = action.color;
      this.ctx.font = `${action.size}px sans-serif`;
      this.ctx.fillText(action.text, action.x, action.y);
    } else {
      this.drawShape(action.tool, action.x1, action.y1, action.x2, action.y2, action.color, action.width);
    }
  }

  renderFreehandSegment(points, tool, color, width) {
    if (points.length < 2) return;
    const p1 = points[points.length - 2];
    const p2 = points[points.length - 1];

    this.ctx.save();
    this.ctx.lineWidth = width;
    if (tool === "eraser") {
      this.ctx.globalCompositeOperation = "destination-out";
      this.ctx.strokeStyle = "rgba(0,0,0,1)";
    } else if (tool === "highlighter") {
      this.ctx.globalCompositeOperation = "source-over";
      this.ctx.globalAlpha = 0.35;
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = width * 3;
    } else {
      this.ctx.globalCompositeOperation = "source-over";
      this.ctx.strokeStyle = color;
    }

    this.ctx.beginPath();
    this.ctx.moveTo(p1.x, p1.y);
    this.ctx.lineTo(p2.x, p2.y);
    this.ctx.stroke();
    this.ctx.restore();
  }

  renderFullFreehand(points, tool, color, width) {
    if (!points || points.length === 0) return;
    this.ctx.save();
    this.ctx.lineWidth = width;

    if (tool === "eraser") {
      this.ctx.globalCompositeOperation = "destination-out";
      this.ctx.strokeStyle = "rgba(0,0,0,1)";
    } else if (tool === "highlighter") {
      this.ctx.globalAlpha = 0.35;
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = width * 3;
    } else {
      this.ctx.strokeStyle = color;
    }

    this.ctx.beginPath();
    this.ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      this.ctx.lineTo(points[i].x, points[i].y);
    }
    this.ctx.stroke();
    this.ctx.restore();
  }

  drawShape(tool, x1, y1, x2, y2, color, width) {
    this.ctx.save();
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = width;
    this.ctx.beginPath();

    if (tool === "line") {
      this.ctx.moveTo(x1, y1);
      this.ctx.lineTo(x2, y2);
      this.ctx.stroke();
    } else if (tool === "arrow") {
      this.ctx.moveTo(x1, y1);
      this.ctx.lineTo(x2, y2);
      this.ctx.stroke();
      // Arrowhead
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const headLen = width * 3 + 10;
      this.ctx.beginPath();
      this.ctx.moveTo(x2, y2);
      this.ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
      this.ctx.moveTo(x2, y2);
      this.ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
      this.ctx.stroke();
    } else if (tool === "rect") {
      this.ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    } else if (tool === "circle") {
      const radiusX = Math.abs(x2 - x1) / 2;
      const radiusY = Math.abs(y2 - y1) / 2;
      const centerX = Math.min(x1, x2) + radiusX;
      const centerY = Math.min(y1, y2) + radiusY;
      this.ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, 2 * Math.PI);
      this.ctx.stroke();
    }
    this.ctx.restore();
  }

  redrawAll() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const act of this.actions) {
      this.renderAction(act);
    }
  }

  undo() {
    if (this.actions.length === 0) return;
    const popped = this.actions.pop();
    this.redoStack.push(popped);
    this.redrawAll();
  }

  redo() {
    if (this.redoStack.length === 0) return;
    const act = this.redoStack.pop();
    this.actions.push(act);
    this.renderAction(act);
  }

  clear(broadcast = true) {
    this.actions = [];
    this.redoStack = [];
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (broadcast) {
      this.ws.send(JSON.stringify({ type: "whiteboard_clear" }));
    }
  }

  handleRemoteStroke(data) {
    this.actions.push(data);
    this.renderAction(data);
  }

  handleRemoteClear() {
    this.actions = [];
    this.redoStack = [];
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  handleRemoteCursor(peerId, user, normX, normY) {
    const parent = this.canvas.parentElement;
    let cursorEl = this.remoteCursors.get(peerId);

    if (!cursorEl) {
      cursorEl = document.createElement("div");
      cursorEl.className = "remote-cursor";
      cursorEl.innerHTML = `
        <div class="cursor-pointer" style="background-color: ${user.avatar_color || '#6366F1'};"></div>
        <span class="cursor-tag">${user.display_name || 'Participant'}</span>
      `;
      parent.appendChild(cursorEl);
      this.remoteCursors.set(peerId, cursorEl);
    }

    const rect = this.canvas.getBoundingClientRect();
    const px = normX * rect.width;
    const py = normY * rect.height;
    cursorEl.style.transform = `translate(${px}px, ${py}px)`;
  }

  removeRemoteCursor(peerId) {
    const el = this.remoteCursors.get(peerId);
    if (el) {
      el.remove();
      this.remoteCursors.delete(peerId);
    }
  }

  exportImage() {
    // Render on white background for clean image export
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = this.canvas.width;
    exportCanvas.height = this.canvas.height;
    const expCtx = exportCanvas.getContext("2d");

    expCtx.fillStyle = "#1e1e24";
    expCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    expCtx.drawImage(this.canvas, 0, 0);

    const link = document.createElement("a");
    link.download = `whiteboard-${this.roomId}-${Date.now()}.png`;
    link.href = exportCanvas.toDataURL("image/png");
    link.click();
  }
}

import os
import uuid
import json
import logging
from contextlib import asynccontextmanager
from typing import Optional
from pathlib import Path

from fastapi import FastAPI, Depends, HTTPException, status, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
import aiosqlite

from server.config import BASE_DIR, ICE_SERVERS
from server.database import init_db, get_db
from server.auth import (
    hash_password,
    verify_password,
    create_access_token,
    get_current_user,
    get_optional_user,
    decode_access_token
)
from server.signaling import manager

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("nexusmeet")

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize SQLite tables on startup
    await init_db()
    logger.info("Database initialized successfully.")
    yield

app = FastAPI(
    title="NexusMeet Real-Time Communication Platform",
    description="Video conferencing, screen sharing, encrypted chat, collaborative whiteboard & P2P file sharing",
    version="1.0.0",
    lifespan=lifespan
)

# Enable CORS for cross-origin or local network connections
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

CLIENT_DIR = BASE_DIR / "client"

# ----------------- PYDANTIC SCHEMAS -----------------

class RegisterRequest(BaseModel):
    username: str
    email: str
    password: str
    display_name: str
    avatar_color: Optional[str] = "#6366F1"

class LoginRequest(BaseModel):
    username: str
    password: str

class CreateRoomRequest(BaseModel):
    name: str
    passcode: Optional[str] = None

class VerifyRoomRequest(BaseModel):
    passcode: Optional[str] = None

# ----------------- AUTHENTICATION API -----------------

@app.post("/api/auth/register")
async def register(req: RegisterRequest, db: aiosqlite.Connection = Depends(get_db)):
    if len(req.username.strip()) < 3:
        raise HTTPException(status_code=400, detail="Username must be at least 3 characters")
    if len(req.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    
    # Check if username or email exists
    async with db.execute(
        "SELECT id FROM users WHERE username = ? OR email = ?",
        (req.username.lower(), req.email.lower())
    ) as cursor:
        existing = await cursor.fetchone()
        if existing:
            raise HTTPException(status_code=400, detail="Username or Email already registered")

    pwd_hash = hash_password(req.password)
    async with db.execute(
        """
        INSERT INTO users (username, email, password_hash, display_name, avatar_color)
        VALUES (?, ?, ?, ?, ?)
        """,
        (req.username.lower(), req.email.lower(), pwd_hash, req.display_name.strip(), req.avatar_color)
    ) as cursor:
        user_id = cursor.lastrowid
        await db.commit()

    token = create_access_token({"sub": req.username.lower(), "user_id": user_id})
    return {
        "status": "success",
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id": user_id,
            "username": req.username.lower(),
            "email": req.email.lower(),
            "display_name": req.display_name.strip(),
            "avatar_color": req.avatar_color
        }
    }

@app.post("/api/auth/login")
async def login(req: LoginRequest, db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute(
        "SELECT id, username, email, password_hash, display_name, avatar_color FROM users WHERE username = ?",
        (req.username.lower(),)
    ) as cursor:
        user = await cursor.fetchone()
        if not user or not verify_password(req.password, user["password_hash"]):
            raise HTTPException(status_code=401, detail="Invalid username or password")

    token = create_access_token({"sub": user["username"], "user_id": user["id"]})
    return {
        "status": "success",
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id": user["id"],
            "username": user["username"],
            "email": user["email"],
            "display_name": user["display_name"],
            "avatar_color": user["avatar_color"]
        }
    }

@app.get("/api/auth/me")
async def get_me(user: dict = Depends(get_current_user)):
    return {"status": "success", "user": user}

# ----------------- ROOM MANAGEMENT API -----------------

@app.post("/api/rooms")
async def create_room(
    req: CreateRoomRequest,
    user: Optional[dict] = Depends(get_optional_user),
    db: aiosqlite.Connection = Depends(get_db)
):
    # Generate human-friendly room code: xxx-yyyy-zzz
    raw_uuid = uuid.uuid4().hex
    room_id = f"{raw_uuid[:3]}-{raw_uuid[3:7]}-{raw_uuid[7:10]}"
    
    pwd_hash = hash_password(req.passcode) if req.passcode else None
    user_id = user["id"] if user else None

    async with db.execute(
        """
        INSERT INTO rooms (id, name, host_user_id, password_hash)
        VALUES (?, ?, ?, ?)
        """,
        (room_id, req.name.strip(), user_id, pwd_hash)
    ) as cursor:
        await db.commit()

    return {
        "status": "success",
        "room_id": room_id,
        "name": req.name.strip(),
        "is_protected": req.passcode is not None,
        "host_user_id": user_id
    }

@app.get("/api/rooms/{room_id}")
async def get_room_info(room_id: str, db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute(
        "SELECT id, name, host_user_id, password_hash, is_locked, created_at FROM rooms WHERE id = ?",
        (room_id,)
    ) as cursor:
        room = await cursor.fetchone()
        if not room:
            # If room wasn't explicitly persisted, allow instant ad-hoc room creation
            return {
                "room_id": room_id,
                "name": f"Meeting {room_id}",
                "is_protected": False,
                "is_locked": False,
                "participants_count": manager.get_room_participants_count(room_id)
            }
        
        return {
            "room_id": room["id"],
            "name": room["name"],
            "is_protected": bool(room["password_hash"]),
            "is_locked": bool(room["is_locked"]),
            "participants_count": manager.get_room_participants_count(room_id)
        }

@app.post("/api/rooms/{room_id}/verify")
async def verify_room_password(
    room_id: str,
    req: VerifyRoomRequest,
    db: aiosqlite.Connection = Depends(get_db)
):
    async with db.execute(
        "SELECT password_hash FROM rooms WHERE id = ?",
        (room_id,)
    ) as cursor:
        room = await cursor.fetchone()
        if not room or not room["password_hash"]:
            return {"valid": True}
        
        if not req.passcode:
            return {"valid": False, "message": "Passcode required"}
        
        is_valid = verify_password(req.passcode, room["password_hash"])
        return {"valid": is_valid, "message": "Valid passcode" if is_valid else "Incorrect room passcode"}

@app.get("/api/config/ice")
async def get_ice_servers():
    """Return public STUN configuration for WebRTC client initialization."""
    return {"ice_servers": ICE_SERVERS}

# ----------------- WEBSOCKET SIGNALING -----------------

@app.websocket("/ws/signal/{room_id}")
async def websocket_signaling(
    websocket: WebSocket,
    room_id: str,
    peer_id: str = Query(...),
    display_name: str = Query("Guest"),
    avatar_color: str = Query("#6366F1"),
    token: Optional[str] = Query(None)
):
    # Verify optional token
    user_info = {
        "peer_id": peer_id,
        "display_name": display_name,
        "avatar_color": avatar_color,
        "is_authenticated": False,
        "is_host": False
    }
    
    if token:
        payload = decode_access_token(token)
        if payload and "sub" in payload:
            user_info["username"] = payload["sub"]
            user_info["is_authenticated"] = True

    # First participant in room becomes host
    if manager.get_room_participants_count(room_id) == 0:
        user_info["is_host"] = True

    await manager.connect(websocket, room_id, peer_id, user_info)

    try:
        while True:
            raw_data = await websocket.receive_text()
            try:
                data = json.loads(raw_data)
            except json.JSONDecodeError:
                continue

            msg_type = data.get("type")

            # 1. WebRTC Signaling: Offer
            if msg_type == "offer":
                target = data.get("target")
                await manager.send_to_peer(room_id, target, {
                    "type": "offer",
                    "sender": peer_id,
                    "sdp": data.get("sdp"),
                    "user": user_info
                })

            # 2. WebRTC Signaling: Answer
            elif msg_type == "answer":
                target = data.get("target")
                await manager.send_to_peer(room_id, target, {
                    "type": "answer",
                    "sender": peer_id,
                    "sdp": data.get("sdp")
                })

            # 3. WebRTC Signaling: ICE Candidate
            elif msg_type == "ice_candidate":
                target = data.get("target")
                await manager.send_to_peer(room_id, target, {
                    "type": "ice_candidate",
                    "sender": peer_id,
                    "candidate": data.get("candidate")
                })

            # 4. Peer Media State (Microphone mute, Camera off, Screen sharing toggle)
            elif msg_type == "media_state":
                await manager.broadcast(room_id, {
                    "type": "media_state",
                    "peer_id": peer_id,
                    "audio_muted": data.get("audio_muted", False),
                    "video_off": data.get("video_off", False),
                    "screen_sharing": data.get("screen_sharing", False)
                }, exclude_peer_id=peer_id)

            # 5. Real-Time Whiteboard Stroke broadcast
            elif msg_type == "whiteboard_draw":
                stroke_data = data.get("data")
                manager.save_whiteboard_stroke(room_id, stroke_data)
                await manager.broadcast(room_id, {
                    "type": "whiteboard_draw",
                    "peer_id": peer_id,
                    "data": stroke_data
                }, exclude_peer_id=peer_id)

            # 6. Real-Time Whiteboard Clear
            elif msg_type == "whiteboard_clear":
                manager.clear_whiteboard(room_id)
                await manager.broadcast(room_id, {
                    "type": "whiteboard_clear",
                    "peer_id": peer_id
                })

            # 7. Real-Time Whiteboard Cursor Position (shows collaborative pointer)
            elif msg_type == "whiteboard_cursor":
                await manager.broadcast(room_id, {
                    "type": "whiteboard_cursor",
                    "peer_id": peer_id,
                    "user": user_info,
                    "x": data.get("x"),
                    "y": data.get("y")
                }, exclude_peer_id=peer_id)

            # 8. Encrypted Chat Message broadcast
            elif msg_type == "chat_message":
                await manager.broadcast(room_id, {
                    "type": "chat_message",
                    "peer_id": peer_id,
                    "user": user_info,
                    "payload": data.get("payload"),  # Encrypted ciphertext or plaintext
                    "is_encrypted": data.get("is_encrypted", False),
                    "iv": data.get("iv"),
                    "timestamp": data.get("timestamp")
                })

            # 9. P2P File announcement
            elif msg_type == "file_announce":
                await manager.broadcast(room_id, {
                    "type": "file_announce",
                    "peer_id": peer_id,
                    "user": user_info,
                    "file_id": data.get("file_id"),
                    "file_name": data.get("file_name"),
                    "file_size": data.get("file_size"),
                    "file_type": data.get("file_type")
                }, exclude_peer_id=peer_id)

            # 10. Host Controls (Kick, Mute remote participant)
            elif msg_type == "host_action":
                if user_info.get("is_host"):
                    target = data.get("target")
                    action = data.get("action")
                    if action == "kick":
                        await manager.send_to_peer(room_id, target, {
                            "type": "kicked",
                            "reason": "Host removed you from the meeting"
                        })
                    elif action == "mute":
                        await manager.send_to_peer(room_id, target, {
                            "type": "force_mute"
                        })

    except WebSocketDisconnect:
        await manager.disconnect(peer_id)
    except Exception as e:
        logger.warning(f"WebSocket exception for peer {peer_id}: {e}")
        await manager.disconnect(peer_id)

# ----------------- STATIC UI ROUTES -----------------

# Serve frontend static assets (CSS, JS)
app.mount("/css", StaticFiles(directory=CLIENT_DIR / "css"), name="css")
app.mount("/js", StaticFiles(directory=CLIENT_DIR / "js"), name="js")

@app.get("/")
async def serve_index():
    return FileResponse(CLIENT_DIR / "index.html")

@app.get("/room/{room_id}")
async def serve_room(room_id: str):
    return FileResponse(CLIENT_DIR / "room.html")

from typing import Dict, Any
from fastapi import WebSocket
import json
import logging

logger = logging.getLogger("signaling")

class ConnectionManager:
    def __init__(self):
        # room_id -> { peer_id -> { "ws": WebSocket, "user": dict } }
        self.rooms: Dict[str, Dict[str, Dict[str, Any]]] = {}
        # peer_id -> room_id
        self.peer_rooms: Dict[str, str] = {}
        # room_id -> list of whiteboard elements history for newly joining peers
        self.whiteboard_state: Dict[str, list] = {}

    async def connect(self, websocket: WebSocket, room_id: str, peer_id: str, user_info: dict):
        await websocket.accept()
        if room_id not in self.rooms:
            self.rooms[room_id] = {}
            self.whiteboard_state[room_id] = []
        
        # Check if room is locked and if this user is allowed
        # Store connection
        self.rooms[room_id][peer_id] = {
            "ws": websocket,
            "user": user_info
        }
        self.peer_rooms[peer_id] = room_id

        # 1. Send existing peers in this room to the new participant
        existing_peers = [
            {"peer_id": pid, "user": data["user"]}
            for pid, data in self.rooms[room_id].items()
            if pid != peer_id
        ]
        await websocket.send_text(json.dumps({
            "type": "room_state",
            "room_id": room_id,
            "peers": existing_peers,
            "whiteboard_history": self.whiteboard_state[room_id]
        }))

        # 2. Notify other peers in this room that a new user joined
        await self.broadcast(
            room_id,
            {
                "type": "peer_joined",
                "peer_id": peer_id,
                "user": user_info
            },
            exclude_peer_id=peer_id
        )
        logger.info(f"Peer {peer_id} joined room {room_id}. Total in room: {len(self.rooms[room_id])}")

    async def disconnect(self, peer_id: str):
        room_id = self.peer_rooms.pop(peer_id, None)
        if not room_id or room_id not in self.rooms:
            return
        
        peer_data = self.rooms[room_id].pop(peer_id, None)
        if peer_data:
            logger.info(f"Peer {peer_id} disconnected from room {room_id}")
            # Notify remaining peers
            await self.broadcast(
                room_id,
                {
                    "type": "peer_left",
                    "peer_id": peer_id,
                    "user": peer_data.get("user", {})
                }
            )
        
        # Clean up empty room state
        if not self.rooms[room_id]:
            del self.rooms[room_id]
            self.whiteboard_state.pop(room_id, None)
            logger.info(f"Room {room_id} closed as all participants left")

    async def send_to_peer(self, room_id: str, target_peer_id: str, message: dict):
        if room_id in self.rooms and target_peer_id in self.rooms[room_id]:
            ws = self.rooms[room_id][target_peer_id]["ws"]
            try:
                await ws.send_text(json.dumps(message))
            except Exception as e:
                logger.warning(f"Error sending to peer {target_peer_id}: {e}")

    async def broadcast(self, room_id: str, message: dict, exclude_peer_id: str = None):
        if room_id not in self.rooms:
            return
        
        payload = json.dumps(message)
        for pid, peer_data in list(self.rooms[room_id].items()):
            if exclude_peer_id and pid == exclude_peer_id:
                continue
            try:
                await peer_data["ws"].send_text(payload)
            except Exception as e:
                logger.warning(f"Failed broadcasting to {pid}: {e}")

    def save_whiteboard_stroke(self, room_id: str, stroke: dict):
        if room_id in self.whiteboard_state:
            # Keep history up to 2000 strokes/actions
            if len(self.whiteboard_state[room_id]) > 2000:
                self.whiteboard_state[room_id].pop(0)
            self.whiteboard_state[room_id].append(stroke)

    def clear_whiteboard(self, room_id: str):
        if room_id in self.whiteboard_state:
            self.whiteboard_state[room_id].clear()

    def get_room_participants_count(self, room_id: str) -> int:
        return len(self.rooms.get(room_id, {}))

manager = ConnectionManager()

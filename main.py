import os
import json
import asyncio
import secrets
import logging
from datetime import datetime
from contextlib import asynccontextmanager
from typing import List, Optional, Dict, Any

import httpx
from fastapi import FastAPI, Request, Depends, HTTPException, Query, Body
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime, JSON, ForeignKey
from sqlalchemy.orm import sessionmaker, Session, relationship, declarative_base

# --- 配置部分 ---
DB_URL = "sqlite:///./bark_multiuser.db"

# --- 数据库模型 ---
Base = declarative_base()
engine = create_engine(DB_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    token = Column(String(64), unique=True, index=True)
    password = Column(String(64))
    created_at = Column(DateTime, default=datetime.now)
    
    devices = relationship("DownstreamDevice", back_populates="owner", cascade="all, delete-orphan")
    messages = relationship("PushMessage", back_populates="owner", cascade="all, delete-orphan")

class DownstreamDevice(Base):
    __tablename__ = "downstream_devices"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    url = Column(String(512))
    owner = relationship("User", back_populates="devices")

class PushMessage(Base):
    __tablename__ = "messages"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    title = Column(String(255))
    subtitle = Column(String(255))
    body = Column(Text)
    raw_params = Column(JSON)
    created_at = Column(DateTime, default=datetime.now)
    owner = relationship("User", back_populates="messages")

Base.metadata.create_all(bind=engine)

# --- Pydantic 请求模型 ---
class AuthBase(BaseModel):
    token: str
    password: str

class AddDeviceRequest(AuthBase):
    url: str

class DeleteDeviceRequest(AuthBase):
    device_id: int

class MessageRequest(AuthBase):
    limit: int = 50

class ImportRequest(AuthBase):
    mode: str
    data: dict

# --- 全局消息队列与客户端 ---
message_queue = asyncio.Queue()
http_client: Optional[httpx.AsyncClient] = None

async def bark_worker():
    while True:
        task_data = await message_queue.get()
        try:
            target_urls = task_data.get("urls", [])
            payload = task_data.get("payload", {})
            if not target_urls: continue
            tasks = [http_client.post(url.rstrip("/"), json=payload, timeout=10.0) for url in target_urls]
            if tasks: await asyncio.gather(*tasks, return_exceptions=True)
        except Exception as e:
            logging.error(f"Worker error: {e}")
        finally:
            message_queue.task_done()

@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client
    http_client = httpx.AsyncClient()
    worker_task = asyncio.create_task(bark_worker())
    yield
    worker_task.cancel()
    await http_client.aclose()

app = FastAPI(title="Meow Multi-User Relay", lifespan=lifespan, redirect_slashes=False)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def get_db():
    db = SessionLocal()
    try: yield db
    finally: db.close()

def verify_user(db: Session, token: str, password: str):
    user = db.query(User).filter(User.token == token, User.password == password).first()
    if not user: raise HTTPException(status_code=401, detail="Invalid token or password")
    return user

async def process_incoming_push(db: Session, token: str, data: dict):
    user = db.query(User).filter(User.token == token).first()
    if not user: return False
    if not data.get("title") and not data.get("body") and not data.get("markdown"):
        return True
    msg = PushMessage(
        user_id=user.id,
        title=data.get("title"),
        subtitle=data.get("subtitle"),
        body=data.get("body") or data.get("markdown"),
        raw_params=data
    )
    db.add(msg)
    db.commit()
    urls = [d.url for d in user.devices]
    await message_queue.put({"urls": urls, "payload": data})
    return True

# --- API 路由 (管理类全部改为 POST) ---

@app.post("/register")
async def register_user(db: Session = Depends(get_db)):
    user = User(token=secrets.token_hex(16), password=secrets.token_urlsafe(12))
    db.add(user)
    db.commit()
    return {"token": user.token, "password": user.password}

@app.post("/config")
async def get_config(req: AuthBase, db: Session = Depends(get_db)):
    user = verify_user(db, req.token, req.password)
    return {"devices": [{"id": d.id, "url": d.url} for d in user.devices]}

@app.post("/config/add")
async def add_device(req: AddDeviceRequest, db: Session = Depends(get_db)):
    user = verify_user(db, req.token, req.password)
    new_device = DownstreamDevice(user_id=user.id, url=req.url)
    db.add(new_device)
    db.commit()
    return {"status": "success", "device_id": new_device.id}

@app.post("/config/delete")
async def delete_device(req: DeleteDeviceRequest, db: Session = Depends(get_db)):
    user = verify_user(db, req.token, req.password)
    device = db.query(DownstreamDevice).filter(DownstreamDevice.id == req.device_id, DownstreamDevice.user_id == user.id).first()
    if not device: raise HTTPException(status_code=404)
    db.delete(device)
    db.commit()
    return {"status": "deleted"}

@app.post("/messages")
async def get_messages(req: MessageRequest, db: Session = Depends(get_db)):
    user = verify_user(db, req.token, req.password)
    msgs = db.query(PushMessage).filter(PushMessage.user_id == user.id).order_by(PushMessage.created_at.desc()).limit(req.limit).all()
    return [{"id": m.id, "title": m.title, "subtitle": m.subtitle, "body": m.body, "created_at": m.created_at, "params": m.raw_params} for m in msgs]

@app.post("/data/export")
async def export_data(req: AuthBase, db: Session = Depends(get_db)):
    user = verify_user(db, req.token, req.password)
    return {
        "export_time": datetime.now().isoformat(),
        "devices": [{"url": d.url} for d in user.devices],
        "messages": [{"title": m.title, "body": m.body, "params": m.raw_params, "created_at": m.created_at.isoformat()} for m in user.messages]
    }

@app.post("/data/import")
async def import_data(req: ImportRequest, db: Session = Depends(get_db)):
    user = verify_user(db, req.token, req.password)
    if req.mode == "overwrite":
        db.query(DownstreamDevice).filter(DownstreamDevice.user_id == user.id).delete()
        db.query(PushMessage).filter(PushMessage.user_id == user.id).delete()
    if "devices" in req.data:
        for d in req.data["devices"]: db.add(DownstreamDevice(user_id=user.id, url=d["url"]))
    if "messages" in req.data:
        for m in req.data["messages"]:
            db.add(PushMessage(user_id=user.id, title=m.get("title"), body=m.get("body"), raw_params=m.get("params"), created_at=datetime.fromisoformat(m["created_at"]) if "created_at" in m else datetime.now()))
    db.commit()
    return {"status": "success"}

# --- Bark 兼容路由 (保持不变，以兼容协议) ---
@app.get("/{key}")
@app.get("/{key}/")
async def bark_get_base(request: Request, key: str, db: Session = Depends(get_db)):
    params = dict(request.query_params)
    if not params.get("body") and not params.get("title"):
        user = db.query(User).filter(User.token == key).first()
        if not user: raise HTTPException(status_code=401)
        return {"code": 200, "message": "success", "data": {"status": "health-check"}}
    if await process_incoming_push(db, key, params): return {"code": 200, "message": "success"}
    raise HTTPException(status_code=401)

@app.get("/{key}/{body}")
@app.get("/{key}/{body}/")
@app.get("/{key}/{title}/{body}")
@app.get("/{key}/{title}/{body}/")
@app.get("/{key}/{title}/{subtitle}/{body}")
@app.get("/{key}/{title}/{subtitle}/{body}/")
async def bark_get_full(request: Request, key: str, body: str, title: str=None, subtitle: str=None, db: Session=Depends(get_db)):
    p = dict(request.query_params)
    p.update({"title": title, "subtitle": subtitle, "body": body})
    if await process_incoming_push(db, key, p): return {"code": 200, "message": "success"}
    raise HTTPException(status_code=401)

@app.post("/{key}")
@app.post("/{key}/")
async def bark_post(request: Request, key: str, db: Session=Depends(get_db)):
    try: data = await request.json()
    except: data = dict(await request.form())
    data.update(dict(request.query_params))
    if await process_incoming_push(db, key, data): return {"code": 200, "message": "success"}
    raise HTTPException(status_code=401)

@app.post("/push")
@app.post("/push/")
async def bark_push_json(request: Request, db: Session=Depends(get_db)):
    data = await request.json()
    key = data.get("device_key") or (data.get("device_keys")[0] if data.get("device_keys") else None)
    if not key: raise HTTPException(status_code=400)
    if await process_incoming_push(db, key, data): return {"code": 200, "message": "success"}
    raise HTTPException(status_code=401)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
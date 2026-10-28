import os
import json
import hmac
import asyncio
import hashlib
import secrets
import logging
from datetime import datetime, timedelta
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
    password = Column(String(255))  # PBKDF2 哈希；历史数据为明文，启动时自动迁移
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

class PasswordReset(Base):
    __tablename__ = "password_resets"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True)
    code_hash = Column(String(255))
    attempts = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.now)
    expires_at = Column(DateTime)

Base.metadata.create_all(bind=engine)

# --- 密码哈希 ---
HASH_PREFIX = "pbkdf2_sha256"
HASH_ITERATIONS = 260000
PASSWORD_MIN_LEN = 8
PASSWORD_MAX_LEN = 128
RESET_CODE_TTL = timedelta(minutes=10)
RESET_CODE_COOLDOWN = timedelta(seconds=60)
RESET_CODE_MAX_ATTEMPTS = 5

def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), HASH_ITERATIONS).hex()
    return f"{HASH_PREFIX}${HASH_ITERATIONS}${salt}${digest}"

def is_hashed(stored: str) -> bool:
    return bool(stored) and stored.startswith(HASH_PREFIX + "$")

# 管理接口每次请求都带密码，缓存已验证结果避免每次都跑 PBKDF2（仅存于进程内存）
_verify_cache_key = secrets.token_bytes(32)
_verify_cache: Dict[str, str] = {}

def check_password(password: str, stored: str) -> bool:
    if not stored or not password:
        return False
    if not is_hashed(stored):
        # 兼容尚未迁移的明文密码
        return hmac.compare_digest(password.encode(), stored.encode())
    fast = hmac.new(_verify_cache_key, password.encode(), hashlib.sha256).hexdigest()
    cached = _verify_cache.get(stored)
    if cached is not None and hmac.compare_digest(cached, fast):
        return True
    try:
        _, iterations, salt, digest = stored.split("$")
        calc = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), int(iterations)).hex()
    except ValueError:
        return False
    if hmac.compare_digest(calc, digest):
        if len(_verify_cache) > 10000:
            _verify_cache.clear()
        _verify_cache[stored] = fast
        return True
    return False

def migrate_plaintext_passwords():
    db = SessionLocal()
    try:
        users = db.query(User).all()
        count = 0
        for u in users:
            if u.password and not is_hashed(u.password):
                u.password = hash_password(u.password)
                count += 1
        if count:
            db.commit()
            logging.warning(f"Migrated {count} plaintext password(s) to PBKDF2 hashes")
    finally:
        db.close()

migrate_plaintext_passwords()

def validate_new_password(password: str):
    if len(password) < PASSWORD_MIN_LEN or len(password) > PASSWORD_MAX_LEN:
        raise HTTPException(status_code=400, detail=f"密码长度需为 {PASSWORD_MIN_LEN}-{PASSWORD_MAX_LEN} 位")

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

class ChangePasswordRequest(AuthBase):
    new_password: str

class ResetRequest(BaseModel):
    token: str

class ResetConfirmRequest(BaseModel):
    token: str
    code: str
    new_password: str

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
    user = db.query(User).filter(User.token == token).first()
    if not user or not check_password(password, user.password):
        raise HTTPException(status_code=401, detail="Invalid token or password")
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
    password = secrets.token_urlsafe(12)
    user = User(token=secrets.token_hex(16), password=hash_password(password))
    db.add(user)
    db.commit()
    return {"token": user.token, "password": password}

@app.post("/password/change")
async def change_password(req: ChangePasswordRequest, db: Session = Depends(get_db)):
    user = verify_user(db, req.token, req.password)
    validate_new_password(req.new_password)
    user.password = hash_password(req.new_password)
    db.query(PasswordReset).filter(PasswordReset.user_id == user.id).delete()
    db.commit()
    return {"status": "success"}

RESET_SENT_MESSAGE = "如果该 Token 存在且已绑定设备，验证码已推送到你的设备"

@app.post("/password/reset/request")
async def request_password_reset(req: ResetRequest, db: Session = Depends(get_db)):
    now = datetime.now()
    db.query(PasswordReset).filter(PasswordReset.expires_at < now).delete()
    db.commit()
    user = db.query(User).filter(User.token == req.token).first()
    if not user or not user.devices:
        return {"status": "sent", "message": RESET_SENT_MESSAGE}
    latest = db.query(PasswordReset).filter(PasswordReset.user_id == user.id).order_by(PasswordReset.created_at.desc()).first()
    if latest and now - latest.created_at < RESET_CODE_COOLDOWN:
        raise HTTPException(status_code=429, detail="请求过于频繁，请稍后再试")
    code = f"{secrets.randbelow(10**6):06d}"
    db.query(PasswordReset).filter(PasswordReset.user_id == user.id).delete()
    db.add(PasswordReset(user_id=user.id, code_hash=hash_password(code), created_at=now, expires_at=now + RESET_CODE_TTL))
    db.commit()
    minutes = int(RESET_CODE_TTL.total_seconds() // 60)
    payload = {
        "title": "Meow 密码重置",
        "body": f"验证码：{code}\n{minutes} 分钟内有效。如非本人操作请忽略。",
        "group": "Meow",
    }
    # 不写入消息历史，直接推送到所有已绑定设备
    await message_queue.put({"urls": [d.url for d in user.devices], "payload": payload})
    return {"status": "sent", "message": RESET_SENT_MESSAGE}

@app.post("/password/reset/confirm")
async def confirm_password_reset(req: ResetConfirmRequest, db: Session = Depends(get_db)):
    invalid = HTTPException(status_code=400, detail="验证码无效或已过期")
    user = db.query(User).filter(User.token == req.token).first()
    if not user: raise invalid
    reset = db.query(PasswordReset).filter(PasswordReset.user_id == user.id).order_by(PasswordReset.created_at.desc()).first()
    if not reset or reset.expires_at < datetime.now() or reset.attempts >= RESET_CODE_MAX_ATTEMPTS:
        raise invalid
    if not check_password(req.code.strip(), reset.code_hash):
        reset.attempts += 1
        db.commit()
        raise invalid
    validate_new_password(req.new_password)
    user.password = hash_password(req.new_password)
    db.query(PasswordReset).filter(PasswordReset.user_id == user.id).delete()
    db.commit()
    return {"status": "success"}

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

# 必须注册在 POST /{key} 之前，否则 /push 会被当作 key="push" 匹配
@app.post("/push")
@app.post("/push/")
async def bark_push_json(request: Request, db: Session=Depends(get_db)):
    data = await request.json()
    key = data.get("device_key") or (data.get("device_keys")[0] if data.get("device_keys") else None)
    if not key: raise HTTPException(status_code=400)
    if await process_incoming_push(db, key, data): return {"code": 200, "message": "success"}
    raise HTTPException(status_code=401)

@app.post("/{key}")
@app.post("/{key}/")
async def bark_post(request: Request, key: str, db: Session=Depends(get_db)):
    try: data = await request.json()
    except: data = dict(await request.form())
    data.update(dict(request.query_params))
    if await process_incoming_push(db, key, data): return {"code": 200, "message": "success"}
    raise HTTPException(status_code=401)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
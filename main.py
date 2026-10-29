import os
import re
import json
import time
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
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime, JSON, ForeignKey, text, or_
from sqlalchemy.exc import IntegrityError
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
    username = Column(String(64), unique=True, index=True)  # 小写存储；老用户迁移时以 token 作为用户名
    password = Column(String(255))  # PBKDF2 哈希；历史数据为明文，启动时自动迁移
    created_at = Column(DateTime, default=datetime.now)
    
    devices = relationship("DownstreamDevice", back_populates="owner", cascade="all, delete-orphan", order_by="DownstreamDevice.id")
    messages = relationship("PushMessage", back_populates="owner", cascade="all, delete-orphan")

class DownstreamDevice(Base):
    __tablename__ = "downstream_devices"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    url = Column(String(512))
    note = Column(String(64))  # 备注；留空时默认「设备 N」
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
    deleted_at = Column(DateTime)  # 非空表示在回收站，超过 TRASH_RETENTION 后彻底删除
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

def migrate_username_column():
    # create_all 不会给已有表加列，这里手动补 username 列并用 token 回填老用户
    with engine.begin() as conn:
        columns = [row[1] for row in conn.execute(text("PRAGMA table_info(users)"))]
        if "username" not in columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN username VARCHAR(64)"))
        filled = conn.execute(text("UPDATE users SET username = token WHERE username IS NULL")).rowcount
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_username ON users (username)"))
    if filled:
        logging.warning(f"Backfilled username for {filled} user(s) from token")

DEVICE_NOTE_MAX_LEN = 64

def default_device_note(existing_notes, position: Optional[int] = None) -> str:
    # 按「第几个地址」命名（position 从 1 开始，默认排在最后），与已有备注重名时顺延
    taken = set(existing_notes)
    n = position or len(existing_notes) + 1
    while f"设备 {n}" in taken:
        n += 1
    return f"设备 {n}"

def migrate_device_note_column():
    with engine.begin() as conn:
        columns = [row[1] for row in conn.execute(text("PRAGMA table_info(downstream_devices)"))]
        if "note" not in columns:
            conn.execute(text("ALTER TABLE downstream_devices ADD COLUMN note VARCHAR(64)"))
        rows = conn.execute(text("SELECT id, user_id, note FROM downstream_devices ORDER BY user_id, id")).fetchall()
        notes_by_user: Dict[int, List[str]] = {}
        for _, user_id, note in rows:
            if note:
                notes_by_user.setdefault(user_id, []).append(note)
        filled = 0
        for device_id, user_id, note in rows:
            if note:
                continue
            notes = notes_by_user.setdefault(user_id, [])
            new_note = default_device_note(notes)
            notes.append(new_note)
            conn.execute(text("UPDATE downstream_devices SET note = :note WHERE id = :id"), {"note": new_note, "id": device_id})
            filled += 1
    if filled:
        logging.warning(f"Backfilled default note for {filled} device(s)")

def migrate_message_deleted_at_column():
    with engine.begin() as conn:
        columns = [row[1] for row in conn.execute(text("PRAGMA table_info(messages)"))]
        if "deleted_at" not in columns:
            conn.execute(text("ALTER TABLE messages ADD COLUMN deleted_at DATETIME"))

migrate_username_column()
migrate_device_note_column()
migrate_message_deleted_at_column()
migrate_plaintext_passwords()

USERNAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_.-]{2,31}$")

def normalize_username(username: str) -> str:
    return (username or "").strip().lower()

def validate_username(username: str):
    if not USERNAME_PATTERN.match(username):
        raise HTTPException(status_code=400, detail="用户名需为 3-32 位字母、数字或 _ . -，且以字母或数字开头")

# 登录失败限流（进程内存）：同一用户名 15 分钟内最多失败 10 次
LOGIN_FAIL_LIMIT = 10
LOGIN_FAIL_WINDOW = 15 * 60
_login_failures: Dict[str, List[float]] = {}

def login_blocked(username: str) -> bool:
    now = time.monotonic()
    recent = [t for t in _login_failures.get(username, []) if now - t < LOGIN_FAIL_WINDOW]
    if recent:
        _login_failures[username] = recent
    else:
        _login_failures.pop(username, None)
    return len(recent) >= LOGIN_FAIL_LIMIT

def record_login_failure(username: str):
    if len(_login_failures) > 10000:
        _login_failures.clear()
    _login_failures.setdefault(username, []).append(time.monotonic())

def validate_new_password(password: str):
    if len(password) < PASSWORD_MIN_LEN or len(password) > PASSWORD_MAX_LEN:
        raise HTTPException(status_code=400, detail=f"密码长度需为 {PASSWORD_MIN_LEN}-{PASSWORD_MAX_LEN} 位")

# --- Pydantic 请求模型 ---
class AuthBase(BaseModel):
    token: str
    password: str

class AddDeviceRequest(AuthBase):
    url: str
    note: Optional[str] = None

class DeleteDeviceRequest(AuthBase):
    device_id: int

class UpdateDeviceRequest(AuthBase):
    device_id: int
    note: Optional[str] = None

def resolve_device_note(note: Optional[str], other_notes, position: Optional[int] = None) -> str:
    note = (note or "").strip()
    if len(note) > DEVICE_NOTE_MAX_LEN:
        raise HTTPException(status_code=400, detail=f"备注最多 {DEVICE_NOTE_MAX_LEN} 个字符")
    return note or default_device_note(other_notes, position)

class MessageRequest(AuthBase):
    limit: int = 50
    q: Optional[str] = None
    trash: bool = False

class MessageCountRequest(AuthBase):
    q: Optional[str] = None
    trash: bool = False

# 批量操作：指定 ids，或 all_matching=True 作用于当前搜索条件下的全部消息
class MessageBatchRequest(AuthBase):
    ids: Optional[List[int]] = None
    q: Optional[str] = None
    all_matching: bool = False

class ImportRequest(AuthBase):
    mode: str
    data: dict

class ChangePasswordRequest(AuthBase):
    new_password: str

class ChangeUsernameRequest(AuthBase):
    new_username: str

class RegisterRequest(BaseModel):
    username: str
    password: str

class LoginRequest(BaseModel):
    username: str
    password: str

# 找回密码按用户名定位；token 字段保留给旧版前端
class ResetRequest(BaseModel):
    username: Optional[str] = None
    token: Optional[str] = None

class ResetConfirmRequest(ResetRequest):
    code: str
    new_password: str

def find_reset_user(db: Session, req: ResetRequest) -> Optional["User"]:
    if req.username:
        return db.query(User).filter(User.username == normalize_username(req.username)).first()
    if req.token:
        return db.query(User).filter(User.token == req.token.strip()).first()
    return None

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

TRASH_RETENTION = timedelta(days=30)

def purge_expired_trash():
    db = SessionLocal()
    try:
        cutoff = datetime.now() - TRASH_RETENTION
        n = db.query(PushMessage).filter(PushMessage.deleted_at.isnot(None), PushMessage.deleted_at < cutoff).delete(synchronize_session=False)
        db.commit()
        if n:
            logging.warning(f"Purged {n} message(s) from trash")
    finally:
        db.close()

async def trash_purger():
    while True:
        try:
            purge_expired_trash()
        except Exception as e:
            logging.error(f"Trash purge error: {e}")
        await asyncio.sleep(3600)

@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client
    http_client = httpx.AsyncClient()
    worker_task = asyncio.create_task(bark_worker())
    purge_task = asyncio.create_task(trash_purger())
    yield
    worker_task.cancel()
    purge_task.cancel()
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

def message_dict(m: "PushMessage") -> dict:
    return {
        "id": m.id, "title": m.title, "subtitle": m.subtitle, "body": m.body,
        "created_at": m.created_at.isoformat() if m.created_at else None,
        "deleted_at": m.deleted_at.isoformat() if m.deleted_at else None,
        "params": m.raw_params,
    }

# --- 实时推送订阅（安卓客户端通过 /stream 长连接接收）---
STREAM_PING_SECONDS = 25
STREAM_BACKLOG_LIMIT = 50
_subscribers: Dict[int, set] = {}

def publish_to_user(user_id: int, event: str, data: dict):
    for queue in list(_subscribers.get(user_id, ())):
        try:
            queue.put_nowait((event, data))
        except asyncio.QueueFull:
            pass

def unsubscribe(user_id: int, queue: asyncio.Queue):
    subs = _subscribers.get(user_id)
    if subs is not None:
        subs.discard(queue)
        if not subs:
            _subscribers.pop(user_id, None)

def sse_event(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

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
    publish_to_user(user.id, "message", message_dict(msg))
    urls = [d.url for d in user.devices]
    await message_queue.put({"urls": urls, "payload": data})
    return True

# --- API 路由 (管理类全部改为 POST) ---

@app.post("/register")
async def register_user(req: RegisterRequest, db: Session = Depends(get_db)):
    username = normalize_username(req.username)
    validate_username(username)
    validate_new_password(req.password)
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(status_code=409, detail="用户名已被占用")
    user = User(token=secrets.token_hex(16), username=username, password=hash_password(req.password))
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="用户名已被占用")
    return {"username": user.username, "token": user.token}

@app.post("/login")
async def login(req: LoginRequest, db: Session = Depends(get_db)):
    username = normalize_username(req.username)
    if login_blocked(username):
        raise HTTPException(status_code=429, detail="登录失败次数过多，请 15 分钟后再试")
    user = db.query(User).filter(User.username == username).first()
    if not user or not check_password(req.password, user.password):
        record_login_failure(username)
        raise HTTPException(status_code=401, detail="用户名或密码不正确")
    _login_failures.pop(username, None)
    return {"username": user.username, "token": user.token}

@app.post("/account/username")
async def change_username(req: ChangeUsernameRequest, db: Session = Depends(get_db)):
    user = verify_user(db, req.token, req.password)
    username = normalize_username(req.new_username)
    validate_username(username)
    if username == user.username:
        return {"status": "success", "username": username}
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(status_code=409, detail="用户名已被占用")
    user.username = username
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="用户名已被占用")
    return {"status": "success", "username": username}

@app.post("/password/change")
async def change_password(req: ChangePasswordRequest, db: Session = Depends(get_db)):
    user = verify_user(db, req.token, req.password)
    validate_new_password(req.new_password)
    user.password = hash_password(req.new_password)
    db.query(PasswordReset).filter(PasswordReset.user_id == user.id).delete()
    db.commit()
    return {"status": "success"}

RESET_SENT_MESSAGE = "如果该用户存在且已绑定设备或已登录安卓客户端，验证码已推送到你的设备"

@app.post("/password/reset/request")
async def request_password_reset(req: ResetRequest, db: Session = Depends(get_db)):
    now = datetime.now()
    db.query(PasswordReset).filter(PasswordReset.expires_at < now).delete()
    db.commit()
    user = find_reset_user(db, req)
    if not user or (not user.devices and not _subscribers.get(user.id)):
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
    # 不写入消息历史，直接推送到所有已绑定设备和在线的安卓客户端
    publish_to_user(user.id, "notice", payload)
    await message_queue.put({"urls": [d.url for d in user.devices], "payload": payload})
    return {"status": "sent", "message": RESET_SENT_MESSAGE}

@app.post("/password/reset/confirm")
async def confirm_password_reset(req: ResetConfirmRequest, db: Session = Depends(get_db)):
    invalid = HTTPException(status_code=400, detail="验证码无效或已过期")
    user = find_reset_user(db, req)
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
    return {"username": user.username, "devices": [{"id": d.id, "url": d.url, "note": d.note} for d in user.devices]}

@app.post("/config/add")
async def add_device(req: AddDeviceRequest, db: Session = Depends(get_db)):
    user = verify_user(db, req.token, req.password)
    note = resolve_device_note(req.note, [d.note for d in user.devices])
    new_device = DownstreamDevice(user_id=user.id, url=req.url, note=note)
    db.add(new_device)
    db.commit()
    return {"status": "success", "device_id": new_device.id, "note": note}

@app.post("/config/update")
async def update_device(req: UpdateDeviceRequest, db: Session = Depends(get_db)):
    user = verify_user(db, req.token, req.password)
    device = db.query(DownstreamDevice).filter(DownstreamDevice.id == req.device_id, DownstreamDevice.user_id == user.id).first()
    if not device: raise HTTPException(status_code=404)
    position = [d.id for d in user.devices].index(device.id) + 1
    device.note = resolve_device_note(req.note, [d.note for d in user.devices if d.id != device.id], position)
    db.commit()
    return {"status": "success", "note": device.note}

@app.post("/config/delete")
async def delete_device(req: DeleteDeviceRequest, db: Session = Depends(get_db)):
    user = verify_user(db, req.token, req.password)
    device = db.query(DownstreamDevice).filter(DownstreamDevice.id == req.device_id, DownstreamDevice.user_id == user.id).first()
    if not device: raise HTTPException(status_code=404)
    db.delete(device)
    db.commit()
    return {"status": "deleted"}

def message_query(db: Session, user_id: int, trash: bool, q: Optional[str] = None):
    query = db.query(PushMessage).filter(PushMessage.user_id == user_id)
    query = query.filter(PushMessage.deleted_at.isnot(None) if trash else PushMessage.deleted_at.is_(None))
    q = (q or "").strip()
    if q:
        pattern = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        query = query.filter(or_(
            PushMessage.title.ilike(pattern, escape="\\"),
            PushMessage.subtitle.ilike(pattern, escape="\\"),
            PushMessage.body.ilike(pattern, escape="\\"),
        ))
    return query

def batch_target(db: Session, user_id: int, trash: bool, req: MessageBatchRequest):
    query = message_query(db, user_id, trash, req.q if req.all_matching else None)
    if req.all_matching:
        return query
    if not req.ids:
        raise HTTPException(status_code=400, detail="未选择任何消息")
    return query.filter(PushMessage.id.in_(req.ids))

@app.post("/messages")
async def get_messages(req: MessageRequest, db: Session = Depends(get_db)):
    user = verify_user(db, req.token, req.password)
    order = PushMessage.deleted_at.desc() if req.trash else PushMessage.created_at.desc()
    msgs = message_query(db, user.id, req.trash, req.q).order_by(order, PushMessage.id.desc()).limit(req.limit).all()
    return [message_dict(m) for m in msgs]

class StreamRequest(AuthBase):
    since_id: Optional[int] = None  # 上次收到的最大消息 id；传入时补发其后的消息（最多 50 条）

@app.post("/stream")
async def stream(req: StreamRequest):
    db = SessionLocal()
    try:
        user = verify_user(db, req.token, req.password)
        user_id, username = user.id, user.username
        # 先订阅再查补发，避免两者之间到达的消息丢失；客户端按 id 去重
        queue: asyncio.Queue = asyncio.Queue(maxsize=200)
        _subscribers.setdefault(user_id, set()).add(queue)
        try:
            latest = message_query(db, user_id, False).order_by(PushMessage.id.desc()).first()
            latest_id = latest.id if latest else 0
            backlog, backlog_total = [], 0
            if req.since_id is not None:
                newer = message_query(db, user_id, False).filter(PushMessage.id > req.since_id)
                backlog_total = newer.count()
                backlog = [message_dict(m) for m in reversed(newer.order_by(PushMessage.id.desc()).limit(STREAM_BACKLOG_LIMIT).all())]
        except Exception:
            unsubscribe(user_id, queue)
            raise
    finally:
        db.close()

    async def events():
        try:
            yield sse_event("hello", {"latest_id": latest_id, "username": username})
            if req.since_id is not None:
                yield sse_event("backlog", {"messages": backlog, "total": backlog_total})
            while True:
                try:
                    event, data = await asyncio.wait_for(queue.get(), timeout=STREAM_PING_SECONDS)
                    yield sse_event(event, data)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            unsubscribe(user_id, queue)

    return StreamingResponse(events(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",  # 让 Nginx 不缓冲，事件即时下发
    })

@app.post("/messages/count")
async def count_messages(req: MessageCountRequest, db: Session = Depends(get_db)):
    user = verify_user(db, req.token, req.password)
    return {"count": message_query(db, user.id, req.trash, req.q).count(), "retention_days": TRASH_RETENTION.days}

@app.post("/messages/delete")
async def delete_messages(req: MessageBatchRequest, db: Session = Depends(get_db)):
    user = verify_user(db, req.token, req.password)
    n = batch_target(db, user.id, False, req).update({PushMessage.deleted_at: datetime.now()}, synchronize_session=False)
    db.commit()
    return {"status": "success", "count": n}

@app.post("/messages/restore")
async def restore_messages(req: MessageBatchRequest, db: Session = Depends(get_db)):
    user = verify_user(db, req.token, req.password)
    n = batch_target(db, user.id, True, req).update({PushMessage.deleted_at: None}, synchronize_session=False)
    db.commit()
    return {"status": "success", "count": n}

@app.post("/messages/purge")
async def purge_messages(req: MessageBatchRequest, db: Session = Depends(get_db)):
    user = verify_user(db, req.token, req.password)
    n = batch_target(db, user.id, True, req).delete(synchronize_session=False)
    db.commit()
    return {"status": "success", "count": n}

@app.post("/data/export")
async def export_data(req: AuthBase, db: Session = Depends(get_db)):
    user = verify_user(db, req.token, req.password)
    return {
        "export_time": datetime.now().isoformat(),
        "devices": [{"url": d.url, "note": d.note} for d in user.devices],
        "messages": [{"title": m.title, "body": m.body, "params": m.raw_params, "created_at": m.created_at.isoformat()} for m in user.messages if m.deleted_at is None]
    }

@app.post("/data/import")
async def import_data(req: ImportRequest, db: Session = Depends(get_db)):
    user = verify_user(db, req.token, req.password)
    if req.mode == "overwrite":
        db.query(DownstreamDevice).filter(DownstreamDevice.user_id == user.id).delete()
        db.query(PushMessage).filter(PushMessage.user_id == user.id).delete()
    if "devices" in req.data:
        notes = [] if req.mode == "overwrite" else [d.note for d in user.devices]
        for d in req.data["devices"]:
            note = (d.get("note") or "").strip()[:DEVICE_NOTE_MAX_LEN] or default_device_note(notes)
            notes.append(note)
            db.add(DownstreamDevice(user_id=user.id, url=d["url"], note=note))
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
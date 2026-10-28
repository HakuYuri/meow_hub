# Meow Hub

Meow Hub 是一个自托管的多用户 [Bark](https://github.com/Finb/Bark) 推送中转站：兼容 Bark 推送协议，收到的消息会保存为历史记录，并同时分发到你绑定的多个下级 Bark 设备。适合配合 SMSForwarder 等转发工具，把短信、通知集中到一处查看和管理。

## 功能

- **兼容 Bark 协议**：直接把 `https://<你的域名>/<token>` 当作 Bark 推送地址使用，支持 GET 路径参数、POST JSON / 表单和 `/push` 接口。
- **多设备分发**：每个账号可绑定多个下级 Bark 地址，推送会同时转发到全部设备；设备支持备注。
- **消息管理**：网页查看历史消息，服务端搜索，单条 / 多选 / 搜索结果全选删除。
- **回收站**：删除的消息先进入回收站，可恢复或永久删除，30 天后自动彻底清理。
- **验证码识别**：网页端自动识别简体、繁体中文和英文验证码短信，显示验证码并一键复制（纯前端计算）。
- **账号**：用户名 + 密码注册登录，可修改用户名和密码；忘记密码时，验证码会推送到已绑定的设备。
- **数据备份**：导出 / 导入设备配置和消息记录（JSON）。

## 项目结构

```
main.py            后端（FastAPI + SQLAlchemy + SQLite）
run.sh             启动脚本（uvicorn，默认端口 19988）
requirements.txt   后端依赖
bark_front/        前端源码（React + Vite + Tailwind CSS）
static/            前端构建产物，由 Web 服务器直接提供
```

前端与后端分开部署：后端提供 API 与 Bark 推送入口，`static/` 由 Nginx 等 Web 服务器作为静态站点提供。前端请求的 API 地址写在 `bark_front/src/App.jsx` 的 `API_BASE` 中，自行部署时需要改成你自己的后端域名。

## 部署

### 后端

需要 Python 3.10+。

```bash
git clone https://github.com/HakuYuri/meow_hub.git
cd meow_hub
python3 -m venv venv
venv/bin/pip install -r requirements.txt
./run.sh
```

首次启动会在当前目录创建 SQLite 数据库 `bark_multiuser.db`。

使用 systemd 常驻运行的示例：

```ini
[Unit]
Description=Meow - Bark Relay Hub
After=network.target

[Service]
User=ubuntu
WorkingDirectory=/path/to/meow_hub
Environment="PATH=/path/to/meow_hub/venv/bin"
ExecStart=bash ./run.sh
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

建议在前面加一层反向代理并启用 HTTPS。

### 前端

```bash
cd bark_front
npm install
npm run dev      # 本地开发
npm run build    # 构建到 bark_front/dist
```

构建后把 `dist/` 里的内容复制到仓库根目录的 `static/`。

> 如果 Web 服务器（例如 Docker 容器）是以目录挂载的方式提供 `static/`，更新时只替换目录里的文件，**不要删除重建 `static/` 目录本身**，否则容器仍挂着已删除的旧目录，页面会变成 403。

### 升级与数据迁移

数据库结构变更（新增字段、旧明文密码转哈希等）会在服务启动时自动完成，可重复执行。升级前建议先备份 `bark_multiuser.db`；回滚到旧版本代码时需要同时恢复备份的数据库。

## API

### Bark 兼容推送

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/{token}/{body}`、`/{token}/{title}/{body}`、`/{token}/{title}/{subtitle}/{body}` | 路径参数推送，其余 Bark 参数放在 query 中 |
| GET | `/{token}?title=...&body=...` | query 推送；不带 title / body 时为健康检查 |
| POST | `/{token}` | JSON 或表单推送 |
| POST | `/push` | JSON 推送，`device_key` 为 token |

### 管理接口

以下接口均为 POST + JSON。除注册、登录和找回密码外，请求体都需要带 `token` 和 `password`。

| 路径 | 说明 |
|---|---|
| `/register` | 注册：`username`、`password` |
| `/login` | 登录：`username`、`password`，返回 `token` |
| `/account/username` | 修改用户名：`new_username` |
| `/password/change` | 修改密码：`new_password` |
| `/password/reset/request` | 找回密码，向已绑定设备推送验证码：`username` |
| `/password/reset/confirm` | 用验证码重置密码：`username`、`code`、`new_password` |
| `/config` | 获取用户名和设备列表 |
| `/config/add` | 添加设备：`url`，可选 `note` |
| `/config/update` | 修改设备备注：`device_id`、`note` |
| `/config/delete` | 删除设备：`device_id` |
| `/messages` | 消息列表：`limit`，可选 `q`（搜索）、`trash`（回收站） |
| `/messages/count` | 消息数量：可选 `q`、`trash` |
| `/messages/delete` | 移到回收站：`ids`，或 `all_matching: true` + `q` |
| `/messages/restore` | 从回收站恢复：同上 |
| `/messages/purge` | 永久删除回收站消息：同上 |
| `/data/export` | 导出设备与消息 |
| `/data/import` | 导入：`mode`（`append` / `overwrite`）、`data` |

## 安全说明

- 密码使用 PBKDF2-SHA256 加盐哈希存储。
- 登录按用户名限流：15 分钟内失败 10 次会暂时锁定。
- 找回密码的验证码 10 分钟有效，最多尝试 5 次，同一账号 60 秒内只能请求一次。
- 推送 token 相当于推送地址的密钥，请勿公开。

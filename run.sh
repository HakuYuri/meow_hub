#!/bin/bash

# --- 1. 获取脚本所在的绝对路径 ---
APP_DIR="~/meow_hub"
VENV_PATH="$APP_DIR/venv"

exec $VENV_PATH/bin/uvicorn main:app \
    --host 0.0.0.0 \
    --port 19988 

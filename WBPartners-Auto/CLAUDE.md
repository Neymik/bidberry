# WB Partners Automation

## Project Goal
Automate the WB Partners (Wildberries) mobile Android app to monitor orders in real-time, store them in SQLite, and send notifications + analytics via Telegram bot.

## Authoritative data source

WBPartners-Auto is the **authoritative source of truth for orders** for the Остапенко cabinet. The WB API (via the bidberry backend) is unreliable for order data — it lags, undercounts, and sometimes breaks. The phone sees exactly what the seller sees in the WB Partners Android app, in near-realtime. When reports need order data, they should pull from this project's SQLite (`orders.db`) or HTTP API (port 22001), not from the WB API.

Use the WB Advert API (via bidberry) only for data the phone cannot observe: ad spend, campaign budgets, CPM bids, balance.

## Architecture
- **Python + uiautomator2** for UI automation and data extraction
- **ADB** for device/app management
- **Telegram Bot** for notifications and order analytics commands
- **FastAPI** REST API for programmatic access
- **SQLite** for order storage

## Deployments

### Production: ostapLace (remote server)
- **Server:** Ubuntu 24.04.1 LTS (`ssh ostapLace`)
- **Device:** Huawei DNN-LX9 (Android 10) via USB, serial `AKPNU20B20107099`
- **App:** `wb.partners` (WB Partners)
- **Service:** systemd `wb-monitor` (auto-start on boot, auto-restart on crash)
- **Proxy:** Telegram blocked in Russia — uses local proxy (`http://127.0.0.1:3128`, `socks5://127.0.0.1:1080`)
- **Logs:** `/home/ostap/WBPartners-Auto/monitor.log`
- **API:** `http://localhost:22001` (FastAPI + Swagger at `/docs`)

#### Service management
```bash
sudo systemctl status wb-monitor     # check status
sudo systemctl restart wb-monitor    # restart
sudo systemctl stop wb-monitor       # stop
sudo journalctl -u wb-monitor -f     # follow systemd journal
tail -f ~/WBPartners-Auto/monitor.log  # follow app log
```

#### Deploying updates
```bash
# From local machine:
rsync -avz --exclude='venv/' --exclude='__pycache__/' --exclude='orders.db' --exclude='*.apk' --exclude='server.log' \
  ~/Documents/bidberry/WBPartners-Auto/ ostapLace:~/WBPartners-Auto/
ssh ostapLace "sudo systemctl restart wb-monitor"
```

### Local: macOS (development)
- **AVD Name:** `wb_auto` (Pixel 6, Android 14 with Play Store)
- **ANDROID_HOME:** `/opt/homebrew/share/android-commandlinetools`
- **Launch headless:** `emulator -avd wb_auto -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect &`

## Huawei Device Quirks
- **INJECT_EVENTS error:** `d.swipe()` fails with `SecurityException` on Huawei EMUI. All swipe operations use `adb shell input swipe` via the `adb_swipe()` helper instead.
- **`d.swipe_ext()`** works for full-screen directional swipes (used in navigation).
- **`d.click()`** and **`d.scroll.forward()`** work normally.
- **Screen timeout:** Disabled via `adb shell settings put system screen_off_timeout 2147483647` + `svc power stayon true`.
- **uiautomator2 init:** Must re-run `python -m uiautomator2 init` after device reconnects or atx-agent crashes.

## App Navigation (WB Partners)
The monitor auto-navigates to "Лента заказов" on startup and re-navigates if the page is lost. Path:

1. Press `top_app_bar_back_button` repeatedly → main dashboard
2. `d.swipe_ext("up")` × 3 → scroll past Продажи/Выкупы/Статистика to "Лента заказов" section
3. ADB swipe left in order carousel → reveals "Все заказы" button
4. ADB tap "Все заказы" at (880, 2045) — avoid overlapping `w_bot_button`
5. Verify `top_app_bar_header_text == "Лента заказов"`

## Order Parsing (Лента заказов page)
The page has a scrollable container with flat children separated by `wb_image` elements. Each order group contains labeled fields:
- Product name (first text node)
- Article (digit string > 5 chars)
- Size ("Размер X")
- Quantity ("N шт")
- "Дата оформления" + date value (e.g., "5 апр, 16:35")
- "Стоимость" + price value (e.g., "2 495 ₽")
- "Прибытие" + city value
- "Склад WB" + warehouse value

No status tag on this page — status defaults to "Заказ" (tab filter applies).

## Telegram Bot Commands
| Command | Description |
|---------|-------------|
| `/orders [N]` | Last N orders (default 5, max 50) |
| `/count` | Today's totals: count, revenue, by-status, by-article |
| `/count hour` | Last hour totals |
| `/count YYYY-MM-DD` | Totals for specific date |
| `/count YYYY-MM-DD YYYY-MM-DD` | Totals for date range |
| `/status Заказ\|Отказ\|Выкуп\|Возврат` | Filter by status |
| `/stats` | Overall statistics |
| `/csv [start] [end]` | Export orders as CSV |

The `/count` command includes an article summary table (Артикул | Кол-во | Сумма). If >3 articles, sent as CSV file attachment.

## Environment Variables (.env)
| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Yes | Telegram chat ID for notifications |
| `ANDROID_DEVICE` | No | Device serial (empty = auto-detect) |
| `API_KEY` | **Yes** | Required. REST API auth key. All `/orders`, `/stats`, `/export/csv` endpoints reject requests without `X-API-Key: <value>`. |
| `TRIGGER_SECRET` | **Yes** | Required. Same value as bidberry's `TRIGGER_SECRET`. Sent as `X-Trigger-Secret` header when calling `/api/trigger/cabinet-report/:cabinetId`. |
| `BIDBERRY_URL` | No | Default `http://127.0.0.1:3000`. Where to reach bidberry trigger endpoints. |
| `BIDBERRY_CABINET_ID` | No | If set, the bot's `/count` and the order monitor will fetch a rich report from bidberry for this cabinet ID. |
| `API_PORT` | No | API port (default 22001) |
| `http_proxy` | Server | HTTP proxy for Telegram |
| `https_proxy` | Server | HTTPS proxy for Telegram |
| `ALL_PROXY` | Server | SOCKS5 proxy for Telegram |

## Python Dependencies
```
uiautomator2          # Android UI automation
python-telegram-bot   # Telegram bot (with [socks] extra on server)
python-dotenv         # .env loading
requests              # HTTP client
Pillow                # Image processing
fastapi               # REST API
uvicorn[standard]     # ASGI server
httpx[socks]          # SOCKS proxy support (server only)
```

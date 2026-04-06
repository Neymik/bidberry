# VPS Deployment Guide

## VPS Requirements

- **OS:** Ubuntu 22.04+ or Debian 12+
- **CPU:** x86_64 with KVM support (verify: `egrep -c '(vmx|svm)' /proc/cpuinfo` > 0)
- **RAM:** 4 GB minimum
- **Storage:** 20 GB minimum
- **Providers with KVM:** Hetzner (CPX/CCX), OVH dedicated, AWS bare metal

> ARM VPS will NOT work — Android emulator images for ARM on Linux are very limited.

## 1. System Setup

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y \
    python3 python3-pip python3-venv \
    openjdk-17-jdk-headless \
    unzip wget curl \
    libgl1-mesa-dev libpulse0 libnss3 \
    adb qemu-kvm nginx

# Enable KVM for your user
sudo adduser $USER kvm
# Verify
ls -la /dev/kvm
```

## 2. Android SDK + Emulator

```bash
# Download command-line tools
mkdir -p ~/android-sdk/cmdline-tools
cd ~/android-sdk/cmdline-tools
wget https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
unzip commandlinetools-linux-11076708_latest.zip
mv cmdline-tools latest

# Environment variables (add to ~/.bashrc)
cat >> ~/.bashrc << 'EOF'
export ANDROID_HOME=$HOME/android-sdk
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator
EOF
source ~/.bashrc

# Install SDK components
yes | sdkmanager --licenses
sdkmanager "platform-tools" "emulator" \
    "platforms;android-34" \
    "system-images;android-34;google_apis;x86_64"

# Create AVD
avdmanager create avd -n wb_auto \
    -k "system-images;android-34;google_apis;x86_64" \
    -d "pixel_6"
```

### Test emulator

```bash
emulator -avd wb_auto -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect &
adb wait-for-device shell 'while [[ -z $(getprop sys.boot_completed | tr -d "\r") ]]; do sleep 2; done'
adb shell input keyevent 82
echo "Emulator ready"
```

### Install the WB Partners app

On your Mac (where the app is already installed), extract the APK:

```bash
# On Mac
adb shell pm path wb.partners
# Output: package:/data/app/.../base.apk
adb pull /data/app/.../base.apk wb_partners.apk
```

Transfer `wb_partners.apk` to the VPS and install:

```bash
# On VPS
adb install wb_partners.apk
```

Then log in to your account on the emulator (you'll need GUI access once — use VNC or temporarily enable `-no-window` off).

## 3. Application Setup

```bash
# Clone or copy project files
sudo mkdir -p /opt/wbpartners-automation
sudo chown $USER:$USER /opt/wbpartners-automation
cd /opt/wbpartners-automation
# Copy files here (git clone, scp, etc.)

# Python virtual environment
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Configure environment
cp .env.example .env
nano .env
# Fill in:
#   TELEGRAM_BOT_TOKEN=<from BotFather>
#   TELEGRAM_CHAT_ID=<your chat id>
#   API_KEY=<generate: python3 -c "import secrets; print(secrets.token_hex(32))">
#   API_PORT=8000
```

## 4. systemd Service

Create `/etc/systemd/system/wb-emulator.service`:

```ini
[Unit]
Description=Android Emulator for WB Partners
After=network.target

[Service]
Type=forking
User=wbuser
Environment=ANDROID_HOME=/home/wbuser/android-sdk
Environment=PATH=/home/wbuser/android-sdk/emulator:/home/wbuser/android-sdk/platform-tools:/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/bash -c 'emulator -avd wb_auto -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect &'
ExecStartPost=/bin/bash -c 'adb wait-for-device shell "while [[ -z $(getprop sys.boot_completed | tr -d \\r) ]]; do sleep 2; done" && adb shell input keyevent 82 && adb emu geo fix 37.6173 55.7558'
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Create `/etc/systemd/system/wb-monitor.service`:

```ini
[Unit]
Description=WB Partners Order Monitor
After=wb-emulator.service
Requires=wb-emulator.service

[Service]
Type=simple
User=wbuser
WorkingDirectory=/opt/wbpartners-automation
ExecStart=/opt/wbpartners-automation/venv/bin/python wb_order_monitor.py
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable wb-emulator wb-monitor
sudo systemctl start wb-emulator
# Wait for emulator to boot (~30s), then:
sudo systemctl start wb-monitor
```

View logs:

```bash
sudo journalctl -u wb-monitor -f
```

## 5. Nginx Reverse Proxy

Create `/etc/nginx/sites-available/wb-api`:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/wb-api /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### TLS (optional but recommended)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

## 6. Firewall

```bash
sudo ufw allow 22/tcp   # SSH
sudo ufw allow 80/tcp   # HTTP
sudo ufw allow 443/tcp  # HTTPS
sudo ufw enable
```

Do NOT expose port 8000 directly — use nginx.

## 7. API Usage

Docs available at `https://your-domain.com/docs` (Swagger UI).

### Examples

```bash
# Health check (no auth)
curl https://your-domain.com/health

# Recent orders
curl -H "X-API-Key: YOUR_KEY" https://your-domain.com/orders?limit=10

# Filter by status
curl -H "X-API-Key: YOUR_KEY" https://your-domain.com/orders?status=Заказ

# Date range
curl -H "X-API-Key: YOUR_KEY" "https://your-domain.com/orders?start_date=2026-03-09&end_date=2026-03-09"

# Orders by article
curl -H "X-API-Key: YOUR_KEY" https://your-domain.com/orders/62441596

# Stats
curl -H "X-API-Key: YOUR_KEY" https://your-domain.com/stats

# CSV export
curl -H "X-API-Key: YOUR_KEY" -o orders.csv "https://your-domain.com/export/csv?start_date=2026-03-01&end_date=2026-03-09"
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `emulator: command not found` | Check `ANDROID_HOME` and `PATH` in service file |
| `/dev/kvm not found` | VPS doesn't support KVM — need bare metal or nested virt |
| `adb: no devices` | Emulator not running — check `wb-emulator` service |
| API returns 403 | Wrong `X-API-Key` header |
| Bot not responding | Check `TELEGRAM_BOT_TOKEN` in .env |

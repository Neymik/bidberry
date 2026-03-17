FROM python:3.12-slim

RUN pip install --no-cache-dir uiautomator2 requests && \
    apt-get update && apt-get install -y --no-install-recommends android-tools-adb && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

COPY . /opt/wb-monitor/
WORKDIR /opt/wb-monitor

CMD ["python3", "run.py"]

FROM node:20-slim

# Install Python, OpenCV dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY requirements.txt ./
# --break-system-packages is used here because we are in a container environment
RUN pip3 install --no-cache-dir -r requirements.txt --break-system-packages

COPY . .

# Set a fallback port
ENV PORT=8080
EXPOSE 8080

CMD ["node", "websocket-server.js"]

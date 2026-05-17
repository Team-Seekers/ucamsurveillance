const express = require("express");
const app = express();
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const http = require("http");
const nodemailer = require("nodemailer");
const twilio = require("twilio");

const port = process.env.PORT || 8080;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// --- Time Range Configuration (Server-side state) ---
let activeTimeRange = {
  startTime: "00:00",
  endTime: "23:59",
  isActive: false,
};

// --- Notification State (Server-side state) ---
let warnCount = 0;
const NOTIFICATION_INTERVAL_MS = 10 * 1000; // 10 seconds
let lastEmailNotificationTime = 0;
let lastSMSNotificationTime = 0;
let lastWebNotificationTime = 0;

let notificationPreferences = {
  email: true,
  sms: true,
  web: true,
};

const emailUser = process.env.EMAIL_USER || "";
const emailPass = process.env.EMAIL_PASS || ""; 

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465, 
  secure: true, 
  auth: {
    user: emailUser,
    pass: emailPass,
  },
  pool: true, 
  maxConnections: 5, 
  maxMessages: 100, 
  rateLimit: 10, 
  timeout: 15000, 
  socketTimeout: 30000, 
  logger: false, 
  debug: false, 
});

const accountSid = process.env.TWILIO_ACCOUNT_SID || "";
const authToken = process.env.TWILIO_AUTH_TOKEN || "";

let twilioClient;
try {
  twilioClient = twilio(accountSid, authToken);
} catch (error) {
  console.error("Error initializing Twilio client:", error.message);
  twilioClient = null;
}

const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER || "";

let cameraStatus = {
  isOnline: false,
  lastSeen: null,
  isEnabled: true,
  uptimeStart: null,
};

let sessionWarnCounts = new Map();
let sessionStartTimes = new Map();

function isWithinActiveTimeRange() {
  if (!activeTimeRange.isActive) return false;
  const now = new Date();
  const currentHours = now.getHours();
  const currentMinutes = now.getMinutes();
  const currentTimeInMinutes = currentHours * 60 + currentMinutes;

  const [startHours, startMinutes] = activeTimeRange.startTime.split(":").map(Number);
  const [endHours, endMinutes] = activeTimeRange.endTime.split(":").map(Number);

  const startTimeInMinutes = startHours * 60 + startMinutes;
  const endTimeInMinutes = endHours * 60 + endMinutes;

  if (endTimeInMinutes < startTimeInMinutes) {
    return (currentTimeInMinutes >= startTimeInMinutes || currentTimeInMinutes <= endTimeInMinutes);
  }
  return (currentTimeInMinutes >= startTimeInMinutes && currentTimeInMinutes <= endTimeInMinutes);
}

function broadcastToAll(message) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

const wsUserDataMap = new Map();

wss.on("connection", (ws, req) => {
  console.log("Client connected via WebSocket.");

  sessionWarnCounts.set(ws, 0);
  sessionStartTimes.set(ws, new Date());

  cameraStatus.isOnline = true;
  cameraStatus.lastSeen = new Date();
  if (!cameraStatus.uptimeStart) {
    cameraStatus.uptimeStart = new Date();
  }

  broadcastToAll({
    type: "camera_status",
    status: {
      isOnline: cameraStatus.isOnline,
      isEnabled: cameraStatus.isEnabled,
      lastSeen: cameraStatus.lastSeen.toISOString(),
      uptime: cameraStatus.uptimeStart ? Math.floor((new Date() - cameraStatus.uptimeStart) / (1000 * 60)) : 0,
    },
  });

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === "user_data") {
        if (!data.userData || !data.userData.email) {
          console.warn("Received user data without email:", data.userData);
        } else {
          wsUserDataMap.set(ws, data.userData);
        }
        return;
      }

      if (data.type === "image_frame" && data.image_data) {
        cameraStatus.lastSeen = new Date();

        broadcastToAll({
          type: "camera_status",
          status: {
            isOnline: cameraStatus.isOnline,
            isEnabled: cameraStatus.isEnabled,
            lastSeen: cameraStatus.lastSeen.toISOString(),
            uptime: cameraStatus.uptimeStart ? Math.floor((new Date() - cameraStatus.uptimeStart) / (1000 * 60)) : 0,
          },
        });

        if (!cameraStatus.isEnabled) {
          ws.send(JSON.stringify({ type: "status_update", status: "inactive", message: "Camera is currently disabled." }));
          return;
        }

        if (activeTimeRange.isActive && !isWithinActiveTimeRange()) {
          ws.send(JSON.stringify({ type: "status_update", status: "inactive", message: "System is currently outside active time range." }));
          return;
        }

        const pythonProcess = spawn("python", [path.join(__dirname, "BackEnd/detect.py")]);
        pythonProcess.stdin.write(data.image_data);
        pythonProcess.stdin.end();

        let detectionResults = "";
        let errorOutput = "";

        pythonProcess.stdout.on("data", (output) => { detectionResults += output.toString(); });
        pythonProcess.stderr.on("data", (output) => { errorOutput += output.toString(); });

        pythonProcess.on("close", (code) => {
          if (code === 0) {
            try {
              const results = JSON.parse(detectionResults);
              if (results.human_detected) {
                const clientUserData = wsUserDataMap.get(ws);
                handleHumanDetection(results, data.image_data, clientUserData, ws);
              } else {
                sessionWarnCounts.set(ws, 0);
              }
            } catch (error) {
              console.error("Error parsing JSON from Python:", error.message);
            }
          }
        });
      } else if (data.type === "camera_toggle" && data.camera_enabled !== undefined) {
        cameraStatus.isEnabled = data.camera_enabled;
        if (!cameraStatus.isEnabled) warnCount = 0;
        broadcastToAll({
          type: "camera_status",
          status: {
            isOnline: cameraStatus.isOnline,
            isEnabled: cameraStatus.isEnabled,
            lastSeen: cameraStatus.lastSeen ? cameraStatus.lastSeen.toISOString() : null,
            uptime: cameraStatus.uptimeStart ? Math.floor((new Date() - cameraStatus.uptimeStart) / (1000 * 60)) : 0,
          },
        });
      }
    } catch (error) {
      if (!error.message.includes("ENAMETOOLONG")) {
        console.error("WebSocket message error:", error.message);
      }
    }
  });

  ws.on("close", () => {
    wsUserDataMap.delete(ws);
    sessionWarnCounts.delete(ws);
    sessionStartTimes.delete(ws);
    if (wss.clients.size === 0) {
      cameraStatus.isOnline = false;
      cameraStatus.lastSeen = null;
      cameraStatus.uptimeStart = null;
    }
    broadcastToAll({
      type: "camera_status",
      status: {
        isOnline: cameraStatus.isOnline,
        isEnabled: cameraStatus.isEnabled,
        lastSeen: cameraStatus.lastSeen,
        uptime: 0,
      },
    });
  });

  ws.on("error", (error) => {
    wsUserDataMap.delete(ws);
    if (wss.clients.size === 0) {
      cameraStatus.isOnline = false;
      cameraStatus.lastSeen = null;
      cameraStatus.uptimeStart = null;
      warnCount = 0;
    }
  });
});

function formatToE164(phoneNumber) {
  if (!phoneNumber) return null;
  let cleanedNumber = phoneNumber.replace(/[^\d+]/g, "");
  if (cleanedNumber.startsWith("+")) return cleanedNumber;
  const defaultCountryCode = "91";
  if (!cleanedNumber.startsWith(defaultCountryCode)) cleanedNumber = defaultCountryCode + cleanedNumber;
  return "+" + cleanedNumber;
}

async function sendDetectionSMS(body, phoneNumber) {
  if (!twilioClient || !notificationPreferences.sms) return false;
  const now = Date.now();
  if (now - lastSMSNotificationTime < NOTIFICATION_INTERVAL_MS) return false;
  try {
    const formattedTo = formatToE164(phoneNumber);
    if (!formattedTo) return false;
    const formattedFrom = twilioPhoneNumber.startsWith("+") ? twilioPhoneNumber : `+${twilioPhoneNumber}`;
    await twilioClient.messages.create({ body: body, from: formattedFrom, to: formattedTo });
    lastSMSNotificationTime = now;
    return true;
  } catch (error) {
    return false;
  }
}

async function handleHumanDetection(results, imageData, userData, ws) {
  const now = Date.now();
  const sessionStartTime = sessionStartTimes.get(ws) || new Date();
  const sessionDuration = Math.floor((now - sessionStartTime.getTime()) / 1000);
  const warnCount = (sessionWarnCounts.get(ws) || 0) + 1;
  sessionWarnCounts.set(ws, warnCount);

  let emailSubject = "Security Alert: Human Detected";
  let emailBody = `<p>Human detected at ${new Date().toLocaleString()}. Warning Level: ${warnCount}</p>`;
  let smsBody = "Human detected.";

  if (warnCount >= 3) {
    emailSubject = `Security Alert: HIGH DANGER (Warning ${warnCount})`;
    smsBody = `HIGH DANGER: Human detected for ~${warnCount * (NOTIFICATION_INTERVAL_MS / 1000)}s.`;
  }

  if (notificationPreferences.email && now - lastEmailNotificationTime >= NOTIFICATION_INTERVAL_MS && userData?.email) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    sendDetectionEmail(emailSubject, emailBody, imageData, timestamp, userData.email);
    lastEmailNotificationTime = now;
  }

  if (notificationPreferences.sms && warnCount >= 3 && userData?.phonenumber) {
    await sendDetectionSMS(smsBody, userData.phonenumber);
  }

  if (notificationPreferences.web && now - lastWebNotificationTime >= NOTIFICATION_INTERVAL_MS) {
    broadcastToAll({
      type: "motion_detected",
      data: { ...results, detectionTime: new Date().toLocaleString(), imageData: imageData, warnCount: warnCount },
    });
    lastWebNotificationTime = now;
  }
}

function sendDetectionEmail(subject, body, imageData, timestamp, recipientEmail) {
  const mailOptions = {
    from: emailUser,
    to: recipientEmail,
    subject: `${subject} on ${timestamp}`,
    html: body,
    attachments: [
      {
        filename: "human_detected.jpg",
        content: imageData.split("base64,")[1],
        encoding: "base64",
      },
    ],
  };
  transporter.sendMail(mailOptions);
}

// Health check endpoint for Render
app.get("/", (req, res) => {
  res.send("WebSocket and Detection Server is running!");
});

app.use(express.json({ limit: "5mb" }));
app.use(require("cors")({ origin: "*" })); // Allow requests from Vercel

app.post("/api/update-notifications", (req, res) => {
  const { type, enabled } = req.body;
  if (type && typeof enabled === "boolean" && notificationPreferences.hasOwnProperty(type)) {
    notificationPreferences[type] = enabled;
    if (type === "web" && !enabled) {
      broadcastToAll({
        type: "status_update",
        status: "active",
        message: "System is active",
        details: { detectionTime: new Date().toLocaleString(), warnCount: 0, type: "web", enabled: false },
      });
    }
    res.json({ success: true, notificationPreferences });
  } else {
    res.status(400).json({ error: "Invalid request parameters" });
  }
});

app.get("/api/notification-preferences", (req, res) => {
  res.json(notificationPreferences);
});

app.post("/api/set-time-range", (req, res) => {
  const { startTime, endTime, isActive } = req.body;
  const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
  if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
    return res.status(400).json({ error: "Invalid time format. Use HH:MM format." });
  }
  activeTimeRange = { startTime, endTime, isActive: isActive !== undefined ? isActive : false };
  res.json({ message: "Time range updated successfully", activeTimeRange, cameraStatus });
});

app.get("/api/get-time-range", (req, res) => {
  res.json(activeTimeRange);
});

app.get("/api/camera-status", (req, res) => {
  res.json({
    isOnline: cameraStatus.isOnline,
    isEnabled: cameraStatus.isEnabled,
    lastSeen: cameraStatus.lastSeen ? cameraStatus.lastSeen.toISOString() : null,
    uptime: cameraStatus.uptimeStart ? Math.floor((new Date() - cameraStatus.uptimeStart) / (1000 * 60)) : 0,
  });
});

server.listen(port, () => {
  console.log(`WebSocket server running on port ${port}`);
});

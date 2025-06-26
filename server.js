// server.js
import express from "express";
import pkg from "whatsapp-web.js";
import cors from "cors";
import multer from "multer";
import http from "http";
import { WebSocketServer } from "ws";
import { parse } from "csv-parse/sync";
import qrcode from "qrcode";
import path from "path";
import { fileURLToPath } from "url";

const { Client, LocalAuth, MessageMedia } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 3016;
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const upload = multer({ storage: multer.memoryStorage() });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let client = null;
let isAuthenticated = false;
let currentUser = null;

// Password validation
const ADMIN_PASSWORD = "shams";

function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(message);
    }
  });
}

function initializeClient() {
  if (client) {
    try {
      client.destroy();
    } catch (error) {
      console.log('Client cleanup error:', error.message);
    }
  }
  
  client = new Client({
    authStrategy: new LocalAuth({ clientId: `session_${Date.now()}` }),
    puppeteer: { 
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor'
      ]
    },
  });

  client.on("qr", async (qr) => {
    try {
      const qrImage = await qrcode.toDataURL(qr);
      broadcast({ 
        type: "qr_code", 
        qrCode: qrImage,
        message: "Scan QR code with WhatsApp"
      });
    } catch (err) {
      console.error("Error generating QR code:", err);
    }
  });

  client.on("ready", () => {
    currentUser = client.info?.wid?.user || "Unknown";
    broadcast({ 
      type: "ready", 
      message: "WhatsApp connected successfully",
      phoneNumber: currentUser
    });
    console.log(`WhatsApp ready - Number: ${currentUser}`);
  });

  client.on("disconnected", (reason) => {
    currentUser = null;
    broadcast({ 
      type: "disconnected", 
      message: `WhatsApp disconnected: ${reason}` 
    });
    console.log(`WhatsApp disconnected: ${reason}`);
  });

  client.on("auth_failure", (msg) => {
    console.error("Authentication failure:", msg);
    broadcast({ 
      type: "auth_failure", 
      message: "Authentication failed. Please try connecting again." 
    });
  });

  try {
    client.initialize();
  } catch (error) {
    console.error("Client initialization error:", error);
    broadcast({ 
      type: "error", 
      message: "Failed to initialize WhatsApp client" 
    });
  }
}

// Routes
app.post("/authenticate", (req, res) => {
  const { password } = req.body;
  
  if (password === ADMIN_PASSWORD) {
    isAuthenticated = true;
    res.json({ status: "success", message: "Authentication successful" });
  } else {
    res.status(401).json({ status: "error", message: "Invalid password" });
  }
});

app.post("/connect-whatsapp", (req, res) => {
  if (!isAuthenticated) {
    return res.status(401).json({ status: "error", message: "Not authenticated" });
  }
  
  try {
    initializeClient();
    res.json({ status: "success", message: "WhatsApp connection initiated" });
  } catch (error) {
    res.status(500).json({ status: "error", message: "Failed to initialize WhatsApp" });
  }
});

app.post("/send-bulk-messages", upload.single("photo"), async (req, res) => {
  if (!isAuthenticated || !client) {
    return res.status(401).json({ status: "error", message: "Not authenticated or WhatsApp not connected" });
  }

  const { recipientsText, messageTemplate, delay = 60000 } = req.body;
  const photo = req.file;

  if (!recipientsText || !messageTemplate) {
    return res.status(400).json({
      status: "error",
      message: "Recipients data and message template are required.",
    });
  }

  try {
    const recipients = parse(recipientsText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({
        status: "error",
        message: "No recipients found in the provided data.",
      });
    }

    const statuses = {};
    let sent = 0;

    broadcast({ type: "bulk_start", total: recipients.length });

    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i];
      const number = recipient.number;

      if (!number) {
        statuses["Unknown"] = "Failed: Number is missing.";
        continue;
      }

      const personalizedMessage = messageTemplate.replace(
        /{(\w+)}/g,
        (_, key) => recipient[key] || `{${key}}`
      );

      try {
        if (photo) {
          const media = new MessageMedia(
            photo.mimetype,
            photo.buffer.toString("base64"),
            photo.originalname
          );
          await client.sendMessage(`${number}@c.us`, media, {
            caption: personalizedMessage,
          });
        } else {
          await client.sendMessage(`${number}@c.us`, personalizedMessage);
        }
        statuses[number] = "Sent";
        sent += 1;
        
        broadcast({ 
          type: "message_sent", 
          number, 
          status: "Sent",
          progress: i + 1,
          total: recipients.length
        });
      } catch (err) {
        statuses[number] = `Failed: ${err.message}`;
        broadcast({ 
          type: "message_sent", 
          number, 
          status: `Failed: ${err.message}`,
          progress: i + 1,
          total: recipients.length
        });
      }

      if (i < recipients.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    broadcast({ type: "bulk_complete", sent, total: recipients.length });
    res.json({ status: "success", sent, total: recipients.length, statuses });
  } catch (err) {
    console.error("Error sending bulk messages:", err);
    res.status(500).json({
      status: "error",
      message: "An error occurred while sending messages.",
    });
  }
});

app.post("/logout", async (req, res) => {
  if (!isAuthenticated) {
    return res.status(401).json({ status: "error", message: "Not authenticated" });
  }

  try {
    if (client) {
      try {
        await client.logout();
      } catch (logoutError) {
        console.log("Logout error (continuing):", logoutError.message);
      }
      
      try {
        client.destroy();
      } catch (destroyError) {
        console.log("Destroy error (continuing):", destroyError.message);
      }
      
      client = null;
    }
    currentUser = null;
    broadcast({ type: "logged_out", message: "Logged out successfully" });
    res.json({ status: "success", message: "Logged out successfully." });
  } catch (err) {
    console.error("Error during logout:", err);
    // Still consider it successful if we can't logout cleanly
    client = null;
    currentUser = null;
    broadcast({ type: "logged_out", message: "Logged out (forced)" });
    res.json({ status: "success", message: "Logged out successfully." });
  }
});

app.get("/status", (req, res) => {
  res.json({
    authenticated: isAuthenticated,
    connected: client?.info?.wid ? true : false,
    phoneNumber: currentUser
  });
});

// WebSocket connection handler
wss.on("connection", (ws) => {
  console.log("New WebSocket connection established.");
  
  // Send current status to new connection
  ws.send(JSON.stringify({
    type: "status",
    authenticated: isAuthenticated,
    connected: client?.info?.wid ? true : false,
    phoneNumber: currentUser
  }));

  ws.on("close", () => {
    console.log("WebSocket connection closed.");
  });
});

// Serve the frontend
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(port, () => {
  console.log(`🚀 WhatsApp Bulk Sender running on http://localhost:${port}`);
  console.log(`📱 Admin Password: ${ADMIN_PASSWORD}`);
});
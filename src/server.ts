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
import { createClient } from '@supabase/supabase-js';

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

// ✅ Supabase Client Initialize
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const JWT_SECRET = process.env.JWT_SECRET || 'JAM_SUPER_SECRET_KEY_2026';

// ✅ Multer memoryStorage (for Supabase upload)
const upload = multer({ storage: multer.memoryStorage() });

// ------------------------------------------------------------
// 1. REGISTER API
// ------------------------------------------------------------
app.post('/register', async (req, res) => {
  try {
    const { name, email, password, role, parentId } = req.body;
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'Email is already registered!' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const userData: any = {
      name,
      email,
      password: hashedPassword,
      role: role || 'child',
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
// 2. LOGIN API
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
        role: user.role
      }
    });
  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// 3. ADD DEVICE API
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
// 4. GET DEVICES API
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
// 5. UPDATE LOCATION API
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
// 6. UPLOAD PHOTO API (Supabase Storage)
// ------------------------------------------------------------
app.post('/upload-photo', upload.single('photo'), async (req: any, res: any) => {
  try {
    const { userId } = req.body;
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No photo received by server' });
    }

    const fileExt = path.extname(req.file.originalname);
    const fileName = `jam_hidden_pic_${Date.now()}${fileExt}`;
    const filePath = `photos/${userId}/${fileName}`;

    const { data, error } = await supabase.storage
      .from('jam-shield')
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
        cacheControl: '3600',
        upsert: false,
      });

    if (error) {
      console.error('Supabase Upload Error:', error);
      return res.status(500).json({ success: false, message: 'Failed to upload to storage' });
    }

    const { data: urlData } = supabase.storage
      .from('jam-shield')
      .getPublicUrl(filePath);

    const photoUrl = urlData?.publicUrl || '';

    console.log(`📸 Photo uploaded to Supabase: ${photoUrl}`);
    io.emit('new_photo_received', { userId, photoUrl });
    res.json({ success: true, message: 'Photo uploaded successfully!', photoUrl });
  } catch (error: any) {
    console.error('Upload Photo Error:', error);
    res.status(500).json({ success: false, message: 'Server error during photo upload' });
  }
});

// ------------------------------------------------------------
// 7. DELETE PHOTO API (Supports both local & Supabase)
// ------------------------------------------------------------
app.post('/delete-photo', async (req: any, res: any) => {
  try {
    const { userId, photoUrl } = req.body;
    if (!photoUrl) {
      return res.status(400).json({ success: false, message: 'Photo URL is required' });
    }
    console.log(`🔍 Attempting to delete: ${photoUrl}`);

    // Check local URL
    if (photoUrl.includes('/uploads/')) {
      const filename = photoUrl.split('/').pop();
      if (!filename) {
        return res.status(400).json({ success: false, message: 'Invalid local URL format' });
      }
      const filePath = path.join(__dirname, '../uploads', filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`🗑️ Deleted local file: ${filename}`);
        io.emit('photo_deleted', { userId, photoUrl });
        return res.json({ success: true, message: 'Local photo deleted successfully!' });
      } else {
        return res.json({ success: true, message: 'Local file already removed.' });
      }
    }

    // Supabase URL
    try {
      const urlObj = new URL(photoUrl);
      const pathname = urlObj.pathname;
      const bucketName = 'jam-shield';
      const searchStr = `/storage/v1/object/public/${bucketName}/`;
      if (!pathname.includes(searchStr)) {
        return res.status(400).json({ success: false, message: 'Invalid Supabase URL format.' });
      }
      const filePath = pathname.split(searchStr)[1];
      if (!filePath) {
        return res.status(400).json({ success: false, message: 'Could not extract file path.' });
      }
      console.log(`🗑️ Deleting Supabase file: ${filePath}`);
      const { data, error } = await supabase.storage
        .from(bucketName)
        .remove([filePath]);
      if (error) {
        if (error.message?.includes('not found')) {
          return res.json({ success: true, message: 'File already removed from Supabase.' });
        }
        return res.status(500).json({ success: false, message: 'Failed to delete from storage: ' + error.message });
      }
      console.log(`✅ File deleted successfully: ${filePath}`);
      io.emit('photo_deleted', { userId, photoUrl });
      res.json({ success: true, message: 'Photo deleted successfully from Supabase!' });
    } catch (parseError) {
      console.error('URL Parsing Error:', parseError);
      return res.status(400).json({ success: false, message: 'Malformed URL provided.' });
    }
  } catch (error: any) {
    console.error('Delete Photo Error:', error);
    res.status(500).json({ success: false, message: 'Server error during photo deletion' });
  }
});

// ------------------------------------------------------------
// 8. SYNC FILES API
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
// 9. SYNC NOTIFICATIONS API
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
// 10. SYNC ACTIVITY LOGS API
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
// 11. GET CHILDREN API (for Parent Dashboard)
// ------------------------------------------------------------
app.get('/children/:parentId', async (req, res) => {
  try {
    const { parentId } = req.params;
    const children = await prisma.user.findMany({
      where: { parentId: parentId },
      include: { devices: { orderBy: { createdAt: 'desc' } } }
    });
    res.json({ success: true, children });
  } catch (error) {
    console.error('Fetch Children Error:', error);
    res.status(500).json({ success: false, message: 'Error fetching children' });
  }
});

// ------------------------------------------------------------
// 12. DELETE CHILD API (Parent delete child)
// ------------------------------------------------------------
app.delete('/child/:childId', async (req: any, res: any) => {
  try {
    const { childId } = req.params;
    console.log(`🗑️ Deleting child with ID: ${childId}`);

    const child = await prisma.user.findUnique({
      where: { id: childId },
      include: { devices: true }
    });

    if (!child) {
      return res.status(404).json({ success: false, message: 'Child not found' });
    }

    // Delete all devices
    await prisma.device.deleteMany({
      where: { userId: childId }
    });

    // Delete child user
    await prisma.user.delete({
      where: { id: childId }
    });

    console.log(`✅ Child ${childId} deleted successfully`);
    res.json({ success: true, message: 'Child deleted successfully!' });
  } catch (error) {
    console.error('Delete Child Error:', error);
    res.status(500).json({ success: false, message: 'Error deleting child' });
  }
});

// ------------------------------------------------------------
// SOCKET.IO CONNECTION HANDLER
// ------------------------------------------------------------
io.on('connection', (socket: any) => {
  console.log(`🔌 A client connected: ${socket.id}`);

  socket.on('register_user', (userId: string) => {
    socket.join(userId);
    console.log(`✅ User ${userId} joined their private room`);
  });

  socket.on('parent_trigger_capture', async (data: any) => {
    const { parentId, childId } = data;
    console.log(`📸 Parent ${parentId} requesting capture from child ${childId}`);

    try {
      const child = await prisma.user.findUnique({
        where: { id: childId },
        select: { parentId: true }
      });
      if (child?.parentId !== parentId) {
        socket.emit('command_error', 'Unauthorized: This is not your child.');
        return;
      }
      io.to(childId).emit('capture_command', { parentId });
    } catch (error: any) {
      console.error('Error verifying parent-child relation:', error);
    }
  });

  socket.on('child_capture_result', (data: any) => {
    const { childId, parentId, photoUrl } = data;
    console.log(`📸 Child ${childId} sent photo to parent ${parentId}: ${photoUrl}`);
    io.to(parentId).emit('capture_result', { childId, photoUrl, success: true });
  });

  socket.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
  });
});

// ------------------------------------------------------------
// SERVER START
// ------------------------------------------------------------
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 JAM API is running!`);
  console.log(`🛡️ JAM Server is active on port ${PORT}`);
});
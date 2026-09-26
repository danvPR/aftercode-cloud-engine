const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Thay chuỗi kết nối MongoDB của bạn vào đây:
const MONGO_URI = "mongodb://studiodanv_db_user:U054mgoM0sBzPtAL@ac-ymskw8m-shard-00-00.my0r9ky.mongodb.net:27017,ac-ymskw8m-shard-00-01.my0r9ky.mongodb.net:27017,ac-ymskw8m-shard-00-02.my0r9ky.mongodb.net:27017/?ssl=true&replicaSet=atlas-g3l1co-shard-0&authSource=admin&appName=StudioDANV";

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Đã kết nối MongoDB Atlas!"))
  .catch(err => console.error("❌ Lỗi kết nối MongoDB:", err.message));

// Khai báo Schema lưu trữ theo từng dự án
const PlayerSchema = new mongoose.Schema({
  projectId: { type: String, default: "default_project" },
  username: { type: String, required: true },
  score: { type: Number, default: 0 },
  saveData: { type: String, default: "" },
  updatedAt: { type: Date, default: Date.now }
});
// Khóa kết hợp: Mỗi dự án có một không gian dữ liệu riêng
PlayerSchema.index({ projectId: 1, username: 1 }, { unique: true });
const Player = mongoose.model('Player', PlayerSchema);

// Schema lưu trữ từng biến Cloud độc lập theo Key
const CloudVarSchema = new mongoose.Schema({
  projectId: { type: String, default: "default_project" },
  username: { type: String, required: true },
  key: { type: String, required: true },
  value: { type: String, default: "" },
  updatedAt: { type: Date, default: Date.now }
});
CloudVarSchema.index({ projectId: 1, username: 1, key: 1 }, { unique: true });
const CloudVar = mongoose.model('CloudVar', CloudVarSchema);

app.get('/ping', (req, res) => {
  res.send("Server Aftercode Render đang chạy ngon lành!");
});

// API: Lưu game theo projectId
app.post('/api/save', async (req, res) => {
  try {
    const { projectId = "default_project", username, score, saveData } = req.body;
    if (!username) return res.status(400).json({ error: "Thiếu username" });

    const player = await Player.findOneAndUpdate(
      { projectId, username },
      { score, saveData, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ success: true, data: player });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Tải dữ liệu của 1 người (hỗ trợ cả link cũ lẫn link có projectId)
app.get(['/api/load/:username', '/api/load/:projectId/:username'], async (req, res) => {
  try {
    const projectId = req.params.projectId || "default_project";
    const username = req.params.username;
    const player = await Player.findOne({ projectId, username });
    if (!player) return res.status(404).json({ success: false, message: "Không tìm thấy" });
    res.json({ success: true, data: player });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Tải dữ liệu hàng loạt theo projectId
app.post('/api/load-batch', async (req, res) => {
  try {
    const { projectId = "default_project", usernames } = req.body;
    if (!Array.isArray(usernames)) return res.status(400).json({ error: "Yêu cầu mảng usernames" });

    const players = await Player.find({ projectId, username: { $in: usernames } });
    
    const result = {};
    players.forEach(p => {
      result[p.username] = { score: p.score, saveData: p.saveData };
    });

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 🚀 API MỚI: Đặt từng biến Cloud độc lập theo Key
app.post('/api/var/set', async (req, res) => {
  try {
    const { projectId = "default_project", username, key, value } = req.body;
    if (!username || !key) return res.status(400).json({ error: "Thiếu username hoặc key" });

    const record = await CloudVar.findOneAndUpdate(
      { projectId, username, key },
      { value: String(value), updatedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ success: true, data: record });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 🚀 API MỚI: Lấy giá trị biến Cloud độc lập theo Key
app.post('/api/var/get', async (req, res) => {
  try {
    const { projectId = "default_project", username, key } = req.body;
    if (!username || !key) return res.status(400).json({ error: "Thiếu username hoặc key" });

    const record = await CloudVar.findOne({ projectId, username, key });
    if (!record) return res.json({ success: true, value: "" });
    res.json({ success: true, value: record.value });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy trên cổng ${PORT}`);
});
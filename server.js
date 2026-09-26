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

// Khai báo Schema người chơi
const PlayerSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  score: { type: Number, default: 0 },
  saveData: { type: String, default: "" },
  updatedAt: { type: Date, default: Date.now }
});
const Player = mongoose.model('Player', PlayerSchema);

app.get('/ping', (req, res) => {
  res.send("Server Aftercode Render đang chạy ngon lành!");
});

// API: Lưu game
app.post('/api/save', async (req, res) => {
  try {
    const { username, score, saveData } = req.body;
    if (!username) return res.status(400).json({ error: "Thiếu username" });

    const player = await Player.findOneAndUpdate(
      { username },
      { score, saveData, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ success: true, data: player });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Tải dữ liệu của 1 người
app.get('/api/load/:username', async (req, res) => {
  try {
    const player = await Player.findOne({ username: req.params.username });
    if (!player) return res.status(404).json({ success: false, message: "Không tìm thấy" });
    res.json({ success: true, data: player });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 🚀 TÍNH NĂNG MỚI: API Tải dữ liệu hàng loạt (Batch Load)
app.post('/api/load-batch', async (req, res) => {
  try {
    const { usernames } = req.body; // Yêu cầu truyền lên một Array ['Player1', 'Player2']
    if (!Array.isArray(usernames)) return res.status(400).json({ error: "Yêu cầu mảng usernames" });

    // Tìm tất cả user có trong mảng
    const players = await Player.find({ username: { $in: usernames } });
    
    // Gom dữ liệu thành object { "Player1": { score: ..., saveData: ... } }
    const result = {};
    players.forEach(p => {
      result[p.username] = { score: p.score, saveData: p.saveData };
    });

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy trên cổng ${PORT}`);
});
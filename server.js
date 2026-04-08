const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 4000;
const DB_PATH = path.join(__dirname, 'quiz.db');

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let db, SQL;

async function initDB() {
  SQL = await initSqlJs();
  db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();

  // Tabel Siswa
  db.run(`CREATE TABLE IF NOT EXISTS students (
    nis TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    class_name TEXT NOT NULL
  )`);

  // Tabel Kuis (kolom level untuk tingkat kelas, misal "5")
  db.run(`CREATE TABLE IF NOT EXISTS quizzes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    level TEXT DEFAULT '', 
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabel Pertanyaan
  db.run(`CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id INTEGER,
    question_text TEXT NOT NULL,
    option_a TEXT, option_b TEXT, option_c TEXT, option_d TEXT,
    correct_answer TEXT NOT NULL,
    FOREIGN KEY (quiz_id) REFERENCES quizzes(id)
  )`);

  saveDB();
}

function saveDB() { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); }

function dbQuery(sql, params = []) {
  try {
    const res = db.exec(sql, params);
    if (!res.length) return [];
    const { columns, values } = res[0];
    return values.map(row => {
      const obj = {};
      columns.forEach((col, i) => obj[col] = row[i]);
      return obj;
    });
  } catch(e) { return []; }
}

// --- API UNTUK ADMIN ---
app.get('/api/students', (req, res) => {
  res.json(dbQuery("SELECT * FROM students ORDER BY class_name ASC, name ASC"));
});

app.post('/api/students', (req, res) => {
  const { nis, name, class_name } = req.body;
  db.run("INSERT OR REPLACE INTO students (nis, name, class_name) VALUES (?, ?, ?)", [nis, name, class_name]);
  saveDB();
  res.json({ success: true });
});

app.delete('/api/students/:nis', (req, res) => {
  db.run("DELETE FROM students WHERE nis = ?", [req.params.nis]);
  saveDB();
  res.json({ success: true });
});

// --- SOCKET.IO (REALTIME & DINAMIS) ---
io.on('connection', (socket) => {
  // 1. Ambil DAFTAR KELAS secara dinamis dari database siswa
  socket.on('get_classes', () => {
    const rows = dbQuery("SELECT DISTINCT class_name FROM students ORDER BY class_name ASC");
    const classes = rows.map(r => r.class_name);
    socket.emit('list_classes', classes);
  });

  // 2. Ambil DAFTAR NAMA berdasarkan kelas yang dipilih
  socket.on('get_students_by_class', (cls) => {
    const list = dbQuery("SELECT nis, name FROM students WHERE class_name = ?", [cls]);
    socket.emit('list_students', list);
  });

  // 3. Validasi LOGIN (Nama + NIS)
  socket.on('student_login', ({ nis, className }) => {
    const student = dbQuery("SELECT * FROM students WHERE nis = ? AND class_name = ?", [nis, className])[0];
    if (!student) return socket.emit('login_error', 'NIS tidak cocok dengan Nama/Kelas!');

    // Ambil angka tingkat (Misal: "5A" atau "Kelas 5" -> "5")
    const levelNum = className.replace(/[^0-9]/g, '');
    const quizzes = dbQuery("SELECT * FROM quizzes WHERE level = ?", [levelNum]);
    
    socket.emit('login_success', { student, quizzes });
  });
});

initDB();
server.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));

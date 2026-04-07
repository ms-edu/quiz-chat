const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 8080;
const DB_PATH = path.join(__dirname, 'quiz.db');

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let db, SQL;

async function initDB() {
  SQL = await initSqlJs();
  db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();

  // 1. Tabel Siswa (Data Siswa)
  db.run(`CREATE TABLE IF NOT EXISTS students (
    nis TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    class_name TEXT NOT NULL
  )`);

  // 2. Tabel Kuis (Ditambah kolom allowed_level untuk jenjang kelas)
  db.run(`CREATE TABLE IF NOT EXISTS quizzes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    allowed_level TEXT DEFAULT '', 
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 3. Tabel Pertanyaan
  db.run(`CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id INTEGER,
    question_type TEXT DEFAULT 'pg',
    question_text TEXT NOT NULL,
    option_a TEXT, option_b TEXT, option_c TEXT, option_d TEXT,
    correct_answer TEXT NOT NULL,
    explanation TEXT,
    FOREIGN KEY (quiz_id) REFERENCES quizzes(id)
  )`);

  // 4. Tabel Sesi Hasil Kuis
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_nis TEXT,
    student_name TEXT NOT NULL,
    quiz_id INTEGER,
    score REAL DEFAULT 0,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME,
    FOREIGN KEY (quiz_id) REFERENCES quizzes(id)
  )`);

  saveDB();
  console.log('✅ Database & Student Table Ready');
}

function saveDB() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

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

// API Routes
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

// Socket.io Real-time
io.on('connection', (socket) => {
  // Ambil daftar nama berdasarkan pilihan kelas
  socket.on('get_students_by_class', (cls) => {
    const list = dbQuery("SELECT nis, name FROM students WHERE class_name = ?", [cls]);
    socket.emit('list_students', list);
  });

  // Validasi Login (Nama + NIS)
  socket.on('student_login', ({ nis, className }) => {
    const student = dbQuery("SELECT * FROM students WHERE nis = ? AND class_name = ?", [nis, className])[0];
    if (!student) return socket.emit('login_error', 'NIS tidak ditemukan atau tidak sesuai!');

    // Ambil angka depan saja (misal 5A -> 5)
    const level = className.replace(/[^0-9]/g, '');
    const quizzes = dbQuery("SELECT * FROM quizzes WHERE allowed_level = ?", [level]);
    
    socket.emit('login_success', { student, quizzes });
  });
});

initDB();
server.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));

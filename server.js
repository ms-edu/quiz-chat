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

// ─── Database ────────────────────────────────────────────────────────
async function initDB() {
  SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(`CREATE TABLE IF NOT EXISTS quizzes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    allowed_classes TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  try { db.run(`ALTER TABLE quizzes ADD COLUMN allowed_classes TEXT DEFAULT ''`); } catch(e) {}

  db.run(`CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id INTEGER,
    question_type TEXT DEFAULT 'pg',
    question_text TEXT NOT NULL,
    option_a TEXT DEFAULT '',
    option_b TEXT DEFAULT '',
    option_c TEXT DEFAULT '',
    option_d TEXT DEFAULT '',
    correct_answer TEXT NOT NULL,
    explanation TEXT,
    FOREIGN KEY (quiz_id) REFERENCES quizzes(id)
  )`);
  // Migrasi DB lama: tambah kolom baru jika belum ada
  try { db.run(`ALTER TABLE questions ADD COLUMN question_type TEXT DEFAULT 'pg'`); } catch(e) {}

  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_name TEXT NOT NULL,
    quiz_id INTEGER,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME,
    score INTEGER DEFAULT 0,
    total INTEGER DEFAULT 0,
    FOREIGN KEY (quiz_id) REFERENCES quizzes(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER,
    question_id INTEGER,
    student_answer TEXT,
    is_correct INTEGER,
    answered_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  const rows = db.exec("SELECT COUNT(*) as c FROM quizzes");
  if ((rows[0]?.values[0][0] || 0) === 0) seedSampleData();

  saveDB();
  console.log('✅ Database initialized');
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
  } catch(e) { console.error('DB Query error:', e.message); return []; }
}

function dbRun(sql, params = []) {
  db.run(sql, params);
  const res = db.exec("SELECT last_insert_rowid() as id");
  const lastId = res[0]?.values[0][0];
  saveDB();
  return lastId;
}

// ─── Penilaian per tipe soal ─────────────────────────────────────────
// Mengembalikan { isCorrect, isPartial, points } (points: 0, 0.5, 1)
function evaluateAnswer(question, studentAnswer) {
  const type = question.question_type || 'pg';
  const correct = (question.correct_answer || '').trim();

  if (type === 'pg' || type === 'tf') {
    // PG biasa & Benar-Salah: exact match (case-insensitive)
    const isCorrect = studentAnswer.trim().toUpperCase() === correct.toUpperCase();
    return { isCorrect, isPartial: false, points: isCorrect ? 1 : 0 };

  } else if (type === 'pgk') {
    // PG Kompleks: jawaban benar adalah kombinasi huruf, misal "AB" atau "ACD"
    const correctSet = new Set(correct.toUpperCase().split('').filter(c => /[A-D]/.test(c)));
    const studentSet = new Set(studentAnswer.trim().toUpperCase().split('').filter(c => /[A-D]/.test(c)));
    const isCorrect = [...correctSet].every(c => studentSet.has(c)) && correctSet.size === studentSet.size;
    // Partial: jawaban benar sebagian (>0 benar, tapi tidak semua)
    const intersection = [...correctSet].filter(c => studentSet.has(c)).length;
    const isPartial = !isCorrect && intersection > 0 && studentSet.size <= correctSet.size;
    const points = isCorrect ? 1 : (isPartial ? 0.5 : 0);
    return { isCorrect, isPartial, points };

  } else if (type === 'menjodohkan') {
    // Menjodohkan: jawaban berupa pasangan, misal "A3,B1,C4,D2"
    // correct_answer berupa format yang sama
    const parseMap = (str) => {
      const map = {};
      str.split(',').forEach(pair => {
        const [k, v] = pair.trim().split(/[-:=]/).map(s => s.trim().toUpperCase());
        if (k && v) map[k] = v;
      });
      return map;
    };
    const correctMap = parseMap(correct);
    const studentMap = parseMap(studentAnswer);
    const total = Object.keys(correctMap).length;
    if (!total) return { isCorrect: false, isPartial: false, points: 0 };
    const matchCount = Object.keys(correctMap).filter(k => correctMap[k] === studentMap[k]).length;
    const isCorrect = matchCount === total;
    const isPartial = !isCorrect && matchCount > 0;
    const points = matchCount / total;
    return { isCorrect, isPartial, points };

  } else if (type === 'isian') {
    // Isian singkat: toleransi case-insensitive, trim whitespace
    // correct_answer bisa berisi beberapa jawaban yang diterima dipisah '|'
    const acceptedAnswers = correct.split('|').map(a => a.trim().toLowerCase());
    const isCorrect = acceptedAnswers.includes(studentAnswer.trim().toLowerCase());
    return { isCorrect, isPartial: false, points: isCorrect ? 1 : 0 };
  }

  return { isCorrect: false, isPartial: false, points: 0 };
}

function seedSampleData() {
  db.run(`INSERT INTO quizzes (title, description) VALUES ('Contoh Quiz Campuran', 'Demo semua tipe soal')`);
  const samples = [
    ['pg','Planet terbesar dalam tata surya adalah...','Mars','Jupiter','Saturnus','Uranus','B','Jupiter adalah planet terbesar'],
    ['tf','Matahari terbit dari arah timur.','Benar','Salah','','','A','Matahari memang terbit dari timur'],
    ['pgk','Manakah yang termasuk planet dalam (inner planet)? (Pilih semua yang benar)','Merkurius','Venus','Jupiter','Saturnus','AB','Merkurius dan Venus adalah planet dalam tata surya'],
    ['isian','Ibu kota Indonesia adalah...','Jakarta','','','','Jakarta','Ibu kota Indonesia adalah Jakarta'],
  ];
  samples.forEach(q => {
    db.run(`INSERT INTO questions (quiz_id,question_type,question_text,option_a,option_b,option_c,option_d,correct_answer,explanation) VALUES (1,?,?,?,?,?,?,?,?)`, q);
  });
  saveDB();
}

// ─── REST API ────────────────────────────────────────────────────────
app.get('/api/quizzes', (req, res) => res.json(dbQuery('SELECT * FROM quizzes ORDER BY id')));

app.get('/api/quizzes/for-class/:kelas', (req, res) => {
  const kelas = req.params.kelas.trim().toLowerCase();
  const all = dbQuery('SELECT id, title, description, allowed_classes FROM quizzes ORDER BY id');
  res.json(all.filter(q => {
    if (!q.allowed_classes?.trim()) return true;
    const allowed = q.allowed_classes.split(',').map(k => k.trim().toLowerCase());
    return allowed.some(k => kelas.startsWith(k) || k === kelas);
  }));
});

app.get('/api/quizzes/:id', (req, res) => {
  const quiz = dbQuery('SELECT * FROM quizzes WHERE id = ?', [req.params.id]);
  if (!quiz.length) return res.status(404).json({ error: 'Quiz not found' });
  const questions = dbQuery('SELECT * FROM questions WHERE quiz_id = ?', [req.params.id]);
  res.json({ ...quiz[0], questions });
});

app.post('/api/quizzes', (req, res) => {
  const { title, description, questions, allowed_classes } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  const quizId = dbRun('INSERT INTO quizzes (title, description, allowed_classes) VALUES (?, ?, ?)', [title, description || '', allowed_classes || '']);
  if (questions?.length) {
    questions.forEach(q => dbRun(
      `INSERT INTO questions (quiz_id,question_type,question_text,option_a,option_b,option_c,option_d,correct_answer,explanation) VALUES (?,?,?,?,?,?,?,?,?)`,
      [quizId, q.question_type||'pg', q.question_text, q.option_a||'', q.option_b||'', q.option_c||'', q.option_d||'', q.correct_answer, q.explanation||'']
    ));
  }
  res.json({ id: quizId, message: 'Quiz created' });
});

app.put('/api/quizzes/:id', (req, res) => {
  const { title, description, allowed_classes } = req.body;
  const id = req.params.id;
  if (!title) return res.status(400).json({ error: 'Title required' });
  dbRun('UPDATE quizzes SET title=?, description=?, allowed_classes=? WHERE id=?', [title, description||'', allowed_classes||'', id]);
  res.json({ id, message: 'Quiz updated' });
});

app.post('/api/quizzes/:id/questions', (req, res) => {
  const q = req.body;
  if (!q.question_text) return res.status(400).json({ error: 'question_text required' });
  const qid = dbRun(
    `INSERT INTO questions (quiz_id,question_type,question_text,option_a,option_b,option_c,option_d,correct_answer,explanation) VALUES (?,?,?,?,?,?,?,?,?)`,
    [req.params.id, q.question_type||'pg', q.question_text, q.option_a||'', q.option_b||'', q.option_c||'', q.option_d||'', q.correct_answer, q.explanation||'']
  );
  res.json({ id: qid, message: 'Question added' });
});

app.post('/api/quizzes/:id/questions/bulk', (req, res) => {
  const { questions } = req.body;
  if (!questions?.length) return res.status(400).json({ error: 'No questions' });
  questions.forEach(q => dbRun(
    `INSERT INTO questions (quiz_id,question_type,question_text,option_a,option_b,option_c,option_d,correct_answer,explanation) VALUES (?,?,?,?,?,?,?,?,?)`,
    [req.params.id, q.question_type||'pg', q.question_text, q.option_a||'', q.option_b||'', q.option_c||'', q.option_d||'', q.correct_answer, q.explanation||'']
  ));
  res.json({ added: questions.length });
});

app.delete('/api/questions/:id', (req, res) => { dbRun('DELETE FROM questions WHERE id=?', [req.params.id]); res.json({ message: 'Deleted' }); });
app.delete('/api/quizzes/:id', (req, res) => {
  dbRun('DELETE FROM questions WHERE quiz_id=?', [req.params.id]);
  dbRun('DELETE FROM quizzes WHERE id=?', [req.params.id]);
  res.json({ message: 'Deleted' });
});

app.get('/api/leaderboard/:quizId', (req, res) => {
  res.json(dbQuery(`SELECT student_name, score, total, ROUND(score*100.0/total,1) as percentage, finished_at FROM sessions WHERE quiz_id=? AND finished_at IS NOT NULL ORDER BY score DESC, finished_at ASC LIMIT 20`, [req.params.quizId]));
});

app.get('/api/sessions', (req, res) => {
  res.json(dbQuery(`SELECT s.*, q.title as quiz_title FROM sessions s JOIN quizzes q ON s.quiz_id=q.id ORDER BY s.started_at DESC LIMIT 100`));
});

app.get('/api/sessions/export', (req, res) => {
  const { quiz_id } = req.query;
  let sql = `SELECT s.id, s.student_name, q.title as quiz_title, s.score, s.total, ROUND(s.score*100.0/s.total,1) as nilai, CASE WHEN ROUND(s.score*100.0/s.total)>=90 THEN 'A' WHEN ROUND(s.score*100.0/s.total)>=80 THEN 'B' WHEN ROUND(s.score*100.0/s.total)>=70 THEN 'C' WHEN ROUND(s.score*100.0/s.total)>=60 THEN 'D' ELSE 'E' END as grade, s.started_at, s.finished_at FROM sessions s JOIN quizzes q ON s.quiz_id=q.id`;
  const params = [];
  if (quiz_id) { sql += ' WHERE s.quiz_id=?'; params.push(quiz_id); }
  sql += ' ORDER BY s.finished_at DESC';
  const rows = dbQuery(sql, params);
  const header = 'No,Nama Siswa,Quiz,Skor,Total,Nilai (%),Grade,Mulai,Selesai\n';
  const csv = rows.map((r,i) => `${i+1},"${r.student_name}","${r.quiz_title}",${r.score},${r.total},${r.nilai},${r.grade},"${r.started_at||''}","${r.finished_at||''}"`).join('\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="hasil-quiz.csv"');
  res.send('\uFEFF' + header + csv);
});

// ─── Socket.IO ────────────────────────────────────────────────────────
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

const activeSessions = {};
const adminSockets = new Set();

io.on('connection', socket => {
  socket.on('admin_register', () => {
    adminSockets.add(socket.id);
    socket.emit('stats', { activeSessions: Object.keys(activeSessions).length });
  });

  socket.on('join_quiz', ({ studentName, quizId, studentClass }) => {
    const quiz = dbQuery('SELECT * FROM quizzes WHERE id=?', [quizId]);
    if (!quiz.length) { socket.emit('error_msg','Quiz tidak ditemukan!'); return; }

    const allowed = quiz[0].allowed_classes || '';
    if (allowed.trim()) {
      const kelas = (studentClass||'').trim().toLowerCase();
      const ok = allowed.split(',').map(k=>k.trim().toLowerCase()).some(k=>kelas.startsWith(k)||k===kelas);
      if (!ok) { socket.emit('error_msg',`Quiz ini hanya untuk kelas: ${allowed}`); return; }
    }

    const rawQ = dbQuery('SELECT * FROM questions WHERE quiz_id=? ORDER BY id', [quizId]);
    if (!rawQ.length) { socket.emit('error_msg','Quiz belum memiliki soal!'); return; }

    // Acak soal: kelompokkan per tipe dulu, acak dalam tiap kelompok, lalu gabung
    const TYPE_ORDER = ['pg','pgk','tf','menjodohkan','isian'];
    const grouped = {};
    rawQ.forEach(q => {
      const t = q.question_type || 'pg';
      if (!grouped[t]) grouped[t] = [];
      grouped[t].push(q);
    });
    const sortedTypes = Object.keys(grouped).sort((a,b) => {
      const ia = TYPE_ORDER.indexOf(a); const ib = TYPE_ORDER.indexOf(b);
      return (ia===-1?99:ia) - (ib===-1?99:ib);
    });
    const shuffledByType = sortedTypes.flatMap(t => shuffleArray(grouped[t]));

    const questions = shuffledByType.map(q => {
      const type = q.question_type || 'pg';
      if (type === 'pg' || type === 'pgk') {
        const optKeys = ['option_a','option_b','option_c','option_d'];
        const labels  = ['A','B','C','D'];
        // Untuk PGK: correct_answer bisa "AB", perlu remap semua huruf
        const correctLabels = (q.correct_answer||'').toUpperCase().split('').filter(c=>/[A-D]/.test(c));
        const correctIdxs   = correctLabels.map(l => labels.indexOf(l));
        let opts = optKeys.map((k,i) => ({ origIdx:i, text:q[k] }));
        opts = shuffleArray(opts);
        // Remap correct
        const newCorrect = correctIdxs.map(origIdx => {
          const newPos = opts.findIndex(o => o.origIdx === origIdx);
          return labels[newPos];
        }).sort().join('');
        return { ...q, option_a:opts[0].text, option_b:opts[1].text, option_c:opts[2].text, option_d:opts[3].text, correct_answer:newCorrect };
      }
      return q;
    });

    const sessionId = dbRun('INSERT INTO sessions (student_name,quiz_id,total) VALUES (?,?,?)', [studentName,quizId,questions.length]);
    activeSessions[socket.id] = { sessionId, studentName, quizId, quiz:quiz[0], questions, currentIndex:0, score:0, startTime:Date.now() };

    broadcastToAdmins('student_joined', { sessionId, studentName, quizTitle:quiz[0].title, activeSessions:Object.keys(activeSessions).length });
    socket.emit('quiz_started', { quizTitle:quiz[0].title, totalQuestions:questions.length, studentName });
    setTimeout(() => sendQuestion(socket), 800);
  });

  socket.on('answer', ({ answer }) => {
    const session = activeSessions[socket.id];
    if (!session) return;
    const { questions, currentIndex, sessionId } = session;
    const question = questions[currentIndex];
    const { isCorrect, isPartial, points } = evaluateAnswer(question, answer);

    session.score += points;
    dbRun('INSERT INTO answers (session_id,question_id,student_answer,is_correct) VALUES (?,?,?,?)',
      [sessionId, question.id, answer, isCorrect ? 1 : (isPartial ? 0.5 : 0)]);

    socket.emit('answer_feedback', {
      isCorrect, isPartial, points,
      correctAnswer: question.correct_answer,
      explanation: question.explanation||'',
      currentScore: Math.round(session.score * 10) / 10,
      questionNumber: currentIndex+1,
      totalQuestions: questions.length,
      questionType: question.question_type||'pg'
    });

    session.currentIndex++;
    if (session.currentIndex < questions.length) setTimeout(()=>sendQuestion(socket),1500);
    else setTimeout(()=>finishQuiz(socket),1500);
  });

  socket.on('disconnect', () => {
    adminSockets.delete(socket.id);
    const session = activeSessions[socket.id];
    if (session && !session.finished && session.currentIndex < session.questions.length) {
      const abandonedScore = Math.round(session.score * 10) / 10;
      dbRun('UPDATE sessions SET score=?, finished_at=CURRENT_TIMESTAMP WHERE id=?', [abandonedScore, session.sessionId]);
      broadcastToAdmins('student_abandoned', { sessionId:session.sessionId, studentName:session.studentName, score:abandonedScore, total:session.questions.length, activeSessions:Math.max(0,Object.keys(activeSessions).length-1) });
    }
    delete activeSessions[socket.id];
  });

  socket.on('get_stats', () => socket.emit('stats', { activeSessions:Object.keys(activeSessions).length }));
});

function broadcastToAdmins(event, data) {
  adminSockets.forEach(id => io.sockets.sockets.get(id)?.emit(event, data));
}

function sendQuestion(socket) {
  const session = activeSessions[socket.id];
  if (!session) return;
  const q = session.questions[session.currentIndex];
  const type = q.question_type || 'pg';

  const payload = {
    number: session.currentIndex+1,
    total: session.questions.length,
    type,
    text: q.question_text,
    explanation: q.explanation||''
  };

  if (type === 'pg' || type === 'pgk') {
    payload.options = { A:q.option_a, B:q.option_b, C:q.option_c, D:q.option_d };
    if (type === 'pgk') payload.correctCount = (q.correct_answer||'').replace(/[^A-D]/gi,'').length;
  } else if (type === 'tf') {
    payload.options = { A:'Benar', B:'Salah' };
  } else if (type === 'menjodohkan') {
    // option_a..d adalah premis, correct_answer="A3,B1,C4,D2", option pasangan disimpan di explanation sbg JSON
    try {
      const pairs = JSON.parse(q.option_a); // [{left,right}] format
      payload.pairs = pairs;
    } catch(e) {
      // Fallback: opsi disimpan biasa, pasangan di correct_answer
      payload.leftItems  = [q.option_a, q.option_b, q.option_c, q.option_d].filter(Boolean);
      payload.rightItems = shuffleArray([q.option_a, q.option_b, q.option_c, q.option_d].filter(Boolean));
    }
    payload.matchData = q.option_a; // raw data
  } else if (type === 'isian') {
    // Tidak ada opsi — siswa ketik sendiri
  }

  socket.emit('question', payload);
}

function finishQuiz(socket) {
  const session = activeSessions[socket.id];
  if (!session) return;
  const { sessionId, score, questions, studentName, startTime, quizId, quiz } = session;
  const total = questions.length;
  const rawScore = Math.round(score * 10) / 10;
  const percentage = Math.round((rawScore / total) * 100);
  const duration = Math.round((Date.now()-startTime)/1000);

  dbRun('UPDATE sessions SET score=?, finished_at=CURRENT_TIMESTAMP WHERE id=?', [rawScore, sessionId]);

  const rank = dbQuery(`SELECT COUNT(*) as r FROM sessions WHERE quiz_id=? AND finished_at IS NOT NULL AND score>?`, [quizId, rawScore]);
  const myRank = (rank[0]?.r||0)+1;
  const grade = percentage>=90?'A':percentage>=80?'B':percentage>=70?'C':percentage>=60?'D':'E';

  broadcastToAdmins('student_finished', { sessionId, studentName, quizTitle:quiz.title, quizId, score:rawScore, total, percentage, grade, duration, rank:myRank, activeSessions:Math.max(0,Object.keys(activeSessions).length-1) });
  socket.emit('quiz_finished', { studentName, score:rawScore, total, percentage, duration, rank:myRank, grade });

  session.finished = true;
  delete activeSessions[socket.id];
}

// ─── Start ─────────────────────────────────────────────────────────
initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`\n🚀 QuizChat v5 running at http://localhost:${PORT}`);
    console.log(`📚 Admin: http://localhost:${PORT}/admin.html`);
  });
});

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'GPS@Orlando2026';
const DB_PATH = process.env.DB_PATH || 'gps.db';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    last_lat REAL,
    last_lng REAL,
    last_seen TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS trajectories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    timestamp TEXT NOT NULL,
    FOREIGN KEY (employee_id) REFERENCES employees(id)
  );
  CREATE INDEX IF NOT EXISTS idx_trajectories_employee_time
    ON trajectories(employee_id, timestamp);
`);

const stmtUpsertEmployee = db.prepare(`
  INSERT INTO employees (id, name, last_lat, last_lng, last_seen, created_at)
  VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    last_lat = excluded.last_lat,
    last_lng = excluded.last_lng,
    last_seen = excluded.last_seen
`);

const stmtInsertTrajectory = db.prepare(`
  INSERT INTO trajectories (employee_id, lat, lng, timestamp) VALUES (?, ?, ?, ?)
`);

const stmtRecentTrajectory = db.prepare(`
  SELECT lat, lng, timestamp FROM trajectories
  WHERE employee_id = ? AND timestamp >= datetime('now', '-4 hours')
  ORDER BY timestamp ASC
`);

const stmtCleanupTrajectories = db.prepare(`
  DELETE FROM trajectories WHERE timestamp < datetime('now', '-7 days')
`);

const stmtAllEmployees = db.prepare(`
  SELECT * FROM employees ORDER BY last_seen DESC
`);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static('public'));
app.use(express.json());

app.get('/funcionario', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'funcionario.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: 'Senha incorreta' });
  }
});

app.get('/api/employees', (req, res) => {
  res.json(stmtAllEmployees.all());
});

app.get('/api/trajectory/:id', (req, res) => {
  const rows = stmtRecentTrajectory.all(req.params.id);
  res.json(rows);
});

app.delete('/api/employees/:id', (req, res) => {
  db.prepare('DELETE FROM trajectories WHERE employee_id = ?').run(req.params.id);
  db.prepare('DELETE FROM employees WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/employees', (req, res) => {
  db.prepare('DELETE FROM trajectories').run();
  db.prepare('DELETE FROM employees').run();
  res.json({ ok: true });
});

const onlineEmployees = new Map();

function broadcastOfflineCheck() {
  const now = Date.now();
  for (const [socketId, info] of onlineEmployees) {
    if (now - info.lastHeartbeat > 120000) {
      onlineEmployees.delete(socketId);
      io.emit('employee-offline', { deviceId: info.deviceId });
    }
  }
}
setInterval(broadcastOfflineCheck, 60000);

io.on('connection', (socket) => {
  console.log('Conectado:', socket.id);

  const employees = stmtAllEmployees.all();
  const latestLocations = {};
  for (const emp of employees) {
    if (emp.last_lat && emp.last_lng) {
      latestLocations[emp.id] = {
        lat: emp.last_lat,
        lng: emp.last_lng,
        employeeId: emp.name,
        deviceId: emp.id,
        timestamp: emp.last_seen
      };
    }
  }
  socket.emit('initial-locations', latestLocations);

  socket.on('update-location', (data) => {
    const id = data.deviceId || data.employeeId;
    const name = data.employeeId || id;

    stmtUpsertEmployee.run(id, name, data.lat, data.lng);
    stmtInsertTrajectory.run(id, data.lat, data.lng, data.timestamp || new Date().toISOString());

    onlineEmployees.set(socket.id, { deviceId: id, lastHeartbeat: Date.now() });

    io.emit('location-broadcast', data);

    if (Math.random() < 0.1) {
      stmtCleanupTrajectories.run();
    }
  });

  socket.on('disconnect', () => {
    const info = onlineEmployees.get(socket.id);
    if (info) {
      setTimeout(() => {
        if (![...onlineEmployees.values()].some(v => v.deviceId === info.deviceId)) {
          io.emit('employee-offline', { deviceId: info.deviceId });
        }
      }, 60000);
    }
    onlineEmployees.delete(socket.id);
    console.log('Desconectado:', socket.id);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`GPS Funcionários v2 rodando em http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin`);
});

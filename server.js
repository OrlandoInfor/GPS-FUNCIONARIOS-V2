require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'GPS@Orlando2026';
// Suporte a múltiplos admins: ADMIN_PASSWORDS=senha1,senha2,senha3
const ADMIN_PASSWORDS = process.env.ADMIN_PASSWORDS ? process.env.ADMIN_PASSWORDS.split(',') : [ADMIN_PASSWORD];
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

  CREATE TABLE IF NOT EXISTS schedules (
    employee_id TEXT PRIMARY KEY,
    start_hour TEXT NOT NULL DEFAULT '08:00',
    end_hour TEXT NOT NULL DEFAULT '17:00',
    days TEXT NOT NULL DEFAULT '1,2,3,4,5',
    FOREIGN KEY (employee_id) REFERENCES employees(id)
  );
`);

db.exec(`
  UPDATE schedules SET start_hour = printf('%02d:00', CAST(start_hour AS INTEGER)) WHERE typeof(start_hour) = 'integer';
  UPDATE schedules SET end_hour = printf('%02d:00', CAST(end_hour AS INTEGER)) WHERE typeof(end_hour) = 'integer';
`);

const stmtUpsertEmployee = db.prepare(`
  INSERT INTO employees (id, name, last_lat, last_lng, last_seen, created_at)
  VALUES (?, ?, ?, ?, ?, datetime('now'))
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
  if (ADMIN_PASSWORDS.includes(password)) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: 'Senha incorreta' });
  }
});

function handleReport(req, res) {
  const id = req.params.id;
  let rows;
  if (id) {
    rows = db.prepare(`
      SELECT e.name, t.lat, t.lng, t.timestamp 
      FROM trajectories t 
      JOIN employees e ON t.employee_id = e.id 
      WHERE t.employee_id = ? 
      ORDER BY t.timestamp DESC
    `).all(id);
  } else {
    rows = db.prepare(`
      SELECT e.name, t.lat, t.lng, t.timestamp 
      FROM trajectories t 
      JOIN employees e ON t.employee_id = e.id 
      ORDER BY t.timestamp DESC
    `).all();
  }

  if (rows.length === 0) {
    return res.status(404).send('Nenhum dado encontrado');
  }

  const csvRows = ['Nome,Latitude,Longitude,Data/Hora'];
  rows.forEach(row => {
    csvRows.push(`${row.name},${row.lat},${row.lng},${row.timestamp}`);
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=relatorio_gps_${new Date().toISOString().split('T')[0]}.csv`);
  res.send(csvRows.join('\n'));
}

app.get('/api/report', handleReport);
app.get('/api/report/:id', handleReport);

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
  db.prepare('DELETE FROM schedules').run();
  res.json({ ok: true });
});

const stmtGetSchedule = db.prepare('SELECT * FROM schedules WHERE employee_id = ?');
const stmtUpsertSchedule = db.prepare(`
  INSERT INTO schedules (employee_id, start_hour, end_hour, days)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(employee_id) DO UPDATE SET
    start_hour = excluded.start_hour,
    end_hour = excluded.end_hour,
    days = excluded.days
`);

app.get('/api/schedule/:id', (req, res) => {
  const row = stmtGetSchedule.get(req.params.id);
  if (row) {
    res.json(row);
  } else {
    res.json({ start_hour: '08:00', end_hour: '17:00', days: '1,2,3,4,5' });
  }
});

app.post('/api/schedule/:id', (req, res) => {
  const { start_hour, end_hour, days } = req.body;
  stmtUpsertSchedule.run(req.params.id, start_hour || '08:00', end_hour || '17:00', days || '1,2,3,4,5');
  io.emit('schedule-update', { deviceId: req.params.id, start_hour, end_hour, days });
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

  socket.on('register', (data) => {
    const id = data.deviceId || data.employeeId;
    const name = data.employeeId || id;
    db.prepare(`
      INSERT INTO employees (id, name, last_seen, created_at)
      VALUES (?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        last_seen = excluded.last_seen
    `).run(id, name);

    const schedule = stmtGetSchedule.get(id);
    if (schedule) {
      socket.emit('schedule-config', {
        start_hour: schedule.start_hour,
        end_hour: schedule.end_hour,
        days: schedule.days
      });
    }

    io.emit('employee-registered', { deviceId: id, name: name });
  });

  socket.on('update-location', (data) => {
    const id = data.deviceId || data.employeeId;
    const name = data.employeeId || id;

    stmtUpsertEmployee.run(id, name, data.lat, data.lng, data.timestamp || new Date().toISOString());
    stmtInsertTrajectory.run(id, data.lat, data.lng, data.timestamp || new Date().toISOString());

    onlineEmployees.set(socket.id, { deviceId: id, lastHeartbeat: Date.now() });

    const schedule = stmtGetSchedule.get(id);
    if (schedule) {
      socket.emit('schedule-config', {
        start_hour: schedule.start_hour,
        end_hour: schedule.end_hour,
        days: schedule.days
      });
    }

    io.emit('location-broadcast', data);

    if (Math.random() < 0.1) {
      stmtCleanupTrajectories.run();
    }
  });

  socket.on('tracking-paused', (data) => {
    const id = data.deviceId || data.employeeId;
    const entry = [...onlineEmployees.entries()].find(([, v]) => v.deviceId === id);
    if (entry) onlineEmployees.delete(entry[0]);
    io.emit('employee-offline', { deviceId: id });
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
  console.log(`Deploy: 2026-05-20T00:33Z`);
});

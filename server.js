const express = require("express");
const { Pool } = require("pg");
const redis = require("redis");

const app = express();
app.use(express.json());

// Connexion PostgreSQL via variable d'environnement
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Connexion Redis via variable d'environnement
const redisClient = redis.createClient({
  url: process.env.REDIS_URL,
});

redisClient.on("error", (err) => console.error("Redis Client Error", err));
redisClient.connect();

// Initialisation de la table users
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("Database initialized");
  } catch (error) {
    console.error("Database init error:", error);
  }
}
initDatabase();

// GET all users avec cache Redis (stratégie Cache Aside)
app.get("/api/users", async (req, res) => {
  try {
    const cached = await redisClient.get("users:all");
    if (cached) {
      console.log("Cache HIT");
      return res.json(JSON.parse(cached));
    }

    console.log("Cache MISS - Query DB");
    const result = await pool.query("SELECT * FROM users ORDER BY id");

    // Mise en cache pour 60 secondes
    await redisClient.setEx("users:all", 60, JSON.stringify(result.rows));
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Database error" });
  }
});

// GET a single user by ID
app.get('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

// POST create user
app.post("/api/users", async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name || !email)
      return res.status(400).json({ error: "Name and email required" });

    const result = await pool.query(
      "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING *",
      [name, email],
    );

    // Invalider le cache après un ajout
    await redisClient.del("users:all");
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505")
      return res.status(409).json({ error: "Email already exists" });
    res.status(500).json({ error: "Database error" });
  }
});

// Health check pour Docker Compose
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    await redisClient.ping();
    res.json({ status: "OK", database: "connected", cache: "connected" });
  } catch (error) {
    res.status(503).json({ status: "ERROR", error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

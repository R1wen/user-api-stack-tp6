const request = require("supertest");

const mockQuery = jest.fn();

jest.mock("pg", () => {
  const MockPool = jest.fn().mockImplementation(() => ({ query: mockQuery }));
  return { Pool: MockPool };
});

const mockRedisGet = jest.fn();
const mockRedisSetEx = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisPing = jest.fn();
const mockRedisConnect = jest.fn().mockResolvedValue(undefined);

jest.mock("redis", () => ({
  createClient: jest.fn().mockReturnValue({
    on: jest.fn(),
    connect: mockRedisConnect,
    get: mockRedisGet,
    setEx: mockRedisSetEx,
    del: mockRedisDel,
    ping: mockRedisPing,
  }),
}));

const app = require("../server");

describe("User API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  describe("GET /health", () => {
    it("retourne 200 si DB et Redis sont OK", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockRedisPing.mockResolvedValueOnce("PONG");
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "OK", database: "connected", cache: "connected" });
    });

    it("retourne 503 si DB en erreur", async () => {
      mockQuery.mockRejectedValueOnce(new Error("DB down"));
      const res = await request(app).get("/health");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("ERROR");
    });

    it("retourne 503 si Redis en erreur", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockRedisPing.mockRejectedValueOnce(new Error("Redis down"));
      const res = await request(app).get("/health");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("ERROR");
    });
  });

  describe("GET /api/users", () => {
    it("retourne le cache si cache HIT", async () => {
      const users = [{ id: 1, name: "Alice", email: "alice@example.com" }];
      mockRedisGet.mockResolvedValueOnce(JSON.stringify(users));
      const res = await request(app).get("/api/users");
      expect(res.status).toBe(200);
      expect(res.body).toEqual(users);
    });

    it("interroge la DB et remplit le cache sur MISS", async () => {
      const users = [{ id: 1, name: "Alice", email: "alice@example.com" }];
      mockRedisGet.mockResolvedValueOnce(null);
      mockQuery.mockResolvedValueOnce({ rows: users });
      mockRedisSetEx.mockResolvedValueOnce("OK");
      const res = await request(app).get("/api/users");
      expect(res.status).toBe(200);
      expect(res.body).toEqual(users);
      expect(mockRedisSetEx).toHaveBeenCalledWith("users:all", 60, JSON.stringify(users));
    });

    it("retourne 500 sur erreur DB", async () => {
      mockRedisGet.mockResolvedValueOnce(null);
      mockQuery.mockRejectedValueOnce(new Error("DB error"));
      const res = await request(app).get("/api/users");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Database error" });
    });
  });

  describe("GET /api/users/:id", () => {
    it("retourne l'utilisateur si trouvé", async () => {
      const user = { id: 1, name: "Alice", email: "alice@example.com" };
      mockQuery.mockResolvedValueOnce({ rows: [user] });
      const res = await request(app).get("/api/users/1");
      expect(res.status).toBe(200);
      expect(res.body).toEqual(user);
    });

    it("retourne 404 si non trouvé", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const res = await request(app).get("/api/users/999");
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "User not found" });
    });

    it("retourne 500 sur erreur DB", async () => {
      mockQuery.mockRejectedValueOnce(new Error("DB error"));
      const res = await request(app).get("/api/users/1");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Database error" });
    });
  });

  describe("POST /api/users", () => {
    it("crée un utilisateur et retourne 201", async () => {
      const newUser = { id: 2, name: "Bob", email: "bob@example.com" };
      mockQuery.mockResolvedValueOnce({ rows: [newUser] });
      mockRedisDel.mockResolvedValueOnce(1);
      const res = await request(app)
        .post("/api/users")
        .send({ name: "Bob", email: "bob@example.com" });
      expect(res.status).toBe(201);
      expect(res.body).toEqual(newUser);
      expect(mockRedisDel).toHaveBeenCalledWith("users:all");
    });

    it("retourne 400 si name manquant", async () => {
      const res = await request(app)
        .post("/api/users")
        .send({ email: "bob@example.com" });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Name and email required" });
    });

    it("retourne 400 si email manquant", async () => {
      const res = await request(app)
        .post("/api/users")
        .send({ name: "Bob" });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Name and email required" });
    });

    it("retourne 409 sur email dupliqué (code pg 23505)", async () => {
      const err = new Error("duplicate key");
      err.code = "23505";
      mockQuery.mockRejectedValueOnce(err);
      const res = await request(app)
        .post("/api/users")
        .send({ name: "Alice", email: "alice@example.com" });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "Email already exists" });
    });

    it("retourne 500 sur autre erreur DB", async () => {
      mockQuery.mockRejectedValueOnce(new Error("Generic error"));
      const res = await request(app)
        .post("/api/users")
        .send({ name: "Bob", email: "bob@example.com" });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Database error" });
    });
  });
});

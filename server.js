import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { db } from "./db.js";
import { verificarAuth, verificarAuthPagina } from "./middleware/auth.js";
import interaccionesRouter from "./routes/interacciones.js";
import analiticaRouter from "./routes/analitica.js";

dotenv.config();
const app = express();
const isProd = process.env.NODE_ENV === "production";
app.set("trust proxy", 1);

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
});

// Helper para leer la cookie 'token' en el handshake WebSocket
function extraerTokenCookie(cookieHeader = "") {
    const match = cookieHeader.match(/(?:^|;\s*)token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
}

// Middleware de autenticación JWT para WebSockets
io.use((socket, next) => {
    const token =
        socket.handshake.auth?.token ||
        extraerTokenCookie(socket.handshake.headers?.cookie || "");

    if (!token) {
        return next(new Error("No autorizado: falta token JWT."));
    }

    try {
        socket.admin = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch {
        next(new Error("Token JWT inválido o expirado."));
    }
});

io.on("connection", (socket) => {
    console.log(`[WS] Admin conectado: ${socket.admin.username} (${socket.id})`);

    socket.emit("ws:conectado", {
        mensaje: "Conexión WebSocket en tiempo real establecida",
        usuario: socket.admin.username,
        clientes_activos: io.engine.clientsCount,
        timestamp: new Date().toISOString(),
    });

    // Comunicación bidireccional: cliente puede enviar ping y recibir confirmación
    socket.on("cliente:ping", (payload, callback) => {
        const respuesta = {
            ok: true,
            servidor_ts: new Date().toISOString(),
            clientes_activos: io.engine.clientsCount,
            eco: payload?.origen || "dashboard",
        };
        if (typeof callback === "function") callback(respuesta);
        else socket.emit("servidor:pong", respuesta);
    });

    socket.on("disconnect", () => {
        console.log(`[WS] Admin desconectado: ${socket.admin.username} (${socket.id})`);
    });
});

app.set("io", io);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Protección server-side para las rutas del dashboard (antes de express.static)
app.get(["/dashboard", "/dashboard.html"], verificarAuthPagina, (req, res) => {
    res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.use(express.static(path.join(__dirname, "public")));

// 0. HEALTH CHECK (útil para Render / Railway)
app.get("/api/health", (req, res) => {
    res.status(200).json({
        status: "ok",
        service: "community360",
        timestamp: new Date().toISOString(),
    });
});

// 1. INICIO DE SESION (acepta username o correo)
app.post("/api/auth/login", async (req, res) => {
    const identificador = (req.body.username || req.body.correo || req.body.email || "").trim();
    const { password } = req.body;

    if (!identificador || !password) {
        return res.status(400).json({ error: "Usuario y contraseña requeridos." });
    }

    try {
        const result = await db.execute({
            sql: `SELECT id_admin, nombre, apellido_paterno, username, password_hash, rol
                  FROM admin_usuarios
                  WHERE LOWER(username) = LOWER(?) OR LOWER(COALESCE(correo, '')) = LOWER(?)`,
            args: [identificador, identificador],
        });

        if (result.rows.length === 0) {
            return res.status(401).json({ error: "Credenciales incorrectas." });
        }

        const admin = result.rows[0];
        const passwordValido = await bcrypt.compare(password, admin.password_hash);

        if (!passwordValido) {
            return res.status(401).json({ error: "Credenciales incorrectas." });
        }

        const token = jwt.sign(
            { id_admin: admin.id_admin, username: admin.username, rol: admin.rol },
            process.env.JWT_SECRET,
            { expiresIn: "2h" }
        );

        res.cookie("token", token, {
            httpOnly: true,
            sameSite: "lax",
            secure: isProd,
            maxAge: 2 * 60 * 60 * 1000,
        });

        res.json({
            mensaje: "Inicio de sesión exitoso",
            usuario: {
                id_admin: admin.id_admin,
                nombre: `${admin.nombre} ${admin.apellido_paterno}`,
                username: admin.username,
                rol: admin.rol,
            },
            token,
        });
    } catch (error) {
        console.error("Error en login:", error);
        res.status(500).json({ error: "Error interno del servidor." });
    }
});

// 2. VERIFICAR SESION ACTIVA
app.get("/api/auth/me", verificarAuth, (req, res) => {
    res.json({ autenticado: true, usuario: req.admin });
});

// 3. CIERRE DE SESION
app.post("/api/auth/logout", (req, res) => {
    res.clearCookie("token", {
        httpOnly: true,
        sameSite: "lax",
        secure: isProd,
    });
    res.json({ mensaje: "Sesión cerrada correctamente." });
});

// 4. RUTAS API REST - FASE 4 (PROTEGIDAS CON JWT)
app.use("/api/interacciones", interaccionesRouter);
app.use("/api/analitica", analiticaRouter);

// Alias compatible con Fase 3 (/api/dashboard/resumen -> /api/analitica/resumen)
app.get("/api/dashboard/resumen", verificarAuth, (req, res, next) => {
    req.url = "/resumen";
    analiticaRouter(req, res, next);
});

// Manejo de rutas API inexistentes
app.use("/api", (req, res) => {
    res.status(404).json({ error: `Endpoint '${req.method} ${req.originalUrl}' no encontrado.` });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`Servidor Community 360 (REST + WebSockets) corriendo en http://localhost:${PORT}`);
});
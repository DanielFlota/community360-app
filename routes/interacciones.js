import { Router } from "express";
import { db } from "../db.js";
import { verificarAuth } from "../middleware/auth.js";

const router = Router();
router.use(verificarAuth);

async function resolverCatalogo(tabla, columnaId, columnaNombre, valor) {
    if (valor === undefined || valor === null || valor === "") return null;

    if (typeof valor === "number" || /^\d+$/.test(String(valor))) {
        const res = await db.execute({
            sql: `SELECT ${columnaId} AS id, ${columnaNombre} AS nombre FROM ${tabla} WHERE ${columnaId} = ?`,
            args: [Number(valor)],
        });
        return res.rows[0]?.id ?? null;
    }

    const limpio = String(valor).trim();
    const res = await db.execute({
        sql: `SELECT ${columnaId} AS id FROM ${tabla} WHERE LOWER(${columnaNombre}) = LOWER(?)`,
        args: [limpio],
    });
    return res.rows[0]?.id ?? null;
}

async function obtenerInteraccionPorId(idInteraccion) {
    const res = await db.execute({
        sql: `
            SELECT
                i.id_interaccion,
                i.id_usuario,
                u.alias AS usuario_alias,
                p.nombre AS plataforma,
                ti.nombre AS tipo,
                te.nombre AS tema,
                d.nombre AS dispositivo,
                id.codigo AS idioma,
                i.timestamp,
                i.sentimiento,
                i.longitud_texto,
                i.reacciones_recibidas,
                i.detalles_extra
            FROM interacciones i
            JOIN usuarios u ON u.id_usuario = i.id_usuario
            JOIN plataformas p ON p.id_plataforma = i.id_plataforma
            JOIN tipos_interaccion ti ON ti.id_tipo = i.id_tipo
            JOIN temas te ON te.id_tema = i.id_tema
            JOIN dispositivos d ON d.id_dispositivo = i.id_dispositivo
            JOIN idiomas id ON id.id_idioma = i.id_idioma
            WHERE i.id_interaccion = ?
        `,
        args: [idInteraccion],
    });

    if (res.rows.length === 0) return null;

    const tagsRes = await db.execute({
        sql: `
            SELECT e.nombre
            FROM interaccion_etiquetas ie
            JOIN etiquetas e ON e.id_etiqueta = ie.id_etiqueta
            WHERE ie.id_interaccion = ?
            ORDER BY e.nombre ASC
        `,
        args: [idInteraccion],
    });

    const row = res.rows[0];
    let texto = null;
    if (row.detalles_extra) {
        try {
            const parsed = JSON.parse(row.detalles_extra);
            texto = parsed.texto ?? null;
        } catch {
            texto = row.detalles_extra;
        }
    }

    return {
        id_interaccion: row.id_interaccion,
        id_usuario: row.id_usuario,
        usuario_alias: row.usuario_alias,
        plataforma: row.plataforma,
        tipo: row.tipo,
        tema: row.tema,
        dispositivo: row.dispositivo,
        idioma: row.idioma,
        timestamp: row.timestamp,
        sentimiento: Number(row.sentimiento),
        longitud_texto: Number(row.longitud_texto),
        reacciones_recibidas: Number(row.reacciones_recibidas),
        texto,
        etiquetas: tagsRes.rows.map((t) => t.nombre),
    };
}

function normalizarEtiquetas(etiquetas) {
    if (etiquetas === undefined || etiquetas === null) return [];
    if (Array.isArray(etiquetas)) {
        return [...new Set(etiquetas.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
    }
    if (typeof etiquetas === "string") {
        return [...new Set(etiquetas.split(/[|,]/).map((t) => t.trim().toLowerCase()).filter(Boolean))];
    }
    return null;
}

async function guardarEtiquetas(idInteraccion, etiquetas) {
    await db.execute({
        sql: "DELETE FROM interaccion_etiquetas WHERE id_interaccion = ?",
        args: [idInteraccion],
    });

    for (const tag of etiquetas) {
        await db.execute({
            sql: "INSERT OR IGNORE INTO etiquetas (nombre) VALUES (?)",
            args: [tag],
        });
        const tagRow = await db.execute({
            sql: "SELECT id_etiqueta FROM etiquetas WHERE nombre = ?",
            args: [tag],
        });
        const idEtiqueta = tagRow.rows[0]?.id_etiqueta;
        if (idEtiqueta) {
            await db.execute({
                sql: "INSERT OR IGNORE INTO interaccion_etiquetas (id_interaccion, id_etiqueta) VALUES (?, ?)",
                args: [idInteraccion, idEtiqueta],
            });
        }
    }
}

// 1. GET /api/interacciones - Consulta histórica con filtros y paginación
router.get("/", async (req, res) => {
    try {
        const { plataforma, tipo, tema, id_usuario, desde, hasta } = req.query;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 250);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

        const condiciones = [];
        const args = [];

        if (plataforma) {
            condiciones.push("LOWER(p.nombre) = LOWER(?)");
            args.push(String(plataforma).trim());
        }
        if (tipo) {
            condiciones.push("LOWER(ti.nombre) = LOWER(?)");
            args.push(String(tipo).trim());
        }
        if (tema) {
            condiciones.push("LOWER(te.nombre) = LOWER(?)");
            args.push(String(tema).trim());
        }
        if (id_usuario) {
            condiciones.push("UPPER(i.id_usuario) = UPPER(?)");
            args.push(String(id_usuario).trim());
        }
        if (desde) {
            condiciones.push("i.timestamp >= ?");
            args.push(String(desde).trim());
        }
        if (hasta) {
            condiciones.push("i.timestamp <= ?");
            args.push(String(hasta).trim());
        }

        const whereClause = condiciones.length > 0 ? `WHERE ${condiciones.join(" AND ")}` : "";

        const countRes = await db.execute({
            sql: `
                SELECT COUNT(*) AS total
                FROM interacciones i
                JOIN plataformas p ON p.id_plataforma = i.id_plataforma
                JOIN tipos_interaccion ti ON ti.id_tipo = i.id_tipo
                JOIN temas te ON te.id_tema = i.id_tema
                ${whereClause}
            `,
            args,
        });

        const dataRes = await db.execute({
            sql: `
                SELECT
                    i.id_interaccion,
                    i.id_usuario,
                    u.alias AS usuario_alias,
                    p.nombre AS plataforma,
                    ti.nombre AS tipo,
                    te.nombre AS tema,
                    d.nombre AS dispositivo,
                    id.codigo AS idioma,
                    i.timestamp,
                    i.sentimiento,
                    i.longitud_texto,
                    i.reacciones_recibidas,
                    i.detalles_extra,
                    GROUP_CONCAT(e.nombre, '|') AS etiquetas_concat
                FROM interacciones i
                JOIN usuarios u ON u.id_usuario = i.id_usuario
                JOIN plataformas p ON p.id_plataforma = i.id_plataforma
                JOIN tipos_interaccion ti ON ti.id_tipo = i.id_tipo
                JOIN temas te ON te.id_tema = i.id_tema
                JOIN dispositivos d ON d.id_dispositivo = i.id_dispositivo
                JOIN idiomas id ON id.id_idioma = i.id_idioma
                LEFT JOIN interaccion_etiquetas ie ON ie.id_interaccion = i.id_interaccion
                LEFT JOIN etiquetas e ON e.id_etiqueta = ie.id_etiqueta
                ${whereClause}
                GROUP BY i.id_interaccion
                ORDER BY i.timestamp DESC
                LIMIT ? OFFSET ?
            `,
            args: [...args, limit, offset],
        });

        const data = dataRes.rows.map((row) => {
            let texto = null;
            if (row.detalles_extra) {
                try {
                    texto = JSON.parse(row.detalles_extra).texto ?? null;
                } catch {
                    texto = row.detalles_extra;
                }
            }
            return {
                id_interaccion: row.id_interaccion,
                id_usuario: row.id_usuario,
                usuario_alias: row.usuario_alias,
                plataforma: row.plataforma,
                tipo: row.tipo,
                tema: row.tema,
                dispositivo: row.dispositivo,
                idioma: row.idioma,
                timestamp: row.timestamp,
                sentimiento: Number(row.sentimiento),
                longitud_texto: Number(row.longitud_texto),
                reacciones_recibidas: Number(row.reacciones_recibidas),
                texto,
                etiquetas: row.etiquetas_concat ? String(row.etiquetas_concat).split("|") : [],
            };
        });

        res.status(200).json({
            total: Number(countRes.rows[0].total),
            limit,
            offset,
            data,
        });
    } catch (error) {
        console.error("Error consultando interacciones:", error);
        res.status(500).json({ error: "Error interno al consultar interacciones." });
    }
});

// 2. GET /api/interacciones/:id - Consultar detalle de una interacción
router.get("/:id", async (req, res) => {
    try {
        const interaccion = await obtenerInteraccionPorId(req.params.id);
        if (!interaccion) {
            return res.status(404).json({ error: `Interacción '${req.params.id}' no encontrada.` });
        }
        res.status(200).json(interaccion);
    } catch (error) {
        console.error("Error obteniendo interacción:", error);
        res.status(500).json({ error: "Error interno al obtener la interacción." });
    }
});

// 3. POST /api/interacciones - Crear interacción (uso vía Postman)
router.post("/", async (req, res) => {
    try {
        const {
            id_interaccion,
            id_usuario,
            plataforma,
            tipo,
            tema,
            dispositivo = "Web",
            idioma = "es",
            timestamp,
            sentimiento,
            longitud_texto,
            reacciones_recibidas = 0,
            texto = null,
            etiquetas = [],
        } = req.body;

        const errores = [];
        if (!id_usuario || typeof id_usuario !== "string") errores.push("id_usuario es obligatorio.");
        if (!plataforma) errores.push("plataforma es obligatoria.");
        if (!tipo) errores.push("tipo es obligatorio.");
        if (!tema) errores.push("tema es obligatorio.");

        const sentNum = Number(sentimiento);
        if (sentimiento === undefined || sentimiento === null || Number.isNaN(sentNum) || sentNum < -1 || sentNum > 1) {
            errores.push("sentimiento debe ser un número entre -1.0 y 1.0.");
        }

        const reaccionesNum = Number(reacciones_recibidas);
        if (!Number.isInteger(reaccionesNum) || reaccionesNum < 0) {
            errores.push("reacciones_recibidas debe ser un entero mayor o igual a 0.");
        }

        const textoLimpio = texto !== null && texto !== undefined ? String(texto).trim() : null;
        const longNum =
            longitud_texto !== undefined && longitud_texto !== null
                ? Number(longitud_texto)
                : textoLimpio
                    ? textoLimpio.length
                    : 0;

        if (!Number.isInteger(longNum) || longNum < 0) {
            errores.push("longitud_texto debe ser un entero mayor o igual a 0.");
        }

        let fechaIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
        if (timestamp !== undefined && timestamp !== null && timestamp !== "") {
            const parsedDate = new Date(timestamp);
            if (Number.isNaN(parsedDate.getTime())) {
                errores.push("timestamp debe tener un formato de fecha ISO 8601 válido.");
            } else {
                fechaIso = parsedDate.toISOString().replace(/\.\d{3}Z$/, "Z");
            }
        }

        const etiquetasNorm = normalizarEtiquetas(etiquetas);
        if (etiquetasNorm === null) {
            errores.push("etiquetas debe ser un arreglo de strings o texto separado por '|'.");
        }

        if (errores.length > 0) {
            return res.status(400).json({ error: "Datos inválidos.", detalles: errores });
        }

        // Verificar existencia del usuario
        const userCheck = await db.execute({
            sql: "SELECT id_usuario FROM usuarios WHERE id_usuario = ?",
            args: [id_usuario.trim()],
        });
        if (userCheck.rows.length === 0) {
            return res.status(404).json({
                error: `El usuario '${id_usuario}' no existe en el padrón.`,
            });
        }

        // Resolver catálogos
        const [idPlataforma, idTipo, idTema, idDispositivo, idIdioma] = await Promise.all([
            resolverCatalogo("plataformas", "id_plataforma", "nombre", plataforma),
            resolverCatalogo("tipos_interaccion", "id_tipo", "nombre", tipo),
            resolverCatalogo("temas", "id_tema", "nombre", tema),
            resolverCatalogo("dispositivos", "id_dispositivo", "nombre", dispositivo),
            resolverCatalogo("idiomas", "id_idioma", "codigo", idioma),
        ]);

        const erroresCatalogo = [];
        if (!idPlataforma) erroresCatalogo.push(`Plataforma no válida: '${plataforma}'.`);
        if (!idTipo) erroresCatalogo.push(`Tipo de interacción no válido: '${tipo}'.`);
        if (!idTema) erroresCatalogo.push(`Tema no válido: '${tema}'.`);
        if (!idDispositivo) erroresCatalogo.push(`Dispositivo no válido: '${dispositivo}'.`);
        if (!idIdioma) erroresCatalogo.push(`Idioma no válido: '${idioma}'.`);

        if (erroresCatalogo.length > 0) {
            return res.status(400).json({
                error: "Valores de catálogo no válidos. Consulta GET /api/analitica/catalogos.",
                detalles: erroresCatalogo,
            });
        }

        const nuevoId =
            id_interaccion && String(id_interaccion).trim()
                ? String(id_interaccion).trim()
                : `I${Date.now().toString().slice(-7)}`;

        const dupCheck = await db.execute({
            sql: "SELECT id_interaccion FROM interacciones WHERE id_interaccion = ?",
            args: [nuevoId],
        });
        if (dupCheck.rows.length > 0) {
            return res.status(409).json({
                error: `Ya existe una interacción con id_interaccion '${nuevoId}'.`,
            });
        }

        const detallesExtra = textoLimpio ? JSON.stringify({ texto: textoLimpio }) : null;

        await db.execute({
            sql: `
                INSERT INTO interacciones (
                    id_interaccion, id_usuario, id_plataforma, id_tipo, id_tema,
                    id_dispositivo, id_idioma, timestamp, sentimiento,
                    longitud_texto, reacciones_recibidas, detalles_extra
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            args: [
                nuevoId,
                id_usuario.trim(),
                idPlataforma,
                idTipo,
                idTema,
                idDispositivo,
                idIdioma,
                fechaIso,
                sentNum,
                longNum,
                reaccionesNum,
                detallesExtra,
            ],
        });

        if (etiquetasNorm.length > 0) {
            await guardarEtiquetas(nuevoId, etiquetasNorm);
        }

        const creada = await obtenerInteraccionPorId(nuevoId);

        const io = req.app.get("io");
        if (io) {
            io.emit("interaccion:creada", {
                evento: "creada",
                interaccion: creada,
                timestamp: new Date().toISOString(),
            });
        }

        res.status(201).json({
            mensaje: "Interacción creada correctamente.",
            interaccion: creada,
        });
    } catch (error) {
        console.error("Error creando interacción:", error);
        res.status(500).json({ error: "Error interno al crear la interacción." });
    }
});

// 4. PUT /api/interacciones/:id - Actualizar interacción existente (uso vía Postman)
router.put("/:id", async (req, res) => {
    try {
        const id = req.params.id;
        const existente = await db.execute({
            sql: "SELECT * FROM interacciones WHERE id_interaccion = ?",
            args: [id],
        });

        if (existente.rows.length === 0) {
            return res.status(404).json({ error: `Interacción '${id}' no encontrada.` });
        }

        const actual = existente.rows[0];
        const {
            plataforma,
            tipo,
            tema,
            dispositivo,
            idioma,
            timestamp,
            sentimiento,
            longitud_texto,
            reacciones_recibidas,
            texto,
            etiquetas,
        } = req.body;

        const errores = [];

        let idPlataforma = actual.id_plataforma;
        if (plataforma !== undefined) {
            idPlataforma = await resolverCatalogo("plataformas", "id_plataforma", "nombre", plataforma);
            if (!idPlataforma) errores.push(`Plataforma no válida: '${plataforma}'.`);
        }

        let idTipo = actual.id_tipo;
        if (tipo !== undefined) {
            idTipo = await resolverCatalogo("tipos_interaccion", "id_tipo", "nombre", tipo);
            if (!idTipo) errores.push(`Tipo no válido: '${tipo}'.`);
        }

        let idTema = actual.id_tema;
        if (tema !== undefined) {
            idTema = await resolverCatalogo("temas", "id_tema", "nombre", tema);
            if (!idTema) errores.push(`Tema no válido: '${tema}'.`);
        }

        let idDispositivo = actual.id_dispositivo;
        if (dispositivo !== undefined) {
            idDispositivo = await resolverCatalogo("dispositivos", "id_dispositivo", "nombre", dispositivo);
            if (!idDispositivo) errores.push(`Dispositivo no válido: '${dispositivo}'.`);
        }

        let idIdioma = actual.id_idioma;
        if (idioma !== undefined) {
            idIdioma = await resolverCatalogo("idiomas", "id_idioma", "codigo", idioma);
            if (!idIdioma) errores.push(`Idioma no válido: '${idioma}'.`);
        }

        let nuevoSentimiento = Number(actual.sentimiento);
        if (sentimiento !== undefined) {
            const s = Number(sentimiento);
            if (Number.isNaN(s) || s < -1 || s > 1) {
                errores.push("sentimiento debe estar entre -1.0 y 1.0.");
            } else {
                nuevoSentimiento = s;
            }
        }

        let nuevasReacciones = Number(actual.reacciones_recibidas);
        if (reacciones_recibidas !== undefined) {
            const r = Number(reacciones_recibidas);
            if (!Number.isInteger(r) || r < 0) {
                errores.push("reacciones_recibidas debe ser un entero mayor o igual a 0.");
            } else {
                nuevasReacciones = r;
            }
        }

        let nuevaFecha = actual.timestamp;
        if (timestamp !== undefined) {
            const parsedDate = new Date(timestamp);
            if (Number.isNaN(parsedDate.getTime())) {
                errores.push("timestamp debe tener un formato ISO 8601 válido.");
            } else {
                nuevaFecha = parsedDate.toISOString().replace(/\.\d{3}Z$/, "Z");
            }
        }

        let nuevosDetalles = actual.detalles_extra;
        let nuevaLongitud = Number(actual.longitud_texto);
        if (texto !== undefined) {
            const textoLimpio = texto === null ? null : String(texto).trim();
            nuevosDetalles = textoLimpio ? JSON.stringify({ texto: textoLimpio }) : null;
            if (longitud_texto === undefined) {
                nuevaLongitud = textoLimpio ? textoLimpio.length : 0;
            }
        }

        if (longitud_texto !== undefined) {
            const l = Number(longitud_texto);
            if (!Number.isInteger(l) || l < 0) {
                errores.push("longitud_texto debe ser un entero mayor o igual a 0.");
            } else {
                nuevaLongitud = l;
            }
        }

        let etiquetasNorm;
        if (etiquetas !== undefined) {
            etiquetasNorm = normalizarEtiquetas(etiquetas);
            if (etiquetasNorm === null) {
                errores.push("etiquetas debe ser un arreglo de strings o texto separado por '|'.");
            }
        }

        if (errores.length > 0) {
            return res.status(400).json({ error: "Datos inválidos.", detalles: errores });
        }

        await db.execute({
            sql: `
                UPDATE interacciones
                SET id_plataforma = ?, id_tipo = ?, id_tema = ?, id_dispositivo = ?,
                    id_idioma = ?, timestamp = ?, sentimiento = ?, longitud_texto = ?,
                    reacciones_recibidas = ?, detalles_extra = ?
                WHERE id_interaccion = ?
            `,
            args: [
                idPlataforma,
                idTipo,
                idTema,
                idDispositivo,
                idIdioma,
                nuevaFecha,
                nuevoSentimiento,
                nuevaLongitud,
                nuevasReacciones,
                nuevosDetalles,
                id,
            ],
        });

        if (etiquetasNorm !== undefined) {
            await guardarEtiquetas(id, etiquetasNorm);
        }

        const actualizada = await obtenerInteraccionPorId(id);

        const io = req.app.get("io");
        if (io) {
            io.emit("interaccion:actualizada", {
                evento: "actualizada",
                interaccion: actualizada,
                timestamp: new Date().toISOString(),
            });
        }

        res.status(200).json({
            mensaje: "Interacción actualizada correctamente.",
            interaccion: actualizada,
        });
    } catch (error) {
        console.error("Error actualizando interacción:", error);
        res.status(500).json({ error: "Error interno al actualizar la interacción." });
    }
});

// 5. DELETE /api/interacciones/:id - Eliminar interacción (uso vía Postman)
router.delete("/:id", async (req, res) => {
    try {
        const id = req.params.id;
        const existente = await db.execute({
            sql: "SELECT id_interaccion FROM interacciones WHERE id_interaccion = ?",
            args: [id],
        });

        if (existente.rows.length === 0) {
            return res.status(404).json({ error: `Interacción '${id}' no encontrada.` });
        }

        await db.execute({
            sql: "DELETE FROM interaccion_etiquetas WHERE id_interaccion = ?",
            args: [id],
        });
        await db.execute({
            sql: "DELETE FROM interacciones WHERE id_interaccion = ?",
            args: [id],
        });

        const io = req.app.get("io");
        if (io) {
            io.emit("interaccion:eliminada", {
                evento: "eliminada",
                id_interaccion: id,
                timestamp: new Date().toISOString(),
            });
        }

        res.status(200).json({
            mensaje: "Interacción eliminada correctamente.",
            id_interaccion: id,
        });
    } catch (error) {
        console.error("Error eliminando interacción:", error);
        res.status(500).json({ error: "Error interno al eliminar la interacción." });
    }
});

export default router;

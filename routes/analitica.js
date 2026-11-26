import { Router } from "express";
import { db } from "../db.js";
import { verificarAuth } from "../middleware/auth.js";

const router = Router();
router.use(verificarAuth);

// 1. Resumen ejecutivo de KPIs
router.get("/resumen", async (req, res) => {
    try {
        const [usuariosStats, interStats, cuarentenaRes] = await Promise.all([
            db.execute(`
                SELECT
                    COUNT(*) AS total_usuarios,
                    SUM(CASE WHEN e.nombre = 'activo' THEN 1 ELSE 0 END) AS usuarios_activos,
                    SUM(CASE WHEN e.nombre = 'en_riesgo' THEN 1 ELSE 0 END) AS usuarios_en_riesgo,
                    SUM(CASE WHEN e.nombre = 'inactivo' THEN 1 ELSE 0 END) AS usuarios_inactivos,
                    SUM(CASE WHEN u.consentimiento_datos = 1 THEN 1 ELSE 0 END) AS usuarios_con_consentimiento,
                    SUM(CASE WHEN u.consentimiento_datos = 0 THEN 1 ELSE 0 END) AS usuarios_anonimizados
                FROM usuarios u
                JOIN estatus_usuario e ON e.id_estatus = u.id_estatus
            `),
            db.execute(`
                SELECT
                    COUNT(*) AS total_interacciones,
                    ROUND(COALESCE(AVG(sentimiento), 0), 3) AS sentimiento_promedio,
                    COALESCE(SUM(reacciones_recibidas), 0) AS total_reacciones
                FROM interacciones
            `),
            db.execute("SELECT COUNT(*) AS total_cuarentena FROM interacciones_cuarentena"),
        ]);

        const u = usuariosStats.rows[0];
        const i = interStats.rows[0];
        const c = cuarentenaRes.rows[0];

        res.status(200).json({
            total_usuarios: Number(u.total_usuarios),
            usuarios_activos: Number(u.usuarios_activos),
            usuarios_en_riesgo: Number(u.usuarios_en_riesgo),
            usuarios_inactivos: Number(u.usuarios_inactivos),
            usuarios_con_consentimiento: Number(u.usuarios_con_consentimiento),
            usuarios_anonimizados: Number(u.usuarios_anonimizados),
            total_interacciones: Number(i.total_interacciones),
            sentimiento_promedio: Number(i.sentimiento_promedio),
            total_reacciones: Number(i.total_reacciones),
            total_cuarentena: Number(c.total_cuarentena),
        });
    } catch (error) {
        console.error("Error en resumen analítico:", error);
        res.status(500).json({ error: "Error consultando el resumen analítico." });
    }
});

// 2. Métricas por plataforma
router.get("/plataformas", async (req, res) => {
    try {
        const result = await db.execute(`
            SELECT
                p.nombre AS plataforma,
                COUNT(DISTINCT i.id_interaccion) AS total_interacciones,
                ROUND(COALESCE(AVG(i.sentimiento), 0), 3) AS sentimiento_promedio,
                COALESCE(SUM(i.reacciones_recibidas), 0) AS total_reacciones,
                (SELECT COUNT(*) FROM usuarios u WHERE u.id_plataforma_principal = p.id_plataforma) AS usuarios_principales
            FROM plataformas p
            LEFT JOIN interacciones i ON i.id_plataforma = p.id_plataforma
            GROUP BY p.id_plataforma, p.nombre
            ORDER BY total_interacciones DESC, usuarios_principales DESC
        `);

        res.status(200).json(
            result.rows.map((r) => ({
                plataforma: r.plataforma,
                total_interacciones: Number(r.total_interacciones),
                sentimiento_promedio: Number(r.sentimiento_promedio),
                total_reacciones: Number(r.total_reacciones),
                usuarios_principales: Number(r.usuarios_principales),
            }))
        );
    } catch (error) {
        console.error("Error en analítica por plataformas:", error);
        res.status(500).json({ error: "Error consultando métricas por plataforma." });
    }
});

// 3. Temas de mayor interés
router.get("/temas", async (req, res) => {
    try {
        const result = await db.execute(`
            SELECT
                t.nombre AS tema,
                COUNT(i.id_interaccion) AS total_interacciones,
                ROUND(COALESCE(AVG(i.sentimiento), 0), 3) AS sentimiento_promedio,
                COALESCE(SUM(i.reacciones_recibidas), 0) AS total_reacciones
            FROM temas t
            LEFT JOIN interacciones i ON i.id_tema = t.id_tema
            GROUP BY t.id_tema, t.nombre
            ORDER BY total_interacciones DESC
        `);

        res.status(200).json(
            result.rows.map((r) => ({
                tema: r.tema,
                total_interacciones: Number(r.total_interacciones),
                sentimiento_promedio: Number(r.sentimiento_promedio),
                total_reacciones: Number(r.total_reacciones),
            }))
        );
    } catch (error) {
        console.error("Error en analítica por temas:", error);
        res.status(500).json({ error: "Error consultando métricas por tema." });
    }
});

// 4. Distribución por tipo de interacción
router.get("/tipos", async (req, res) => {
    try {
        const result = await db.execute(`
            SELECT
                ti.nombre AS tipo,
                COUNT(i.id_interaccion) AS total_interacciones,
                ROUND(COALESCE(AVG(i.sentimiento), 0), 3) AS sentimiento_promedio
            FROM tipos_interaccion ti
            LEFT JOIN interacciones i ON i.id_tipo = ti.id_tipo
            GROUP BY ti.id_tipo, ti.nombre
            ORDER BY total_interacciones DESC
        `);

        res.status(200).json(
            result.rows.map((r) => ({
                tipo: r.tipo,
                total_interacciones: Number(r.total_interacciones),
                sentimiento_promedio: Number(r.sentimiento_promedio),
            }))
        );
    } catch (error) {
        console.error("Error en analítica por tipos:", error);
        res.status(500).json({ error: "Error consultando métricas por tipo." });
    }
});

// 5. Polaridad de sentimiento (Negativo < 0, Neutral 0 a 0.4, Positivo > 0.4)
router.get("/sentimiento", async (req, res) => {
    try {
        const result = await db.execute(`
            SELECT
                SUM(CASE WHEN sentimiento > 0.4 THEN 1 ELSE 0 END) AS positivo,
                SUM(CASE WHEN sentimiento >= 0 AND sentimiento <= 0.4 THEN 1 ELSE 0 END) AS neutral,
                SUM(CASE WHEN sentimiento < 0 THEN 1 ELSE 0 END) AS negativo,
                ROUND(COALESCE(AVG(sentimiento), 0), 3) AS promedio_global
            FROM interacciones
        `);

        const r = result.rows[0];
        res.status(200).json({
            criterio: { positivo: "> 0.4", neutral: "0 a 0.4", negativo: "< 0" },
            positivo: Number(r.positivo || 0),
            neutral: Number(r.neutral || 0),
            negativo: Number(r.negativo || 0),
            promedio_global: Number(r.promedio_global || 0),
        });
    } catch (error) {
        console.error("Error en analítica de sentimiento:", error);
        res.status(500).json({ error: "Error consultando distribución de sentimiento." });
    }
});

// 6. Distribución geográfica (SOLO usuarios con consentimiento_datos = 1)
router.get("/geografia", async (req, res) => {
    try {
        const [ciudadesRes, excluidosRes] = await Promise.all([
            db.execute(`
                SELECT
                    c.nombre AS ciudad,
                    es.nombre AS estado,
                    pa.nombre AS pais,
                    COUNT(u.id_usuario) AS total_usuarios
                FROM usuarios u
                JOIN ciudades c ON c.id_ciudad = u.id_ciudad
                JOIN estados es ON es.id_estado = c.id_estado
                JOIN paises pa ON pa.id_pais = es.id_pais
                WHERE u.consentimiento_datos = 1 AND u.id_ciudad IS NOT NULL
                GROUP BY c.id_ciudad, c.nombre, es.nombre, pa.nombre
                ORDER BY total_usuarios DESC
                LIMIT 10
            `),
            db.execute("SELECT COUNT(*) AS excluidos FROM usuarios WHERE consentimiento_datos = 0"),
        ]);

        res.status(200).json({
            usuarios_excluidos_privacidad: Number(excluidosRes.rows[0].excluidos),
            top_ciudades: ciudadesRes.rows.map((r) => ({
                ciudad: r.ciudad,
                estado: r.estado,
                pais: r.pais,
                total_usuarios: Number(r.total_usuarios),
            })),
        });
    } catch (error) {
        console.error("Error en analítica geográfica:", error);
        res.status(500).json({ error: "Error consultando distribución geográfica." });
    }
});

// 7. Usuarios en riesgo de abandono (respetando privacidad geográfica)
router.get("/usuarios-riesgo", async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 15, 1), 100);
        const result = await db.execute({
            sql: `
                SELECT
                    u.id_usuario,
                    u.alias,
                    p.nombre AS plataforma_principal,
                    u.mensajes_30d,
                    u.reacciones_30d,
                    u.sentimiento_promedio,
                    u.ultima_actividad,
                    u.consentimiento_datos,
                    CASE
                        WHEN u.consentimiento_datos = 1 AND c.nombre IS NOT NULL THEN c.nombre || ', ' || pa.nombre
                        ELSE 'Anonimizado (sin consentimiento)'
                    END AS ubicacion
                FROM usuarios u
                JOIN estatus_usuario e ON e.id_estatus = u.id_estatus
                JOIN plataformas p ON p.id_plataforma = u.id_plataforma_principal
                LEFT JOIN ciudades c ON c.id_ciudad = u.id_ciudad AND u.consentimiento_datos = 1
                LEFT JOIN estados es ON es.id_estado = c.id_estado
                LEFT JOIN paises pa ON pa.id_pais = es.id_pais
                WHERE e.nombre = 'en_riesgo'
                ORDER BY u.sentimiento_promedio ASC, u.mensajes_30d ASC
                LIMIT ?
            `,
            args: [limit],
        });

        res.status(200).json(
            result.rows.map((r) => ({
                id_usuario: r.id_usuario,
                alias: r.alias,
                plataforma_principal: r.plataforma_principal,
                mensajes_30d: Number(r.mensajes_30d),
                reacciones_30d: Number(r.reacciones_30d),
                sentimiento_promedio: Number(r.sentimiento_promedio),
                ultima_actividad: r.ultima_actividad,
                ubicacion: r.ubicacion,
            }))
        );
    } catch (error) {
        console.error("Error en usuarios en riesgo:", error);
        res.status(500).json({ error: "Error consultando usuarios en riesgo." });
    }
});

// 8. Catálogos válidos (para filtros del dashboard y referencia en Postman)
router.get("/catalogos", async (req, res) => {
    try {
        const [plataformas, tipos, temas, dispositivos, idiomas, estatus] = await Promise.all([
            db.execute("SELECT nombre FROM plataformas ORDER BY nombre ASC"),
            db.execute("SELECT nombre FROM tipos_interaccion ORDER BY nombre ASC"),
            db.execute("SELECT nombre FROM temas ORDER BY nombre ASC"),
            db.execute("SELECT nombre FROM dispositivos ORDER BY nombre ASC"),
            db.execute("SELECT codigo FROM idiomas ORDER BY codigo ASC"),
            db.execute("SELECT nombre FROM estatus_usuario ORDER BY nombre ASC"),
        ]);

        res.status(200).json({
            plataformas: plataformas.rows.map((r) => r.nombre),
            tipos: tipos.rows.map((r) => r.nombre),
            temas: temas.rows.map((r) => r.nombre),
            dispositivos: dispositivos.rows.map((r) => r.nombre),
            idiomas: idiomas.rows.map((r) => r.codigo),
            estatus: estatus.rows.map((r) => r.nombre),
        });
    } catch (error) {
        console.error("Error consultando catálogos:", error);
        res.status(500).json({ error: "Error consultando catálogos." });
    }
});

// 9. Auditoría ETL y cuarentena
router.get("/cuarentena", async (req, res) => {
    try {
        const [motivosRes, bitacoraRes] = await Promise.all([
            db.execute(`
                SELECT motivo_rechazo, COUNT(*) AS total
                FROM interacciones_cuarentena
                GROUP BY motivo_rechazo
                ORDER BY total DESC
            `),
            db.execute(`
                SELECT archivo, fecha_ejecucion, recibidos, aceptados, transformados, rechazados
                FROM etl_bitacora
                ORDER BY id_ejecucion DESC
                LIMIT 6
            `),
        ]);

        res.status(200).json({
            motivos: motivosRes.rows.map((r) => ({
                motivo_rechazo: r.motivo_rechazo,
                total: Number(r.total),
            })),
            bitacora: bitacoraRes.rows.map((r) => ({
                archivo: r.archivo,
                fecha_ejecucion: r.fecha_ejecucion,
                recibidos: Number(r.recibidos),
                aceptados: Number(r.aceptados),
                transformados: Number(r.transformados),
                rechazados: Number(r.rechazados),
            })),
        });
    } catch (error) {
        console.error("Error consultando cuarentena:", error);
        res.status(500).json({ error: "Error consultando auditoría ETL y cuarentena." });
    }
});

// 10. Mapa de calor: Plataforma x Tema
router.get("/heatmap", async (req, res) => {
    try {
        const [plataformasRes, temasRes, matrizRes] = await Promise.all([
            db.execute("SELECT nombre FROM plataformas ORDER BY nombre ASC"),
            db.execute("SELECT nombre FROM temas ORDER BY nombre ASC"),
            db.execute(`
                SELECT
                    p.nombre AS plataforma,
                    t.nombre AS tema,
                    COUNT(i.id_interaccion) AS total_interacciones,
                    ROUND(COALESCE(AVG(i.sentimiento), 0), 3) AS sentimiento_promedio
                FROM interacciones i
                JOIN plataformas p ON p.id_plataforma = i.id_plataforma
                JOIN temas t ON t.id_tema = i.id_tema
                GROUP BY p.nombre, t.nombre
            `),
        ]);

        res.status(200).json({
            plataformas: plataformasRes.rows.map((r) => r.nombre),
            temas: temasRes.rows.map((r) => r.nombre),
            celdas: matrizRes.rows.map((r) => ({
                plataforma: r.plataforma,
                tema: r.tema,
                total_interacciones: Number(r.total_interacciones),
                sentimiento_promedio: Number(r.sentimiento_promedio),
            })),
        });
    } catch (error) {
        console.error("Error consultando mapa de calor:", error);
        res.status(500).json({ error: "Error consultando mapa de calor." });
    }
});

export default router;

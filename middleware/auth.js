import jwt from "jsonwebtoken";

function extraerToken(req) {
    return (
        req.cookies?.token ||
        (req.headers.authorization?.startsWith("Bearer ")
            ? req.headers.authorization.split(" ")[1]
            : null)
    );
}

export function verificarAuth(req, res, next) {
    const token = extraerToken(req);

    if (!token) {
        return res.status(401).json({ error: "Acceso denegado. Inicia sesión." });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.admin = decoded;
        next();
    } catch (err) {
        return res.status(403).json({ error: "Token inválido o expirado." });
    }
}

export function verificarAuthPagina(req, res, next) {
    const token = extraerToken(req);

    if (!token) {
        return res.redirect("/index.html");
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.admin = decoded;
        next();
    } catch (err) {
        res.clearCookie("token");
        return res.redirect("/index.html");
    }
}
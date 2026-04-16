const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const FormData = require('form-data');

const app = express();
const upload = multer({ dest: 'uploads/' });

const linkMap = new Map();

app.use(express.static('public'));
app.use(express.json());

// Générer un code court unique
function generateShortCode() {
    return crypto.randomBytes(6).toString('base64url');
}

// Upload vers Catbox (avec fs.createReadStream)
async function uploadToCatbox(filePath, originalName) {
    const fileExt = path.extname(originalName).toLowerCase();

    let contentType = 'application/octet-stream';
    if (['.jpg', '.jpeg'].includes(fileExt)) contentType = 'image/jpeg';
    else if (fileExt === '.png') contentType = 'image/png';
    else if (fileExt === '.gif') contentType = 'image/gif';
    else if (fileExt === '.webp') contentType = 'image/webp';
    else if (fileExt === '.mp4') contentType = 'video/mp4';
    else if (fileExt === '.webm') contentType = 'video/webm';
    else if (fileExt === '.mov') contentType = 'video/quicktime';
    else if (fileExt === '.mp3') contentType = 'audio/mpeg';
    else if (fileExt === '.wav') contentType = 'audio/wav';
    else if (fileExt === '.ogg') contentType = 'audio/ogg';
    else if (['.js', '.mjs'].includes(fileExt)) contentType = 'application/javascript';
    else if (fileExt === '.css') contentType = 'text/css';
    else if (fileExt === '.pdf') contentType = 'application/pdf';

    const formData = new FormData();
    formData.append('reqtype', 'fileupload');
    // Utiliser fs.createReadStream au lieu du buffer
    formData.append('fileToUpload', fs.createReadStream(filePath), {
        filename: originalName,
        contentType: contentType
    });

    const response = await fetch('https://catbox.moe/user/api.php', {
        method: 'POST',
        body: formData,
        headers: formData.getHeaders() // Important : ajouter les headers Content-Type avec boundary
    });

    const imageUrl = await response.text();
    console.log('Catbox response:', response.status, imageUrl);

    if (!imageUrl || !imageUrl.startsWith('http')) {
        throw new Error('Échec upload Catbox: ' + imageUrl);
    }

    return imageUrl.trim();
}

// Route upload
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });

        const catboxUrl = await uploadToCatbox(req.file.path, req.file.originalname);
        const shortCode = generateShortCode();
        const fileExt = path.extname(req.file.originalname).toLowerCase();

        let mime = 'application/octet-stream';
        if (['.jpg', '.jpeg'].includes(fileExt)) mime = 'image/jpeg';
        else if (fileExt === '.png') mime = 'image/png';
        else if (fileExt === '.gif') mime = 'image/gif';
        else if (fileExt === '.webp') mime = 'image/webp';
        else if (fileExt === '.mp4') mime = 'video/mp4';
        else if (fileExt === '.webm') mime = 'video/webm';
        else if (fileExt === '.mov') mime = 'video/quicktime';
        else if (fileExt === '.mp3') mime = 'audio/mpeg';
        else if (fileExt === '.wav') mime = 'audio/wav';
        else if (fileExt === '.ogg') mime = 'audio/ogg';
        else if (['.js', '.mjs'].includes(fileExt)) mime = 'application/javascript';
        else if (fileExt === '.css') mime = 'text/css';
        else if (fileExt === '.pdf') mime = 'application/pdf';

        linkMap.set(shortCode, {
            catboxUrl: catboxUrl,   // stockée serveur uniquement, jamais révélée
            mime: mime,
            filename: req.file.originalname
        });

        // Nettoyage fichier temporaire
        fs.unlink(req.file.path, () => {});

        res.json({
            success: true,
            shortUrl: `/f/${shortCode}/${encodeURIComponent(req.file.originalname)}`,
            originalName: req.file.originalname
        });

    } catch (err) {
        console.error('Erreur upload:', err);
        // Nettoyage même en cas d'erreur
        if (req.file && req.file.path) {
            fs.unlink(req.file.path, () => {});
        }
        res.status(500).json({ error: err.message });
    }
});

// Proxy transparent — localhost:3000/f/XXXX/nom.png
// Catbox est fetché en interne, streamé, URL jamais révélée au client
app.get('/f/:code/:filename?', async (req, res) => {
    const code = req.params.code;
    const entry = linkMap.get(code);
    if (!entry) return res.status(404).send('Lien invalide ou expiré');

    try {
        const response = await fetch(entry.catboxUrl);

        if (!response.ok) {
            return res.status(502).send('Erreur récupération fichier: ' + response.status);
        }

        res.setHeader('Content-Type', entry.mime);
        res.setHeader(
            'Content-Disposition',
            `inline; filename="${encodeURIComponent(entry.filename)}"`
        );
        // Stream direct — aucune trace Catbox dans les headers de réponse
        response.body.pipe(res);

    } catch (err) {
        console.error('Erreur proxy:', err.message);
        res.status(502).send('Erreur lors de la récupération du fichier');
    }
});

app.listen(3000, () => {
    console.log('Serveur démarré sur http://localhost:3000');
});
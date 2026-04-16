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

function generateShortCode() {
    return crypto.randomBytes(6).toString('base64url');
}

// ⚡ Version
async function uploadToCatbox(filePath, originalName) {
    // Lecture en buffer
    const buffer = fs.readFileSync(filePath);
    
    const formData = new FormData();
    formData.append('reqtype', 'fileupload');
    // IMPORTANT : 3 arguments seulement, pas de 4ème objet
    formData.append('fileToUpload', buffer, originalName);

    const response = await fetch('https://catbox.moe/user/api.php', {
        method: 'POST',
        body: formData
        // PAS de headers supplémentaires
    });

    const result = await response.text();
    if (!result || !result.startsWith('http')) {
        throw new Error(result || 'Upload failed');
    }
    return result.trim();
}

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
            catboxUrl: catboxUrl,
            mime: mime,
            filename: req.file.originalname
        });

        fs.unlink(req.file.path, () => {});

        res.json({
            success: true,
            shortUrl: `/f/${shortCode}/${encodeURIComponent(req.file.originalname)}`,
            originalName: req.file.originalname
        });

    } catch (err) {
        console.error('Erreur upload:', err);
        if (req.file?.path) fs.unlink(req.file.path, () => {});
        res.status(500).json({ error: err.message });
    }
});

app.get('/f/:code/:filename?', async (req, res) => {
    const code = req.params.code;
    const entry = linkMap.get(code);
    if (!entry) return res.status(404).send('Lien invalide ou expiré');

    try {
        const response = await fetch(entry.catboxUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        res.setHeader('Content-Type', entry.mime);
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(entry.filename)}"`);
        response.body.pipe(res);
    } catch (err) {
        console.error('Erreur proxy:', err.message);
        res.status(502).send('Erreur lors de la récupération du fichier');
    }
});

app.listen(3000, () => {
    console.log('Serveur démarré sur http://localhost:3000');
});
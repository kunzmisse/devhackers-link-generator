const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
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

// Upload vers Catbox (URL masquée)
async function uploadToCatbox(filePath, originalName) {
    const form = new FormData();
    form.append('reqtype', 'fileupload'); // reqtype en premier (important)
    form.append('fileToUpload', fs.createReadStream(filePath), {
        filename: originalName           // nom original explicite
    });

    const response = await axios.post('https://catbox.moe/user/api.php', form, {
        headers: {
            ...form.getHeaders(),
            'User-Agent': 'Mozilla/5.0 (compatible; ShadowUpload/1.0)' // fix 412
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
    });

    console.log('Catbox response:', response.status, response.data);

    if (!response.data.startsWith('https://files.catbox.moe/')) {
        throw new Error('Échec upload Catbox: ' + response.data);
    }
    return response.data; // URL Catbox réelle (jamais exposée au client)
}

app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });

        const catboxUrl = await uploadToCatbox(req.file.path, req.file.originalname);
        const shortCode = generateShortCode();
        const fileExt = path.extname(req.file.originalname).toLowerCase();

        let mime = 'application/octet-stream';
        if (['.jpg', '.jpeg'].includes(fileExt)) mime = 'image/jpeg';
        else if (['.png'].includes(fileExt)) mime = 'image/png';
        else if (['.gif'].includes(fileExt)) mime = 'image/gif';
        else if (['.webp'].includes(fileExt)) mime = 'image/webp';
        else if (['.mp4'].includes(fileExt)) mime = 'video/mp4';
        else if (['.webm'].includes(fileExt)) mime = 'video/webm';
        else if (['.mov'].includes(fileExt)) mime = 'video/quicktime';
        else if (['.mp3'].includes(fileExt)) mime = 'audio/mpeg';
        else if (['.wav'].includes(fileExt)) mime = 'audio/wav';
        else if (['.ogg'].includes(fileExt)) mime = 'audio/ogg';
        else if (['.js', '.mjs'].includes(fileExt)) mime = 'application/javascript';
        else if (['.css'].includes(fileExt)) mime = 'text/css';
        else if (['.pdf'].includes(fileExt)) mime = 'application/pdf';

        linkMap.set(shortCode, {
            catboxUrl: catboxUrl,      // URL Catbox stockée côté serveur uniquement
            mime: mime,
            filename: req.file.originalname
        });

        // Nettoyage du fichier temporaire
        fs.unlink(req.file.path, () => {});

        // Le client ne voit jamais l'URL Catbox — seulement le lien localhost
        res.json({
            success: true,
            shortUrl: `/f/${shortCode}`,
            originalName: req.file.originalname
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Proxy transparent : localhost:3000/f/XXXX/nom.png
// L'URL Catbox est récupérée en interne et streamée, jamais révélée
app.get('/f/:code/:filename?', async (req, res) => {
    const code = req.params.code;
    const entry = linkMap.get(code);
    if (!entry) return res.status(404).send('Lien invalide ou expiré');

    try {
        const response = await axios.get(entry.catboxUrl, {
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; ShadowUpload/1.0)'
            }
        });

        // On sert le fichier depuis localhost avec le nom d'origine
        res.setHeader('Content-Type', entry.mime);
        res.setHeader(
            'Content-Disposition',
            `inline; filename="${encodeURIComponent(entry.filename)}"`
        );
        // Aucune trace de Catbox dans les headers de réponse
        response.data.pipe(res);
    } catch (err) {
        console.error('Erreur proxy:', err.message);
        res.status(502).send('Erreur lors de la récupération du fichier');
    }
});

app.listen(3000, () => {
    console.log('Serveur démarré sur http://localhost:3000');
});
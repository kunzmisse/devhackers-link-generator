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

// Upload vers Catbox
async function uploadToCatbox(filePath, originalName) {
    const form = new FormData();
    form.append('fileToUpload', fs.createReadStream(filePath));
    form.append('reqtype', 'fileupload');

    const response = await axios.post('https://catbox.moe/user/api.php', form, {
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity
    });

    if (!response.data.startsWith('https://files.catbox.moe/')) {
        throw new Error('Échec upload Catbox: ' + response.data);
    }
    return response.data; // URL Catbox directe
}

app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });

        const catboxUrl = await uploadToCatbox(req.file.path, req.file.originalname);
        const shortCode = generateShortCode();
        const fileExt = path.extname(req.file.originalname).toLowerCase();
        
        let mime = 'application/octet-stream';
        if (['.jpg','.jpeg','.png','.gif','.webp'].includes(fileExt)) mime = 'image/'+fileExt.substr(1);
        else if (['.mp4','.webm','.mov'].includes(fileExt)) mime = 'video/'+fileExt.substr(1);
        else if (['.mp3','.wav','.ogg'].includes(fileExt)) mime = 'audio/'+fileExt.substr(1);
        else if (['.js','.mjs'].includes(fileExt)) mime = 'application/javascript';
        else if (['.css'].includes(fileExt)) mime = 'text/css';
        else if (['.pdf'].includes(fileExt)) mime = 'application/pdf';

        linkMap.set(shortCode, {
            catboxUrl: catboxUrl,
            mime: mime,
            filename: req.file.originalname
        });

        // Nettoyage du fichier temporaire
        fs.unlink(req.file.path, () => {});

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

// Redirection /affichage direct du fichier (cache Catbox)
app.get('/f/:code', async (req, res) => {
    const code = req.params.code;
    const entry = linkMap.get(code);
    if (!entry) return res.status(404).send('Lien invalide ou expiré');

    // Version proxy (cache complet de l'URL Catbox):
    try {
        const response = await axios.get(entry.catboxUrl, { responseType: 'stream' });
        res.setHeader('Content-Type', entry.mime);
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(entry.filename)}"`);
        response.data.pipe(res);
    } catch (err) {
        res.status(502).send('Erreur lors de la récupération du fichier');
    }
});

app.listen(3000, () => {
    console.log('Serveur démarré sur http://localhost:3000');
});
// index.js
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Octokit } = require('@octokit/rest');

const app = express();
const linkMap = new Map();

// Configuration GitHub
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'toge021';
const GITHUB_REPO = process.env.GITHUB_REPO || 'Media';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// Vérification que le token existe
if (!GITHUB_TOKEN) {
    console.error('❌ ERREUR: GITHUB_TOKEN non défini dans les variables d\'environnement');
    process.exit(1);
}

// Configuration multer pour Railway (utilise /tmp)
const upload = multer({ 
    dest: '/tmp/uploads/',
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB max
});

// Créer le dossier /tmp/uploads s'il n'existe pas
if (!fs.existsSync('/tmp/uploads')) {
    fs.mkdirSync('/tmp/uploads', { recursive: true });
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

app.use(express.static('public'));
app.use(express.json());

function generateShortCode() {
    return crypto.randomBytes(6).toString('base64url');
}

function sanitizeFilename(filename) {
    return filename
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9.-]/g, '_')
        .replace(/__+/g, '_');
}

// ULTRA COURT - nom de fichier de seulement 4 caractères hexadécimaux!
function generateObfuscatedPath(originalName) {
    const ext = path.extname(originalName);
    // 2 bytes = 4 caractères hexadécimaux (65536 combinaisons possibles)
    const shortName = crypto.randomBytes(2).toString('hex');
    return `m/${shortName}${ext}`;
}

async function uploadToGitHub(filePath, originalName) {
    const buffer = fs.readFileSync(filePath);
    const content = buffer.toString('base64');
    const cleanName = sanitizeFilename(originalName) || 'file.bin';
    const obfuscatedPath = generateObfuscatedPath(cleanName);
    
    try {
        // Vérifier si le fichier existe déjà
        let sha = null;
        try {
            const existingFile = await octokit.repos.getContent({
                owner: GITHUB_OWNER,
                repo: GITHUB_REPO,
                path: obfuscatedPath,
                ref: GITHUB_BRANCH
            });
            sha = existingFile.data.sha;
        } catch (e) {
            // Fichier n'existe pas, on continue
            if (e.status !== 404) {
                console.warn('Erreur check existence:', e.message);
            }
        }

        // Upload du fichier
        await octokit.repos.createOrUpdateFileContents({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            path: obfuscatedPath,
            message: `Upload: ${cleanName}`,
            content: content,
            branch: GITHUB_BRANCH,
            sha: sha
        });

        // Construire l'URL brute GitHub
        const rawUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${obfuscatedPath}`;
        return rawUrl;
    } catch (err) {
        throw new Error(`GitHub upload error: ${err.message}`);
    }
}

// Route d'upload - encode l'URL GitHub dans le shortCode
app.post('/upload', upload.single('file'), async (req, res) => {
    let tempFilePath = null;
    try {
        if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });
        tempFilePath = req.file.path;

        const githubUrl = await uploadToGitHub(tempFilePath, req.file.originalname);
        const fileExt = path.extname(req.file.originalname).toLowerCase();

        // Encode l'URL GitHub en base64url pour la cacher dans l'URL
        const encoded = Buffer.from(githubUrl).toString('base64url');

        if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);

        // URL ultra courte! Juste /f/{encoded}
        res.json({
            success: true,
            shortUrl: `/f/${encoded}`,
            originalName: req.file.originalname
        });

    } catch (err) {
        if (tempFilePath && fs.existsSync(tempFilePath)) try { fs.unlinkSync(tempFilePath); } catch(e) {}
        res.status(500).json({ error: err.message });
    }
});

// Route proxy - décode l'URL GitHub depuis le shortCode (sans paramètre filename)
app.get('/f/:encoded', async (req, res) => {
    try {
        const githubUrl = Buffer.from(req.params.encoded, 'base64url').toString('utf8');
        
        // Vérification que c'est bien une URL GitHub (sécurité)
        if (!githubUrl.startsWith('https://raw.githubusercontent.com/')) {
            return res.status(400).send('Lien invalide');
        }

        // Extraire le nom du fichier depuis l'URL GitHub
        const urlParts = githubUrl.split('/');
        const fullFilename = urlParts[urlParts.length - 1];
        const filename = decodeURIComponent(fullFilename);
        const fileExt = path.extname(filename).toLowerCase();

        let mime = 'application/octet-stream';
        if (['.jpg','.jpeg'].includes(fileExt)) mime = 'image/jpeg';
        else if (fileExt === '.png') mime = 'image/png';
        else if (fileExt === '.gif') mime = 'image/gif';
        else if (fileExt === '.webp') mime = 'image/webp';
        else if (fileExt === '.mp4') mime = 'video/mp4';
        else if (fileExt === '.webm') mime = 'video/webm';
        else if (fileExt === '.mov') mime = 'video/quicktime';
        else if (fileExt === '.mp3') mime = 'audio/mpeg';
        else if (fileExt === '.pdf') mime = 'application/pdf';

        const response = await fetch(githubUrl);
        if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);

        res.setHeader('Content-Type', mime);
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);

        const arrayBuffer = await response.arrayBuffer();
        res.send(Buffer.from(arrayBuffer));

    } catch (err) {
        console.error('❌ Erreur proxy:', err.message);
        res.status(502).send('Erreur: ' + err.message);
    }
});

// Route de santé pour Railway
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Gestionnaire d'erreurs global
app.use((err, req, res, next) => {
    console.error('❌ Erreur serveur:', err);
    if (err instanceof multer.MulterError) {
        if (err.code === 'FILE_TOO_LARGE') {
            return res.status(413).json({ error: 'Fichier trop volumineux (max 100MB)' });
        }
        return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Erreur interne du serveur' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Serveur démarré sur le port ${PORT}`);
    console.log(`📁 GitHub Repo: ${GITHUB_OWNER}/${GITHUB_REPO}`);
    console.log(`🔑 Token GitHub: ${GITHUB_TOKEN ? '✅ Configuré' : '❌ Manquant'}`);
});